// The button under a page that behaves like a browser: state that really re-renders, effects with
// dependencies and cleanups, a listener registry that counts every add and remove, and a timer
// queue that only fires when a case advances the clock. The shared `press-harness.mjs` stub is
// enough for the press decision, but it cannot see a listener that is never removed or a timer that
// outlives the document, which is exactly what this file is about.
//
// The page is exported so the sibling stability files drive the same fake; a file that only wants
// the cases below still runs them on its own, because the cases are behind the main guard.
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'

const SOURCE_URL = new URL('../client.js', import.meta.url)
const sleep = () => new Promise((resolve) => setImmediate(resolve))

export const rows = [
  { kind: 'script-preload', src: 'plugins/??@local/a/client.js&rev=live' },
  { kind: 'script-src', src: 'plugins/??@local/a/client.js&rev=live', id: 'queue' },
]
export const graph = { rev: 'live', entries: [{ id: '@local/a', rev: 'live' }], batches: [{ url: 'plugins/??@local/a/client.js&rev=live', entries: ['@local/a'], rev: 'live' }] }

// Waits below this belong to a press (the host is re-read, a retry is spaced): they run on their
// own, so a case never has to advance a clock to let a press finish. Longer waits are the page's
// own timers, and only `advance` fires them.
const SILENT_MS = 1500

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    this.target = init.target
    this.key = init.key
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

/** A DOM node good enough for `contains`, which is how the menu tells inside from outside. */
function domNode(element) {
  const node = { tag: element.type, props: element.props, parent: null, children: [] }
  for (const child of element.children ?? []) {
    if (child === null || typeof child !== 'object') continue
    const built = domNode(child)
    built.parent = node
    node.children.push(built)
  }
  node.contains = (target) => {
    let walk = target
    while (walk !== null && walk !== undefined) {
      if (walk === node) return true
      walk = walk.parent ?? null
    }
    return false
  }
  return node
}

/**
 * Start one fake page and mount the plugin's button on it.
 * @param options - what the fake host and the fake page answer; the defaults are a healthy host.
 * @returns the page: presses, menus, timers, listeners and the records a case asserts on.
 */
export async function stablePage(options = {}) {
  const opts = {
    settings: { plugins: true, page: true },
    reload: { status: 'done' },
    verifyAnswers: [],
    switchAnswer: 'done',
    graph,
    bootRows: rows,
    language: 'en-US',
    stamp: '0',
    storageThrows: false,
    dispatchThrows: false,
    activeThrows: false,
    brokenSelector: false,
    openWindow: false,
    draftFiles: 0,
    draftImages: 0,
    holdReload: null,
    revAfterReload: null,
    codeAfterReload: null,
    ...options,
  }
  const source = await readFile(SOURCE_URL, 'utf8')

  const requests = []
  const navigations = []
  const reloads = []
  const errors = []
  const current = { rev: graph.rev, code: 'c1' }
  const verifyAnswers = [...opts.verifyAnswers]
  const longTimers = new Map()
  const listenerLog = []
  const registry = { document: new Map(), window: new Map() }
  let timerSeq = 1
  let clock = 0
  let replaced = false
  let lastRequestId = null
  let component = null
  let activeHooks = null

  const addListener = (scope, type, fn) => {
    listenerLog.push({ op: 'add', scope, type })
    if (!registry[scope].has(type)) registry[scope].set(type, new Set())
    registry[scope].get(type).add(fn)
  }
  const removeListener = (scope, type, fn) => {
    listenerLog.push({ op: 'remove', scope, type })
    registry[scope].get(type)?.delete(fn)
  }
  const listenerCount = (scope) => {
    let total = 0
    for (const set of registry[scope].values()) total += set.size
    return total
  }
  const dispatch = (scope, type, init = {}) => {
    const event = new FakeEvent(type, init)
    for (const fn of [...(registry[scope].get(type) ?? [])]) {
      try {
        fn(event)
      } catch (error) {
        errors.push(error)
      }
    }
    return event
  }

  // Per key: the page also counts how many documents a window has loaded under its own key, and a
  // store that answered every key with one value would read the press stamp as that counter.
  const stored = new Map(opts.stamp === undefined ? [] : [['dsh-unlag:at', opts.stamp]])
  const storage = {
    getItem: (key) => {
      if (opts.storageThrows) throw new Error('storage is unavailable')
      return stored.has(key) ? stored.get(key) : null
    },
    setItem: (key, value) => {
      if (opts.storageThrows) throw new Error('storage is unavailable')
      stored.set(key, String(value))
    },
    removeItem: (key) => {
      if (opts.storageThrows) throw new Error('storage is unavailable')
      stored.delete(key)
    },
  }

  const location = {
    href: 'http://127.0.0.1:62542/?interface=live',
    replace: (target) => navigations.push(String(target)),
    reload: () => reloads.push(1),
  }

  const document = {
    addEventListener: (type, fn) => addListener('document', type, fn),
    removeEventListener: (type, fn) => removeListener('document', type, fn),
    querySelector: () => {
      if (opts.brokenSelector) throw new Error('the page cannot be read')
      return opts.openWindow ? {} : null
    },
    querySelectorAll: (selector) => {
      if (opts.brokenSelector) throw new Error('the page cannot be read')
      if (selector === 'input[type="file"]') return Array.from({ length: opts.draftFiles }, () => ({}))
      if (selector === 'img[src^="blob:"]') return Array.from({ length: opts.draftImages }, () => ({}))
      return []
    },
    get activeElement() {
      if (opts.activeThrows) throw new Error('the focused field cannot be read')
      return null
    },
  }

  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, '')
    requests.push({ path, init })
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    if (path.startsWith('/dsh-unlag/state')) {
      if (opts.settings === null) return new Response('', { status: 503 })
      return json({ ...opts.settings, code: current.code })
    }
    if (path.startsWith('/dsh-unlag/boot') || path.startsWith('/dsh-unlag/report')) return json({})
    if (path.startsWith('/dsh-unlag/reload')) {
      lastRequestId = decodeURIComponent(path.split('requestId=')[1] ?? '')
      if (opts.holdReload !== null) await opts.holdReload
      if (opts.reload === 'error') throw new Error('the host did not answer')
      replaced = true
      if (opts.revAfterReload !== null) current.rev = opts.revAfterReload
      if (opts.codeAfterReload !== null) current.code = opts.codeAfterReload
      return json(opts.reload ?? {})
    }
    if (path.startsWith('/dsh-unlag/graph')) return json(opts.graph)
    if (path.startsWith('/dsh-unlag/verify')) {
      const answer = verifyAnswers.length > 0 ? verifyAnswers.shift() : 'ok'
      return answer === 'ok' ? json({ status: 'ok' }) : json({ status: 'failed', reason: 'list' })
    }
    if (path.startsWith('/dsh-unlag/switches')) {
      const body = JSON.parse(String(init.body ?? '{}'))
      if (opts.switchAnswer === 'error') return new Response('', { status: 500 })
      if (opts.switchAnswer === 'readonly') return new Response('', { status: 403 })
      return json({ ...body, status: 'done', saved: opts.switchAnswer !== 'unsaved' })
    }
    return new Response('', { status: 404 })
  }

  const windowObject = {
    __ModuleLoader__: { load: (module) => { loaded = module } },
    __DSH_BOOT__: opts.graph,
    dshDesktopBoot: { ready: async () => ({ injections: opts.bootRows }) },
    sessionStorage: storage,
    location,
    addEventListener: (type, fn) => addListener('window', type, fn),
    removeEventListener: (type, fn) => removeListener('window', type, fn),
    dispatchEvent: (event) => {
      if (opts.dispatchThrows) throw new Error('the page cannot be asked to stand by')
      dispatch('window', String(event?.type))
      return true
    },
    onbeforeunload: null,
  }
  windowObject.window = windowObject

  // Hooks are read from whichever instance is rendering now: the plugin's own `React` object was
  // handed to it once, so the calls have to be routed to the instance instead of captured.
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== undefined),
    }),
    useState: (...args) => activeHooks.useState(...args),
    useRef: (...args) => activeHooks.useRef(...args),
    useEffect: (...args) => activeHooks.useEffect(...args),
  }

  let loaded = null
  const sandbox = {
    window: windowObject,
    navigator: { language: opts.language, userAgent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0' },
    location,
    document,
    fetch: fetchImpl,
    URL,
    Response,
    console,
    CustomEvent: class extends FakeEvent {},
    Event: FakeEvent,
    sessionStorage: storage,
    setTimeout: (fn, ms) => {
      const id = timerSeq++
      if (ms < SILENT_MS) {
        setImmediate(() => fn())
        return id
      }
      longTimers.set(id, { fn, at: clock + ms, id })
      return id
    },
    clearTimeout: (id) => {
      longTimers.delete(id)
    },
    requestAnimationFrame: (fn) => {
      setImmediate(() => fn())
      return 0
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  runInNewContext(source, sandbox, { filename: 'client.js' })
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`the page does not provide ${name}`)
  })

  // --- the component renderer: hooks keyed by call order, like the real thing ------------------
  const components = []
  const registrations = []
  const slots = {
    inject: (_name, register) => register(),
    register: (config, target) => {
      registrations.push({ name: config.name, id: config.id, order: config.order })
      components.push(target)
      component = target
      return target
    },
  }
  const ctx = {
    slots,
    get: (name) => {
      if (name === 'sessions') return { list: () => [] }
      return undefined
    },
  }

  let instance = null

  function createInstance(target) {
    let hooks = []
    let cursor = 0
    let alive = false
    let dirty = true
    let tree = null
    let lateUpdates = 0
    let cleanupErrors = 0

    const slotAt = (index, make) => {
      if (hooks[index] === undefined) hooks[index] = make()
      return hooks[index]
    }

    const hooksApi = {
      useState: (initial) => {
        const index = cursor++
        const slot = slotAt(index, () => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }))
        const set = (next) => {
          if (!alive) {
            lateUpdates += 1
            return
          }
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          dirty = true
        }
        return [slot.value, set]
      },
      useRef: (initial) => {
        const index = cursor++
        return slotAt(index, () => ({ kind: 'ref', ref: { current: initial } })).ref
      },
      useEffect: (fn, deps) => {
        const index = cursor++
        const slot = slotAt(index, () => ({ kind: 'effect', deps: undefined, ran: false, cleanup: null }))
        const same = slot.ran
          && deps !== undefined
          && Array.isArray(slot.deps)
          && deps.length === slot.deps.length
          && deps.every((dep, position) => Object.is(dep, slot.deps[position]))
        if (same) return
        slot.deps = deps
        slot.fn = fn
        slot.pending = true
      },
    }

    const runCleanup = (slot) => {
      if (slot.cleanup === null) return
      const cleanup = slot.cleanup
      slot.cleanup = null
      try {
        cleanup()
      } catch {
        cleanupErrors += 1
      }
    }

    const commitEffects = () => {
      for (const slot of hooks) {
        if (slot?.kind !== 'effect' || slot.pending !== true) continue
        slot.pending = false
        runCleanup(slot)
        try {
          const out = slot.fn()
          slot.cleanup = typeof out === 'function' ? out : null
        } catch (error) {
          errors.push(error)
        }
        slot.ran = true
      }
    }

    const renderOnce = () => {
      cursor = 0
      dirty = false
      activeHooks = hooksApi
      try {
        tree = target(hooksApi)
      } finally {
        activeHooks = null
      }
      commitEffects()
      assignRefs(tree)
    }

    const api = {
      mount: () => {
        alive = true
        dirty = true
        api.flush()
        return api
      },
      unmount: () => {
        if (!alive) return api
        alive = false
        for (const slot of [...hooks].reverse()) {
          if (slot?.kind === 'effect') runCleanup(slot)
        }
        tree = null
        return api
      },
      flush: () => {
        for (let round = 0; round < 20; round += 1) {
          if (!dirty) return api
          renderOnce()
        }
        return api
      },
      get tree() { return tree },
      get alive() { return alive },
      get lateUpdates() { return lateUpdates },
      get cleanupErrors() { return cleanupErrors },
      get hooks() { return hooks },
    }
    return api
  }

  // Refs in this page are the menu's only way to tell an inside click from an outside one.
  function assignRefs(element) {
    if (element === null || typeof element !== 'object') return
    const ref = element.props?.ref
    if (ref !== null && typeof ref === 'object' && 'current' in ref) ref.current = domNode(element)
    for (const child of element.children ?? []) {
      if (child !== null && typeof child === 'object') assignRefs(child)
    }
  }

  const find = (element, predicate) => {
    if (element === null || typeof element !== 'object') return null
    if (predicate(element)) return element
    for (const child of element.children ?? []) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  const findAll = (element, predicate, found = []) => {
    if (element === null || typeof element !== 'object') return found
    if (predicate(element)) found.push(element)
    for (const child of element.children ?? []) findAll(child, predicate, found)
    return found
  }

  const currentTree = () => (instance === null ? null : instance.tree)
  const buttonNode = () => find(currentTree(), (element) => element.type === 'button')
  const buttonNodes = () => findAll(currentTree(), (element) => element.type === 'button')
  const wrapperNode = () => find(currentTree(), (element) => element.props?.onContextMenu !== undefined)
  const checkboxNodes = () => findAll(currentTree(), (element) => element.type === 'input' && element.props?.type === 'checkbox')

  const settle = async (promise) => {
    let done = false
    let failure = null
    Promise.resolve(promise).then(
      () => { done = true },
      (error) => {
        done = true
        failure = error
      },
    )
    for (let tick = 0; tick < 600 && !done; tick += 1) await sleep()
    instance?.flush()
    await sleep()
    instance?.flush()
    if (failure !== null) {
      errors.push(failure)
      throw failure
    }
  }

  const page = {
    // --- what the host sees ------------------------------------------------------------------
    get requests() { return requests },
    get navigations() { return navigations },
    get reloads() { return reloads },
    get errors() { return errors },
    get listenerLog() { return listenerLog },
    get registrations() { return registrations },
    get components() { return components },
    get lastRequestId() { return lastRequestId },
    get clock() { return clock },
    listenerCount: (scope = 'document') => listenerCount(scope),
    listenerBalance: (scope = 'document') => listenerLog.filter((entry) => entry.scope === scope && entry.op === 'add').length
      - listenerLog.filter((entry) => entry.scope === scope && entry.op === 'remove').length,
    timerCount: () => longTimers.size,
    timerDelays: () => [...longTimers.values()].map((timer) => timer.at - clock),

    // --- the page's own state ----------------------------------------------------------------
    render: () => currentTree(),
    instance: () => instance,
    button: buttonNode,
    buttonCount: () => buttonNodes().length,
    wrapper: wrapperNode,
    checkboxes: checkboxNodes,
    notice: () => {
      const pill = find(currentTree(), (element) => element.props?.role === 'status')
      if (pill === null) return null
      return String(Array.isArray(pill.children) ? pill.children.join('') : pill.children)
    },
    menu: () => find(currentTree(), (element) => element.props?.role === 'group'),
    rendered: () => currentTree() !== null,
    nodeCount: () => {
      let total = 0
      const walk = (element) => {
        if (element === null || typeof element !== 'object') return
        total += 1
        for (const child of element.children ?? []) walk(child)
      }
      walk(currentTree())
      return total
    },

    // --- actions -----------------------------------------------------------------------------
    /** One press, exactly as a click delivers it, and the page settled afterwards. */
    press: async () => {
      const target = buttonNode()
      if (target === null) throw new Error('there is no button to press')
      await settle(target.props.onClick())
      return page
    },
    /** Several clicks delivered before any of them returns, the way a fast double click arrives. */
    pressTimes: async (times) => {
      const target = buttonNode()
      if (target === null) throw new Error('there is no button to press')
      const started = []
      for (let index = 0; index < times; index += 1) started.push(target.props.onClick())
      await settle(Promise.all(started))
      return page
    },
    hover: () => {
      buttonNode()?.props.onMouseEnter?.()
      instance?.flush()
      return page
    },
    rightClick: async () => {
      await settle((wrapperNode() ?? {}).props?.onContextMenu?.(new FakeEvent('contextmenu', { cancelable: true })))
      return page
    },
    outsideClick: () => {
      dispatch('document', 'mousedown', { target: domNode({ type: 'div', props: {}, children: [] }) })
      instance?.flush()
      return page
    },
    insideClick: () => {
      const wrap = wrapperNode()
      dispatch('document', 'mousedown', { target: wrap?.props?.ref?.current ?? domNode(wrap ?? { type: 'div', props: {}, children: [] }) })
      instance?.flush()
      return page
    },
    escape: () => {
      dispatch('document', 'keydown', { key: 'Escape' })
      instance?.flush()
      return page
    },
    otherKey: (key = 'a') => {
      dispatch('document', 'keydown', { key })
      instance?.flush()
      return page
    },
    blur: () => {
      dispatch('window', 'blur')
      instance?.flush()
      return page
    },
    toggle: async (index) => {
      const box = checkboxNodes()[index]
      if (box === undefined) throw new Error(`there is no switch ${index}`)
      await settle(box.props.onChange())
      return page
    },
    /** Two switches flipped in the same tick, before either save has been answered. */
    toggleBoth: async (first, second) => {
      const boxes = checkboxNodes()
      await settle(Promise.all([boxes[first].props.onChange(), boxes[second].props.onChange()]))
      return page
    },
    /** Two flips of the same switch in the same tick: one save, not two. */
    toggleTwice: async (index) => {
      const box = checkboxNodes()[index]
      await settle(Promise.all([box.props.onChange(), box.props.onChange()]))
      return page
    },
    advance: async (ms) => {
      const target = clock + ms
      for (;;) {
        const due = [...longTimers.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0]
        if (due === undefined) break
        longTimers.delete(due.id)
        clock = due.at
        try {
          due.fn()
        } catch (error) {
          errors.push(error)
        }
        instance?.flush()
        await sleep()
        instance?.flush()
      }
      clock = target
      instance?.flush()
      await sleep()
      instance?.flush()
      return page
    },
    unmount: () => {
      instance?.unmount()
      return page
    },
    /** Mount one registration the way the shell mounts a new one; later actions drive it. */
    mountRegistration: (index = components.length - 1) => {
      instance = createInstance(components[index])
      page.instanceRef = instance
      return instance.mount()
    },
    /** Apply again the way a remount does; a second registration is what a duplicate button is. */
    applyAgain: () => {
      plugin.apply(ctx)
      return page
    },
    set: (changes) => {
      Object.assign(opts, changes)
      return page
    },
    /** Count of a report line, for the checks that read the log instead of the pill. */
    reports: (piece) => requests.filter((entry) => entry.path.startsWith('/dsh-unlag/report')
      && decodeURIComponent(entry.path).includes(piece)).length,
    count: (piece) => requests.filter((entry) => entry.path.includes(piece)).length,
    stamp: () => stored.get('dsh-unlag:at') ?? null,
    switchesRequests: () => requests.filter((entry) => entry.path.startsWith('/dsh-unlag/switches')),
    navved: () => navigations.length + reloads.length,
  }

  plugin.apply(ctx)
  instance = createInstance(components[0])
  instance.mount()
  return page
}

// --- the button's own state machine, asserted on a page that really re-renders ---------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = []
  const check = (label, ok, extra = '') => {
    out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
    if (!ok) process.exitCode = 1
  }
  const oneLine = (text) => typeof text === 'string' && text.length > 0 && !text.includes('\n')

  // A burst of clicks is one press: the first one is answered by the document going away, and the
  // nine that arrive while it runs join it instead of starting nine presses.
  {
    const page = await stablePage()
    await page.pressTimes(10)
    check('ten clicks in one burst rebuild the page once', page.navved() === 1, String(page.navved()))
    check('and the host is asked to replace the plugins once', page.count('/dsh-unlag/reload') === 1, String(page.count('/dsh-unlag/reload')))
    check('the extra clicks are told the press is already running', /already|applying|进行/u.test(String(page.notice())), String(page.notice()))
  }

  // A click while the host is still replacing joins the press in flight: two replacements would
  // leave the page on a set nobody asked for.
  {
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const page = await stablePage({ holdReload: gate })
    const first = page.button().props.onClick()
    await sleep()
    await page.button().props.onClick()
    page.instance().flush()
    check('a click during an in-flight press starts no second replacement', page.count('/dsh-unlag/reload') === 1, String(page.count('/dsh-unlag/reload')))
    check('and it says the press is already running', /already|applying|进行/u.test(String(page.notice())), String(page.notice()))
    release()
    await settleDrain(page)
    await page.press()
    check('the joined click did not queue a second rebuild', page.navved() === 1, String(page.navved()))
    await first
  }

  // A host that cannot verify the startup list: the press is held with a reason, and the very next
  // press, with the list healthy, goes through.
  {
    const page = await stablePage({ verifyAnswers: ['failed', 'failed', 'failed', 'ok'] })
    await page.press()
    check('a startup list the host cannot verify holds the press', page.navved() === 0, String(page.navved()))
    check('and the notice is one line', oneLine(page.notice()), JSON.stringify(page.notice()))
    check('the held press says why without naming an implementation',
      !/fetch|POST|verify|timeout|ms\b|storage/iu.test(String(page.notice())), String(page.notice()))
    check('a held press writes no pacing stamp', page.stamp() === null, JSON.stringify(page.stamp()))
    await page.press()
    check('the retry after the held press rebuilds', page.navved() === 1, String(page.navved()))
    check('and the retry reported the rebuild once', page.reports('rebuild') === 1, String(page.reports('rebuild')))
  }

  // The button is never disabled, never greyed out, and never loses its click: a press that could
  // not finish still leaves something to click.
  {
    const page = await stablePage({ settings: { plugins: true, page: false } })
    await page.press()
    const target = page.button()
    check('a press with nothing switched on leaves the button clickable', typeof target.props.onClick === 'function')
    check('and the button is never disabled', target.props.disabled === undefined, String(target.props.disabled))
    check('and the button is not greyed out', (target.props.style?.opacity ?? 1) > 0.6, String(target.props.style?.opacity))
    check('and it says what to switch on', oneLine(page.notice()), JSON.stringify(page.notice()))
    check('and the page stayed', page.navved() === 0, String(page.navved()))
  }

  // Storage that throws is a page that cannot pace presses. It may cost the pacing, never the press.
  {
    const page = await stablePage({ storageThrows: true })
    let threw = false
    try {
      await page.press()
    } catch {
      threw = true
    }
    check('a page whose storage throws still presses', threw === false && page.navved() === 1, `${threw} ${page.navved()}`)
    check('and no uncaught error reaches the page', page.errors.length === 0, String(page.errors.length))
  }

  // The notice timer is the one thing on the page besides the button: it must be cleared when the
  // document goes, or a dead page keeps writing to state it no longer owns.
  {
    const page = await stablePage({ settings: { plugins: true, page: false } })
    await page.press()
    check('a press that stays puts the notice on a timer', page.timerCount() >= 1, String(page.timerCount()))
    page.unmount()
    const late = page.instance().lateUpdates
    await page.advance(9000)
    check('unmounting clears the notice timer', page.timerCount() === 0, String(page.timerCount()))
    check('and nothing writes to the unmounted page', page.instance().lateUpdates === late, `${late} -> ${page.instance().lateUpdates}`)
  }

  console.log(out.join('\n'))
  process.exit(process.exitCode ?? 0)

  async function settleDrain(page) {
    for (let tick = 0; tick < 200; tick += 1) await sleep()
    page.instance()?.flush()
    await sleep()
    page.instance()?.flush()
  }
}
