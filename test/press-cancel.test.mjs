// A press that is stopped before the app is asked must apply nothing. The window that matters is
// between "the press is accepted" and "the queue runs this update": another reload can hold the
// queue for whole seconds, and a person who closes the tab or stops the turn in that window must
// not come back to a plugin set that was replaced for a document that is gone. Both ways in — the
// page's route and the agent's tool — are checked here, and so is the line the log owes afterwards.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-cancel-'))
const LOG = join(HOME, 'cancel.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '6000'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '')
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The HMR service is held at the queue: `runExclusive` does not run its callback until the test
 * opens the gate. That is the app under a reload of its own, and it is the only honest way to get
 * at the window between accepting a press and asking for it.
 */
function mount(options = {}) {
  const routes = new Map()
  const tools = new Map()
  let state = (options.before ?? []).map((entry) => ({ ...entry }))
  let applies = 0
  let open = null
  const gate = new Promise((resolve) => {
    open = resolve
  })
  const clientModules = {
    graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }),
    fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }),
  }
  const ctx = {
    effect: (work) => work(),
    get: (key) => {
      if (key === 'webServer') {
        return {
          collectIndexInjections: () => [],
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      if (key === 'tools') {
        return {
          register: (definition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      }
      if (key === 'loader') return { entries: () => state.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
      if (key === 'clientModules') return clientModules
      if (key === 'hmr') {
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => {
            await gate
            return work()
          },
          reconcileProfile: async () => {
            applies += 1
            state = (options.after ?? state).map((entry) => ({ ...entry }))
            return { warnings: [], pending: [] }
          },
        }
      }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, { agentRefresh: true, plugins: true })
  return { routes, tools, applies: () => applies, open }
}

const json = (routes, path, { method = 'GET' } = {}) => {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(text) { this.body += text ?? ''; this.writableEnded = true } }
  return Promise.resolve(routes.get(path)({ method, url: path, headers: { 'x-dsh-unlag': '1' } }, res)).then(() => ({ status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) }))
}

// --- the page's route: a tab that goes away before the update is asked for ---------------------
{
  writeFileSync(LOG, '')
  const { routes, applies, open } = mount({ before: [{ id: '@local/a', state: 2 }] })
  /**
   * `close` is the route's cancel signal, so this reply keeps the handler it registers and fires it
   * the way a closed connection would.
   */
  let onClose = null
  const res = {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(text) { this.body += text ?? ''; this.writableEnded = true },
    once(event, handler) { if (event === 'close') onClose = handler },
  }
  const pending = routes.get('/dsh-unlag/reload')({ method: 'POST', url: '/dsh-unlag/reload?requestId=gone', headers: { 'x-dsh-unlag': '1' } }, res)
  // The press is accepted and waiting on the queue's gate; nothing has been asked of the app.
  await settle(50)
  check('the route has a way to hear that the page went away', typeof onClose === 'function')
  if (typeof onClose === 'function') onClose()
  open()
  await pending
  await settle(120)
  const answer = JSON.parse(res.body === '' ? '{}' : res.body)
  check('a press stopped in the queue answers cancelled', answer.status === 'cancelled', JSON.stringify(answer))
  check('and the rebuild is not claimed either way', answer.rebuild === 'unknown', JSON.stringify(answer))
  check('nothing was applied for a page that is gone', applies() === 0, `applies=${applies()}`)
  const state = await json(routes, '/dsh-unlag/state')
  check('the state does not say an update is running on', state.body.operation?.status === 'cancelled', JSON.stringify(state.body.operation))
  check('the log says the set was left as it was found', lines().some((line) => line.includes('stopped before it reached the app; nothing was replaced')))
}

// --- the agent's tool: a turn stopped while the update waits for the queue ---------------------
{
  writeFileSync(LOG, '')
  const { tools, applies, open } = mount({ before: [{ id: '@local/a', state: 2 }] })
  const tool = tools.get('unlag_refresh')
  check('the tool is offered when agent refresh is on', tool !== undefined)
  const stop = new AbortController()
  const pending = tool.execute({ requestId: 'stopped-turn' }, { signal: stop.signal })
  await settle(50)
  stop.abort()
  open()
  const answer = await pending
  await settle(120)
  check('a turn stopped in the queue answers cancelled', answer.status === 'cancelled', JSON.stringify(answer))
  check('and applies nothing', applies() === 0, `applies=${applies()}`)
  /**
   * A press stopped before it asked anything has no verdict to record, so the next press must not
   * inherit a failure from it: this update now runs and ends on what it actually did.
   */
  const next = await tool.execute({ requestId: 'after-cancel' }, {})
  check('the next press is judged on its own update', next.status === 'done', JSON.stringify(next))
  check('and that update really ran once', applies() === 1, `applies=${applies()}`)
}

// --- an answer already sent is not a page that went away --------------------------------------
{
  writeFileSync(LOG, '')
  const { routes, applies, open } = mount({ before: [{ id: '@local/a', state: 2 }] })
  let onClose = null
  const res = {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(text) { this.body += text ?? ''; this.writableEnded = true },
    once(event, handler) { if (event === 'close') onClose = handler },
  }
  process.env.DSH_UNLAG_ANSWER_MS = '20'
  let pending
  try {
    pending = routes.get('/dsh-unlag/reload')({ method: 'POST', url: '/dsh-unlag/reload?requestId=applying', headers: { 'x-dsh-unlag': '1' } }, res)
  } finally {
    process.env.DSH_UNLAG_ANSWER_MS = '6000'
  }
  await pending
  await settle(60)
  const answer = JSON.parse(res.body === '' ? '{}' : res.body)
  check('a press too slow for the page is told it is still applying', answer.status === 'applying', JSON.stringify(answer))
  // The response's own end can report "close"; a page that was told "still applying" is waiting.
  if (typeof onClose === 'function') onClose()
  open()
  await settle(300)
  check('the update the page was promised carries on', applies() === 1, `applies=${applies()}`)
  check('and it is not recorded as cancelled', lines().every((line) => !line.includes('stopped before it reached the app')))
}

// --- wording ----------------------------------------------------------------------------------
for (const line of out) console.log(line)
const failed = out.filter((line) => line.startsWith('FAIL'))
console.log(`\n${failed.length === 0 ? 'all cancel checks passed' : `${failed.length} cancel check(s) failed`}`)
