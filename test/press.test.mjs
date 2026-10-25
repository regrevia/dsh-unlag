import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// A press is the one action this plugin exists for, and it runs in a page that can go away at any
// moment. These cases drive the real button handler in a sandbox: the press must end in exactly one
// of three ways (one navigation, one notice, or one honest hold), it must never run twice at once,
// and no answer from the app may leave the button grey.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    this.cancelable = init.cancelable === true
    this.detail = init.detail
    this.defaultPrevented = false
    this.returnValue = true
  }
  preventDefault() {
    this.defaultPrevented = true
    this.returnValue = false
  }
}

const rows = [
  { kind: 'script-preload', src: 'plugins/??@local/a/client.js&rev=live' },
  { kind: 'script-src', src: 'plugins/??@local/a/client.js&rev=live', id: 'queue' },
]
const graph = { rev: 'live', entries: [{ id: '@local/a', rev: 'live' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=live', entries: ['@local/a'], rev: 'live' }] }
const body = 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} })'

/** Encode a notice the handler showed; the component is re-rendered for every state change. */
function show(tree) {
  const pill = tree.children?.find((child) => child !== null && typeof child === 'object' && child.props?.role === 'status')
  return pill === undefined ? null : String(Array.isArray(pill.children) ? pill.children.join('') : pill.children)
}

function harness({ settings = { plugins: true, page: true }, reload = { status: 'done' }, scripts = {}, openWindow = false, brokenSelector = false, stamp = '0', hold, answers = null, reportAnswers = [], revAfterReload, codeAfterReload, bootRows = rows, storageThrows = false, href } = {}) {
  const requests = []
  const navigations = []
  const current = { rev: graph.rev, code: 'c1' }
  let reloadBody = reload
  let reloadAnswer = null
  const reloads = []
  const location = {
    href: href ?? 'http://127.0.0.1:62542/?interface=live',
    replace: (target) => navigations.push(String(target)),
    reload: () => reloads.push(1),
  }
  const fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, '')
    requests.push({ path, init })
    if (path.startsWith('/dsh-unlag/state')) {
      if (settings === null) return new Response('', { status: 503 })
      return new Response(JSON.stringify({ ...settings, code: current.code }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/reload')) {
      if (revAfterReload !== undefined) current.rev = revAfterReload
      if (codeAfterReload !== undefined) current.code = codeAfterReload
      if (reloadAnswer !== null) await reloadAnswer
      if (reloadBody instanceof Error) throw reloadBody
      return new Response(JSON.stringify(reloadBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/graph')) {
      return new Response(JSON.stringify({ graph: current.rev === graph.rev ? graph : { ...graph, rev: current.rev } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/verify')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path.startsWith('/dsh-unlag/report')) {
      const next = reportAnswers.shift()
      if (next === undefined) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      if (next === 0) throw new Error('the route was not listening')
      return new Response('{}', { status: next, headers: { 'content-type': 'application/json' } })
    }
    const answer = scripts[path]
    if (answer === undefined) return new Response('', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } })
  }
  const document = {
    activeElement: null,
    querySelector: () => {
      if (brokenSelector) throw new Error('selector blew up')
      return openWindow ? {} : null
    },
  }
  const store = new Map()
  const listeners = []
  const window = {
    __ModuleLoader__: { load: () => {} },
    __DSH_BOOT__: graph,
    dshDesktopBoot: { ready: async () => ({ injections: bootRows }) },
    sessionStorage: { getItem: (key) => (store.has(key) ? store.get(key) : stamp), setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
    location,
    dispatchEvent: (event) => {
      listeners.push(event.type)
      /**
       * The browser runs `window.onbeforeunload` for a dispatched beforeunload and, when it returns
       * a message, copies that message into `returnValue`. The stand-in does the same so a test can
       * ask the question the page really asks.
       */
      if (event.type === 'beforeunload' && typeof window.onbeforeunload === 'function') {
        const answer = window.onbeforeunload(event)
        if (typeof answer === 'string' && answer !== '') event.returnValue = answer
      }
      if (typeof hold === 'function') hold(event)
      return true
    },
  }
  if (answers !== null) window.onbeforeunload = () => answers
  // The component talks to React through hooks; this stand-in runs a render, keeps state across
  // renders, and hands back the last tree so a notice can be read the way a person reads it.
  let hooks = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const slot = cursor
      cursor += 1
      if (slot >= hooks.length) hooks.push(typeof initial === 'function' ? initial() : initial)
      return [hooks[slot], (next) => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next }]
    },
    useEffect() {},
  }
  // A wait the page arms for later is recorded instead of run: a test drives it by hand.
  const scheduled = []
  const setTimeoutStub = (fn, ms) => {
    scheduled.push({ fn, ms })
    if (ms >= 6000) return 0
    return setTimeout(fn, ms)
  }
  const sandbox = {
    window,
    navigator: { language: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0' },
    location,
    document,
    fetch,
    URL,
    Response,
    console,
    setTimeout: setTimeoutStub,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Event: FakeEvent,
    CustomEvent: FakeEvent,
  }
  // Some profiles deny the store outright: reading it throws rather than answering null.
  if (storageThrows) {
    Object.defineProperty(sandbox, 'sessionStorage', { get() { throw new Error('storage denied') } })
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage denied') } })
  } else {
    sandbox.sessionStorage = window.sessionStorage
  }
  sandbox.globalThis = sandbox

  let Component = null
  const slots = {
    inject: (_name, register) => register(),
    register: (_config, component) => {
      Component = component
      return component
    },
  }
  const registration = { factory: null }
  sandbox.window.__ModuleLoader__.load = (value) => { registration.factory = value.factory }
  runInNewContext(`'use strict';\n${source}`, sandbox)
  const plugin = registration.factory(() => React)
  plugin.apply({ slots })

  const render = () => {
    cursor = 0
    const tree = Component()
    const find = (node) => {
      if (node === null || typeof node !== 'object') return null
      if (typeof node.props?.onClick === 'function') return node.props.onClick
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const found = find(child)
        if (found !== null) return found
      }
      return null
    }
    const button = (function walk(node) {
      if (node === null || typeof node !== 'object') return null
      if (node.type === 'button') return node
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const found = walk(child)
        if (found !== null) return found
      }
      return null
    })(tree)
    return { tree, onClick: find(tree), button }
  }

  const press = async () => {
    const view = render()
    await view.onClick()
    return render()
  }

  return {
    press,
    render,
    requests,
    navigations,
    listeners,
    settings,
    scheduled,
    reloads,
    /** Release a /reload that is being held open, to model a slow app. */
    release: () => { reloadAnswer = null },
    holdReload: () => { reloadAnswer = new Promise((resolve) => { setImmediate(resolve) }) },
    setReload: (value) => { reloadBody = value },
    notice: () => show(render().tree),
    /** Whether this press left a pacing stamp behind, and what it says. */
    stamp: () => (store.has('dsh-unlag:at') ? Number(store.get('dsh-unlag:at')) : 0),
  }
}

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const count = (requests, piece) => requests.filter((request) => request.path.startsWith(piece)).length

// --- a plain press: replace the plugins, prove the next page boots, then navigate once ---------
{
  const page = harness()
  await page.press()
  check('a press asks the app to replace plugins once', count(page.requests, '/dsh-unlag/reload') === 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('a press proves the next page boots before leaving', count(page.requests, '/dsh-unlag/verify') === 1)
  check('a press navigates exactly once', page.navigations.length === 1, String(page.navigations.length))
  check('the new page keeps the address it already had', page.navigations[0]?.includes('interface=live') === true, String(page.navigations[0]))
  check('a press writes its outcome to the app log', page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('event=rebuild')))
  check(
    'that line says which page generation came up',
    page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('&rev=live')),
  )
  check('a plain press shows nothing to fix', page.notice() === null, String(page.notice()))
}

// --- a page that holds the navigation must not leave the button waiting forever ----------------
{
  const page = harness()
  await page.press()
  const wait = page.scheduled.find((entry) => entry.ms === 6000)
  check('a rebuild arms a way back for a navigation the page holds', wait !== undefined, JSON.stringify(page.scheduled.map((entry) => entry.ms)))
  wait.fn()
  const view = page.render()
  check('a held navigation leaves the button usable', view.button.props.style.opacity === 0.75, String(view.button.props.style.opacity))
  check('a held navigation says the page did not rebuild', /page did not rebuild/.test(String(page.notice())), String(page.notice()))
  // The notice may only claim the plugins changed when this press really replaced them.
  check('a held navigation says the code went live too', /Plugin code updated/.test(String(page.notice())), String(page.notice()))
  check('a held navigation says why', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('gate=navigation')))
}

// --- a handler that answers with a message is a page that holds the navigation -----------------
// `event.returnValue = false` was the only shape checked, so a plugin that says "unsaved work" by
// returning a message was judged ready: the press navigated and the browser asked over its head.
{
  const page = harness({ answers: 'unsaved work' })
  await page.press()
  check('a handler that answers with a message keeps the page', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('and the press says why it stayed', /Unsaved changes; save them, then retry/u.test(String(page.notice())), String(page.notice()))
  check('and leaves the button usable', page.render().button.props.style.opacity === 0.75, String(page.render().button.props.style.opacity))
}

// --- a page-only press that holds the navigation must not claim the code changed ----------------
{
  const page = harness({ settings: { plugins: false, page: true } })
  await page.press()
  const wait = page.scheduled.find((entry) => entry.ms === 6000)
  wait.fn()
  check('a page-only press that held says only that the page stayed', String(page.notice()) === 'The page did not rebuild; press again shortly', String(page.notice()))
  check('a page-only press that held leaves the button usable', page.render().button.props.style.opacity === 0.75)
}

// --- both switches off: the press says so instead of doing nothing -----------------------------
{
  const page = harness({ settings: { plugins: false, page: false } })
  const view = await page.press()
  check('both switches off touches nothing', count(page.requests, '/dsh-unlag/reload') === 0 && page.navigations.length === 0)
  check('both switches off says what to do', /Both switches are off/.test(String(page.notice())), String(page.notice()))
  check('both switches off leaves the button pressable', view.tree !== null)
}

// --- the plugin half alone: it says the code is live and the page stays ------------------------
{
  const page = harness({ settings: { plugins: true, page: false } })
  await page.press()
  check('plugin-only press replaces the plugins', count(page.requests, '/dsh-unlag/reload') === 1)
  check('plugin-only press does not navigate', page.navigations.length === 0)
  check('plugin-only press says the code is live', /Plugin code updated/.test(String(page.notice())), String(page.notice()))
}

// --- a press already answered a moment ago does not run twice ---------------------------------
{
  const page = harness({ stamp: String(Date.now()) })
  await page.press()
  check('a repeated press asks nothing', count(page.requests, '/dsh-unlag/state') === 0 && page.navigations.length === 0)
  check('a repeated press explains itself', /Still applying/.test(String(page.notice())), String(page.notice()))
}

// --- two presses at once: the second joins the first instead of starting another --------------
{
  const page = harness()
  page.holdReload()
  const first = page.press()
  const second = page.press()
  await new Promise((resolve) => setImmediate(resolve))
  check('the press that joined says the update is still running', /Still applying/.test(String(page.notice())), String(page.notice()))
  page.release()
  await Promise.all([first, second])
  check('two presses in one moment replace plugins once', count(page.requests, '/dsh-unlag/reload') === 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('two presses in one moment navigate once', page.navigations.length === 1, String(page.navigations.length))
}

// --- a line written while the route is being replaced ------------------------------------------
const swapped = harness({ reload: { status: 'done' }, reportAnswers: [404, 0] })
await swapped.press()
await new Promise((resolve) => setTimeout(resolve, 1500))
const reports = swapped.requests.filter((request) => request.path.includes('/dsh-unlag/report'))
check('a line written during the swap is written again until the route answers', reports.length >= 3, `${reports.length} lines`)
check('and the pressed page still rebuilt', swapped.navigations.length === 1, swapped.navigations.length)

// --- the app reports the change as still starting: no page is built on it --------------------
{
  const page = harness({ reload: { status: 'queued' } })
  await page.press()
  check('a queued update keeps the page', page.navigations.length === 0)
  check('a queued update says to press again', /queued/.test(String(page.notice())), String(page.notice()))
  check('a queued update is logged with its reason', page.requests.some((request) => request.path.includes('event=plugin-held') && request.path.includes('gate=queued')))
}

// --- the app did not answer at all: the press ends, the button comes back --------------------
{
  const page = harness({ reload: new Error('app did not answer') })
  await page.press()
  check('an unanswered replacement keeps the page', page.navigations.length === 0)
  check('an unanswered replacement says it did not finish', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('an unanswered replacement is logged', page.requests.some((request) => request.path.includes('event=plugin-held')))
}

// --- the replacement answer is lost, but the set did change ------------------------------------
{
  const page = harness({ reload: new Error('the route was replaced while it answered'), revAfterReload: 'next' })
  await page.press()
  check('a lost answer is not a failed replacement when the set changed', page.navigations.length === 1, String(page.navigations.length))
  check('and the press is logged as a rebuild', page.requests.some((request) => request.path.includes('event=rebuild')))
  check('and the notice never says it did not finish', !/did not finish/.test(String(page.notice())))
}

// --- a lost answer where only the code changed ----------------------------------------------
// Replacing a plugin whose served bundles keep the same revision leaves the boot list unchanged, so
// the graph cannot show that the press worked; the code stamp can, and the press must use it rather
// than tell the user it did not finish.
{
  const page = harness({ reload: new Error('the route was replaced while it answered'), codeAfterReload: 'c2', settings: { plugins: true, page: false } })
  await page.press()
  check('a lost answer is a finished replacement when the code changed', page.requests.some((request) => request.path.includes('event=replaced')), page.requests.map((r) => r.path).join(' '))
  check('and the press does not say it did not finish', !/did not finish/.test(String(page.notice())), String(page.notice()))
  check('and nothing navigates when only the code was asked for', page.navigations.length === 0, String(page.navigations.length))
}

// --- plugins replaced, page held: the notice says what did happen ----------------------------
{
  const page = harness({ openWindow: true })
  await page.press()
  check('an open window keeps the page', page.navigations.length === 0)
  check('an applied update says the plugins are live', /Plugins updated; the page stayed/.test(String(page.notice())), String(page.notice()))
  check('an applied hold is logged as applied', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('applied%3Adialog')))
}

// --- the switches cannot be read: the press must not claim an update it never made ------------
{
  const page = harness({ settings: null })
  await page.press()
  check('unreadable switches leave the page alone', page.navigations.length === 0, String(page.navigations.length))
  check('unreadable switches ask no replacement', count(page.requests, '/dsh-unlag/reload') === 0)
  check('unreadable switches never say the code is current', !/already up to date/.test(String(page.notice())), String(page.notice()))
  check('unreadable switches say it cannot rebuild yet', /Cannot rebuild/.test(String(page.notice())), String(page.notice()))
  check('unreadable switches are logged as such', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('gate=settings')))
}

// --- a page check throws: the rebuild is held with its real reason, no crash, no navigation ---
{
  const page = harness({ brokenSelector: true })
  const view = await page.press()
  check('a failing page check does not navigate', page.navigations.length === 0)
  // The plugins are replaced by then; what is left to say is that the page could not be read,
  // which is the truth of it, rather than a bare failure with no reason.
  check('a failing page check names the page as unreadable', /page state cannot be read/.test(String(page.notice())), String(page.notice()))
  const heldLog = page.requests.filter((request) => request.path.includes('event=held')).map((request) => request.path)
  check('a failing page check is logged as a hold', heldLog.some((path) => path.includes('screen')), JSON.stringify(heldLog))
  check('a failing page check leaves the button usable', view.button !== null && view.button.props.disabled !== true)
}

// --- the list a booting document really gets: one inline queue script, inline global, both kinds ---
// `dsh-client-modules` emits exactly four row kinds (script, script-preload, script-src, global) and
// the shell replays them for every document. The check must read the two script addresses out of that
// shape without refusing the list over the inline rows it cannot fetch.
{
  const real = [
    { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__={};' },
    { kind: 'script-preload', src: '/plugins/??@local/a/client.js,@local/b/client.js&rev=live' },
    { kind: 'script-src', placement: 'head', src: '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=live' },
    { kind: 'style', text: ':root{--a:1}' },
    { kind: 'global', name: '__DSH_BOOT__', value: JSON.stringify(graph) },
  ]
  const page = harness({ bootRows: real })
  await page.press()
  check('a real boot list shape is not refused', page.navigations.length === 1, JSON.stringify(page.navigations))
  const sent = page.requests.find((request) => request.path.startsWith('/dsh-unlag/verify'))
  const sentBody = String(sent?.init?.body ?? '')
  check(
    'a real boot list sends both script addresses to the check',
    sentBody.includes('@local/a/client.js') && sentBody.includes('dsh-client-modules/client.js') && !sentBody.includes('__ModuleLoader__'),
    sentBody.slice(0, 160),
  )
}

// A store that cannot be read is not a reason to lose a press: the stamp only paces repeats.
{
  const denied = harness({ storageThrows: true })
  let threw = null
  try {
    await denied.press()
  } catch (error) {
    threw = error
  }
  check('a store that refuses to be read does not stop the press', threw === null && denied.navigations.length === 1, String(threw?.message ?? JSON.stringify(denied.navigations)))
  check('and the plugins were asked to replace', denied.requests.some((request) => request.path.startsWith('/dsh-unlag/reload')))
}
// A document whose address cannot be parsed still comes back as a fresh one: by then the code
// behind it has already been replaced, and leaving the old page running would show the state as
// the person never pressed.
{
  const addressless = harness({ href: '::bad address' })
  let threw = null
  try {
    await addressless.press()
  } catch (error) {
    threw = error
  }
  const rebuilt = addressless.navigations.length + addressless.reloads.length
  check('a page whose address cannot be parsed still reloads', threw === null && rebuilt >= 1, String(threw?.message ?? JSON.stringify({ navigations: addressless.navigations, reloads: addressless.reloads })))
  check('and it reloads in place rather than leaving the old page', addressless.navigations.length === 0 && addressless.reloads.length === 1)
}

// --- a press that was held changed nothing, so it must not pace the next press ------------------
// The stamp used to be written before the readiness checks ran: a press held by an open dialog or
// unsaved work left "already applying" behind and turned the next press away for three seconds.
{
  const page = harness({ openWindow: true })
  await page.press()
  check('a press held by an open window records no answered press', page.stamp() === 0, String(page.stamp()))
  check('a press held by an open window says what to do', /Close the open window/u.test(String(page.notice())), String(page.notice()))
  const next = harness()
  check('and a different page is not paced by it either', next.stamp() === 0)
}
{
  const page = harness({ answers: 'unsaved work' })
  await page.press()
  check('a press held by unsaved work records no answered press', page.stamp() === 0, String(page.stamp()))
}
{
  const page = harness({ settings: { plugins: true, page: false } })
  await page.press()
  check('a plugin-only press records no page answer', page.stamp() === 0, String(page.stamp()))
}
{
  const page = harness()
  await page.press()
  check('a press that really rebuilds records itself', page.stamp() > 0, String(page.stamp()))
}
{
  // The document stayed anyway: the press that was written down never happened, so it is taken back.
  const page = harness()
  await page.press()
  page.scheduled.find((entry) => entry.ms === 6000).fn()
  check('a rebuild the page held takes its pacing stamp back', page.stamp() === 0, String(page.stamp()))
}

console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
