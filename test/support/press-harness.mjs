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

/** Every word a rendered node carries, the way a person reads the line on screen. */
function words(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  if (typeof node === 'object' && 'children' in node) return words(node.children)
  return ''
}

/** The raw words a notice can hand over, once the person asked for them. */
function showDetail(tree) {
  const panel = (function walk(node) {
    if (node === null || typeof node !== 'object') return null
    const style = node.props?.style
    if (style !== undefined && style?.whiteSpace === 'pre-wrap') return node
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const found = walk(child)
      if (found !== null) return found
    }
    return null
  })(tree)
  if (panel === null) return null
  const said = words(panel.children)
  return said === '' ? null : said
}

/** Encode a notice the handler showed; the component is re-rendered for every state change. */
function show(tree) {
  const pill = tree.children?.find((child) => child !== null && typeof child === 'object' && child.props?.role === 'status')
  if (pill === undefined) return null
  const said = words(pill.children)
  return said === '' ? null : said
}

// `documentAnswers` stands for the page the press is about to enter: a rebuild walks into that
// address, so a fake app has to say whether a page really comes up there.
function harnessWith(sourceText, { settings = { plugins: true, page: true }, reload = { status: 'done' }, scripts = {}, openWindow = false, brokenSelector = false, stamp = '0', hold, answers = null, reportAnswers = [], lateOperation = null, revAfterReload, codeAfterReload, bootRows = rows, storageThrows = false, dispatchThrows = false, activeThrows = false, draftImages = 0, draftFiles = 0, conversation = null, sessions = null, language = 'en-US', href, switchAnswer = 'done', stampInStore = false, verifyAnswer = { status: 'ok' }, documentAnswers = true } = {}) {
  const requests = []
  const navigations = []
  const current = { rev: graph.rev, code: 'c1' }
  let replaced = false
  let reloadBody = reload
  let reloadAnswer = null
  const reloads = []
  // The name a press gives its update; a fake host can answer for that same press by it.
  let lastRequestId = null
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
      const operation = replaced && lateOperation !== null
        ? { operation: typeof lateOperation === 'function' ? lateOperation(lastRequestId) : lateOperation }
        : {}
      return new Response(JSON.stringify({ ...settings, code: current.code, ...operation }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/reload')) {
      const asked = new URL(path, 'http://press.invalid').searchParams.get('requestId')
      if (asked !== null) lastRequestId = asked
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
    if (path.startsWith('/dsh-unlag/switches')) {
      // The menu writes the two switches the press reads, and the fake host keeps them the way the
      // real one does: a refused write leaves the old answer in place.
      if (switchAnswer === 'error') return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
      if (switchAnswer === 'readonly') return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })
      try {
        const asked = JSON.parse(String(init.body ?? '{}'))
        if (typeof asked.plugins === 'boolean') settings.plugins = asked.plugins
        if (typeof asked.page === 'boolean') settings.page = asked.page
        if (typeof asked.agentRefresh === 'boolean') settings.agentRefresh = asked.agentRefresh
      } catch {}
      const saved = switchAnswer !== 'unsaved'
      return new Response(JSON.stringify({ status: 'done', plugins: settings.plugins, page: settings.page, agentRefresh: settings.agentRefresh === true, saved }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.startsWith('/dsh-unlag/verify')) return new Response(JSON.stringify(verifyAnswer), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path.startsWith('/dsh-unlag/report')) {
      const next = reportAnswers.shift()
      if (next === undefined) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      if (next === 0) throw new Error('the route was not listening')
      return new Response('{}', { status: next, headers: { 'content-type': 'application/json' } })
    }
    // The page itself, asked before the press walks into it: an address that answers no page is
    // the one case where a rebuild would trade a slow page for no page at all.
    if (path === '/' || path.startsWith('/?') || path.includes('interface=')) {
      if (!documentAnswers) return new Response('No page here', { status: 404 })
      return new Response('<!doctype html><script>window.__DSH_BOOT__ = {};</script>', { status: 200, headers: { 'content-type': 'text/html' } })
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
    // What the composer holds: a draft image is previewed from a local blob, and a picked file
    // still sits in its input. Both are what a rebuild would drop.
    querySelectorAll: (selector) => {
      if (String(selector).includes('blob:')) return Array.from({ length: draftImages }, () => ({}))
      if (String(selector).includes('input[type="file"]')) return Array.from({ length: draftFiles }, () => ({ files: { length: 1 } }))
      return []
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const store = new Map()
  // `stamp` alone models a stamp that is always there (a press this document already made). A page
  // that boots with a stamp of its own needs it in the store, so clearing it really clears it.
  if (stampInStore) store.set('dsh-unlag:at', stamp)
  const listeners = []
  const window = {
    __ModuleLoader__: { load: () => {} },
    __DSH_BOOT__: graph,
    dshDesktopBoot: { ready: async () => ({ injections: bootRows }) },
    sessionStorage: { getItem: (key) => (store.has(key) ? store.get(key) : stampInStore ? '0' : stamp), setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
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
    useRef(initial) {
      return { current: initial }
    },
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
  // The composer keeps picked files and settled drafts in its own state, not in the markup, so the
  // service is what a press has to read: a stand-in can hold attachments the page never shows.
  plugin.apply({
    slots,
    get: (name) => (name === 'conversation' ? conversation : name === 'sessions' ? sessions : undefined),
  })

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
    /** The words behind the notice, after the person asks for them. */
    detail: () => showDetail(render().tree),
    /** Ask for the refusal's own words, the way a press on the notice does. */
    openDetail: () => {
      const ask = (function walk(node) {
        if (node === null || typeof node !== 'object') return null
        if (typeof node.props?.onClick === 'function' && node.props?.['aria-expanded'] !== undefined) return node.props.onClick
        for (const child of Array.isArray(node.children) ? node.children : []) {
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      })(render().tree)
      if (ask === null) return null
      ask({ preventDefault() {} })
      return showDetail(render().tree)
    },
    /** Right-click the button the way a person does, and render what the menu then shows. */
    openMenu: async () => {
      const menu = (function walk(node) {
        if (node === null || typeof node !== 'object') return null
        if (typeof node.props?.onContextMenu === 'function') return node.props.onContextMenu
        for (const child of Array.isArray(node.children) ? node.children : []) {
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      })(render().tree)
      await menu({ preventDefault() {} })
      return render()
    },
    /** Change one switch from the menu: 0 is plugins, 1 the page, 2 the agent switch. */
    toggle: async (index) => {
      const inputs = []
      ;(function walk(node) {
        if (node === null || typeof node !== 'object') return
        if (node.type === 'input') inputs.push(node)
        for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
      })(render().tree)
      await inputs[index].props.onChange()
      return render()
    },
    /** Whether this press left a pacing stamp behind, and what it says. */
    stamp: () => (store.has('dsh-unlag:at') ? Number(store.get('dsh-unlag:at')) : 0),
    conversation,
  }
}

/**
 * The shipped composer's failure bookkeeping, modeled from the app bundle (the client input model,
 * `SessionInput`): a draft with the revision it was published at, the sends that failed and are
 * waiting to be restored, and the revision of the last automatic restoration.
 *
 * The behaviors that decide the press, and are modeled rather than assumed:
 * - a failed send is restored only into an empty composer, or over a draft that is itself the last
 *   restoration; the restore writes the text and the draft is published (saved) in the same turn;
 * - a real edit moves the revision on and drops both the waiting records and the recorded revision;
 * - clearing words the person typed after the failure is a real edit, so it never brings a record
 *   back: the app has no later path that restores a failed send.
 * @param {object} options - the starting draft, revision, files and phase.
 * @returns the shell a session composer would expose, plus `type`, `clear` and `fail`.
 */
export function composerShell({ draft = '', draftRev = 0, attachmentIds = [], phase = 'idle' } = {}) {
  const shell = {
    snapshot: { draft, draftRev, attachmentIds, phase },
    detachedDrafts: new Map(),
    failedDetached: new Map(),
    attachmentFlights: new Map(),
    failedRestoreRev: undefined,
    /**
     * Type into the composer. The revision moves on; the failure books are dropped only once a
     * restoration is on record (the app's own condition), so a send the app never took back keeps
     * waiting through later edits, and clearing the composer does not make it disappear.
     */
    type(text) {
      shell.snapshot.draft = text
      shell.snapshot.draftRev += 1
      if (shell.failedRestoreRev !== undefined) {
        shell.failedDetached.clear()
        shell.failedRestoreRev = undefined
      }
      return shell
    },
    /** Empty the composer. The app saves an empty draft and restores nothing it did not restore. */
    clear() {
      return shell.type('')
    },
    /** A default send fails, carrying the text and files it tried to send. */
    fail(seq, record = {}) {
      const files = record.attachmentIds ?? []
      shell.failedDetached.set(seq, { draft: record.draft ?? '', attachmentIds: files })
      // The app returns a failed send's files to the rail at the failure itself, before deciding
      // whether the words can be restored.
      const rail = shell.snapshot.attachmentIds.filter((id) => !files.includes(id))
      shell.snapshot.attachmentIds = [...files, ...rail]
      const current = shell.snapshot.draftRev
      const restoring = shell.snapshot.draft === '' || shell.failedRestoreRev === current
      if (!restoring) return shell
      const text = [...shell.failedDetached.values()]
        .map((waiting) => waiting.draft)
        .filter((words) => words !== '')
        .join('\n\n')
      // A restore that writes nothing does not move the revision, but the app records the revision
      // it restored at either way; a restore that writes text publishes a new revision.
      if (text !== '') shell.snapshot.draftRev += 1
      shell.snapshot.draft = text
      shell.failedRestoreRev = shell.snapshot.draftRev
      return shell
    },
  }
  return shell
}

/** A page showing one retained session's composer, built through `composerShell`. */
export function harnessWithComposer(shell, options = {}) {
  const conversation = {
    draftAttachments: new Map(),
    pendingFileUploads: new Set(),
    fileUploads: { getSnapshot: () => ({}) },
    input: { shell: (id) => (options.sessionId !== undefined && id !== options.sessionId ? undefined : shell) },
  }
  const { sessionId = 's1', sourceText = null, ...rest } = options
  return harnessWith(sourceText, { sessions: { list: () => [{ id: sessionId }] }, ...rest, conversation })
}

/** Today's button, over the fake host. */
export function harness(options = {}) {
  return harnessWith(null, options)
}

/** A shipped version's button, over the same fake host: what an open page still runs after an update. */
export function harnessForSource(sourceText, options = {}) {
  return harnessWith(sourceText, options)
}
