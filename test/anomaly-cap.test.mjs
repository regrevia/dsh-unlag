/**
 * The page shows a runaway update in a few lines, but "may this page be rebuilt on what is left
 * behind" is a judgment about every plugin, not about the first few names that fit on screen. This
 * file has more stopped plugins than the wire answer carries names for and asks the three readers
 * that judge the same update — the answer that started it, a retry of the same press, and
 * `/state.operation` — for the same verdict.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-cap-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'cap.log')
process.env.DSH_UNLAG_ANSWER_MS = '2000'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const PLUGINS = 48
const STOPPED = 40

function mount() {
  const routes = new Map()
  const tools = []
  let applies = 0
  let state = Array.from({ length: PLUGINS }, (_, index) => ({ id: `@local/p${index}`, state: 2 }))
  const ctx = {
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
      if (key === 'loader') return { entries: () => state.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
      if (key === 'clientModules') return { graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }), fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) }
      if (key === 'hmr') {
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => work(),
          reconcileProfile: async () => {
            applies += 1
            // Every plugin but the first few stops running with this update: the fact that has to
            // reach the verdict is the count, not the names the page would print.
            state = state.map((entry, index) => ({ ...entry, state: index < PLUGINS - STOPPED ? 2 : 1 }))
            return { warnings: [], pending: [] }
          },
        }
      }
      return undefined
    },
    on: () => {},
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
    },
    effect: (factory) => {
      factory()
      return () => {}
    },
  }
  apply(ctx, { agentRefresh: true })
  return { routes, tools, applies: () => applies }
}

const { routes, tools, applies } = mount()
check('the refresh tool is offered', tools.length === 1 && tools[0].name === 'unlag_refresh', String(tools.length))

const pressed = await tools[0].execute({ requestId: 'many-1' })
check('an update that stops many plugins ends failed', pressed.status === 'failed', JSON.stringify(pressed))
check('and it is not called safe to rebuild', pressed.rebuild === 'unsafe', JSON.stringify(pressed))
check('and the plugin set was composed once', applies() === 1, String(applies()))

const stateRes = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
const state = JSON.parse(String(stateRes.body))
check('the record counts every stopped plugin', state?.operation?.failed === STOPPED, JSON.stringify(state?.operation?.failed))
check('the record judges the whole set, not the names it kept', state?.operation?.rebuild === 'unsafe', JSON.stringify(state?.operation?.rebuild))
check('the record still holds its final status', state?.operation?.status === 'failed', JSON.stringify(state?.operation?.status))

const retry = await tools[0].execute({ requestId: 'many-1' })
check('a retry of that press reads failed', retry.status === 'failed', JSON.stringify(retry))
check('and the retry keeps the same verdict', retry.rebuild === 'unsafe', JSON.stringify(retry))
check('and the retry composed nothing', applies() === 1, String(applies()))

// The names are what the wire answer drops; the count is what the verdict keeps.
check('the answer itself carries no phantom success', pressed.reason !== '' && !String(pressed.reason).includes('已换成新代码'), String(pressed.reason))

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
