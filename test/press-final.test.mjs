// What a press ends as, and what the next press is judged against. Three separate truths are
// checked here: a plugin that was already stopped before the press is not this update's failure,
// a plugin this press stopped makes it fail, and the end of an update that outlasted the answer is
// still written down so the next press and a late reader see it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-final-'))
const LOG = join(HOME, 'final.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '40'

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

// --- a plugin that was already stopped is not this press's failure ----------------------------
{
  writeFileSync(LOG, '')
  const { routes } = mount({
    before: [{ id: '@local/envoy', state: 2 }, { id: '@local/a', state: 2 }],
    after: [{ id: '@local/envoy', state: 1 }, { id: '@local/a', state: 2 }],
  })
  // The first press is the one that took the plugin down, so it is the update's failure and says so.
  const failed = await press(routes)
  check('a press that stopped a plugin ends failed', failed.body.status === 'failed', JSON.stringify(failed.body))
  // It is still down, but it went down with that press: the next one is judged against the state it
  // finds instead of being turned away by a record nothing on the page can fix.
  const next = await pressSlow(routes)
  check('the next press ends done even though the plugin is still stopped', next.body.status === 'done', JSON.stringify(next.body))
  check('and the log says that plugin was left out of the refusal', lines().some((line) => /left out of the refusal, already stopped before this press: @local\/envoy/u.test(line)), lines().slice(-5).join(' | '))
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
  const { routes } = mount({
    before: [{ id: '@local/a', state: 2 }],
    after: [{ id: '@local/a', state: 1 }],
    delay: 200,
    fail: true,
  })
  const answer = await press(routes)
  check('a press that will fail late is told it is still applying first', answer.body.status === 'applying', JSON.stringify(answer.body))
  await settle()
  const state = await stateOf(routes)
  check('an update that failed after the answer ends failed', state.body.operation?.status === 'failed', JSON.stringify(state.body.operation))
  // The plugin is still down, but it went down with that failed update, so this press may run
  // again instead of being turned away by a record nothing can fix. The answer is allowed to wait
  // for the whole update here, so the verdict is read directly.
  const retry = await pressSlow(routes)
  check('and the next press is allowed to run', retry.body.status === 'done', JSON.stringify(retry.body))
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
