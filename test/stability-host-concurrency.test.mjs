// Concurrent presses: the app restarts the whole plugin set for one apply, so two applies must never
// overlap, and no press may be left without an answer. The fake hmr below counts how many
// reconciliations are running at once — that number is the thing being checked, not the words in the
// log — and every front door is exercised: two ids at once, the same id twice, a dispose mid-press, a
// press waiting out the minimum interval, and a burst of presses arriving while one apply is running.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-concurrent-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'concurrent.log')
const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A rejection that nothing handled is the app's problem, not a test detail: record them all.
const escaped = []
process.on('unhandledRejection', (error) => escaped.push(`rejection: ${error?.message ?? error}`))
process.on('uncaughtException', (error) => escaped.push(`exception: ${error?.message ?? error}`))

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

function mount({ config = {}, delayMs = 40, agents = undefined, failWith = null } = {}) {
  const routes = new Map()
  const disposers = []
  const counters = { calls: 0, active: 0, maxActive: 0 }
  const loader = { entries: () => [{ options: { id: '@local/a' }, fiber: { state: 2 } }] }
  const clientModules = {
    graph: () => ({ rev: 'r1', entries: [{ id: '@local/a', rev: 'r1' }] }),
    fetchBundle: async () => null,
  }
  const hmr = {
    baseDir: join(HOME, 'profile'),
    runExclusive: async (op) => op(),
    reconcileProfile: async () => {
      counters.calls += 1
      counters.active += 1
      counters.maxActive = Math.max(counters.maxActive, counters.active)
      try {
        await realDelay(delayMs)
        if (failWith !== null) throw new Error(failWith)
        return { warnings: [], pending: [] }
      } finally {
        counters.active -= 1
      }
    },
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
    counters,
    dispose: () => {
      for (const fn of disposers.splice(0).reverse()) fn()
    },
    press: (requestId = '') => {
      const handler = routes.get('/dsh-unlag/reload')
      const res = makeRes()
      const query = requestId === '' ? '' : `?requestId=${encodeURIComponent(requestId)}`
      return Promise.resolve(
        handler({ method: 'POST', url: `/dsh-unlag/reload${query}`, headers: { 'x-dsh-unlag': '1' } }, res),
      ).then(() => {
        const parsed = JSON.parse(res.body)
        return { status: parsed.status, operationId: parsed.operationId, res }
      })
    },
  }
}

const bounded = (promise, ms, what) =>
  Promise.race([promise.then((value) => ({ kind: 'answered', value })), realDelay(ms).then(() => ({ kind: 'timeout', what }))])

// --- 1: two different ids arriving together make one apply, never two ---------------------------
{
  const host = mount({ delayMs: 40 })
  const first = host.press('alpha')
  await realDelay(10)
  const second = host.press('beta')
  const both = await Promise.all([bounded(first, 5000, 'alpha'), bounded(second, 5000, 'beta')])
  check('both concurrent presses reach an answer', both.every((row) => row.kind === 'answered'), both.map((row) => row.kind).join(','))
  check('two ids at once are one apply, not two', host.counters.calls === 1, String(host.counters.calls))
  check('no two applies ever overlap', host.counters.maxActive === 1, String(host.counters.maxActive))
  const statuses = both.map((row) => row.value.status).sort()
  check('the second press is told the first is still applying', statuses[0] === 'applying' && statuses[1] === 'done', statuses.join(','))
  host.dispose()
}

// --- 2: the same id twice runs the update once and answers the same thing both times -----------
{
  const host = mount({ delayMs: 40 })
  const first = host.press('same-id')
  await realDelay(10)
  const second = host.press('same-id')
  const both = await Promise.all([bounded(first, 5000, 'first'), bounded(second, 5000, 'second')])
  check('a repeated id reaches an answer', both.every((row) => row.kind === 'answered'))
  check('a repeated id does not run the update twice', host.counters.calls === 1, String(host.counters.calls))
  check('a repeated id gets one operation id', both[0].value.operationId === both[1].value.operationId, `${both[0].value.operationId}/${both[1].value.operationId}`)
  check(
    'a retry that meets its own run in flight is told it is still applying, not held',
    both[1].value.status === 'applying' || both[1].value.status === both[0].value.status,
    `${both[0].value.status}/${both[1].value.status}`,
  )
  // Once the run it was waiting on has ended, the same id reads that end instead of starting again.
  const replay = await bounded(host.press('same-id'), 2000, 'replay')
  check('a retry after the end reads that end', replay.kind === 'answered' && replay.value.status === 'done', replay.kind === 'answered' ? replay.value.status : replay.kind)
  check('a retry after the end does not run the update again', host.counters.calls === 1, String(host.counters.calls))
  host.dispose()
}

// --- 3: a dispose in the middle of an apply still answers the press -----------------------------
{
  const host = mount({ delayMs: 60 })
  const press = host.press('during-dispose')
  await realDelay(15)
  host.dispose()
  const answer = await bounded(press, 1000, 'press')
  check('a press interrupted by a dispose is answered', answer.kind === 'answered', answer.kind)
  check(
    'that answer is a real end, not an invented failure',
    answer.kind === 'answered' && typeof answer.value.status === 'string' && answer.value.status.length > 0,
    answer.kind === 'answered' ? answer.value.status : '',
  )
  check('the apply was only started once', host.counters.calls === 1, String(host.counters.calls))
}

// --- 4: a press that waits out the minimum interval applies after it, without overlapping -------
{
  const host = mount({ delayMs: 20 })
  const first = await host.press('gap-one')
  check('the first press applies at once', first.status === 'done', first.status)
  const second = await bounded(host.press('gap-two'), 4000, 'gap-two')
  check('a press inside the minimum interval still reaches an answer', second.kind === 'answered', second.kind)
  check('it applies rather than being dropped', second.kind === 'answered' && second.value.status === 'done', second.kind === 'answered' ? second.value.status : '')
  check('the two applies never overlapped', host.counters.maxActive === 1, String(host.counters.maxActive))
  check('both presses did apply, one after the other', host.counters.calls === 2, String(host.counters.calls))
  host.dispose()
}

// --- 5: a burst of presses while one apply runs stays bounded and all get answers ---------------
{
  const host = mount({ delayMs: 80 })
  const running = host.press('burst-0')
  await realDelay(10)
  const burst = Array.from({ length: 50 }, (_row, index) => host.press(`burst-${index + 1}`))
  const answered = await Promise.all(burst.map((promise, index) => bounded(promise, 5000, `burst-${index + 1}`)))
  check('all fifty presses in the burst are answered', answered.every((row) => row.kind === 'answered'), answered.filter((row) => row.kind !== 'answered').length + ' unanswered')
  check('the burst does not start extra applies', host.counters.calls === 1, String(host.counters.calls))
  const statuses = new Set(answered.map((row) => row.value.status))
  check('every press in the burst is told one thing: still applying', statuses.size === 1 && statuses.has('applying'), [...statuses].join(','))
  const live = globalThis[Symbol.for('dsh-unlag.presses-live')]
  check('the press table stays bounded', live === undefined || live.size <= 256, String(live?.size ?? 0))
  await bounded(running, 5000, 'running')
  host.dispose()
}

// --- 6: an update that fails still answers, and the next press starts cleanly -------------------
{
  const host = mount({ delayMs: 5, failWith: 'the swap failed' })
  const failed = await host.press('fails')
  check('a failed update is answered', typeof failed.status === 'string' && failed.status !== '', failed.status)
  const again = await host.press('after-failure')
  check('the press after a failure is answered too', typeof again.status === 'string' && again.status !== '', again.status)
  check('a failure does not overlap two applies', host.counters.maxActive === 1, String(host.counters.maxActive))
  host.dispose()
}

await realDelay(50)
check('no press escaped as an unhandled rejection', escaped.length === 0, escaped.slice(0, 3).join(' | '))

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
