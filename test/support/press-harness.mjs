// One press harness, shared: `press.test.mjs` drives today's button through it, and the
// cross-version check drives the button of every shipped version through the same fake host. A
// harness that lived in one test file would be copied, and the copies would drift.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

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

export const rows = [
  { kind: 'script-preload', src: 'plugins/??@local/a/client.js&rev=live' },
  { kind: 'script-src', src: 'plugins/??@local/a/client.js&rev=live', id: 'queue' },
]
export const graph = { rev: 'live', entries: [{ id: '@local/a', rev: 'live' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=live', entries: ['@local/a'], rev: 'live' }] }
const body = 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} })'

/** Encode a notice the handler showed; the component is re-rendered for every state change. */
function show(tree) {
  const pill = tree.children?.find((child) => child !== null && typeof child === 'object' && child.props?.role === 'status')
  return pill === undefined ? null : String(Array.isArray(pill.children) ? pill.children.join('') : pill.children)
}

function harnessWith(sourceText, { settings = { plugins: true, page: true }, reload = { status: 'done' }, scripts = {}, openWindow = false, brokenSelector = false, stamp = '0', hold, answers = null, reportAnswers = [], lateOperation = null, revAfterReload, codeAfterReload, bootRows = rows, storageThrows = false, dispatchThrows = false, activeThrows = false, language = 'en-US', href } = {}) {
  const requests = []
  const navigations = []
  const current = { rev: graph.rev, code: 'c1' }
  let replaced = false
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
      // A page reads this before, during and after a press: a case that changes what the host says
      // over time queues the answers it wants in order, and later reads fall back to the switches.
      const operation = replaced && lateOperation !== null ? { operation: lateOperation } : {}
      return new Response(JSON.stringify({ ...settings, code: current.code, ...operation }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/reload')) {
      if (revAfterReload !== undefined) current.rev = revAfterReload
      if (codeAfterReload !== undefined) current.code = codeAfterReload
      if (reloadAnswer !== null) await reloadAnswer
      replaced = true
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
    get activeElement() {
      if (activeThrows) throw new Error('the focused field cannot be read')
      return null
    },
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
      // A page whose event hub is broken throws where a listener would have run. That must hold the
      // rebuild with the page named as the reason, not end the press with no notice on screen.
      if (dispatchThrows) throw new Error('event hub blew up')
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
    navigator: { language, userAgent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0' },
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
  runInNewContext(`'use strict';\n${sourceText ?? readFileSync(new URL('../../client.js', import.meta.url), 'utf8')}`, sandbox)
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

/** Today's button, over the fake host. */
export function harness(options = {}) {
  return harnessWith(null, options)
}

/** A shipped version's button, over the same fake host: what an open page still runs after an update. */
export function harnessForSource(sourceText, options = {}) {
  return harnessWith(sourceText, options)
}
