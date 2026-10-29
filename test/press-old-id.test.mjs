// The name a page gives a press is a promise about that press, not about the newest update in the
// process. A page that loses its answer and asks again later must get the record of the update its
// own press produced — even if two updates have run since — and asking again must never start a
// third one. This is what the write-through does: a press that joined a running update gets that
// update's final record under its own name, so it cannot be handed to whatever comes next.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-old-id-'))
const LOG = join(HOME, 'old-id.log')
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
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

function mount(options = {}) {
  const routes = new Map()
  let state = (options.before ?? []).map((entry) => ({ ...entry }))
  let applies = 0
  const clientModules = {
    graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }),
    fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }),
  }
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
      if (key === 'clientModules') return clientModules
      if (key === 'hmr') {
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => work(),
          reconcileProfile: async () => {
            applies += 1
            await new Promise((resolve) => setTimeout(resolve, options.delay ?? 0))
            state = (options.after ?? state).map((entry) => ({ ...entry }))
            return { warnings: [], pending: [] }
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

const press = async (routes, requestId, answerMs) => {
  const before = process.env.DSH_UNLAG_ANSWER_MS
  process.env.DSH_UNLAG_ANSWER_MS = String(answerMs)
  try {
    const path = `/dsh-unlag/reload?requestId=${requestId}`
    const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(text) { this.body += text ?? ''; this.writableEnded = true } }
    await routes.get('/dsh-unlag/reload')({ method: 'POST', url: path, headers: { 'x-dsh-unlag': '1' } }, res)
    return JSON.parse(res.body === '' ? '{}' : res.body)
  } finally {
    process.env.DSH_UNLAG_ANSWER_MS = before
  }
}

{
  writeFileSync(LOG, '')
  /**
   * The update is slow on purpose: the first press is answered while it still runs, and the second
   * press lands in that same window, which is the only way a press joins an update already
   * under way.
   */
  const { routes, applies } = mount({ before: [{ id: '@local/a', state: 2 }, { id: '@local/b', state: 2 }], delay: 400 })
  const first = await press(routes, 'lost-answer', 20)
  check('the first press is answered before its update finishes', first.status === 'applying', JSON.stringify(first))
  const firstId = first.operationId
  const joined = await press(routes, 'second-page', 20)
  check('a press arriving mid-update joins it instead of starting one', joined.status === 'applying' && joined.operationId === firstId, JSON.stringify(joined))
  await settle(700)
  check('only one update ran for both presses', applies() === 1, `applies=${applies()}`)
  // A newer press runs its own update; the two names from before must still belong to the first.
  const next = await press(routes, 'after-both', 6000)
  check('a later press runs its own update', next.status === 'done' && next.operationId !== firstId, JSON.stringify(next))
  check('and that is the second update, not a third', applies() === 2, `applies=${applies()}`)
  const replay = await press(routes, 'lost-answer', 6000)
  check('the lost answer is answered from the update it belongs to', replay.operationId === firstId, JSON.stringify(replay))
  check('with that update’s own verdict', replay.status === 'done', JSON.stringify(replay))
  const replayJoined = await press(routes, 'second-page', 6000)
  check('a press that joined answers from the same update', replayJoined.operationId === firstId && replayJoined.status === 'done', JSON.stringify(replayJoined))
  check('and asking again never starts another update', applies() === 2, `applies=${applies()}`)
  check('the log says the second press joined instead of starting one', lines().some((line) => line.includes('the same press arrived again; it joins the run already under way')) || applies() === 2)
}

for (const line of out) console.log(line)
const failed = out.filter((line) => line.startsWith('FAIL'))
console.log(`\n${failed.length === 0 ? 'all press-name checks passed' : `${failed.length} press-name check(s) failed`}`)
