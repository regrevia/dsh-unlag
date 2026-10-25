import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { verifyStartupRows } from '../index.js'

// The desktop shell reads the startup list once, when the app starts, and replays that same copy
// for every document after that. A plugin swapped since then leaves every script in that copy
// naming a revision the running app no longer serves; the document fails to boot and the desktop
// shell treats that as fatal, which takes every running turn down with it. These cases cover the
// judgement the button makes before it navigates: it must say no on any doubt.
//
// The page half cannot read a script and know what a script tag will make of it, so it asks the
// host half, which compiles the served bytes with the real parser and checks which plugin ids they
// register. The harness below answers that question with the real host function, so these cases
// measure the contract the page and the host share rather than a copy of it.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const ok = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
const gone = () => new Response('', { status: 404 })
const asPath = (url) => String(url).replace(/^https?:\/\/[^/]+/u, '')
const registered = (id) => `window.__ModuleLoader__.load({ id: "${id}", factory() {} })`

function harness({ userAgent = 'Mozilla/5.0 (Macintosh) Electron/44.7.0', bridge, frozen, live, scripts = {}, probe = true, prepare, verifyAnswer, shimWrapped } = {}) {
  let registration
  const navigations = []
  const requests = []
  const fetch = async (url, init = {}) => {
    const path = asPath(url)
    requests.push({ path, init })
    if (path.startsWith('/dsh-unlag/graph')) {
      if (live === undefined || live === null) return gone()
      return new Response(JSON.stringify({ graph: live }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/state') && shimWrapped !== undefined) {
      return new Response(JSON.stringify({ version: 'test', code: 'test', plugins: true, page: true, shim: { wrapped: shimWrapped } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/verify') && verifyAnswer !== undefined) {
      return new Response(JSON.stringify(verifyAnswer), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/verify')) {
      const asked = JSON.parse(String(init.body ?? '{}'))
      const verdict = await verifyStartupRows(live ?? {}, async (address) => {
        requests.push({ path: asPath(address), init: { method: 'GET', fromHost: true } })
        const answer = scripts[asPath(address)]
        return answer === undefined ? gone() : answer()
      }, Array.isArray(asked.rows) ? asked.rows : [])
      return new Response(JSON.stringify(verdict), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const answer = scripts[path]
    if (answer === undefined) return gone()
    return answer()
  }
  const location = { href: 'http://127.0.0.1:62542/?interface=old', replace: (target) => navigations.push(target) }
  const window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    __DSH_UNLAG_PROBE__: probe,
    __DSH_BOOT__: frozen,
    dshDesktopBoot: bridge,
    sessionStorage: { getItem: () => '0', setItem() {} },
    location,
    dispatchEvent: (event) => {
      // The rebuild announcement is the one event this page raises itself; a stand-in can answer
      // it the way a plugin holding work would.
      if (event?.type === 'dsh-unlag:before' && prepare !== undefined) return prepare(event)
      return true
    },
  }
  const sandbox = {
    window,
    navigator: { language: 'en-US', userAgent },
    location,
    document: { activeElement: null, querySelector: () => null },
    sessionStorage: window.sessionStorage,
    fetch,
    URL,
    Response,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Event,
    CustomEvent,
    JSON,
    RegExp,
  }
  sandbox.globalThis = sandbox
  runInNewContext(source, sandbox)
  const plugin = registration.factory(() => ({ createElement: () => null }))
  return { probe: plugin.probe, plugin, navigations, requests }
}

const rows = (boot, src = 'plugins/??@local/a/client.js&rev=stale') => [
  { kind: 'script-preload', src },
  { kind: 'script-src', src, id: 'queue' },
  { kind: 'global', name: '__DSH_BOOT__', value: boot },
]
const boot = { rev: 'stale', entries: [{ id: '@local/a', rev: 'stale' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=stale', entries: ['@local/a'], rev: 'stale' }] }
const live = { rev: 'new', entries: [{ id: '@local/a', rev: 'new' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }] }
const bridgeOf = (value) => ({ ready: async () => ({ injections: value }) })
const body = registered('@local/a')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

// --- the case that crashed the app: a saved list whose scripts no longer resolve ---------------
const crashed = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': gone } })
check('a saved script the app no longer serves holds the rebuild', (await crashed.probe.startupLooksServable()) === false)
check('the guard asks about the saved list, not the page', crashed.requests.some((r) => r.path === '/plugins/??@local/a/client.js&rev=stale'))
check('a held rebuild reports as blocked', (await crashed.probe.prepareInterface()) === 'blocked')
check('the hold names the script it could not read', crashed.probe.startupHoldReason() === 'script', String(crashed.probe.startupHoldReason()))
check('a held rebuild does not navigate', crashed.navigations.length === 0)

// The same page after the plugin answers the old revision at the current one: safe to rebuild.
const served = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) } })
check('a saved script answered at the current revision lets the rebuild through', (await served.probe.startupLooksServable()) === true)
check('the guard reads every saved script back', served.requests.filter((r) => r.path.startsWith('/plugins/')).length === 2, String(served.requests.filter((r) => r.path.startsWith('/plugins/')).length))
check('the guard asks the host half rather than reading bodies itself', served.requests.some((r) => r.path === '/dsh-unlag/verify' && r.init.method === 'POST'))

// A plugin removed since the app started leaves a saved entry with nowhere to load from.
const removed = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live: { rev: 'new', entries: [], batches: [] }, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) } })
check('a plugin gone from the running app holds the rebuild', (await removed.probe.startupLooksServable()) === false)

// The host stands in for a row whose plugin is gone; the check below reads that row back the same
// way, so a switch-off between the app starting and the press does not disable the button.
const switchedOff = harness({
  bridge: bridgeOf(rows(boot)),
  frozen: boot,
  live: { rev: 'new', entries: [], batches: [] },
  shimWrapped: true,
  scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('/* @local/a is not part of the plugin set served now */') },
})
check('a plugin switched off does not hold the rebuild when the host stands in for it', (await switchedOff.probe.startupLooksServable()) === true, String(switchedOff.probe.startupHoldReason()))
check('and the press asks the host check rather than deciding alone', switchedOff.requests.some((r) => r.path === '/dsh-unlag/verify'))

const noStandIn = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live: { rev: 'new', entries: [], batches: [] }, shimWrapped: false })
check('without a stand-in the switched-off plugin still holds the rebuild', (await noStandIn.probe.startupLooksServable()) === false)

// A saved body that no longer carries the plugin it lists is broken exactly as a 404 is.
const foreign = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('/* somebody else */') } })
check('a saved script missing its plugin holds the rebuild', (await foreign.probe.startupLooksServable()) === false)
check('the hold names the plugin the body does not register', foreign.probe.startupHoldReason() === 'plugin', String(foreign.probe.startupHoldReason()))

// A body that registers a different plugin is as broken as one that registers none.
const wrongId = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(registered('@local/b')) } })
check('a saved script registering another plugin holds the rebuild', (await wrongId.probe.startupLooksServable()) === false)
check('the hold names the plugin a wrong body registers', wrongId.probe.startupHoldReason() === 'plugin', String(wrongId.probe.startupHoldReason()))

// A script that needs a plugin the next document does not carry cannot start it either.
const grew = { rev: 'new', entries: [{ id: '@local/a', rev: 'an' }, { id: '@local/b', rev: 'bn' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=an', entries: ['@local/a'], rev: 'an' }] }
const addedDep = harness({
  bridge: bridgeOf(rows(boot)),
  frozen: boot,
  live: grew,
  scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('window.__ModuleLoader__.load({ id: "@local/a", factory(require) { require("@local/b") } })') },
})
check('a saved script that needs a plugin the list does not name holds the rebuild', (await addedDep.probe.startupLooksServable()) === false)
check('the hold names the plugin the list does not carry', addedDep.probe.startupHoldReason() === 'covers', String(addedDep.probe.startupHoldReason()))

// A row the boot code cannot read ends the document just as a missing script does.
const unknownRow = harness({ bridge: bridgeOf([...rows(boot), { kind: 'frame-src', src: 'plugins/??@local/a/client.js&rev=stale' }]), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) } })
check('a saved row of an unknown kind holds the rebuild', (await unknownRow.probe.startupLooksServable()) === false)
const noSource = harness({ bridge: bridgeOf([{ kind: 'script-src', src: '' }, ...rows(boot)]), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) } })
check('a saved script row with no address holds the rebuild', (await noSource.probe.startupLooksServable()) === false)

// A body written as a module never runs as a classic script, so the document that loads it ends.
const moduleBody = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('export function revealAllowed() {}\n/* @local/a */') } })
check('a saved script written as a module holds the rebuild', (await moduleBody.probe.startupLooksServable()) === false)
check('the hold names the script that does not parse', moduleBody.probe.startupHoldReason() === 'parse', String(moduleBody.probe.startupHoldReason()))
const compiles = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(`(function () {})\n${body}`) } })
check('a saved script that parses lets the rebuild through', (await compiles.probe.startupLooksServable()) === true)

// A top-level return only parses as a function body, never as a classic script.
const returned = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('return;\n/* @local/a */') } })
check('a saved script with a top-level return holds the rebuild', (await returned.probe.startupLooksServable()) === false)

// A return inside a callback is ordinary code. Reading every `}` before a `return` as a top-level
// one refused every real bundle the app serves, which held the rebuild while nothing was wrong.
const nested = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(`(function () {\n  const bytes = [7];\n  const hex = bytes.map((byte) => {\n    return byte.toString(16)\n  })\n  return hex\n})()\n${body}`) } })
check('a return inside a callback does not hold the rebuild', (await nested.probe.startupLooksServable()) === true, String(nested.probe.startupHoldReason()))
// A pattern that mentions the keyword is not a return either.
const pattern = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(`const re = /[}]\\s*return/\nif (re.test("a")) { console.log("a") }\n${body}`) } })
check('a pattern holding the keyword does not hold the rebuild', (await pattern.probe.startupLooksServable()) === true, String(pattern.probe.startupHoldReason()))

// Without the running list there is nothing to compare a saved one against, so it is not trusted.
const noLive = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live: null, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) } })
check('a saved list without a served one holds the rebuild', (await noLive.probe.startupLooksServable()) === false)
check('the hold names the plugin list it could not read', noLive.probe.startupHoldReason() === 'graph', String(noLive.probe.startupHoldReason()))
check('a passing check leaves no reason behind', (await compiles.probe.startupLooksServable()) === true && compiles.probe.startupHoldReason() === null, String(compiles.probe.startupHoldReason()))

// --- a page not running inside the desktop shell: the served list is the one it asks -----------
const web = harness({ userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0', frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': () => ok(body) } })
check('a page outside the desktop shell asks the served list', (await web.probe.startupLooksServable()) === true)
check('no saved list is read outside the desktop shell', (await web.probe.desktopStartupPayload()) === null)

const webStale = harness({ userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0', frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': gone } })
check('a served list that does not load holds the rebuild', (await webStale.probe.startupLooksServable()) === false)

// --- the payload itself: an app that cannot answer is not trusted to be safe -------------------
const broken = harness({ bridge: { ready: async () => { throw new Error('not ready') } }, frozen: boot, live })
check('an app that cannot answer reads as unknown', (await broken.probe.desktopStartupPayload()) === null)
const empty = harness({ bridge: bridgeOf([]), frozen: boot, live })
check('an empty saved list reads as unknown', (await empty.probe.desktopStartupPayload()) === null)

// --- the host verdict itself, on the real function the route calls ----------------------------
const read = (text) => async () => ok(text)
const row = ['/plugins/??@local/a/client.js&rev=stale']
const verdictOk = await verifyStartupRows(live, read(body), row)
check('the host verdict passes a body that registers the plugin it lists', verdictOk.status === 'ok', JSON.stringify(verdictOk))
check('the verdict names the revision it read', verdictOk.revision === 'new', String(verdictOk.revision))
check('the verdict carries a digest of the served bytes', verdictOk.scripts?.[0]?.digest === createHash('sha256').update(body).digest('hex').slice(0, 16), JSON.stringify(verdictOk.scripts))

const verdictMissing = await verifyStartupRows(live, async () => gone(), row)
check('a script the table does not serve is blocked as missing', verdictMissing.status === 'blocked' && verdictMissing.reason === 'missing', JSON.stringify(verdictMissing))

const verdictEmpty = await verifyStartupRows(live, read(''), row)
check('an empty script is blocked', verdictEmpty.status === 'blocked' && verdictEmpty.reason === 'empty', JSON.stringify(verdictEmpty))

const verdictParse = await verifyStartupRows(live, read('export function f() {}'), row)
check('a module body is blocked by the real parser', verdictParse.status === 'blocked' && verdictParse.reason === 'parse', JSON.stringify(verdictParse))

const verdictRegister = await verifyStartupRows(live, read(registered('@local/b')), row)
check('a body that registers another plugin is blocked', verdictRegister.status === 'blocked' && verdictRegister.reason === 'register', JSON.stringify(verdictRegister))

const verdictComment = await verifyStartupRows(live, read('/* @local/a */'), row)
check('a comment mentioning the plugin is not a registration', verdictComment.status === 'blocked' && verdictComment.reason === 'register', JSON.stringify(verdictComment))

const grewRows = [{ id: '@local/a', rev: 'an' }, { id: '@local/b', rev: 'bn' }]
const verdictDependency = await verifyStartupRows({ rev: 'new', entries: grewRows }, read('window.__ModuleLoader__.load({ id: "@local/a", factory(require) { require("@local/b") } })'), row)
check('a script that requires a plugin outside the list is blocked', verdictDependency.status === 'blocked' && verdictDependency.reason === 'dependencies', JSON.stringify(verdictDependency))

// One request must not become unbounded work on the process that owns every running turn.
let reads = 0
const manyRows = 'plugins/??@local/a/client.js&rev=live'
const bounded = await verifyStartupRows(live, async () => {
  reads += 1
  return read(body)()
}, Array.from({ length: 200 }, () => manyRows))
check('a list far longer than a startup list is read only up to the bound', reads === 64, `${reads} reads`)
check('and it still answers instead of failing', bounded.status === 'ok', JSON.stringify(bounded).slice(0, 120))
let longReads = 0
const tooLong = await verifyStartupRows(live, async () => {
  longReads += 1
  return read(body)()
}, [`plugins/??@local/a/client.js&rev=live&pad=${'x'.repeat(5000)}`])
check('an address too long to be a startup script is not read', longReads === 0, `${longReads} reads`)
check('and the list it leaves is empty, not silently approved', tooLong.status === 'blocked' && tooLong.reason === 'list', JSON.stringify(tooLong))

const verdictList = await verifyStartupRows(live, read(body), [])
check('a list that names no script is blocked', verdictList.status === 'blocked' && verdictList.reason === 'list', JSON.stringify(verdictList))

const verdictNetwork = await verifyStartupRows(live, async () => { throw new Error('no route') }, row)
check('a script that cannot be read at all is blocked', verdictNetwork.status === 'blocked' && verdictNetwork.reason === 'network', JSON.stringify(verdictNetwork))

// --- the rebuild itself only stamps the address, never a restart ------------------------------
const stamp = harness({ frozen: boot, live })
stamp.probe.reloadFreshPage()
check('a rebuild re-enters the same address', stamp.navigations.length === 1 && stamp.navigations[0].startsWith('http://127.0.0.1:62542/'), stamp.navigations[0])
check('a rebuild asks for a fresh interface', new URL(stamp.navigations[0]).searchParams.get('interface') === 'stale')

// --- the app is there but will not say what the next document boots ---------------------------
// Reading nothing is not evidence the saved list is fine: the shell replays that list for every
// document, so a page that cannot see it must not navigate.
const muteShell = harness({ bridge: { ready: async () => { throw new Error('not ready') } }, frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': () => ok(body) } })
check('a shell that cannot hand over its list holds the rebuild', (await muteShell.probe.startupLooksServable()) === false)
check('a held rebuild does not navigate', muteShell.navigations.length === 0)
check('a shell that cannot hand over its list reports as blocked', (await muteShell.probe.prepareInterface()) === 'blocked')

// --- work another plugin has not saved yet stops the rebuild ---------------------------------
const vetoed = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) }, prepare: (event) => { event.detail.pending = [Promise.resolve(true)]; event.preventDefault(); return false } })
check('a plugin that refuses the rebuild stops it', (await vetoed.probe.prepareInterface()) === 'unsaved')
check('a refused rebuild does not navigate', vetoed.navigations.length === 0)

const rejected = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) }, prepare: (event) => { event.detail.pending = [Promise.reject(new Error('could not save'))]; return true } })
check('a save that failed stops the rebuild', (await rejected.probe.prepareInterface()) === 'unsaved')

const slowSave = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) }, prepare: (event) => { event.detail.pending = [new Promise(() => {})]; return true } })
check('a save that never settles stops the rebuild', (await slowSave.probe.prepareInterface()) === 'unsaved')

const saved = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) }, prepare: (event) => { event.detail.pending = [Promise.resolve(true)]; return true } })
check('a save that landed lets the rebuild through', (await saved.probe.prepareInterface()) === null)

// --- the probe stays out of the shipped plugin surface ---------------------------------------
const plain = harness({ frozen: boot, live, probe: false })
check('the probe is not part of the plugin by default', plain.plugin.probe === undefined)
check('the button still registers through slots', Array.isArray(plain.plugin.inject) && plain.plugin.inject.includes('slots') && typeof plain.plugin.apply === 'function')

// --- what the app's answer to a replacement means for the rebuild that follows ----------------
const verdictOf = (value) => saved.probe.reloadVerdict(value)
check('a finished replacement is an update', verdictOf({ status: 'done' }) === 'done')
check('a replacement the app refused is not an update', verdictOf({ status: 'failed' }) === 'failed')
check('changed code that needs a restart is not an update', verdictOf({ status: 'done', pending: ['@local/a'] }) === 'restart')
check('an update in flight is not an update yet', verdictOf({ status: 'applying' }) === 'applying')
check('an update the app put on hold is not an update', verdictOf({ status: 'queued' }) === 'queued')
check('an entry the app could not replace is not an update', verdictOf({ status: 'done', warnings: ['cannot load @local/a'], failedEntries: ['@local/a'] }) === 'failed')
check('a replacement the running page cannot take is not an update', verdictOf({ status: 'done', restartReason: 'native' }) === 'failed')
check('no answer at all is not an update', verdictOf(null) === 'failed')

// A startup check that ran out of time is its own reason: the notice must not claim a script was
// unreadable when the list simply answered too slowly.
const slowCheck = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok(body) }, verifyAnswer: { status: 'blocked', reason: 'slow', detail: 'the startup list took longer than this check waits' } })
check('a slow startup check holds the rebuild', (await slowCheck.probe.prepareInterface()) === 'blocked')
check('the hold is named for what happened', slowCheck.probe.startupHoldReason() === 'slow', String(slowCheck.probe.startupHoldReason()))
check('and the notice says the list answered too slowly', String(slowCheck.probe.noticeFor('blocked')).includes('too slowly'), String(slowCheck.probe.noticeFor('blocked')))

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
