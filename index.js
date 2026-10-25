import { appendFileSync, existsSync, readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * One header button, three ways new code reaches the running app:
 *
 * - Plugins (this half): a saved file below a watched development root replaces the affected
 *   plugin in place. The page is not rebuilt, so drafts, queued messages and running turns stay.
 * - Interface (client half): the header button rebuilds the page once and keeps the session.
 * - Both at once: the button asks this half to replace the changed plugins first, then the client
 *   half rebuilds the interface, so one press leaves neither half on old code. Either half can be
 *   switched off in the plugin's settings row; with both off a press does nothing.
 *
 * This half is written so that no path here can end the app: every callback body is inside a
 * `try`, every failure is written to a log and dropped, and the reload itself waits for idle
 * agents and refuses to re-enter. A plugin that cannot start is worse than a plugin that does
 * nothing, because the desktop shell treats a failed startup entry as fatal.
 */
export const name = 'dsh-unlag'
/**
 * Cordis has no optional injection: every key of an object declaration is read as a required
 * service name, so `{ optional: [...] }` waits forever for a service called "optional". Declare
 * only the web server, which any interface that can show the button has, and look the reload
 * service up per use instead so a disabled reloader costs the plugin half, not the whole entry.
 */
export const inject = ['webServer']

const LOG_PATH = join(homedir(), '.dsh', 'unlag-reload.log')
/** Survives a module replacement, so a reload cannot leave a second watcher behind. */
const WATCHER_KEY = Symbol.for('dsh-unlag.watchers')
/** The same, for the HTTP entry points the header button calls. */
const ROUTES_KEY = Symbol.for('dsh-unlag.routes')
const BASE_PATH = '/dsh-unlag'
/** A same-origin page sets this itself; a cross-site form post cannot, and fails the preflight. */
const BUTTON_HEADER = 'x-dsh-unlag'
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
/** Build output and dependency trees change without the source a developer edits changing. */
const IGNORED_PATH = /(^|\/)(node_modules|\.git|\.cache|dist|build|coverage)([./]|$)/u
const DEFAULT_ROOTS = [join(homedir(), '.dsh', 'plugins')]
/** A turn that never goes idle must not turn this into an endless poll. */
const MAX_DEFERRALS = 40
const MIN_INTERVAL_MS = 1500

/**
 * The two rows this plugin shows in Settings, in the schema dialect the settings form reads.
 * Both default on: a press then leaves nothing on old code.
 */
const SCHEMA = {
  uid: 6, // ui-copy-ignore
  refs: {
    2: { type: 'boolean', meta: { default: true, description: '按下刷新时换掉插件代码' } }, // ui-copy-ignore
    5: { type: 'boolean', meta: { default: true, description: '按下刷新时重建界面' } }, // ui-copy-ignore
    6: { type: 'object', meta: { default: {} }, dict: { reloadPlugins: 2, reloadInterface: 5 } }, // ui-copy-ignore
  },
}

/** The same rows as plain nodes, which is the shape the settings form projects values through. */
const FIELDS = {
  reloadPlugins: { type: 'boolean', meta: { default: true, description: '按下刷新时换掉插件代码' } },
  reloadInterface: { type: 'boolean', meta: { default: true, description: '按下刷新时重建界面' } },
}

/**
 * Exported as the row's Config so Settings can show the two switches. Validation never throws:
 * an unreadable value falls back to the default instead of failing the startup entry, because a
 * rejected config here would take the whole app down at boot.
 */
export const Config = {
  ...SCHEMA,
  type: 'object', // ui-copy-ignore
  dict: FIELDS, // ui-copy-ignore
  meta: { default: {} }, // ui-copy-ignore
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1, // ui-copy-ignore
    vendor: 'dsh-unlag', // ui-copy-ignore
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return { value: { ...source, ...settingsOf(source) } }
    },
  },
}

/** The two switches, defaulted on, from any config shape. */
function settingsOf(config) {
  return {
    reloadPlugins: config?.reloadPlugins !== false,
    reloadInterface: config?.reloadInterface !== false,
  }
}

function log(line) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function closeAll(closer) {
  if (typeof closer === 'function') {
    try {
      closer()
    } catch {}
  }
}

/** Development roots the profile links by path; a packaged dependency is not watched. */
function linkedRoots(baseDir) {
  const roots = []
  try {
    const manifest = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8'))
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !/^(link|file):/u.test(spec)) continue
      const path = resolve(baseDir, spec.replace(/^(link|file):/u, ''))
      if (existsSync(path)) roots.push(path)
      else log(`skip ${name}: ${path} is missing`)
    }
  } catch (error) {
    log(`cannot read the profile manifest: ${error?.message ?? error}`)
  }
  return roots
}

/** Whether a watched path is worth a reload: source only, and never this log. */
function worthReloading(filename) {
  const name = typeof filename === 'string' ? filename : ''
  if (name === '') return false
  if (!CODE_EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) return false
  return !IGNORED_PATH.test(name)
}

/**
 * The plugin half. One controller serves both callers: a saved file (debounced) and the header
 * button (immediate). Neither ever replaces code while a turn is running, and neither re-enters.
 */
function pluginReloader(ctx, config) {
  /** HMR can start after this half, so ask per use instead of once at load. */
  const hmrService = () => {
    const hmr = ctx.get('hmr')
    if (hmr === null || typeof hmr?.reconcileProfile !== 'function' || typeof hmr?.runExclusive !== 'function') return null
    return hmr
  }
  const available = () => hmrService() !== null
  const idleOnly = config?.idleOnly !== false
  const debounce = Number.isFinite(config?.debounce) ? config.debounce : 300

  let timer = null
  let running = false
  let again = false
  let deferrals = 0
  let lastRun = 0

  const busy = () => {
    if (!idleOnly) return false
    try {
      const agents = ctx.get('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      return Array.isArray(list) && list.some((agent) => agent?.status !== 'idle')
    } catch {
      return false
    }
  }

  /** Ask the HMR service to recompose; it throws rather than half-applying, so a catch is enough. */
  const reload = async (hmr) => {
    const result = await hmr.runExclusive(() => hmr.reconcileProfile([]))
    const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0
    const pending = Array.isArray(result?.pending) ? result.pending.length : 0
    const suffix = typeof result?.restartReason === 'string' ? ` restart=${result.restartReason}` : ''
    log(`plugins reloaded (warnings=${warnings} pending=${pending}${suffix})`)
  }

  const flush = async () => {
    timer = null
    if (running) {
      again = true
      return
    }
    try {
      if (busy()) {
        deferrals += 1
        if (deferrals > MAX_DEFERRALS) {
          deferrals = 0
          log('reload skipped: agents never went idle')
          return
        }
        timer = setTimeout(() => void flush(), 500)
        return
      }
      const wait = lastRun + MIN_INTERVAL_MS - Date.now()
      if (wait > 0) {
        timer = setTimeout(() => void flush(), wait)
        return
      }
      const hmr = hmrService()
      if (hmr === null) return
      deferrals = 0
      lastRun = Date.now()
      running = true
      await reload(hmr)
    } catch (error) {
      log(`reload failed, the previous code keeps running: ${error?.message ?? error}`)
    } finally {
      running = false
      if (again) {
        again = false
        if (timer === null) timer = setTimeout(() => void flush(), debounce)
      }
    }
  }

  const schedule = (filename) => {
    try {
      if (!worthReloading(filename)) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void flush(), debounce)
    } catch (error) {
      log(`ignored a watch event: ${error?.message ?? error}`)
    }
  }

  /**
   * One press is enough. A press that lands during a running turn waits for a quiet moment, and
   * after a short grace reloads anyway: swapping code never interrupts a turn, it only hands the
   * next step newer code. Waiting forever would leave busy machines with a dead button.
   */
  const WAIT_MAX_MS = Number.isFinite(config?.busyWaitMs) ? Math.max(0, config.busyWaitMs) : 60_000
  let queued = null
  const queueReload = () => {
    if (queued !== null) return 'queued'
    const started = Date.now()
    const tick = () => {
      queued = null
      if (running) {
        queued = setTimeout(tick, 500)
        return
      }
      if (busy() && Date.now() - started < WAIT_MAX_MS) {
        queued = setTimeout(tick, 1000)
        return
      }
      if (busy()) log('reloading while turns are still running; they keep running')
      void reloadNow(true)
    }
    queued = setTimeout(tick, 1000)
    return 'queued'
  }

  /**
   * The button path: run now and report what happened, so the page can tell the user why the
   * press did not replace anything instead of looking broken.
   * @returns 'done' | 'queued' | 'unavailable' | 'failed'
   */
  const reloadNow = async (force = false) => {
    const hmr = hmrService()
    if (hmr === null) return 'unavailable'
    if (running || (force === false && busy())) return queueReload()
    const wait = lastRun + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 2000)))
    if (running || (force === false && busy())) return queueReload()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = true
    deferrals = 0
    lastRun = Date.now()
    try {
      await reload(hmr)
      return 'done'
    } catch (error) {
      log(`reload failed, the previous code keeps running: ${error?.message ?? error}`)
      return 'failed'
    } finally {
      running = false
      again = false
    }
  }

  /** Watch the development roots; a missing or unreadable root is logged, never fatal. */
  const startWatching = () => {
    const hmr = hmrService()
    if (hmr === null) return null
    const configured = Array.isArray(config?.roots) ? config.roots.filter((root) => typeof root === 'string') : []
    const roots = [...new Set([...configured, ...linkedRoots(hmr.baseDir ?? process.cwd()), ...DEFAULT_ROOTS])]
    const closers = []
    let watching = 0
    for (const root of roots) {
      try {
        if (statSync(root).isDirectory() === false) continue
        const closer = watch(root, { recursive: true }, (_event, filename) => schedule(filename))
        closer.on?.('error', (error) => log(`watch ${root} stopped: ${String(error?.message ?? error)}`))
        closers.push(() => closer.close())
        watching += 1
      } catch (error) {
        log(`cannot watch ${root}: ${error?.message ?? error}`)
      }
    }
    log(`watching ${watching} package dir(s)`)
    return () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      for (const close of closers) closeAll(close)
    }
  }

  const stop = () => {
    if (queued !== null) clearTimeout(queued)
    queued = null
  }

  return { reloadNow, startWatching, available, stop }
}

/** Write one JSON answer; a response already gone must not throw into the caller. */
function sendJson(res, status, payload) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {}
}

/**
 * The two entry points the header button calls. Both answer with the current switches so the page
 * never guesses: with both off it does nothing, and a busy turn is reported rather than ignored.
 */
function serveButton(ctx, controller, config) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    log('no web server: the header button cannot ask for a reload')
    return null
  }
  const settings = settingsOf(config)
  const handlers = [
    [
      `${BASE_PATH}/state`,
      (_req, res) => {
        sendJson(res, 200, { plugins: settings.reloadPlugins, page: settings.reloadInterface })
      },
    ],
    [
      `${BASE_PATH}/reload`,
      async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
        const header = req?.headers?.[BUTTON_HEADER]
        if (typeof header !== 'string' || header === '') return sendJson(res, 403, { status: 'forbidden' })
        if (!settings.reloadPlugins) return sendJson(res, 200, { status: 'off' })
        const status = await controller.reloadNow()
        sendJson(res, 200, { status })
      },
    ],
  ]
  const disposers = []
  for (const [path, handler] of handlers) {
    try {
      const dispose = server.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`cannot answer ${path}: ${error?.message ?? error}`)
    }
  }
  return () => {
    for (const dispose of disposers) closeAll(dispose)
  }
}

export function apply(ctx, config) {
  try {
    closeAll(globalThis[WATCHER_KEY])
    closeAll(globalThis[ROUTES_KEY])
    globalThis[WATCHER_KEY] = null
    globalThis[ROUTES_KEY] = null

    const controller = pluginReloader(ctx, config ?? {})
    /** Watching needs HMR; start as soon as it exists, drop the watcher when it goes away. */
    const syncWatching = () => {
      if (config?.plugins === 'off') return
      if (controller.available() === false) {
        closeAll(globalThis[WATCHER_KEY])
        globalThis[WATCHER_KEY] = null
        return
      }
      if (globalThis[WATCHER_KEY] !== null) return
      globalThis[WATCHER_KEY] = controller.startWatching()
    }
    if (config?.plugins === 'off') log('file watching is off')
    else {
      syncWatching()
      if (globalThis[WATCHER_KEY] === null) log('plugin reload is unavailable: the hmr entry is not running')
    }
    if (typeof ctx.on === 'function') {
      ctx.on('internal/service', (service) => {
        if (service === 'hmr') syncWatching()
      })
    }
    globalThis[ROUTES_KEY] = serveButton(ctx, controller, config ?? {})

    ctx.on('dispose', () => {
      controller.stop()
      closeAll(globalThis[WATCHER_KEY])
      closeAll(globalThis[ROUTES_KEY])
      globalThis[WATCHER_KEY] = null
      globalThis[ROUTES_KEY] = null
    })
  } catch (error) {
    log(`plugin reload did not start: ${error?.message ?? error}`)
  }
}
