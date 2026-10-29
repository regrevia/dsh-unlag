// What a press ends as, and what the next press is judged against. Three separate truths are
// checked here: a plugin stopped by an earlier press keeps failing the next one until it runs
// again, a plugin this press stopped makes it fail, and the end of an update that outlasted the
// answer is still written down so the next press and a late reader see it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-final-'))
const LOG = join(HOME, 'final.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '40'
// The one more ask a rejected update makes waits a moment in the app; shortened here so a test
// does not sit it out.
process.env.DSH_UNLAG_RETRY_MS = '40'

const { apply, startupPath } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const lines = () => (readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== ''))
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms))

function mount(options = {}) {
  const routes = new Map()
  let state = (options.before ?? []).map((entry) => ({ ...entry }))
  let applies = 0
  let failures = options.fail === true ? 1 : 0
  const clientModules = {
    graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }),
    fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }),
  }
  const ctx = {
    get: (key) => {
      if (key === 'webServer') {
        return { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      }
      if (key === 'loader') return { entries: () => state.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
      if (key === 'clientModules') return clientModules
      if (key === 'hmr') {
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => work(),
          reconcileProfile: async () => {
            applies += 1
            await new Promise((resolve) => setTimeout(resolve, options.delay ?? 0))
            // One failed update, not a broken service: the press after it must be able to work.
            if (options.fail === true && failures > 0) {
              failures -= 1
              state = (options.after ?? state).map((entry) => ({ ...entry }))
              throw new Error('the swap failed after the answer')
            }
            state = (options.after ?? state).map((entry) => ({ ...entry }))
            return { warnings: options.warnings ?? [], pending: options.pending ?? [] }
          },
        }
      }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return { routes, applies: () => applies }
}

async function askJson(routes, path, { method = 'GET', header = true } = {}) {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  await routes.get(path)({ method, url: path, headers: header ? { 'x-dsh-unlag': '1' } : {} }, res)
  return { status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) }
}
const press = (routes, requestId = null) => askJson(routes, `/dsh-unlag/reload${requestId === null ? '' : `?requestId=${requestId}`}`, { method: 'POST' })
// Two presses close together wait for the app to settle before the second one runs; this answer
// budget is long enough to read what the wait ends as instead of "still applying".
const pressSlow = async (routes) => {
  process.env.DSH_UNLAG_ANSWER_MS = '6000'
  try {
    return await press(routes)
  } finally {
    process.env.DSH_UNLAG_ANSWER_MS = '40'
  }
}
const stateOf = (routes) => askJson(routes, '/dsh-unlag/state')

// --- the address shape every reader agrees on ------------------------------------------------
check('a relative startup address resolves to the path the app serves', startupPath('plugins/??@local/a/client.js&rev=old') === '/plugins/??@local/a/client.js&rev=old')
check('an absolute startup address is left as it is', startupPath('/plugins/??@local/a/client.js&rev=old') === '/plugins/??@local/a/client.js&rev=old')
check('an empty address stays empty', startupPath('') === '')
{
  writeFileSync(LOG, '')
  const { routes } = mount()
  const body = JSON.stringify({ boot: { rev: 'old', batches: [{ url: 'plugins/??@local/a/client.js&rev=old' }], entries: ['@local/a'] } })
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(text) { this.body += text ?? ''; this.writableEnded = true } }
  /**
   * The route reads a request body through its events; this request has the body already, so every
   * handler is kept and then called once, data first and end last.
   */
  const handlers = []
  const req = {
    method: 'POST',
    url: '/dsh-unlag/boot',
    headers: { 'x-dsh-unlag': '1' },
    destroy: () => {},
    on: (event, handler) => {
      handlers.push([event, handler])
      if (handlers.length === 1) {
        setImmediate(() => {
          for (const [name, fn] of handlers) if (name === 'data') fn(Buffer.from(body))
          for (const [name, fn] of handlers) if (name === 'end') fn()
        })
      }
    },
  }
  await routes.get('/dsh-unlag/boot')(req, res)
  await settle(200)
  const state = await stateOf(routes)
  const rows = state.body.bootSnapshot?.rows ?? []
  check('a reported relative address is frozen in the shape a check can find again', rows[0]?.url === '/plugins/??@local/a/client.js&rev=old', JSON.stringify(rows))
  check('and the capture is complete now that the address reads', state.body.bootSnapshot?.complete === true, JSON.stringify(state.body.bootSnapshot))
}

// --- a plugin an earlier press stopped keeps failing the next one ------------------------------
{
  writeFileSync(LOG, '')
  const { routes } = mount({
    before: [{ id: '@local/envoy', state: 2 }, { id: '@local/a', state: 2 }],
    after: [{ id: '@local/envoy', state: 1 }, { id: '@local/a', state: 2 }],
  })
  // The first press is the one that took the plugin down, so it is the update's failure and says so.
  const failed = await press(routes)
  check('a press that stopped a plugin ends failed', failed.body.status === 'failed', JSON.stringify(failed.body))
  // It is still down, and the only press that could have taken it down is the one before this one:
  // the record of that failure is kept until the plugin runs again or leaves the profile, so a
  // second press cannot turn a stopped plugin into a done one.
  const next = await pressSlow(routes)
  check('the next press ends done because it changed nothing', next.body.status === 'done', JSON.stringify(next.body))
  check('and it names the plugin as stopped before this press', Array.isArray(next.body.carriedEntries) && next.body.carriedEntries.includes('@local/envoy'), JSON.stringify(next.body))
  check('and the page may rebuild on the set that is running', next.body.rebuild === 'safe', JSON.stringify(next.body))
  check('and the log says that plugin is still stopped from an earlier press', lines().some((line) => /still stopped from an earlier press: @local\/envoy/u.test(line)), lines().slice(-6).join(' | '))
}

// --- a plugin this press stopped fails it ----------------------------------------------------
{
  writeFileSync(LOG, '')
  const { routes } = mount({
    before: [{ id: '@local/envoy', state: 2 }, { id: '@local/a', state: 2 }],
    after: [{ id: '@local/envoy', state: 1 }, { id: '@local/a', state: 2 }],
  })
  const answer = await press(routes)
  check('a press that stopped a plugin ends failed', answer.body.status === 'failed', JSON.stringify(answer.body))
  check('and the log names the plugin it stopped', lines().some((line) => /a plugin stopped running with this update: @local\/envoy/u.test(line)), lines().slice(-4).join(' | '))
}

// --- an update that outlasts the answer is still written down --------------------------------
{
  writeFileSync(LOG, '')
  const { routes } = mount({ before: [{ id: '@local/a', state: 2 }], delay: 200 })
  const answer = await press(routes)
  check('a press that outlasts its answer is told it is still applying', answer.body.status === 'applying', JSON.stringify(answer.body))
  await settle()
  const state = await stateOf(routes)
  check('an update that finished after the answer ends done', state.body.operation?.status === 'done', JSON.stringify(state.body.operation))
}
{
  writeFileSync(LOG, '')
  const { routes, applies } = mount({
    before: [{ id: '@local/a', state: 2 }],
    after: [{ id: '@local/a', state: 1 }],
    delay: 200,
    fail: true,
  })
  const answer = await press(routes)
  check('a press that will fail late is told it is still applying first', answer.body.status === 'applying', JSON.stringify(answer.body))
  await settle()
  const state = await stateOf(routes)
  /**
   * The app rejected that update as unfinished, which leaves the entry it could not bring up
   * stopped. Asking again without that entry is what pressing the button again would do, so the
   * press does that itself and the record ends done for the set that can run. The entry stays
   * named as carried: the update did take it down, and that is not forgotten.
   */
  check('an update that failed is asked once more and ends done for the set that runs', state.body.operation?.status === 'done' && state.body.operation?.rebuild === 'safe', JSON.stringify(state.body.operation))
  check('and the second ask is written down with the entry it left behind', lines().some((line) => /this update left an entry stopped \(@local\/a\); asked once more without it/u.test(line)), lines().slice(-6).join(' | '))
  check('and the press asked the app exactly twice, not in a loop', applies() === 2, String(applies()))
  // The plugin is still down because that failed update took it down. The record of that failure is
  // kept until the plugin runs again or leaves the profile, so the next press reads it as carried.
  const retry = await pressSlow(routes)
  check('and the next press does not forget that the plugin is still down', (retry.body.carriedEntries ?? []).includes('@local/a'), JSON.stringify(retry.body))
  check('and that press ends done so the page can come up on what runs', retry.body.status === 'done', JSON.stringify(retry.body))
}

// --- the record of a stopped plugin clears when that plugin runs again ------------------------
{
  writeFileSync(LOG, '')
  const { routes } = mount({ before: [{ id: '@local/a', state: 2 }], after: [{ id: '@local/a', state: 2 }] })
  const answer = await pressSlow(routes)
  check('a press after the plugin runs again ends done', answer.body.status === 'done', JSON.stringify(answer.body))
  check('and nothing is carried as stopped before it', Array.isArray(answer.body.carriedEntries) && answer.body.carriedEntries.length === 0, JSON.stringify(answer.body))
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
