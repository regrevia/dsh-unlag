import { appendFileSync, existsSync, readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
export const inject = { optional: ['hmr', 'webServer'] }

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
      const path = join(baseDir, spec.replace(/^(link|file):/u, ''))
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
  const hmr = ctx.get('hmr')
  const available =
    hmr !== undefined && hmr !== null && typeof hmr.reconcileProfile === 'function' && typeof hmr.runExclusive === 'function'
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
  const reload = async () => {
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
      deferrals = 0
      lastRun = Date.now()
      running = true
      await reload()
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
   * The button path: run now and report what happened, so the page can tell the user why the
   * press did not replace anything instead of looking broken.
   * @returns 'done' | 'busy' | 'unavailable' | 'failed'
   */
  const reloadNow = async () => {
    if (!available) return 'unavailable'
    if (running) return 'busy'
    if (busy()) return 'busy'
    const wait = lastRun + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 2000)))
    if (running) return 'busy'
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = true
    deferrals = 0
    lastRun = Date.now()
    try {
      await reload()
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
    if (!available) {
      log('plugin reload is unavailable: the hmr entry is not running')
      return null
    }
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

  return { reloadNow, startWatching }
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
    if (config?.plugins === 'off') log('file watching is off')
    else globalThis[WATCHER_KEY] = controller.startWatching()
    globalThis[ROUTES_KEY] = serveButton(ctx, controller, config ?? {})

    ctx.on('dispose', () => {
      closeAll(globalThis[WATCHER_KEY])
      closeAll(globalThis[ROUTES_KEY])
      globalThis[WATCHER_KEY] = null
      globalThis[ROUTES_KEY] = null
    })
  } catch (error) {
    log(`plugin reload did not start: ${error?.message ?? error}`)
  }
}
