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

function harness({ settings = { plugins: true, page: true }, reload = { status: 'done' }, scripts = {}, openWindow = false, brokenSelector = false, stamp = '0', hold, reportAnswers = [] } = {}) {
  const requests = []
  const navigations = []
  let reloadBody = reload
  let reloadAnswer = null
  const location = { href: 'http://127.0.0.1:62542/?interface=live', replace: (target) => navigations.push(String(target)) }
  const fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, '')
    requests.push({ path, init })
    if (path.startsWith('/dsh-unlag/state')) {
      if (settings === null) return new Response('', { status: 503 })
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/reload')) {
      if (reloadAnswer !== null) await reloadAnswer
      if (reloadBody instanceof Error) throw reloadBody
      return new Response(JSON.stringify(reloadBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/graph')) return new Response(JSON.stringify({ graph }), { status: 200, headers: { 'content-type': 'application/json' } })
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
  const listeners = []
  const window = {
    __ModuleLoader__: { load: () => {} },
    __DSH_BOOT__: graph,
    dshDesktopBoot: { ready: async () => ({ injections: rows }) },
    sessionStorage: { getItem: () => stamp, setItem: () => {} },
    location,
    dispatchEvent: (event) => {
      listeners.push(event.type)
      if (typeof hold === 'function') hold(event)
      return true
    },
  }
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
    sessionStorage: window.sessionStorage,
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
    /** Release a /reload that is being held open, to model a slow app. */
    release: () => { reloadAnswer = null },
    holdReload: () => { reloadAnswer = new Promise((resolve) => { setImmediate(resolve) }) },
    setReload: (value) => { reloadBody = value },
    notice: () => show(render().tree),
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
  check('a held navigation says the page stayed', /page stayed/.test(String(page.notice())), String(page.notice()))
  check('a held navigation says why', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('gate=navigation')))
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

// --- plugins replaced, page held: the notice says what did happen ----------------------------
{
  const page = harness({ openWindow: true })
  await page.press()
  check('an open window keeps the page', page.navigations.length === 0)
  check('an applied update says the plugins are live', /Plugins updated; the page stayed/.test(String(page.notice())), String(page.notice()))
  check('an applied hold is logged as applied', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('applied%3Adialog')))
}

// --- the app half does not answer: the press still rebuilds, as it always did ---------------
{
  const page = harness({ settings: null })
  await page.press()
  check('a missing app half still rebuilds the page', page.navigations.length === 1, String(page.navigations.length))
  check('a missing app half asks no replacement it cannot track', count(page.requests, '/dsh-unlag/reload') === 0)
}

// --- a page check throws: no crash, no navigation, the button is usable again ---------------
{
  const page = harness({ brokenSelector: true })
  const view = await page.press()
  check('a failing page check does not navigate', page.navigations.length === 0)
  check('a failing page check says it failed', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('a failing page check is logged', page.requests.some((request) => request.path.includes('event=failed') && request.path.includes('gate=press')))
  check('a failing page check leaves the button usable', view.button !== null && view.button.props.disabled !== true)
}

console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
