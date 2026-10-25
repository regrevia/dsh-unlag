import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Config, apply, name, inject } from '../index.js'

// Keep the live log readable: this run writes its own.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-test.log')

const verdict = (body) => {
  try {
    return JSON.parse(body).status
  } catch {
    return 'unparseable'
  }
}

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

/** The two switches a page reads out of a state answer; the rest of the answer is diagnostics. */
const switches = (body) => {
  try {
    const { plugins, page } = JSON.parse(body)
    return `${plugins}|${page}`
  } catch {
    return String(body)
  }
}

// --- Config: validation never throws and defaults both switches on -----------------------------
// Cordis reads every key of an object declaration as a required service name, so the declaration
// must stay a plain array: `{ optional: [...] }` leaves the entry waiting forever on "optional".
check(
  'name/inject is a plain service list',
  name === 'dsh-unlag' && Array.isArray(inject) && inject.every((service) => typeof service === 'string'),
  JSON.stringify(inject),
)
check('inject names only real services', inject.length === 1 && inject[0] === 'webServer')
const v = (value) => Config['~standard'].validate(value)
check('validate {} -> both on', JSON.stringify(v({}).value) === '{"reloadPlugins":true,"reloadInterface":true}')
check('validate omitted -> both on', v(undefined).value.reloadPlugins === true)
check('validate null -> both on', v(null).value.reloadInterface === true)
check('validate false sticks', v({ reloadPlugins: false }).value.reloadPlugins === false)
check('validate keeps foreign keys', v({ roots: ['/x'], reloadInterface: false }).value.roots?.[0] === '/x')
check('validate survives a string config', v('nope').value.reloadPlugins === true)
const json = JSON.parse(JSON.stringify(Config.toJSON()))
check('toJSON is a plain document', json.refs?.[6]?.dict?.reloadPlugins === 2)
check('form nodes are objects', Config.dict.reloadPlugins.type === 'boolean' && Config.dict.reloadPlugins.meta.default === true)

// --- routes: registered, answer, and honour the switches --------------------------------------
function fakeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writableEnded = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body += body ?? ''
    res.writableEnded = true
  }
  return res
}

function mount(config, extra = {}) {
  const routes = new Map()
  const disposed = []
  const handlers = {}
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? {
            collectIndexInjections: () => extra.injections ?? [],
            register: (route) => {
              routes.set(route.path, route.handler)
              const dispose = () => routes.delete(route.path)
              disposed.push(dispose)
              return dispose
            },
          }
        : key === 'hmr'
          ? {
              baseDir: '/tmp/unlag-probe-profile',
              runExclusive: async (op) => op(),
              reconcileProfile: async () => {
                handlers.reloads = (handlers.reloads ?? 0) + 1
                return { warnings: [], pending: [] }
              },
            }
          : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handlers.dispose = fn
    },
  }
  apply(ctx, config)
  return { routes, disposed, handlers }
}

const both = mount({})
check('four routes registered', both.routes.size === 4, [...both.routes.keys()].join(','))

const stateRes = fakeRes()
both.routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
check('state GET 200', stateRes.status === 200)
check('state says both on', switches(stateRes.body) === 'true|true', stateRes.body)

const viaGet = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'GET', headers: {} }, viaGet)
check('reload rejects GET', viaGet.status === 405)

const noHeader = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: {} }, noHeader)
check('reload rejects a cross-site post', noHeader.status === 403)

const ok = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, ok)
check('reload runs and reports done', verdict(ok.body) === 'done', ok.body)
check('the hmr service really ran', both.handlers.reloads === 1, String(both.handlers.reloads))

// --- the startup list the next document gets --------------------------------------------------
const noGraph = fakeRes()
both.routes.get('/dsh-unlag/graph')({ method: 'GET' }, noGraph)
check('graph without a module table is empty', noGraph.body === '{"graph":null}', noGraph.body)

const served = { rev: 'r1', entries: [{ id: '@local/a' }, { id: '@local/b' }], batches: [{ url: '/plugins/??@local/a/client.js,@local/b/client.js', entries: ['@local/a', '@local/b'] }] }
const liveMount = mount({}, { injections: [{ kind: 'global', name: '__DSH_BOOT__', value: served }] })
const liveGraph = fakeRes()
liveMount.routes.get('/dsh-unlag/graph')({ method: 'GET' }, liveGraph)
check('graph reports the live startup list', liveGraph.body === JSON.stringify({ graph: served }), liveGraph.body.slice(0, 80))

// --- the press outcome reaches the log ---------------------------------------------------------
const heldRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', url: '/dsh-unlag/report?event=held&gate=unsaved' }, heldRes)
check('report accepts a post', heldRes.status === 200 && heldRes.body === '{"status":"done"}', heldRes.body)
await new Promise((resolve) => setTimeout(resolve, 30))
check('report names the gate that stopped it', readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('rebuild held back: unsaved'))

const reportGet = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'GET' }, reportGet)
check('report rejects GET', reportGet.status === 405)

// --- switches --------------------------------------------------------------------------------
const onlyPage = mount({ reloadPlugins: false })
const offRes = fakeRes()
await onlyPage.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, offRes)
check('switch off -> host does not reload', offRes.body === '{"status":"off"}' && onlyPage.handlers.reloads === undefined)
const onlyPageState = fakeRes()
onlyPage.routes.get('/dsh-unlag/state')({}, onlyPageState)
check('switch off is announced', switches(onlyPageState.body) === 'false|true', onlyPageState.body)

const onlyPlugins = mount({ reloadInterface: false })
const onlyPluginsState = fakeRes()
onlyPlugins.routes.get('/dsh-unlag/state')({}, onlyPluginsState)
check('page off is announced', switches(onlyPluginsState.body) === 'true|false', onlyPluginsState.body)

// --- a turn in progress ----------------------------------------------------------------------
let busyRan = 0
const busyMount = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          runExclusive: async (op) => op(),
          reconcileProfile: async () => {
            busyRan += 1
          },
        }
      if (key === 'agents') return { list: () => [{ status: 'working' }] }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const busyRes = fakeRes()
await busyMount.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, busyRes)
check('a running turn does not hold the press back', verdict(busyRes.body) === 'done' && busyRan === 1, `ran=${busyRan}`)

// A machine whose turns never all go idle still gets the reload once the grace is spent.
let graceRan = 0
const graceRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          runExclusive: async (op) => op(),
          reconcileProfile: async () => {
            graceRan += 1
          },
        }
      if (key === 'agents') return { list: () => [{ status: 'working' }] }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, { idleOnly: true, busyWaitMs: 80 })
  return routes
})()
const graceRes = fakeRes()
await graceRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, graceRes)
await new Promise((resolve) => setTimeout(resolve, 2500))
check('opt-in quiet mode still reloads after the grace', verdict(graceRes.body) === 'queued' && graceRan === 1, `ran=${graceRan}`)


// A swap that collides with another transaction is retried, not reported as a failure.
let nestedTries = 0
const nestedRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          operations: Promise.resolve(),
          runExclusive: async (op) => op(),
          reconcileProfile: async () => {
            nestedTries += 1
            if (nestedTries <= 1) throw new Error('HMR transactions cannot be nested')
            return { warnings: [], pending: [] }
          },
        }
      if (key === 'agents') return { list: () => [] }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const nestedRes = fakeRes()
await nestedRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, nestedRes)
check('a stale transaction refusal still reloads', verdict(nestedRes.body) === 'done' && nestedTries === 2, `tries=${nestedTries}`)
// --- an update the app did not finish applying ------------------------------------------------
// The press must not rebuild the page over a plugin set the app has not finished starting: the
// fresh document would boot plugins that are not ready, and the app ends the document over it.
const outcomeRoutes = (result) => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr') return { baseDir: '/tmp/x', runExclusive: async (op) => op(), reconcileProfile: async () => result }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
}

const unfinished = fakeRes()
const unfinishedRoutes = outcomeRoutes({ pending: ['@local/a'] })
await unfinishedRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, unfinished)
const unfinishedBody = JSON.parse(unfinished.body)
check('an update still starting is not reported done', unfinishedBody.status === 'failed', unfinished.body)
check('an update still starting names what is pending', Array.isArray(unfinishedBody.pending) && unfinishedBody.pending.length === 1, unfinished.body)

const needsRestart = fakeRes()
const restartRoutes = outcomeRoutes({ restartReason: 'native' })
await restartRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, needsRestart)
check('an update the page cannot take is not reported done', JSON.parse(needsRestart.body).status === 'failed', needsRestart.body)

// --- a reload asked for from a context a previous reload left behind ---------------------------
// A watch callback made while a reload was restarting this plugin carries that reload's context;
// the service reads a request from there as a nested one even though the transaction is over. The
// reload leaves that context before queuing, so a save still lands instead of reporting failure.
const inherited = fakeRes()
const inheritedRoutes = (() => {
  const routes = new Map()
  let store = true
  const executing = {
    getStore: () => store,
    exit: (run) => {
      const previous = store
      store = undefined
      try {
        return run()
      } finally {
        store = previous
      }
    },
  }
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          executing,
          runExclusive: (op) => (executing.getStore() ? Promise.reject(new Error('HMR transactions cannot be nested')) : Promise.resolve(op())),
          reconcileProfile: async () => ({ warnings: [], pending: [] }),
        }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
await inheritedRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, inherited)
check('a save from a context an earlier reload left behind still applies', verdict(inherited.body) === 'done', inherited.body)

// --- a reload that never finishes ---------------------------------------------------------------
// The page must not wait forever for an answer, and must not rebuild over a set the app has not
// confirmed, so a stuck update is reported as failed instead of hanging the press.
process.env.DSH_UNLAG_TIMEOUT_MS = '60'
const stuckRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr') return { baseDir: '/tmp/x', runExclusive: () => new Promise(() => {}), reconcileProfile: async () => ({}) }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const stuck = fakeRes()
await stuckRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, stuck)
delete process.env.DSH_UNLAG_TIMEOUT_MS
check('an update that never finishes is reported failed', verdict(stuck.body) === 'failed', stuck.body)

// --- hostile surroundings --------------------------------------------------------------------
let survived = true
try {
  const ctx = { get: () => undefined, on: () => {} }
  apply(ctx, {})
} catch {
  survived = false
}
check('no web server and no hmr is not fatal', survived)

// --- replacing the module twice must not stack routes ----------------------------------------
const first = mount({})
const second = mount({})
check('remount leaves one route set', first.routes.size === 0 && second.routes.size === 4, `${first.routes.size}/${second.routes.size}`)

console.log(out.join('\n'))
console.log(process.exitCode === 1 ? 'FAILURES' : 'ALL PASS')
process.exit(process.exitCode ?? 0)

