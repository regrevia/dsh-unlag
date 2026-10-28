// A stopped plugin is remembered until it runs again. The set that decides whether the profile is
// whole is not a display list: dropping part of it turns a profile that is still missing an entry
// into one a later press calls healthy, and the page that press allows starts over a broken set.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-health-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'health.log')
process.env.DSH_UNLAG_ANSWER_MS = '3000'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

function fakeRes() {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  return res
}

/** One app whose Loader reports `before` now and `after` once the update finished. */
function mount(before, after) {
  const routes = new Map()
  let state = before.map((entry) => ({ ...entry }))
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      if (key === 'loader') return { entries: () => state.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
      if (key === 'clientModules') return { graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }), fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }) }
      if (key === 'hmr')
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => work(),
          reconcileProfile: async () => {
            state = after.map((entry) => ({ ...entry }))
            return { warnings: [], pending: [] }
          },
        }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
}

const press = async (routes) => {
  const res = fakeRes()
  await routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/reload', destroy: () => {} }, res)
  return res
}

const N = 65
const id = (n) => `@local/plugin-${n}`
const stoppedOne = id(N)

// --- all 65 entries stop with one press: every one of them is remembered -----------------------
{
  const all = Array.from({ length: N }, (_, n) => ({ id: id(n + 1), state: 2 }))
  const routes = mount(all, all.map((entry) => ({ ...entry, state: 3 })))
  const res = await press(routes)
  check('a press that stops every entry does not call the set healthy', JSON.parse(res.body).status === 'failed', res.body)
}

// --- 64 of them recover, the 65th is still stopped: the next press must not call the set whole --
{
  const recovered = Array.from({ length: N }, (_, n) => ({ id: id(n + 1), state: n + 1 === N ? 3 : 2 }))
  const routes = mount(recovered, recovered)
  const res = await press(routes)
  const body = JSON.parse(res.body)
  // One broken plugin does not hold the page back forever: it is reported as stopped before this
  // press, while the rebuild is judged by what this press changed.
  check('a still stopped entry from an earlier press is not forgotten past 64', (body.carriedEntries ?? []).includes(stoppedOne), res.body)
  check('and that press still ends done', body.status === 'done', res.body)
  check('and the rebuild is safe because nothing new broke', body.rebuild === 'safe', res.body)
  check('and it is not counted among the entries this press stopped', Array.isArray(body.failedEntries) && body.failedEntries.length === 0, res.body)
}

// --- when that last entry runs again the memory clears and the press ends done ------------------
{
  const all = Array.from({ length: N }, (_, n) => ({ id: id(n + 1), state: 2 }))
  const routes = mount(all, all)
  const res = await press(routes)
  const body = JSON.parse(res.body)
  check('a set that runs again ends done', body.status === 'done', res.body)
  check('and the rebuild is safe', body.rebuild === 'safe', res.body)
}

console.log(out.join('\n'))
