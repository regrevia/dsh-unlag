// One press, one baseline. A retry asks the app again on the set that can run, but the entry the
// first attempt took down must stay in the verdict: reporting it as "already stopped before the
// press" would answer done for a set this press broke. The record also has to say how many attempts
// it took, so a press that needed a retry can be told apart from one that did not.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-baseline-'))
const LOG = join(HOME, 'baseline.log')
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
  const seenRequired = []
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
          reconcileProfile: async (required) => {
            applies += 1
            seenRequired.push(Array.isArray(required) ? required.slice() : [])
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (rejections > 0) {
              rejections -= 1
              // The app rejects the set after the swap began: the entry the update needed is down.
              const victim = state.find((entry) => entry.id === '@local/a')
              if (victim !== undefined) victim.state = 1
              throw new Error('dsh: warning: 1 entry did not activate @local/a (a): plugin init failed')
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
  return { routes, applies: () => applies, seenRequired: () => seenRequired }
}

async function askJson(routes, path, { method = 'GET' } = {}) {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  const route = routes.get(path.split('?')[0])
  await route({ method, url: path, headers: { 'x-dsh-unlag': '1' } }, res)
  return { status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) }
}

// --- an entry that ran before the press is taken down by the first attempt -------------------
{
  writeFileSync(LOG, '')
  const { routes, applies, seenRequired } = await mount({
    before: [{ id: '@local/a', state: 2 }, { id: '@local/b', state: 2 }],
    rejections: 1,
  })
  const answer = await press(routes)
  await settle(200)
  const body = answer.body
  const text = lines().join('\n')
  check('a press that lost an entry ends failed, not done', body.status === 'failed', JSON.stringify(body))
  check('the lost entry is named as newly failed', Array.isArray(body.newlyFailed) && body.newlyFailed.includes('@local/a'), JSON.stringify(body))
  check('the lost entry is not filed as carried from an earlier press', Array.isArray(body.carriedEntries) && !body.carriedEntries.includes('@local/a'), JSON.stringify(body))
  check('the completion is partial, not full', body.completion === 'partial', JSON.stringify(body))
  check('the record says two attempts were made', body.attempts === 2, JSON.stringify(body))
  check('the page is not rebuilt on a set this press broke', body.rebuild === 'unsafe', JSON.stringify(body))
  check('the second ask left the lost entry out of the required set', applies() === 2 && !seenRequired()[1].includes('@local/a'), JSON.stringify(seenRequired()))
  check('the log says the update left an entry stopped', text.includes('this update left an entry stopped'), text.slice(-400))
}

// --- the same press asked again gets the same evidence, not an empty one ----------------------
{
  const { routes } = await mount({ before: [{ id: '@local/a', state: 2 }], rejections: 1 })
  const first = await press(routes)
  await settle(200)
  const again = await press(routes)
  check('a repeated request id does not start a second update', again.body.status === first.body.status, JSON.stringify(again.body))
  check('the repeated answer keeps the newly failed entry', Array.isArray(again.body.newlyFailed) && again.body.newlyFailed.includes('@local/a'), JSON.stringify(again.body))
  check('the repeated answer keeps the attempt count', again.body.attempts === first.body.attempts, JSON.stringify(again.body))
}

function press(routes) {
  return askJson(routes, '/dsh-unlag/reload?requestId=baseline-1', { method: 'POST' })
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
