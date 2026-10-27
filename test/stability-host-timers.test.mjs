// Timer hygiene for the host half: every timer this plugin arms is either unreferenced (`unref`), so
// it cannot keep a closing app awake, or it is cleared when the thing it waits for is over. A timer
// that outlives a finished press, or a dispose, is not a slow path — it is the process staying alive
// for work nobody is waiting for any more.
//
// The check counts timers instead of trusting the code: `setTimeout` is wrapped before any host call,
// each handle records whether it was unreferenced, and the assertions read that record. Durations
// alone cannot tell "waits for the update" from "waits for nothing".
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-timers-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'timers.log')

// --- count every timer the host arms -----------------------------------------------------------
const live = new Map()
const timerThrew = []
const realSet = globalThis.setTimeout
const realClear = globalThis.clearTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setTimeout = function countedSetTimeout(fn, ms = 0, ...args) {
  const row = { ms: Number(ms), unref: false, cleared: false, armed: Date.now() }
  const handle = realSet(() => {
    live.delete(handle)
    try {
      fn(...args)
    } catch (error) {
      timerThrew.push(String(error?.message ?? error))
    }
  }, ms)
  const realUnref = handle.unref.bind(handle)
  handle.unref = () => {
    row.unref = true
    realUnref()
    return handle
  }
  live.set(handle, row)
  return handle
}
globalThis.clearTimeout = function countedClearTimeout(handle) {
  const row = live.get(handle)
  if (row !== undefined) {
    row.cleared = true
    live.delete(handle)
  }
  return realClear(handle)
}
const pending = () => [...live.values()].filter((row) => row.cleared === false)
/** Forget whatever an earlier case left armed, so each case counts only its own timers. */
const dropPending = () => {
  for (const handle of [...live.keys()]) globalThis.clearTimeout(handle)
}
const describe = (rows) => (rows.length === 0 ? 'none' : rows.map((row) => `${row.ms}ms${row.unref ? ' unref' : ''}`).join(', '))
const realDelay = (ms) => new Promise((resolve) => realSet(resolve, ms))
const realWaitUntil = async (what, limit) => {
  const began = Date.now()
  while (Date.now() - began < limit) {
    if (what()) return true
    await realDelay(5)
  }
  return false
}

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

// --- the fake host -----------------------------------------------------------------------------
const makeRes = () => ({
  status: 0,
  body: '',
  headersSent: false,
  writableEnded: false,
  destroyed: false,
  writeHead(status) {
    this.status = status
    this.headersSent = true
  },
  write() {
    return true
  },
  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.body += String(chunk)
    this.writableEnded = true
  },
})

function mount({ config = {}, hmr: given = null, agents = undefined } = {}) {
  const routes = new Map()
  const disposers = []
  const loader = { entries: () => [{ options: { id: '@local/a' }, fiber: { state: 2 } }] }
  const graph = { rev: 'r1', entries: [{ id: '@local/a', rev: 'r1' }], batches: [] }
  const clientModules = { graph: () => graph, fetchBundle: async () => null }
  const hmr = given ?? {
    baseDir: join(HOME, 'profile'),
    runExclusive: async (op) => op(),
    reconcileProfile: async () => ({ warnings: [], pending: [] }),
  }
  const server = {
    collectIndexInjections: () => [],
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? server
        : key === 'loader'
          ? loader
          : key === 'hmr'
            ? hmr
            : key === 'clientModules'
              ? clientModules
              : key === 'agents'
                ? agents
                : undefined,
    on: (event, fn) => {
      if (event === 'dispose') disposers.push(fn)
    },
  }
  apply(ctx, config)
  return {
    routes,
    dispose: () => {
      for (const fn of disposers.splice(0).reverse()) fn()
    },
  }
}

const press = (host, query = '') => {
  const handler = host.routes.get('/dsh-unlag/reload')
  const res = makeRes()
  const answered = Promise.resolve(
    handler({ method: 'POST', url: `/dsh-unlag/reload${query}`, headers: { 'x-dsh-unlag': '1' } }, res),
  ).then(() => res)
  return answered
}

// --- 1: a press that finished must not leave its deadline timer behind --------------------------
{
  dropPending()
  const host = mount()
  const res = await press(host)
  check('a press that finished answers done', JSON.parse(res.body).status === 'done', res.body)
  await realDelay(30)
  const left = pending()
  check(
    'a finished press arms no timer it never clears',
    left.length === 0,
    describe(left),
  )
  check('no timer callback threw while that press ran', timerThrew.length === 0, timerThrew.join(' | '))
  host.dispose()
}

// --- 2: a press waiting out the minimum interval must not outlive a dispose ---------------------
{
  dropPending()
  const host = mount()
  const first = await press(host)
  check('the first press in a burst answers done', JSON.parse(first.body).status === 'done', first.body)
  const between = press(host, '?requestId=second')
  // The second press is inside the minimum interval: it waits for the gap instead of swapping twice.
  await realDelay(40)
  // The gap between two applies is MIN_INTERVAL_MS; the wait for it is the timer armed here.
  const waiting = pending().filter((row) => row.ms > 1000 && row.ms < 2000)
  check('a press inside the minimum interval is really waiting', waiting.length === 1, describe(pending()))
  host.dispose()
  const answered = await Promise.race([
    between.then(() => 'answered'),
    realDelay(250).then(() => 'timeout'),
  ])
  check('a dispose does not leave a waiting press hanging', answered === 'answered', answered)
  const late = await between
  check('the press stopped by a dispose says so instead of applying', JSON.parse(late.body).status === 'unavailable', late.body)
  await realDelay(20)
  const left = pending()
  check('a press stopped by a dispose leaves no timer behind', left.length === 0, describe(left))
}

// --- 3: the retry wait after a nested refusal must not hold the app open ------------------------
{
  dropPending()
  process.env.DSH_UNLAG_RETRY_MS = '60'
  process.env.DSH_UNLAG_ANSWER_MS = '30'
  let attempts = 0
  const hmr = {
    baseDir: join(HOME, 'profile'),
    runExclusive: async (op) => op(),
    reconcileProfile: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('nested recomposition refused')
      return { warnings: [], pending: [] }
    },
  }
  const host = mount({ hmr })
  const res = await press(host)
  check('an update that outlasts the page answer is told it is still applying', JSON.parse(res.body).status === 'applying', res.body)
  // From here on only the update's own waits can be armed: the page's answer timer is already cleared.
  let blocking = 0
  let sawRetry = false
  const watch = realSetInterval(() => {
    const rows = pending()
    if (rows.some((row) => row.ms > 0 && row.ms < 10_000 && row.unref === false)) blocking += 1
    if (rows.length > 0) sawRetry = true
  }, 4)
  await realDelay(400)
  realClearInterval(watch)
  check('a nested refusal is retried instead of given up on', attempts >= 3, String(attempts))
  check('the retry wait was really armed (the check saw a timer)', sawRetry === true)
  check(
    'a retry wait is unreferenced, so it cannot keep the app open',
    blocking === 0,
    `${blocking} sample(s) saw a referenced timer`,
  )
  const left = pending()
  check('a finished update leaves no timer behind', left.length === 0, describe(left))
  host.dispose()
  delete process.env.DSH_UNLAG_RETRY_MS
  delete process.env.DSH_UNLAG_ANSWER_MS
}

// --- 4: an idle-only queue tick is unreferenced and cleared by a dispose -----------------------
{
  dropPending()
  const agents = { list: () => [{ status: 'running' }] }
  const host = mount({ config: { idleOnly: true }, agents })
  const res = await press(host)
  check('a press while a turn runs is queued instead of swapping', JSON.parse(res.body).status === 'queued', res.body)
  const ticks = pending()
  check('the queue tick is armed', ticks.length === 1, describe(ticks))
  check('the queue tick is unreferenced', ticks.every((row) => row.unref === true), describe(ticks))
  host.dispose()
  await realDelay(10)
  check('a dispose clears the queue tick', pending().length === 0, describe(pending()))
}

// --- 5: repeating the whole cycle leaves nothing behind ---------------------------------------
{
  dropPending()
  for (let round = 0; round < 5; round += 1) {
    const host = mount()
    await press(host, `?requestId=round-${round}`)
    host.dispose()
  }
  await realDelay(30)
  check('five press-and-dispose rounds leave no timer behind', pending().length === 0, describe(pending()))
  check('no timer callback threw across those rounds', timerThrew.length === 0, timerThrew.slice(0, 3).join(' | '))
}

globalThis.setTimeout = realSet
globalThis.clearTimeout = realClear
rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
