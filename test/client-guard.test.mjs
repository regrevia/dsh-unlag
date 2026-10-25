import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// The desktop shell reads the startup list once, when the app starts, and replays that same copy
// for every document after that. A plugin swapped since then leaves every script in that copy
// naming a revision the running app no longer serves; the document fails to boot and the desktop
// shell treats that as fatal, which takes every running turn down with it. These cases cover the
// judgement the button makes before it navigates: it must say no on any doubt.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const ok = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
const gone = () => new Response('', { status: 404 })

function harness({ userAgent = 'Mozilla/5.0 (Macintosh) Electron/44.7.0', bridge, frozen, live, scripts = {}, probe = true, prepare } = {}) {
  let registration
  const navigations = []
  const requests = []
  const fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, '')
    requests.push({ path, init })
    if (path.startsWith('/dsh-unlag/graph')) {
      if (live === undefined) return gone()
      return new Response(JSON.stringify({ graph: live }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const answer = scripts[path];
    if (answer === undefined) return gone();
    return answer();
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
check('a held rebuild does not navigate', crashed.navigations.length === 0)

// The same page after the plugin answers the old revision at the current one: safe to rebuild.
const served = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') } })
check('a saved script answered at the current revision lets the rebuild through', (await served.probe.startupLooksServable()) === true)
check('the guard reads every saved script back', served.requests.filter((r) => r.path.startsWith('/plugins/')).length === 2, String(served.requests.filter((r) => r.path.startsWith('/plugins/')).length))

// A plugin removed since the app started leaves a saved entry with nowhere to load from.
const removed = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live: { rev: 'new', entries: [], batches: [] }, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') } })
check('a plugin gone from the running app holds the rebuild', (await removed.probe.startupLooksServable()) === false)

// A saved body that no longer carries the plugin it lists is broken exactly as a 404 is.
const foreign = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('/* somebody else */') } })
check('a saved script missing its plugin holds the rebuild', (await foreign.probe.startupLooksServable()) === false)

// A row the boot code cannot read ends the document just as a missing script does.
const unknownRow = harness({ bridge: bridgeOf([...rows(boot), { kind: 'frame-src', src: 'plugins/??@local/a/client.js&rev=stale' }]), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') } })
check('a saved row of an unknown kind holds the rebuild', (await unknownRow.probe.startupLooksServable()) === false)
const noSource = harness({ bridge: bridgeOf([{ kind: 'script-src', src: '' }, ...rows(boot)]), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') } })
check('a saved script row with no address holds the rebuild', (await noSource.probe.startupLooksServable()) === false)

// A body written as a module never runs as a classic script, so the document that loads it ends.
const moduleBody = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('export function revealAllowed() {}\n/* @local/a */') } })
check('a saved script written as a module holds the rebuild', (await moduleBody.probe.startupLooksServable()) === false)
const compiles = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('(function () { const id = "@local/a" })()') } })
check('a saved script that parses lets the rebuild through', (await compiles.probe.startupLooksServable()) === true)

// A top-level return only parses as a function body, never as a classic script.
const returned = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('return;\n/* @local/a */') } })
check('a saved script with a top-level return holds the rebuild', (await returned.probe.startupLooksServable()) === false)

// Without the running list there is nothing to compare a saved one against, so it is not trusted.
const noLive = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live: null, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') } })
check('a saved list without a served one holds the rebuild', (await noLive.probe.startupLooksServable()) === false)

// --- a page not running inside the desktop shell: the served list is the one it asks -----------
const web = harness({ userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0', frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': () => ok('const id = "@local/a"') } })
check('a page outside the desktop shell asks the served list', (await web.probe.startupLooksServable()) === true)
check('no saved list is read outside the desktop shell', (await web.probe.desktopStartupPayload()) === null)

const webStale = harness({ userAgent: 'Mozilla/5.0 (Macintosh) Firefox/140.0', frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': gone } })
check('a served list that does not load holds the rebuild', (await webStale.probe.startupLooksServable()) === false)

// --- the payload itself: an app that cannot answer is not trusted to be safe -------------------
const broken = harness({ bridge: { ready: async () => { throw new Error('not ready') } }, frozen: boot, live })
check('an app that cannot answer reads as unknown', (await broken.probe.desktopStartupPayload()) === null)
const empty = harness({ bridge: bridgeOf([]), frozen: boot, live })
check('an empty saved list reads as unknown', (await empty.probe.desktopStartupPayload()) === null)

// --- the probe stays out of the shipped plugin surface ---------------------------------------
const plain = harness({ frozen: boot, live, probe: false })
check('the probe is not part of the plugin by default', plain.plugin.probe === undefined)
check('the button still registers through slots', Array.isArray(plain.plugin.inject) && plain.plugin.inject.includes('slots') && typeof plain.plugin.apply === 'function')

// --- the rebuild itself only stamps the address, never a restart ------------------------------
const stamp = harness({ frozen: boot, live })
stamp.probe.reloadFreshPage()
check('a rebuild re-enters the same address', stamp.navigations.length === 1 && stamp.navigations[0].startsWith('http://127.0.0.1:62542/'), stamp.navigations[0])
check('a rebuild asks for a fresh interface', new URL(stamp.navigations[0]).searchParams.get('interface') === 'stale')

// --- the app is there but will not say what the next document boots ---------------------------
// Reading nothing is not evidence the saved list is fine: the shell replays that list for every
// document, so a page that cannot see it must not navigate.
const muteShell = harness({ bridge: { ready: async () => { throw new Error('not ready') } }, frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=new': () => ok('const id = "@local/a"') } })
check('a shell that cannot hand over its list holds the rebuild', (await muteShell.probe.startupLooksServable()) === false)
check('a held rebuild does not navigate', muteShell.navigations.length === 0)
check('a shell that cannot hand over its list reports as blocked', (await muteShell.probe.prepareInterface()) === 'blocked')

// --- work another plugin has not saved yet stops the rebuild ---------------------------------
const vetoed = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') }, prepare: (event) => { event.detail.pending = [Promise.resolve(true)]; event.preventDefault(); return false } })
check('a plugin that refuses the rebuild stops it', (await vetoed.probe.prepareInterface()) === 'unsaved')
check('a refused rebuild does not navigate', vetoed.navigations.length === 0)

const rejected = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') }, prepare: (event) => { event.detail.pending = [Promise.reject(new Error('could not save'))]; return true } })
check('a save that failed stops the rebuild', (await rejected.probe.prepareInterface()) === 'unsaved')

const slowSave = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') }, prepare: (event) => { event.detail.pending = [new Promise(() => {})]; return true } })
check('a save that never settles stops the rebuild', (await slowSave.probe.prepareInterface()) === 'unsaved')

const saved = harness({ bridge: bridgeOf(rows(boot)), frozen: boot, live, scripts: { '/plugins/??@local/a/client.js&rev=stale': () => ok('const id = "@local/a"') }, prepare: (event) => { event.detail.pending = [Promise.resolve(true)]; return true } })
check('a save that landed lets the rebuild through', (await saved.probe.prepareInterface()) === null)

// --- what the app's answer to a replacement means for the rebuild that follows ----------------
const verdict = (value) => saved.probe.reloadVerdict(value)
check('a finished replacement is an update', verdict({ status: 'done' }) === 'done')
check('a replacement the app refused is not an update', verdict({ status: 'failed' }) === 'failed')
check('changed code that needs a restart is not an update', verdict({ status: 'done', pending: ['@local/a'] }) === 'restart')
check('an update in flight is not an update yet', verdict({ status: 'applying' }) === 'applying')
check('an update the app put on hold is not an update', verdict({ status: 'queued' }) === 'queued')
check('an entry the app could not replace is not an update', verdict({ status: 'done', warnings: ['cannot load @local/a'], failedEntries: ['@local/a'] }) === 'failed')
check('a replacement the running page cannot take is not an update', verdict({ status: 'done', restartReason: 'native' }) === 'failed')
check('no answer at all is not an update', verdict(null) === 'failed')

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
