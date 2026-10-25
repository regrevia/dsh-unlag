import { AsyncLocalStorage } from 'node:async_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// --- Config: validation never throws, press switches on, automatic reloading off ---------------
// Cordis reads every key of an object declaration as a required service name, so the declaration
// must stay a plain array: `{ optional: [...] }` leaves the entry waiting forever on "optional".
check(
  'name/inject is a plain service list',
  name === 'dsh-unlag' && Array.isArray(inject) && inject.every((service) => typeof service === 'string'),
  JSON.stringify(inject),
)
check('inject names only real services', inject.length === 1 && inject[0] === 'webServer')
const v = (value) => Config['~standard'].validate(value)
check(
  'validate {} -> press on, auto off',
  JSON.stringify(v({}).value) === '{"reloadPlugins":true,"reloadInterface":true,"autoReload":false}',
  JSON.stringify(v({}).value),
)
check('auto reload needs an explicit yes', v({ autoReload: true }).value.autoReload === true)
check('the old off switch still means off', v({ plugins: 'off', autoReload: true }).value.autoReload === false)
check('any other auto value stays off', v({ autoReload: 'yes' }).value.autoReload === false)
check('validate omitted -> both on', v(undefined).value.reloadPlugins === true)
check('validate null -> both on', v(null).value.reloadInterface === true)
check('validate false sticks', v({ reloadPlugins: false }).value.reloadPlugins === false)
check('validate keeps foreign keys', v({ roots: ['/x'], reloadInterface: false }).value.roots?.[0] === '/x')
check('validate survives a string config', v('nope').value.reloadPlugins === true)
const json = JSON.parse(JSON.stringify(Config.toJSON()))
check('toJSON is a plain document', json.refs?.[6]?.dict?.reloadPlugins === 2)
check('toJSON carries the automatic row', json.refs?.[6]?.dict?.autoReload === 7 && json.refs?.[7]?.meta?.default === false)
check('the form row for auto reload defaults off', Config.dict.autoReload.meta.default === false)
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
                if (extra.reloadDelay) await new Promise((resolve) => setTimeout(resolve, extra.reloadDelay))
                return { warnings: (extra.reloadWarnings ?? []).slice(), pending: [] }
              },
            }
          : key === 'clientModules'
            ? extra.clientModules
            : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handlers.dispose = fn
    },
  }
  apply(ctx, config)
  return { routes, disposed, handlers }
}

const both = mount({})
check('five routes registered', both.routes.size === 5, [...both.routes.keys()].join(','))

const stateRes = fakeRes()
both.routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
check('state GET 200', stateRes.status === 200)
check('state says both on', switches(stateRes.body) === 'true|true', stateRes.body)

const verifyGet = fakeRes()
await both.routes.get('/dsh-unlag/verify')({ method: 'GET' }, verifyGet)
check('verify rejects GET', verifyGet.status === 405)
const verifyNoHeader = fakeRes()
await both.routes.get('/dsh-unlag/verify')({ method: 'POST', headers: {} }, verifyNoHeader)
check('verify rejects a press from another page', verifyNoHeader.status === 403)
const verifyOffline = fakeRes()
await both.routes.get('/dsh-unlag/verify')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, verifyOffline)
check('verify without the plugin table answers blocked', verifyOffline.status === 200 && verdict(verifyOffline.body) === 'blocked', verifyOffline.body)

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
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=held&gate=unsaved' }, heldRes)
check('report accepts a post', heldRes.status === 200 && heldRes.body === '{"status":"done"}', heldRes.body)
await new Promise((resolve) => setTimeout(resolve, 30))
check('report names the gate that stopped it', readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('rebuild held back: unsaved'))

const failedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=failed&gate=press' }, failedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a press that failed says so instead of going unrecorded',
  readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('a press ended: failed (press)'),
)

const oddRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=%3Cb%3Ex' }, oddRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'an unknown outcome is written in a shape a forged one cannot forge',
  readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('a press ended: bx'),
)

const namedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=bad58412ac96' }, namedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'the rebuilt line names the page generation that came up',
  readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('(page bad58412ac96)'),
)
const forgedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=%3Cscript%3Ealert(1)' }, forgedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a forged page name cannot put markup in the log', !readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('<script>'))

const plainRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', url: '/dsh-unlag/report?event=mounted&rev=forged1' }, plainRes)
check('report from a page that is not this one is refused', plainRes.status === 403, `${plainRes.status}`)
check(
  'and the refused report leaves no line behind',
  readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('(page forged1)') === false,
)

const reportGet = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'GET' }, reportGet)
check('report rejects GET', reportGet.status === 405)

// --- a sibling plugin that does not come back --------------------------------------------------
const withWarning = mount({}, { reloadWarnings: ['dsh-sibling (dsh-sibling): failed to import: boom'] })
const warnRes = fakeRes()
await withWarning.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://127.0.0.1:62542' } }, warnRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a plugin that did not come back is named in the log', readFileSync(join(tmpdir(), 'dsh-unlag-test.log'), 'utf8').includes('a plugin did not come back: dsh-sibling (dsh-sibling): failed to import: boom'))
check('and the press still reports what it did', verdict(warnRes.body) === 'failed' || warnRes.status === 200, warnRes.body)

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
// The page must not wait forever, and must not rebuild over a set the app has not confirmed. A
// stuck update stays in flight: it is reported as still applying, and another press joins the same
// update instead of starting a second one.
process.env.DSH_UNLAG_TIMEOUT_MS = '60'
let stuckRuns = 0
const stuckRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          runExclusive: () => {
            stuckRuns += 1
            return new Promise(() => {})
          },
          reconcileProfile: async () => ({}),
        }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const stuck = fakeRes()
// The wait's own timer is unref'd, because a live app always has work keeping the loop alive and
// this plugin must never be the reason the process stays up. Hold the loop here for the same reason.
const keepAlive = setInterval(() => {}, 1000)
await stuckRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, stuck)
clearInterval(keepAlive)
check('an update that never finishes is still applying', verdict(stuck.body) === 'applying', stuck.body)
const stuckAgain = fakeRes()
await stuckRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, stuckAgain)
check('another press joins the same update', verdict(stuckAgain.body) === 'applying', stuckAgain.body)
check('an update in flight is started once', stuckRuns === 1, String(stuckRuns))
delete process.env.DSH_UNLAG_TIMEOUT_MS
// That update never finishes, so its state stays in flight: a real app in that state is gone.
// Clearing it here keeps the rest of this file measuring what a later press does on a live app.
const workState = globalThis[Symbol.for('dsh-unlag.work')]
if (workState !== undefined) workState.current = null

// --- the app stops exposing the transaction context by name -------------------------------------
// A later version may move the instance or rename the field. The reload resolves it by type, so a
// save still queues instead of failing as nested.
process.env.DSH_UNLAG_RETRY_MS = '1'
const renamedStore = new AsyncLocalStorage()
const renamedRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return {
          baseDir: '/tmp/x',
          transactions: renamedStore,
          runExclusive: (op) => (renamedStore.getStore() ? Promise.reject(new Error('HMR transactions cannot be nested')) : Promise.resolve(op())),
          reconcileProfile: async () => ({ warnings: [], pending: [] }),
        }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const renamed = fakeRes()
await renamedStore.run(true, () => renamedRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, renamed))
check('a renamed transaction field still queues the reload', verdict(renamed.body) === 'done', renamed.body)

// --- no context at all: the reload is refused and the profile file is never written -----------
// The profile patch file belongs to the user; a comment line in it is not a reliable way to
// re-import a module, and the plugin does not touch that file at all.
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-unlag-profile-'))
const patchFile = join(profileDir, 'cordis.patch.yml')
const originalPatch = 'plugins:\n  dsh-unlag:\n    reloadInterface: true\n'
writeFileSync(patchFile, originalPatch)
const strandedRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'profileContext') return { dir: profileDir }
      if (key === 'hmr') return { baseDir: '/tmp/x', runExclusive: () => Promise.reject(new Error('HMR transactions cannot be nested')), reconcileProfile: async () => ({}) }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const stranded = fakeRes()
await strandedRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, stranded)
check('a save that cannot be queued is reported failed', verdict(stranded.body) === 'failed', stranded.body)
await new Promise((resolve) => setTimeout(resolve, 600))
check('the profile file is left alone', readFileSync(patchFile, 'utf8') === originalPatch, JSON.stringify(readFileSync(patchFile, 'utf8')))

const restartedRoutes = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'profileContext') return { dir: profileDir }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
check('a start does not touch the profile file', readFileSync(patchFile, 'utf8') === originalPatch, JSON.stringify(readFileSync(patchFile, 'utf8')))
delete process.env.DSH_UNLAG_RETRY_MS

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
check('remount leaves one route set', first.routes.size === 0 && second.routes.size === 5, `${first.routes.size}/${second.routes.size}`)

// --- the address a press came from: a browser always sends one -------------------------------
const gate = mount({})
const sameSite = fakeRes()
await gate.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://127.0.0.1:62542' } }, sameSite)
check('a press from this page is allowed', verdict(sameSite.body) === 'done', sameSite.body)
const elsewhere = fakeRes()
await gate.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://evil.example' } }, elsewhere)
check('a press from another site is refused', elsewhere.status === 403, elsewhere.body)
const opaque = fakeRes()
await gate.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'null' } }, opaque)
check('a press from an opaque origin is refused', opaque.status === 403, opaque.body)
const unreadableHeaders = fakeRes()
await gate.routes.get('/dsh-unlag/reload')({ method: 'POST', get headers() { throw new Error('boom') } }, unreadableHeaders)
check('a request whose headers cannot be read is refused', unreadableHeaders.status === 403, unreadableHeaders.body)
check(
  'that refusal says why in the log instead of looking like a normal refusal',
  readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('cannot check where a press came from: boom'),
)
const state = fakeRes()
await gate.routes.get('/dsh-unlag/state')({ method: 'GET', headers: {} }, state)
const stateBody = JSON.parse(state.body)
check('the state names which code this half runs', typeof stateBody.code === 'string' && stateBody.code !== '', String(stateBody.code))
check('the state names the version this half runs', /^\d+\.\d+\.\d+$/u.test(String(stateBody.version)), String(stateBody.version))

const fromOutside = fakeRes()
await gate.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '203.0.113.9:62542' } }, fromOutside)
check('a press addressed from outside this machine is refused', fromOutside.status === 403, fromOutside.body)

// --- a startup row that names a plugin the set no longer has ----------------------------------
// The press asks the table before it rebuilds. The row is answered by the stand-in the route serves
// for a plugin the profile no longer has, so the verdict is a boot that comes up without it, said
// out loud in the log rather than refused.
const goneRows = mount(
  {},
  {
    clientModules: {
      graph: () => ({ rev: 'new', entries: [], batches: [] }),
      fetchBundle: async (request) => {
        const url = String(request?.url ?? request)
        if (!url.includes('&rev=new')) return new Response('', { status: 404 })
        return new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        })
      },
    },
  },
)
const goneRes = fakeRes()
const goneReq = { method: 'POST', headers: { 'x-dsh-unlag': '1' }, on: () => {}, destroy: () => {} }
const listeners = {}
goneReq.on = (event, fn) => {
  ;(listeners[event] ??= []).push(fn)
}
setImmediate(() => {
  for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify({ rows: ['/plugins/??@local/a/client.js&rev=old'] })))
  for (const fn of listeners.end ?? []) fn()
})
await goneRows.routes.get('/dsh-unlag/verify')(goneReq, goneRes)
check('verify accepts a startup row for a plugin the set lost', verdict(goneRes.body) === 'ok', goneRes.body)
check('verify names the plugin the page comes up without', String(goneRes.body).includes('@local/a'), goneRes.body)
check('the log says the app no longer serves it', readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('no longer serves: @local/a'))

// A refused startup check is written down, so a press that stopped can be explained later.
const blockedRows = mount(
  {},
  {
    clientModules: {
      graph: () => ({ rev: 'new', entries: [{ id: '@local/a', url: '/plugins/??@local/a/client.js&rev=new', rev: 'new' }], batches: [] }),
      fetchBundle: async () => new Response('window.__ModuleLoader__.load({ id: "@local/other", factory() {} })', { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
    },
  },
)
const blockedRes = fakeRes()
const blockedReq = { method: 'POST', headers: { 'x-dsh-unlag': '1' }, on: () => {}, destroy: () => {} }
const blockedListeners = {}
blockedReq.on = (event, fn) => {
  ;(blockedListeners[event] ??= []).push(fn)
}
setImmediate(() => {
  for (const fn of blockedListeners.data ?? []) fn(Buffer.from(JSON.stringify({ rows: ['/plugins/??@local/a/client.js&rev=new'] })))
  for (const fn of blockedListeners.end ?? []) fn()
})
await blockedRows.routes.get('/dsh-unlag/verify')(blockedReq, blockedRes)
check('a refused startup check answers blocked', verdict(blockedRes.body) === 'blocked', blockedRes.body)
check('and the reason it refused is written down', readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('a startup check refused the page: register'))

// A slow update must not hold the page's request past the moment it stops waiting, or the press
// would end in "did not finish" while the plugin set is still being replaced.
process.env.DSH_UNLAG_ANSWER_MS = '20'
const slowMount = mount({}, { reloadDelay: 120 })
const slowRes = fakeRes()
const slowBegan = Date.now()
await slowMount.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, slowRes)
const slowTook = Date.now() - slowBegan
check('a slow update answers applying instead of holding the request', verdict(slowRes.body) === 'applying' && slowTook < 100, `${slowRes.body} after ${slowTook}ms`)
await new Promise((resolve) => setTimeout(resolve, 200))
check('and the update it started still runs to the end', slowMount.handlers.reloads === 1, String(slowMount.handlers.reloads))
delete process.env.DSH_UNLAG_ANSWER_MS

console.log(out.join('\n'))
process.exit(process.exitCode ?? 0)


console.log(process.exitCode === 1 ? 'FAILURES' : 'ALL PASS')
