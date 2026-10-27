import { AsyncLocalStorage } from 'node:async_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { Config, apply, name, inject } from '../index.js'

// Keep the live log readable: this run writes its own file in a directory of its own, so a second
// run never reads the first one's lines as if they happened now.
const LOG = join(mkdtempSync(join(tmpdir(), 'dsh-unlag-button-')), 'reload.log')
process.env.DSH_UNLAG_LOG = LOG

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
  v({}).value.reloadPlugins === true && v({}).value.reloadInterface === true && v({}).value.autoReload === false,
  JSON.stringify(v({}).value),
)
// The agent refresh switch is the newest row: off unless a person asked for it.
check(
  'the agent switch is off unless asked',
  v({}).value.agentRefresh === false && v({ agentRefresh: true }).value.agentRefresh === true,
  JSON.stringify(v({ agentRefresh: true }).value),
)
check('auto reload needs an explicit yes', v({ autoReload: true }).value.autoReload === true)
check('the old off switch still means off', v({ plugins: 'off', autoReload: true }).value.autoReload === false)
check('any other auto value stays off', v({ autoReload: 'yes' }).value.autoReload === false)
check('validate omitted -> both on', v(undefined).value.reloadPlugins === true)
check('validate null -> both on', v(null).value.reloadInterface === true)
// A hand-edited config can hold any scalar in a switch row. Only a boolean yes enables one: the
// word "no" must not swap plugin code just because it is not the boolean false.
check('a string switch is off, not on', v({ reloadPlugins: 'no' }).value.reloadPlugins === false)
check('a number switch is off', v({ reloadInterface: 1 }).value.reloadInterface === false)
check('a list switch is off', v({ reloadPlugins: [] }).value.reloadPlugins === false)
check('an empty string switch is off', v({ reloadInterface: '' }).value.reloadInterface === false)
check('a real boolean still works', v({ reloadPlugins: false, reloadInterface: true }).value.reloadInterface === true)
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
                extra.onReconcile?.(extra.entries)
                if (extra.reloadDelay) await new Promise((resolve) => setTimeout(resolve, extra.reloadDelay))
                return { warnings: (extra.reloadWarnings ?? []).slice(), pending: [] }
              },
            }
          : key === 'loader'
            ? { entries: () => (extra.entries ?? [{ id: 'dsh-sibling', state: 2 }]).map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
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
check('seven routes registered', both.routes.size === 7, [...both.routes.keys()].join(','))

const stateRes = fakeRes()
both.routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
check('state GET 200', stateRes.status === 200)
check('state says both on', switches(stateRes.body) === 'true|true', stateRes.body)

for (const [route, method] of [['/dsh-unlag/state', 'POST'], ['/dsh-unlag/state', 'DELETE'], ['/dsh-unlag/graph', 'PUT'], ['/dsh-unlag/graph', 'PATCH']]) {
  const res = fakeRes()
  both.routes.get(route)({ method }, res)
  check(`${route} refuses ${method}`, res.status === 405, `${res.status} ${res.body}`)
}
const stateHead = fakeRes()
both.routes.get('/dsh-unlag/state')({ method: 'HEAD' }, stateHead)
check('state answers HEAD the way a read is asked for', stateHead.status === 200, `${stateHead.status}`)

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
check('report names the gate that stopped it', readFileSync(LOG, 'utf8').includes('rebuild held back: unsaved'))

const failedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=failed&gate=press' }, failedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a press that failed says so instead of going unrecorded',
  readFileSync(LOG, 'utf8').includes('a press ended: failed (press)'),
)

const oddRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=%3Cb%3Ex' }, oddRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'an unknown outcome is written in a shape a forged one cannot forge',
  readFileSync(LOG, 'utf8').includes('a press ended: bx'),
)

const namedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=bad58412ac96' }, namedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'the rebuilt line names the page generation that came up',
  readFileSync(LOG, 'utf8').includes('(page bad58412ac96)'),
)
const bornRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=bad58412ac96&born=1792875929483' }, bornRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a document says which document it is, so two of them are not read as one',
  readFileSync(LOG, 'utf8').includes('(page bad58412ac96, born 1792875929483)'),
)
const navRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=bad58412ac96&born=1792875929484&nav=reload' }, navRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'and how it got here, so a reload is not read as a navigation',
  readFileSync(LOG, 'utf8').includes('(page bad58412ac96, born 1792875929484, nav reload)'),
)
const fromRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=bad58412ac96&born=1792875929485&nav=navigate&from=none' }, fromRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a load the app started says it did not come from this page',
  readFileSync(LOG, 'utf8').includes('(page bad58412ac96, born 1792875929485, nav navigate, from none)'),
)
// One rebuild can report twice. The same document born at the same moment is one event, so the
// second line inside two seconds is not written again.
{
  const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('(page dup1, born 42)')).length
  const before = lines()
  const first = fakeRes()
  liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=dup1&born=42' }, first)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const after = lines() - before
  const second = fakeRes()
  liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=dup1&born=42&nav=reload' }, second)
  await new Promise((resolve) => setTimeout(resolve, 30))
  check('one rebuilt document is written once, not once per reporter', after === 1 && lines() - before === 1, `${after}/${lines() - before}`)
}

const forgedRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=mounted&rev=%3Cscript%3Ealert(1)' }, forgedRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a forged page name cannot put markup in the log', !readFileSync(LOG, 'utf8').includes('<script>'))

const plainRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', url: '/dsh-unlag/report?event=mounted&rev=forged1' }, plainRes)
check('report from a page that is not this one is refused', plainRes.status === 403, `${plainRes.status}`)
check(
  'and the refused report leaves no line behind',
  readFileSync(LOG, 'utf8').includes('(page forged1)') === false,
)

// A press that replaced the plugins and then stopped before rebuilding reports both halves. The
// line has to name the thing that stopped it: the old shape glued the two halves into one word.
const bothRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=held&gate=applied%3Ablocked' }, bothRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a press that applied and then stopped names both halves',
  readFileSync(LOG, 'utf8').includes('rebuild held back: applied then blocked'),
  readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('applied then')).slice(-1).join(''),
)

const junkRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/report?event=held&gate=%3Cimg%20src%3Dx%3Eblocked' }, junkRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'a gate with markup in it cannot put markup in the log',
  readFileSync(LOG, 'utf8').includes('<img') === false,
)

const longRes = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: `/dsh-unlag/report?event=held&gate=${'a'.repeat(200)}` }, longRes)
await new Promise((resolve) => setTimeout(resolve, 30))
const longLine = readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('rebuild held back: aaaa')).slice(-1)[0] ?? ''
check(
  'a gate too long to read is cut, not refused',
  longRes.status === 200 && longLine.length < 120,
  `${longRes.status} ${longLine.length}`,
)

const reportGet = fakeRes()
liveMount.routes.get('/dsh-unlag/report')({ method: 'GET' }, reportGet)
check('report rejects GET', reportGet.status === 405)

// --- a sibling plugin that does not come back --------------------------------------------------
const withWarning = mount({}, { entries: [{ id: 'dsh-sibling', state: 3 }], reloadWarnings: ['dsh-sibling (dsh-sibling): failed to import: boom'] })
const warnRes = fakeRes()
await withWarning.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://127.0.0.1:62542' } }, warnRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check('a plugin that was already not running is named in the log', readFileSync(LOG, 'utf8').includes('a plugin was already not running and still is not: dsh-sibling (dsh-sibling): failed to import: boom'))
// The app rejects a reload that newly breaks an entry, so a leftover inactive entry is not the
// press's result: it is written down, and the press still replaces the set.
check('and it does not turn the press into a failure', verdict(warnRes.body) === 'done', warnRes.body)

// The second press is where a comparison has something to compare with: an entry that was running
// in the last list and is named as failed now is a breakage this update caused, and a page must not
// be rebuilt on top of it.
const warningsNow = ['dsh-sibling (dsh-sibling): failed to import: boom']
const trackingEntries = [{ id: 'dsh-sibling', state: 2 }]
// The second update is the one that breaks the entry: it runs when the update starts and the app
// finds the import gone by the time it settles.
let breakSibling = false
const tracking = mount({}, { entries: trackingEntries, reloadWarnings: warningsNow, onReconcile: () => { if (breakSibling) trackingEntries[0].state = 3 } })
const firstRes = fakeRes()
await tracking.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://127.0.0.1:62542' }, on: () => {}, destroy: () => {} }, firstRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check("a first list of warnings is a baseline, not this press's result", verdict(firstRes.body) === 'done', firstRes.body)
breakSibling = true
warningsNow.push('dsh-new (dsh-new): failed to import: nope')
const secondRes = fakeRes()
await tracking.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62542', origin: 'http://127.0.0.1:62542' }, on: () => {}, destroy: () => {} }, secondRes)
await new Promise((resolve) => setTimeout(resolve, 30))
check('an entry that stops running with this press fails it', verdict(secondRes.body) === 'failed', secondRes.body)
check('and the answer names the entry that stopped', /dsh-new/.test(JSON.stringify(secondRes.body)), secondRes.body)

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

// A failure is retried only when it is the app's own "two updates at once" answer. A path or a
// config key that happens to contain the same word is an ordinary failure: retrying it would run a
// stateful update ten times over one bad file.
let wordTries = 0
const wordRoutes = (() => {
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
            wordTries += 1
            throw new Error('profile/nested/bundle.yml: cannot read the entry list')
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
const wordRes = fakeRes()
await wordRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, wordRes)
check('a failure that only mentions the word is not retried', verdict(wordRes.body) === 'failed' && wordTries === 1, `tries=${wordTries} status=${verdict(wordRes.body)}`)
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
check('an update still starting is not reported done', unfinishedBody.status === 'restart', unfinished.body)
check('an update still starting names what is pending', Array.isArray(unfinishedBody.pending) && unfinishedBody.pending.length === 1, unfinished.body)

const needsRestart = fakeRes()
const restartRoutes = outcomeRoutes({ restartReason: 'native' })
await restartRoutes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, needsRestart)
check('an update the page cannot take is not reported done', JSON.parse(needsRestart.body).status === 'restart', needsRestart.body)

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
check('remount leaves one route set', first.routes.size === 0 && second.routes.size === 7, `${first.routes.size}/${second.routes.size}`)

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
check('verify refuses a startup row for a plugin the set lost', verdict(goneRes.body) === 'blocked', goneRes.body)
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
check('and its late finish is written down', readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('the update finished after the page was told it is still applying'))
delete process.env.DSH_UNLAG_ANSWER_MS

// The state a page reads must match what a press would do: a switch read as off has to show off,
// or the button asks for a replacement the host will refuse.
// What this mount adds, not what an earlier one left: the switch warning is written once per value,
// so a check that only looks for the text cannot tell this mount's line from a stale one.
const beforeStringOff = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8')
const stringOff = mount({ reloadPlugins: 'no' })
const addedByStringOff = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').slice(beforeStringOff.length)
const stringState = fakeRes()
stringOff.routes.get('/dsh-unlag/state')({ method: 'GET' }, stringState)
check('a string switch shows off in the state the page reads', switches(stringState.body) === 'false|true', stringState.body)
const stringPress = fakeRes()
await stringOff.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'http://127.0.0.1:52847' } }, stringPress)
check('and a press on it says the replacement is off', JSON.parse(stringPress.body).status === 'off', stringPress.body)
check(
  'the log names the switch value it could not read as a boolean',
  addedByStringOff.includes('reloadPlugins=no') || readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('reloadPlugins=no'),
  addedByStringOff.slice(-120),
)

// --- a press that arrives while the plugin is being torn down --------------------------------
// A dispose and a press can land together: the press must not start an update for a plugin that has
// already stopped, because nothing would ever finish it and the page would wait on a dead instance.
{
  const stopping = mount({})
  // A request already in flight when teardown lands: the route object is captured first, which is
  // exactly the race this case is about.
  const reloadRoute = stopping.routes.get('/dsh-unlag/reload')
  stopping.handlers.dispose?.()
  const after = fakeRes()
  await reloadRoute({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, after)
  check('a press after teardown is answered, not dropped', after.status === 200, String(after.status))
  check('and it does not claim the code was replaced', verdict(after.body) !== 'done', after.body)
  check('and no update was run for it', stopping.handlers.reloads === undefined, String(stopping.handlers.reloads))
}

// --- what the page reports about the list it booted with --------------------------------------
// The desktop shell freezes the startup list per window, so only the running document knows it.
{
  const reports = mount({})
  const noHeaderBoot = fakeRes()
  await reports.routes.get('/dsh-unlag/boot')({ method: 'POST', headers: {} }, noHeaderBoot)
  check('a boot report from another page is refused', noHeaderBoot.status === 403, String(noHeaderBoot.status))

  const wrongMethod = fakeRes()
  await reports.routes.get('/dsh-unlag/boot')({ method: 'GET', headers: { 'x-dsh-unlag': '1' } }, wrongMethod)
  check('a boot report is a post only', wrongMethod.status === 405, String(wrongMethod.status))

  const empty = fakeRes()
  await reports.routes.get('/dsh-unlag/boot')(
    {
      method: 'POST',
      headers: { 'x-dsh-unlag': '1' },
      on: (event, fn) => {
        if (event === 'end') setImmediate(fn)
      },
      destroy: () => {},
    },
    empty,
  )
  check('a boot report with no list is not stored', JSON.parse(empty.body).status !== 'done', empty.body)

  const told = fakeRes()
  await reports.routes.get('/dsh-unlag/boot')(
    {
      method: 'POST',
      headers: { 'x-dsh-unlag': '1' },
      on: (event, fn) => {
        if (event === 'data') setImmediate(() => fn(Buffer.from(JSON.stringify({ boot: { rev: 'live', entries: 2, batches: [{ url: '/plugins/??@local/a/client.js&rev=live' }] } }))))
        if (event === 'end') setImmediate(fn)
      },
      destroy: () => {},
    },
    told,
  )
  check('a boot report from this page is accepted', JSON.parse(told.body).status === 'done', told.body)
  const carried = fakeRes()
  reports.routes.get('/dsh-unlag/state')({ method: 'GET' }, carried)
  check('and the state route carries it', JSON.parse(carried.body).boot?.rev === 'live', carried.body)
}

// --- the startup snapshot a page boots with ---------------------------------------------------
// The shell freezes the startup list per window, so the bytes behind those addresses are written
// down when the page reports them. A rebuild is then allowed only while the page still runs the
// generation it booted with; otherwise the frozen main and the chunks the shim serves now would be
// two generations in one document.
function bootJson(urls, rev = 'old') {
  return JSON.stringify({ boot: { rev, entries: 1, batches: urls.map((url) => ({ url })) } })
}

async function postJson(route, document) {
  const res = fakeRes()
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { 'x-dsh-unlag': '1' },
    on: (event, fn) => {
      ;(listeners[event] ??= []).push(fn)
    },
    destroy: () => {},
  }
  setImmediate(() => {
    for (const fn of listeners.data ?? []) fn(Buffer.from(document))
    for (const fn of listeners.end ?? []) fn()
  })
  await route(req, res)
  return res
}

/** Answer with the newest frozen record once the capture the report started has settled. */
async function settledBoot(routes) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const res = fakeRes()
    routes.get('/dsh-unlag/state')({ method: 'GET' }, res)
    const body = JSON.parse(res.body)
    if (body.bootSnapshot !== undefined && body.bootSnapshot !== null && body.bootSnapshot.pending !== true) return body.bootSnapshot
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return null
}

const frozenUrl = '/plugins/??@local/a/client.js&rev=old'
let bootGraph = { rev: 'old', entries: [{ id: '@local/a', rev: 'old', url: frozenUrl }], batches: [{ url: frozenUrl, entries: ['@local/a'], rev: 'old' }] }
const booted = mount(
  {},
  {
    clientModules: {
      graph: () => bootGraph,
      fetchBundle: async (request) => {
        const url = String(request?.url ?? request)
        // Only the generation serving now answers, exactly like a real table after a swap.
        if (!url.includes('&rev=new') && !url.includes('&rev=old')) return new Response('', { status: 404 })
        return new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
      },
    },
  },
)
const report = await postJson(booted.routes.get('/dsh-unlag/boot'), bootJson([frozenUrl], 'old'))
check('a page can report the list it booted with', JSON.parse(report.body).status === 'done', report.body)
const frozen = await settledBoot(booted.routes)
check('the report freezes the bytes behind that list', frozen !== null && frozen.complete === true, JSON.stringify(frozen))
check('and records what generation they belong to', frozen?.rev === 'old', JSON.stringify(frozen?.rev))

// The set was replaced after that page booted, but the newer body still registers every id the
// frozen list names: the page rebuilds onto the newer code, which is the update being pressed.
bootGraph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [{ url: '/plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }] }
const sameIdsRes = await postJson(booted.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [frozenUrl] }))
check('a newer body that registers the same ids still rebuilds', verdict(sameIdsRes.body) === 'ok', sameIdsRes.body)

// The newer code dropped an id the frozen body loads while the list itself is unchanged: the
// rebuilt document would require a module nothing registers, so the press is held.
let helperServed = true
const stableGraph = { rev: 'old', entries: [{ id: '@local/a', rev: 'old', url: frozenUrl }], batches: [{ url: frozenUrl, entries: ['@local/a'], rev: 'old' }] }
const renamedBody = mount(
  {},
  {
    clientModules: {
      graph: () => stableGraph,
      fetchBundle: async () =>
        new Response(
          helperServed
            ? 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} }); window.__ModuleLoader__.load({ id: "@local/helper", factory() {} })'
            : 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} })',
          { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } },
        ),
    },
  },
)
await postJson(renamedBody.routes.get('/dsh-unlag/boot'), bootJson([frozenUrl], 'old'))
await settledBoot(renamedBody.routes)
helperServed = false
const renamedRes = await postJson(renamedBody.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [frozenUrl] }))
check('a newer body that drops an id the page loads is held', verdict(renamedRes.body) === 'blocked' && String(renamedRes.body).includes('"boot"'), renamedRes.body)
check('and names the id it no longer registers', String(renamedRes.body).includes('@local/helper'), renamedRes.body)

// The same rule covers the files a plugin loads after boot, not only the ids it registers: a newer
// build that renamed a lazy chunk answers 404 to the page that already runs the older one.
let lazyName = './client.old.js'
const lazyGraph = { rev: 'old', entries: [{ id: '@local/a', rev: 'old', url: frozenUrl }], batches: [{ url: frozenUrl, entries: ['@local/a'], rev: 'old' }] }
const lazyMix = mount(
  {},
  {
    clientModules: {
      graph: () => lazyGraph,
      fetchBundle: async () =>
        new Response(`window.__ModuleLoader__.load({ id: "@local/a", factory() {} }); require.async("${lazyName}")`, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
    },
  },
)
await postJson(lazyMix.routes.get('/dsh-unlag/boot'), bootJson([frozenUrl], 'old'))
await settledBoot(lazyMix.routes)
lazyName = './client.new.js'
const lazyRes = await postJson(lazyMix.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [frozenUrl] }))
check('a newer build that renamed a lazy chunk is held', verdict(lazyRes.body) === 'blocked' && String(lazyRes.body).includes('"boot"'), lazyRes.body)
check('and names the chunk it no longer serves', String(lazyRes.body).includes('client.old.js'), lazyRes.body)

// A record the app could not read is not evidence against the press: the frozen addresses stop
// answering as the set moves on, and a window whose history cannot be read still has no other way
// back. The press then rests on the startup check over the rows the page reported.
let bootCaptureAnswers = false
const unreadable = mount(
  {},
  {
    clientModules: {
      graph: () => stableGraph,
      fetchBundle: async () =>
        bootCaptureAnswers
          ? new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
          : new Response('', { status: 404 }),
    },
  },
)
await postJson(unreadable.routes.get('/dsh-unlag/boot'), bootJson([frozenUrl], 'old'))
const partial = await settledBoot(unreadable.routes)
bootCaptureAnswers = true
check('a script the app could not read leaves the snapshot incomplete', partial !== null && partial.complete === false, JSON.stringify(partial))
const unprovenRes = await postJson(unreadable.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [frozenUrl] }))
check('a rebuild with no complete snapshot rests on the list the page reported', verdict(unprovenRes.body) === 'ok', unprovenRes.body)

// A window that never reported its list is refused by nothing: its rows are checked as before.
const silent = mount(
  {},
  {
    clientModules: {
      graph: () => stableGraph,
      fetchBundle: async () => new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
    },
  },
)
const silentRes = await postJson(silent.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [frozenUrl] }))
check('a window with no startup report can still rebuild', verdict(silentRes.body) === 'ok', silentRes.body)

console.log(out.join('\n'))
process.exit(process.exitCode ?? 0)
