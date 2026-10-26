// The page names its press with a request id. A retry of that same press - because the answer was
// lost on the way, or the page asked again while it was settling - must read the press it already
// made instead of starting the work a second time. Two different presses still both run.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-once-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'once.log')

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

/**
 * A mounted plugin with one satisfying update. `runs` counts how many compositions the app was
 * asked to make, which is exactly what a duplicate press must not increase.
 */
function mount() {
  // Every block below is a fresh app in this process; the record an earlier block left is not this
  // controller's press, so it is cleared before the first press.
  const store = (globalThis[Symbol.for('dsh-unlag.operation')] ??= { id: 0, state: null })
  store.state = null
  globalThis[Symbol.for('dsh-unlag.presses')]?.clear?.()
  const routes = new Map()
  const state = { runs: 0 }
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
        : key === 'hmr'
          ? {
              baseDir: join(HOME, 'profile'),
              runExclusive: async (op) => op(),
              reconcileProfile: async () => {
                state.runs += 1
                return { warnings: [], pending: [] }
              },
            }
          : undefined,
    on: () => {},
  }
  const disposers = []
  ctx.on = (event, fn) => {
    if (event === 'dispose') disposers.push(fn)
  }
  apply(ctx, {})
  return { state, routes, reload: routes.get('/dsh-unlag/reload'), dispose: () => disposers[0]?.() }
}

async function press(route, requestId) {
  const res = {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(body) { this.body += body ?? ''; this.writableEnded = true },
  }
  const url = requestId === undefined ? '/dsh-unlag/reload' : `/dsh-unlag/reload?requestId=${encodeURIComponent(requestId)}`
  await route({ method: 'POST', url, headers: { 'x-dsh-unlag': '1' } }, res)
  return JSON.parse(res.body)
}

// A duplicate of the same press is answered from the record, without a second composition.
{
  const { state, reload } = mount()
  const first = await press(reload, 'press-a')
  const again = await press(reload, 'press-a')
  check('the first press is answered done', first.status === 'done', JSON.stringify(first))
  check('a retry of the same press is answered done too', again.status === 'done', JSON.stringify(again))
  check('a retry names the same operation', first.operationId === again.operationId, `${first.operationId} / ${again.operationId}`)
  check('a retry does not compose the plugin set again', state.runs === 1, String(state.runs))
}

// A different press is a different update and is allowed through.
{
  const { state, reload } = mount()
  const first = await press(reload, 'press-a')
  const second = await press(reload, 'press-b')
  check('a new press is answered done', second.status === 'done', JSON.stringify(second))
  check('a new press gets its own operation', second.operationId !== first.operationId, `${first.operationId} / ${second.operationId}`)
  check('a new press composes the plugin set again', state.runs === 2, String(state.runs))
}

// A press with no request id is never treated as a duplicate of another press.
{
  const { state, reload } = mount()
  await press(reload)
  await press(reload)
  check('a press without a request id is not folded into another', state.runs === 2, String(state.runs))
}

// An update that is still applying is not a finished answer: the retry is told so, and the work is
// left to finish once.
{
  const routes = new Map()
  let release
  let runs = 0
  const hmr = {
    baseDir: join(HOME, 'profile'),
    runExclusive: async (op) => op(),
    reconcileProfile: () => {
      runs += 1
      return new Promise((resolve) => { release = resolve })
    },
  }
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
        : key === 'hmr'
          ? hmr
          : undefined,
    on: () => {},
  }
  apply(ctx, {})
  const reload = routes.get('/dsh-unlag/reload')
  const first = press(reload, 'slow-press')
  // Let the first press start composing, then retry it while it is still in flight.
  await new Promise((resolve) => setTimeout(resolve, 120))
  const again = await press(reload, 'slow-press')
  check('a retry that meets work in flight is told the work is still applying', again.status === 'applying' || again.timeRanOut === true, JSON.stringify(again))
  release({ warnings: [], pending: [] })
  const finished = await first
  check('the in-flight press still finishes done', finished.status === 'done', JSON.stringify(finished))
  check('a retry during the work does not start a second composition', runs === 1, String(runs))
}

// --- a press keeps its own answer after later presses ------------------------------------------
// The newest operation record is overwritten by the next press, so a page that lost the answer to
// its first press and asked again after a second one must still read the first press's result
// instead of being told about the second one or starting a third composition.
const retried = mount()
const firstDone = await press(retried.reload, 'press-one')
const secondDone = await press(retried.reload, 'press-two')
check('a second press is its own composition', retried.state.runs === 2, String(retried.state.runs))
const retriedAgain = await press(retried.reload, 'press-one')
check('a retried old press is answered from its own record', retriedAgain.status === 'done', JSON.stringify(retriedAgain))
check('and it does not compose again', retried.state.runs === 2, String(retried.state.runs))
check('a retried press names the operation it first made', retriedAgain.operationId === firstDone.operationId, `${retriedAgain.operationId} / ${firstDone.operationId}`)
check('the newer press still reads as done', secondDone.status === 'done', JSON.stringify(secondDone))
check('the first press ended as done', firstDone.status === 'done', JSON.stringify(firstDone))

// --- an instance that was replaced stops its own controller ------------------------------------
// Two applies in one process: the older copy is replaced by the newer one, and its dispose hook
// arrives afterwards. It must stop its own work without tearing down what the newer copy installed.
const older = mount()
const newer = mount()
older.dispose()
const afterStale = await press(newer.reload, 'press-after-stale')
check('a stale dispose leaves the newer copy pressing', afterStale.status === 'done', JSON.stringify(afterStale))
check('the newer copy still answers its own state', typeof newer.routes.get('/dsh-unlag/state') === 'function', String(typeof newer.routes.get('/dsh-unlag/state')))

// --- the load line says whether the page can hold unsent text ---------------------------------
const logText = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8')
check('the load line names the composer', /composer: (mounted|no-composer)/.test(logText), logText.slice(0, 300))

console.log(out.join('\n'))
