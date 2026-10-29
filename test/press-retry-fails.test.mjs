// A press is one press. The live log of 1.14.11 shows a press answered `failed` because the app
// rejected the set while one plugin was already down before the press started, and the same press
// seconds later answered `done`. That second press must not be the person's job: the reject is
// asked once more here, judged on the entries that run now, and a loop is kept out by the same flag.
// Two truths are checked: one rejection ends `done` after exactly one more ask, and a set that keeps
// failing still ends `failed` after that one more ask and no more.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-stale-'))
const LOG = join(HOME, 'stale.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '6000'
process.env.DSH_UNLAG_RETRY_MS = '40'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '')
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms))

async function mount(options = {}) {
  const routes = new Map()
  const state = (options.before ?? []).map((entry) => ({ ...entry }))
  let applies = 0
  let rejections = options.rejections ?? 1
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
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (rejections > 0) {
              rejections -= 1
              // The app's own sentence: one entry it could not bring up. The entry was already
              // down before this press, so the press did not stop it and nothing here changed state.
              throw new Error('dsh: warning: 1 entry did not activate adb (dsh-mobile-use): JsonSchemaError: unsupported JSON schema')
            }
            return { warnings: [], pending: [] }
          },
        }
      }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  await settle(400)
  return { routes, applies: () => applies }
}

async function askJson(routes, path, { method = 'GET' } = {}) {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  const route = routes.get(path.split('?')[0])
  await route({ method, url: path, headers: { 'x-dsh-unlag': '1' } }, res)
  return { status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) }
}
const press = (routes) => askJson(routes, '/dsh-unlag/reload?requestId=stale-1', { method: 'POST' })

// --- the set keeps rejecting: one more ask, and then the press tells the person -----------------
{
  writeFileSync(LOG, '')
  const { routes, applies } = await mount({
    before: [{ id: '@local/a', state: 2 }, { id: 'adb', state: 1 }],
    rejections: 5,
  })
  const answer = await press(routes)
  await settle(200)
  const text = lines().join('\n')
  check('a set that keeps rejecting ends failed', answer.body.status === 'failed', JSON.stringify(answer.body))
  check('and it is not asked a third time: one press, one extra ask', applies() === 2, `applies=${applies()}`)
  check('the log keeps the one more ask visible', text.includes('asked once more on the set that runs now'), text.slice(-400))
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
