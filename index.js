import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'

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

/** A transaction that has not finished in this long is stuck; the press reports it instead of hanging. */
const RELOAD_TIMEOUT_MS = 20_000
/**
 * How long a press waits for an answer before it is told the update is still applying. The page
 * gives up on its own request sooner than the update may take, and a press that ends in "did not
 * finish" while the plugin set is still being replaced is a lie the person cannot check.
 */
const RELOAD_ANSWER_MS = 10_000


const LOG_PATH = join(homedir(), '.dsh', 'unlag-reload.log')
/** Past this many bytes the log starts over: it records recent presses, not an archive. */
const LOG_MAX_BYTES = 1_000_000 // ui-copy-ignore

/** Which version this half is running: the only way to tell a reloaded half from a stale one. */
const VERSION = (() => {
  try {
    const raw = readFileSync(new URL('./package.json', import.meta.url), 'utf8') // ui-copy-ignore
    return String(JSON.parse(raw)?.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
})()

/**
 * When this file was last written. The version alone can name a package whose host half was never // ui-copy-ignore
 * reloaded — the loader keeps a module it already loaded — and this is what tells the two apart.
 */
const CODE_STAMP = (() => {
  try {
    return statSync(new URL('./index.js', import.meta.url)).mtime.toISOString() // ui-copy-ignore
  } catch {
    return 'unknown'
  }
})()
let logWrites = 0
/** Tests point this at a scratch file, so a test run leaves the live log readable. */
const logTarget = () => process.env.DSH_UNLAG_LOG ?? LOG_PATH
/** Survives a module replacement, so a reload cannot leave a second watcher behind. */
const WATCHER_KEY = Symbol.for('dsh-unlag.watchers')
/** The same, for the HTTP entry points the header button calls. */
const ROUTES_KEY = Symbol.for('dsh-unlag.routes')
/** The queue request this plugin is waiting on, shared across a replacement of this plugin. */
const WORK_KEY = Symbol.for('dsh-unlag.work')
const BASE_PATH = '/dsh-unlag'
/** A same-origin page sets this itself; a cross-site form post cannot, and fails the preflight. */
const BUTTON_HEADER = 'x-dsh-unlag'
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
/** Build output and dependency trees change without the source a developer edits changing. */
const IGNORED_PATH = /(^|\/)(node_modules|\.git|\.cache|dist|build|coverage)([./]|$)/u
/** The same trees by directory name, so they are not walked at all instead of walked and skipped. */
const IGNORED_DIR = /^(node_modules|\.git|\.cache|dist|build|coverage|\.next|\.turbo)$/u
/**
 * A test edit does not change what a running plugin does, so it is not a reason to restart the
 * plugin set. A development session runs its tests far more often than it changes source.
 */
const TEST_PATH = /(^|\/)(test|tests|__tests__|__mocks__)(\/|$)|[.-](test|spec)\.[cm]?js$/u
const DEFAULT_ROOTS = [join(homedir(), '.dsh', 'plugins')]
/** A turn that never goes idle must not turn this into an endless poll. */
const MAX_DEFERRALS = 40
const MAX_STARTUP_ROWS = 64
/**
 * The longest one startup address may be. The app folds a whole plugin set into one bundle address,
 * and this profile's largest already measured 2.8 KB: one id list up to MAX_BUNDLE_IDS of normal
 * plugin names is about 5 KB, so a bound below that would drop a sound address — and a script the
 * check never reads is a script nothing proved would load in the next document.
 */
const MAX_STARTUP_ROW_CHARS = 8192
/**
 * The largest one startup script may be before a check refuses it. The app serves a whole profile as
 * a few bundles, and those grow with every installed plugin: one profile's largest bundle measured
 * 8.7 MB, which a smaller bound refused as if it were an attack and left the page unrebuildable.
 * A body past this bound is a mistake or an attempt to make a check read (and compile) an unbounded
 * amount of text inside the process that owns every running turn.
 */
const MAX_SCRIPT_BYTES = 64 * 1024 * 1024
/**
 * The same bound for one whole startup list, so a list of large bodies cannot add up either. Only
 * the compile happens under it: what a check keeps per body is the ids it names, never its text.
 */
const MAX_TOTAL_SCRIPT_BYTES = 128 * 1024 * 1024

/**
 * The most plugin ids one bundle address may name. A real startup list is far below this; a made-up
 * address far above it would otherwise have the plugin read one body per id, and answering a request
 * is work the request itself must not be able to grow without bound.
 */
const MAX_BUNDLE_IDS = 128
/**
 * How long one stale-bundle answer may spend before it gives the request back to the app's own
 * route. Each row is bounded on its own, but a request can name many rows and the route answers
 * whatever a socket asks: without a whole-request bound one made-up address holds a connection for
 * as long as its rows add up.
 */
const MAX_ANSWER_MS = 15_000
/** The same bound for a test that must reach it quickly. */
function answerBudgetMs() {
  const set = Number(process.env.DSH_UNLAG_STALE_MS ?? '')
  return set > 0 ? set : MAX_ANSWER_MS
}
/**
 * How long one startup check may spend reading the list. Each address is bounded on its own, but a
 * list of them is not: dozens of slow addresses would otherwise hold a press past the moment the
 * page gives up waiting, and the person would see a button that did nothing.
 */
const MAX_VERIFY_MS = 9000
const MIN_INTERVAL_MS = 1500
/** The route the app publishes client bundles under; the same key the module table registers. */
const BUNDLE_ROUTE = '/plugins'
/** Marks a route handler already wrapped here, so a plugin reload cannot wrap it twice. */
const SHIM_MARK = Symbol.for('dsh-unlag.bundle-shim')
/** Holds the wrapper across a module replacement, so a reload can put the route back. */
const SHIM_KEY = Symbol.for('dsh-unlag.shim')
/** The instance that currently owns the routes and the shim; a late dispose checks it first. */
const INSTANCE_KEY = Symbol.for('dsh-unlag.instance')

/**
 * The three rows this plugin shows in Settings, in the schema dialect the settings form reads.
 * The two press rows default on, so a press leaves nothing on old code. Automatic reloading
 * defaults off: a file saved by an agent must not swap the plugin set under a running turn, and
 * the press is the one trigger a person chose.
 */
const SCHEMA = {
  uid: 7, // ui-copy-ignore
  refs: {
    2: { type: 'boolean', meta: { default: true, description: '按下刷新时换掉插件代码' } }, // ui-copy-ignore
    5: { type: 'boolean', meta: { default: true, description: '按下刷新时重建界面' } }, // ui-copy-ignore
    7: { type: 'boolean', meta: { default: false, description: '改完文件自动刷新，不必按按钮' } }, // ui-copy-ignore
    6: { type: 'object', meta: { default: {} }, dict: { reloadPlugins: 2, reloadInterface: 5, autoReload: 7 } }, // ui-copy-ignore
  },
}

/** The same rows as plain nodes, which is the shape the settings form projects values through. */
const FIELDS = {
  reloadPlugins: { type: 'boolean', meta: { default: true, description: '按下刷新时换掉插件代码' } },
  reloadInterface: { type: 'boolean', meta: { default: true, description: '按下刷新时重建界面' } },
  autoReload: { type: 'boolean', meta: { default: false, description: '改完文件自动刷新，不必按按钮' } },
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

/**
 * The three switches from any config shape. The press switches default on; automatic reloading
 * defaults off, and the undocumented `plugins: 'off'` from older configs keeps meaning off.
 */
function settingsOf(config) {
  return {
    reloadPlugins: config?.reloadPlugins !== false,
    reloadInterface: config?.reloadInterface !== false,
    autoReload: config?.plugins === 'off' ? false : config?.autoReload === true,
  }
}

/**
 * One log line, whatever the message. An address, a plugin id or an error can carry a line break,
 * and a forged line in a file that is read as evidence is worse than a missing one; a message can
 * also be arbitrarily long, and the log is one line per event.
 */
export function oneLine(value, limit = 2000) {
  const text = String(value ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ')
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text
}

function log(line) {
  try {
    const target = logTarget()
    // A file that only grows eventually costs the app its own memory budget: every 200 lines the
    // size is checked once, and a log past the cap starts over instead of growing without end.
    logWrites += 1
    if (logWrites % 200 === 1) {
      try {
        if (statSync(target).size > LOG_MAX_BYTES) writeFileSync(target, '')
      } catch {
        /* a missing or unreadable log is created by the append below */
      }
    }
    appendFileSync(target, `${new Date().toISOString()} ${oneLine(line)}\n`)
  } catch {}
}

function closeAll(closer) {
  if (typeof closer === 'function') {
    try {
      closer()
    } catch {}
  }
}

/**
 * One line for the source a reload would act on: the same files, the same sizes, the same times.
 * A watch event that arrives without any of that changing (a log beside a plugin, a save that
 * wrote back the same bytes, a burst of events for one edit) is not a reason to swap anything,
 * and swapping anyway is what put eleven applies next to a running turn.
 */
function fingerprintOf(roots) {
  const rows = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of names) {
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        // A dependency or build tree can hold tens of thousands of files, and stat-ing them on
        // every watch event blocks the event loop every running turn needs.
        if (IGNORED_DIR.test(item.name)) continue
        walk(path, depth + 1)
        continue
      }
      if (item.isFile() === false || !worthReloading(path)) continue
      try {
        const stat = statSync(path)
        rows.push(`${path}\u0000${stat.size}\u0000${stat.mtimeMs}`)
      } catch {}
    }
  }
  for (const root of roots) walk(root, 0)
  rows.sort()
  return createHash('sha1').update(rows.join('\u0001')).digest('hex')
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
  if (IGNORED_PATH.test(name) || TEST_PATH.test(name)) return false
  return true
}

/**
 * The plugin half. One controller serves both callers: a saved file (debounced) and the header
 * button (immediate). A swap never waits for turns, never interrupts them, and never re-enters.
 */
/**
 * The service keeps its transaction context in an AsyncLocalStorage on the instance. Resolve it by
 * type as well as by name, so a renamed field still works; the name stays the fast path.
 */
function transactionContext(service) {
  try {
    if (typeof service?.executing?.exit === 'function') return service.executing
    for (const value of Object.values(service ?? {})) if (value instanceof AsyncLocalStorage) return value
  } catch {}
  return null
}

function pluginReloader(ctx, config) {
  /** HMR can start after this half, so ask per use instead of once at load. */
  const hmrService = () => {
    const hmr = ctx.get('hmr')
    if (hmr === null || typeof hmr?.reconcileProfile !== 'function' || typeof hmr?.runExclusive !== 'function') return null
    return hmr
  }
  const available = () => hmrService() !== null
  /** Opt-in: wait for a quiet moment instead of swapping at once. Off by default. */
  const idleOnly = config?.idleOnly === true
  const debounce = Number.isFinite(config?.debounce) ? config.debounce : 300
  /**
   * How long a saved file waits for the rest of its burst. Editors write a file more than once and
   * an agent saves a set of files in a row; a swap per write restarts the plugin set under the
   * user's feet, so the watcher waits for the writes to stop instead of racing them. A press is
   * never delayed by this.
   */
  /** How close together two applies may land; one apply restarts the whole plugin set. */
  const minInterval = Number.isFinite(config?.minIntervalMs) ? Math.max(0, config.minIntervalMs) : MIN_INTERVAL_MS
  const settle = Number.isFinite(config?.settleMs)
    ? Math.max(0, config.settleMs)
    : Math.max(debounce, Math.min(1200, debounce * 4))

  let timer = null
  let running = false
  /**
   * The queue request this plugin is still waiting on, so a timeout is not reported as a cancel.
   * It lives outside this closure: replacing this plugin builds a new closure, and
   * a press landing after that must still join the update the first press started rather than queue
   * a second one beside it.
   */
  const workState = (globalThis[WORK_KEY] ??= { current: null })
  let again = false
  let deferrals = 0
  let lastRun = 0
  /** The source the last successful reload applied, so an unchanged save costs nothing. */
  let lastStamp = null
  /** The roots the watcher covers; empty when watching never started. */
  let watchRoots = []
  /** Whether the pending flush came from a saved file rather than from the button. */
  let fromWatch = false
  /** The file named by the newest watch event, so a reload can say what caused it. */
  let lastChange = ''

  const turnsRunning = () => {
    try {
      const agents = ctx.get('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      return Array.isArray(list) && list.some((agent) => agent?.status !== 'idle')
    } catch {
      return false
    }
  }
  const busy = () => idleOnly && turnsRunning()

  /**
   * Ask the HMR service to recompose through its own queue. The service throws instead of
   * half-applying, so a catch is enough. Another reload may already hold the transaction (a save
   * landing next to a session's own swap), so a nested refusal waits and asks again through the
   * same queue. It never recomposes outside the queue: two recompositions at once can leave half
   * the plugin set stopped, and a document started in that state does not boot.
   * @returns what the service reported, so the caller can tell done from partly done.
   */
  const reload = async (hmr) => {
    /**
     * Queue the recomposition through the service's own queue. A watcher callback created while a
     * reload was restarting this plugin inherits that reload's context, and the service reads any
     * request made from that context as a nested one even though the transaction is over. Leaving
     * that context first is what the service's own watcher does, and it keeps the request queued
     * instead of running a second recomposition beside the first.
     */
    const context = transactionContext(hmr)
    const ask = (service) =>
      context === null
        ? service.runExclusive(() => service.reconcileProfile([]))
        : context.exit(() => service.runExclusive(() => service.reconcileProfile([])))
    const abandoned = () =>
      new Promise((_resolve, reject) => {
        const limit = Number(process.env.DSH_UNLAG_TIMEOUT_MS ?? '') || RELOAD_TIMEOUT_MS
        const timer = setTimeout(() => reject(new Error('the plugin update did not finish in time')), limit)
        timer.unref?.()
      })
    /**
     * The queue request itself keeps running after this plugin stops waiting for it. It is tracked
     * so a timeout is reported as still applying, never as a failed update that later fires anyway.
     */
    const tracked = (request) => {
      workState.current = request
      const settle = () => {
        if (workState.current === request) workState.current = null
      }
      request.then(settle, settle)
      return request
    }
    /** Whether the bundle route was wrapped when this update started, so a re-wrap is written down. */
    const shimWrappedBefore = bundleShimStatus(ctx).wrapped
    let result = null
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await Promise.race([tracked(ask(hmr)), abandoned()])
        break
      } catch (error) {
        const message = String(error?.message ?? error)
        if (message.includes('nested')) {
          if (attempt >= 9) throw error
          const step = Number(process.env.DSH_UNLAG_RETRY_MS ?? '') || 250
          await new Promise((resolve) => setTimeout(resolve, step * (attempt + 1)))
          continue
        }
        if (message.includes('did not finish in time')) {
          error.stillRunning = workState.current !== null
          throw error
        }
        throw error
      }
    }
    /**
     * A recomposition can leave the bundle route owned by a fresh handler. A page started from the
     * launch-time list is then answered by the app's own 404 for a stale set, and the desktop shell
     * treats such an entry as fatal — it exits and takes every running turn with it. Wrapping again
     * here means the time between an update and the next press is never left unwrapped.
     */
    try {
      ensureBundleShim(ctx)
      if (bundleShimStatus(ctx).wrapped !== true) log('the bundle route is not wrapped after the update; a page started now may not boot')
      else if (shimWrappedBefore !== true) log('the bundle route was wrapped again after the update')
    } catch (error) {
      log(`cannot wrap the bundle route after the update: ${error?.message ?? error}`)
    }
    const warnings = Array.isArray(result?.warnings) ? result.warnings : []
    const pending = Array.isArray(result?.pending) ? result.pending : []
    const restartReason = typeof result?.restartReason === 'string' ? result.restartReason : null
    /**
     * A reconciliation that returns without throwing can still have left part of the set unready, and
     * the app names each such entry in `warnings`. An earlier test decided by English words inside
     * that sentence, which missed "pending (waiting for service: addonService)" and invented failures
     * out of harmless prose. The warning itself is the app saying an entry is not serving the page, so
     * every warning counts and the sentence is passed on as it reads.
     */
    /**
     * These are the entries that were already not running before this press: the app rejects a
     * reload that newly breaks an entry, so nothing in this list is a result of the press. They are
     * written down because a person sees them afterwards, and they must not stop the page from
     * coming up on the set that is running now.
     */
    const inactiveEntries = warnings.map((warning) => (typeof warning === 'string' ? warning : String(warning?.message ?? warning)))
    log(
      `plugins reloaded (inactive before this press=${inactiveEntries.length} pending=${pending.length}${restartReason === null ? '' : ` restart=${restartReason}`})`,
    )
    for (const entry of inactiveEntries.slice(0, 5)) log(`a plugin was already not running and still is not: ${entry.slice(0, 200)}`)
    if (inactiveEntries.length > 5) log(`and ${inactiveEntries.length - 5} more were already not running`)
    return { status: 'done', warnings, pending, restartReason, inactiveEntries, failedEntries: [] }
  }

  const flush = async () => {
    timer = null
    // A queue request that outlived its wait is still applying: a second flush would ask the plugin
    // set to recompose beside it, which can leave half of it stopped.
    if (running || workState.current !== null) {
      again = true
      return
    }
    try {
      if (busy()) {
        deferrals += 1
        if (deferrals > MAX_DEFERRALS) {
          deferrals = 0
          log('reloading while turns are still running; they keep running')
        } else {
          timer = setTimeout(() => void flush(), 500)
          return
        }
      }
      const wait = lastRun + minInterval - Date.now()
      if (wait > 0) {
        timer = setTimeout(() => void flush(), wait)
        return
      }
      const hmr = hmrService()
      if (hmr === null) return
      const watched = fromWatch
      fromWatch = false
      /**
       * A saved file that did not change anything a reload would apply is not applied again: the
       * watcher reports more events than edits (one save can deliver several), and each apply
       * restarts the whole plugin set next to whatever the user is doing.
       */
      const stamp = watchRoots.length === 0 ? null : fingerprintOf(watchRoots)
      if (watched && stamp !== null && stamp === lastStamp) {
        log(`a change to ${lastChange || 'a watched file'} left the plugin set as it is; nothing applied`)
        return
      }
      if (watched && lastChange !== '') log(`auto reload after a change to ${lastChange}`)
      deferrals = 0
      lastRun = Date.now()
      running = true
      try {
        await reload(hmr)
        if (stamp !== null) lastStamp = stamp
      } finally {
        // The wait can end while its queue request is still applying. Staying busy keeps a press
        // from queueing a second update, and the release clears the flag when that request ends.
        if (workState.current === null) running = false
        else {
          const release = () => {
            running = false
            if (again) {
              again = false
              if (timer === null) timer = unrefTimer(setTimeout(() => void flush(), debounce))
            }
          }
          workState.current.then(release, release)
        }
      }
    } catch (error) {
      log(`reload did not finish; the plugin set may be partly applied: ${error?.message ?? error}`)
    } finally {
      if (again) {
        again = false
        if (timer === null) timer = unrefTimer(setTimeout(() => void flush(), debounce))
      }
    }
  }

  /** A timer here must not keep the app alive on its own once this plugin is done. */
  const unrefTimer = (handle) => {
    handle?.unref?.()
    return handle
  }

  const schedule = (filename) => {
    try {
      if (stopped) return
      if (!worthReloading(filename)) return
      fromWatch = true
      lastChange = String(filename).split('/').pop() ?? ''
      if (timer !== null) clearTimeout(timer)
      timer = unrefTimer(setTimeout(() => void flush(), settle))
    } catch (error) {
      log(`ignored a watch event: ${error?.message ?? error}`)
    }
  }

  /**
   * Opt-in (`idleOnly`) quiet-moment mode: wait for a gap, and after a short grace swap anyway,
   * because waiting forever would leave busy machines with a dead button.
   */
  const WAIT_MAX_MS = Number.isFinite(config?.busyWaitMs) ? Math.max(0, config.busyWaitMs) : 60_000
  let queued = null
  let stopped = false
  const queueReload = () => {
    if (stopped) return 'unavailable'
    if (queued !== null) return 'queued'
    const started = Date.now()
    const tick = () => {
      queued = null
      if (stopped) return
      if (running) {
        queued = unrefTimer(setTimeout(tick, 500))
        return
      }
      if (busy() && Date.now() - started < WAIT_MAX_MS) {
        queued = unrefTimer(setTimeout(tick, 1000))
        return
      }
      if (busy()) log('reloading while turns are still running; they keep running')
      // A rejection here would otherwise vanish: the press already answered, so the log is the only
      // place that can say the update stopped.
      void reloadNow(true).catch((error) => log(`a queued reload could not finish: ${error?.message ?? error}`))
    }
    queued = unrefTimer(setTimeout(tick, 1000))
    return 'queued'
  }

  /** The answer shape a press always gets, whether or not a reload was started. */
  const queuedAnswer = (answer) => ({
    status: answer === 'unavailable' ? 'unavailable' : 'queued',
    warnings: [],
    pending: [],
    restartReason: null,
    failedEntries: [],
  })

  /** A press made while an update is still running joins that update instead of queueing another. */
  const busyAnswer = () => (workState.current !== null ? { status: 'applying', warnings: [], pending: [], restartReason: null, failedEntries: [] } : queuedAnswer(queueReload()))

  /**
   * The button path: run now and report what happened, so the page can tell the user why the
   * press did not replace anything instead of looking broken.
   * @returns {{status: string, warnings: string[], pending: string[], restartReason: string|null}}
   */
  const runNow = async (force = false) => {
    const hmr = hmrService()
    if (hmr === null) return { status: 'unavailable', warnings: [], pending: [], restartReason: null, failedEntries: [] }
    log('manual reload: the refresh button was pressed')
    if (turnsRunning()) log('reloading while turns are still running; they keep running')
    if (running || workState.current !== null || (force === false && busy())) return busyAnswer()
    const wait = lastRun + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 2000)))
    if (running || workState.current !== null || (force === false && busy())) return busyAnswer()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = true
    deferrals = 0
    lastRun = Date.now()
    try {
      const outcome = await reload(hmr)
      /**
       * `pending` means the changed modules are not loaded yet and need a restart this plugin does
       * not perform; it is not a queued update that finishes on its own.
       */
      if (outcome.pending.length > 0 || outcome.restartReason !== null) {
        // The app accepted the update but has not finished starting the new plugin set. Rebuilding
        // the page now would start a document against a set that is still settling.
        return {
          status: 'failed', // ui-copy-ignore
          warnings: outcome.warnings, // ui-copy-ignore
          pending: outcome.pending, // ui-copy-ignore
          restartReason: outcome.restartReason,
          failedEntries: outcome.failedEntries,
        }
      }
      return outcome
    } catch (error) {
      if (error?.stillRunning === true) {
        // The queue still holds the request: it may yet apply, so the press is not called failed.
        return { status: 'applying', warnings: [], pending: [], restartReason: null, failedEntries: [] }
      }
      log(`reload did not finish; the plugin set may be partly applied: ${error?.message ?? error}`)
      return { status: 'failed', warnings: [], pending: [], restartReason: null, failedEntries: [] }
    } finally {
      if (workState.current === null) {
        running = false
        again = false
      } else {
        // Stay busy until the queue request really settles, so a second press joins it.
        const release = () => {
          running = false
          if (again) {
            again = false
            if (timer === null) timer = unrefTimer(setTimeout(() => void flush(), debounce))
          }
        }
        workState.current.then(release, release)
      }
    }
  }

  /**
   * The press path never rejects: a rejection here would be unhandled and end the app, and the page
   * would wait for an answer that never comes.
   */
  const reloadNow = async (force = false) => {
    try {
      return await runNow(force)
    } catch (error) {
      log(`a press could not be answered: ${error?.message ?? error}`)
      return { status: 'failed', warnings: [], pending: [], restartReason: null, failedEntries: [] }
    }
  }

  /** Watch the development roots; a missing or unreadable root is logged, never fatal. */
  const startWatching = () => {
    const hmr = hmrService()
    if (hmr === null) return null
    const configured = Array.isArray(config?.roots) ? config.roots.filter((root) => typeof root === 'string') : []
    const roots = [...new Set([...configured, ...linkedRoots(hmr.baseDir ?? process.cwd()), ...DEFAULT_ROOTS])]
    watchRoots = roots
    lastStamp = fingerprintOf(roots)
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
    stopped = true
    if (queued !== null) clearTimeout(queued)
    queued = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return { reloadNow, startWatching, available, stop }
}

/** Write one JSON answer; a response already gone must not throw into the caller. */
function sendJson(res, status, payload) {
  try {
    if (res.writableEnded === true || res.destroyed === true) return
    let body = ''
    try {
      body = JSON.stringify(payload)
    } catch {
      body = '{"status":"error","detail":"unserializable"}' // ui-copy-ignore
    }
    /**
     * A live graph can hold cycles and a socket can already carry a status: neither may leave the
     * response open, because the page waits on this request and a press would never finish.
     */
    if (res.headersSent === true) {
      res.end()
      return
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      if (res.writableEnded !== true && res.destroyed !== true) res.end()
    } catch {
      /* the socket is already gone */
    }
  }
}

/**
 * A page this machine may have opened: loopback, a private network address, or a `.local` name.
 * A public name that resolves here is the rebinding case, where another site becomes
 * same-origin by pointing at this machine.
 */
const LOCAL_ADDRESS = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/u

/**
 * Whether one request may act for the button. The page sets a header a cross-site form cannot set,
 * a browser sends it only after a preflight this server never allows, and the address check covers
 * the case that bypasses preflight: a page on a public name that resolves to this machine.
 */
function buttonAllowed(req) {
  try {
    const header = req?.headers?.[BUTTON_HEADER]
    if (typeof header !== 'string' || header === '') return false
    const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '' // ui-copy-ignore
    // No address at all is not a browser request; nothing about it can be checked, so the header is
    // the whole gate, exactly as it was for earlier versions.
    if (site !== '' && LOCAL_ADDRESS.test(site) === false) {
      log(`refused a press from ${site}`)
      return false
    }
    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : ''
    if (origin === 'null') return false
    if (origin !== '') {
      let originSite = ''
      try {
        originSite = new URL(origin).host.toLowerCase() // ui-copy-ignore
      } catch {
        return false
      }
      if (originSite !== site) {
        log(`refused a press from ${origin}`)
        return false
      }
    }
    return true
  } catch (error) {
    // The check itself failing is not the same as a refusal, and a silent one hides a bug behind
    // a working-looking 403: leave the real reason in the log.
    log(`cannot check where a press came from: ${error?.message ?? error}`)
    return false
  }
}

/** Read one small JSON request body; anything unreadable answers null instead of hanging. */
function readJsonBody(req, limit = 64 * 1024) {

  return new Promise((resolve) => {
    let size = 0
    let done = false
    const parts = []
    const finish = (value) => {
      if (done === true) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    // A request that opens a body and never finishes it would hold this handler forever.
    const timer = setTimeout(() => {
      finish(null)
      try {
        req.destroy?.()
      } catch {
        /* the request is already gone */
      }
    }, 10000) // ui-copy-ignore
    // A body that never ends must not keep the process alive on its own.
    timer.unref?.()
    try {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          finish(null)
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => {
        if (done === true) return
        try {
          finish(JSON.parse(Buffer.concat(parts).toString('utf8')))
        } catch {
          finish(null)
        }
      })
      req.on('error', () => finish(null))
      req.on('aborted', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

/**
 * The startup list the server would hand the next document, read from the live index injection
 * table. The page's own copy describes the page already running: a plugin swapped since then
 * leaves it naming a module graph that no longer resolves, which is exactly the list a rebuild
 * must not trust.
 */
function liveBootGraph(ctx) {
  try {
    /**
     * The module table's own graph is the list the next document is built from, and reading it has
     * no side effects. The injection table needs a peer for anything page-scoped, so it is not a
     * substitute: a graph that cannot be read stays null and the page holds instead of guessing.
     */
    const modules = ctx.get('clientModules')
    if (typeof modules?.graph === 'function') {
      const graph = modules.graph()
      if (graph !== null && typeof graph === 'object' && Array.isArray(graph.entries)) return graph
      return null
    }
    const server = ctx.get('webServer')
    if (typeof server?.collectIndexInjections !== 'function') return null
    const rows = server.collectIndexInjections({})
    if (!Array.isArray(rows)) return null
    for (const row of rows) {
      if (row?.kind !== 'global') continue
      let value = row.value
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          continue
        }
      }
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value.entries) && Array.isArray(value.batches)) return value
    }
    return null
  } catch (error) {
    log(`cannot read the startup list: ${error?.message ?? error}`)
    return null
  }
}

/**
 * The plugin ids, revision and source-map flag one bundle request names, read from the
 * `??<id>/client.js,…&rev=<rev>` form the startup list uses. A request for a package-local chunk
 * carries a real query string instead and is left alone: it is read from disk, so it is current.
 */
function bundleRequest(rawUrl) {
  const url = String(rawUrl ?? '')
  const start = url.indexOf(`${BUNDLE_ROUTE}/??`)
  if (start < 0) return null
  const rest = url.slice(start + BUNDLE_ROUTE.length + 1)
  const revAt = rest.indexOf('&rev=')
  const target = revAt < 0 ? rest : rest.slice(0, revAt)
  if (!target.startsWith('??')) return null
  const sourceMap = target.endsWith('.map')
  const list = sourceMap ? target.slice(0, -4) : target
  const ids = []
  for (const part of list.slice(2).split(',')) {
    let id = part
    try {
      id = decodeURIComponent(part)
    } catch {}
    id = id.endsWith('/client.js') ? id.slice(0, -'/client.js'.length) : id
    if (id !== '') ids.push(id)
  }
  if (ids.length === 0 || ids.length > MAX_BUNDLE_IDS) return null
  // The same plugin twice in one address is one plugin: read its body once.
  const unique = [...new Set(ids)]
  return { ids: unique, sourceMap, rev: revAt < 0 ? '' : rest.slice(revAt + '&rev='.length) }
}

/**
 * The same plugin set under the revision the running app serves it at. The startup list a
 * document is given names one revision; after a plugin is swapped, that revision stops
 * resolving, and a document that boots from the list is refused by its own module loader. The
 * ids are unchanged, so the set can be re-pointed at the current revision instead.
 */
function currentBundleUrls(graph, request) {
  const wanted = new Set(request.ids)
  const revisions = new Set()
  for (const batch of Array.isArray(graph?.batches) ? graph.batches : []) {
    const entries = Array.isArray(batch?.entries) ? batch.entries : []
    if (entries.length !== request.ids.length) continue
    if (!entries.every((id) => wanted.has(id))) continue
    if (typeof batch.rev === 'string' && batch.rev !== '') revisions.add(batch.rev)
  }
  if (request.ids.length === 1) {
    for (const entry of Array.isArray(graph?.entries) ? graph.entries : []) {
      if (entry?.id !== request.ids[0]) continue
      if (typeof entry.rev === 'string' && entry.rev !== '') revisions.add(entry.rev)
    }
  }
  const list = request.ids.map((id) => `${id}/client.js${request.sourceMap ? '.map' : ''}`).join(',')
  return [...revisions].map((rev) => `${BUNDLE_ROUTE}/??${list}&rev=${rev}`)
}

/**
 * Ask the module table for one bundle at one URL. The newest app takes a standard request object;
 * older ones take the method and address on their own, so both shapes are offered instead of one
 * silently failing on the other.
 */
async function fetchBundleAt(clientModules, url, method) {
  const address = `http://unlag.invalid${url}`
  /**
   * A table that accepts the question and then never answers would hold the request that asked it:
   * the document waits on this script and the page stops. The wait is bounded, and a table that
   * misses it is answered the same way as one that fails.
   */
  const limit = Number(process.env.DSH_UNLAG_FETCH_TIMEOUT_MS ?? '') > 0 ? Number(process.env.DSH_UNLAG_FETCH_TIMEOUT_MS) : 8000
  let timer = null
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the module table did not answer in time')), limit)
  })
  const asked = (async () => {
    if (typeof Request === 'function') {
      try {
        return await clientModules.fetchBundle(new Request(address, { method, headers: {} }))
      } catch (error) {
        if (error?.name !== 'TypeError') throw error
      }
    }
    return clientModules.fetchBundle({ method, url: address })
  })()
  // Whichever side loses the race must still be observed, or its rejection ends the process.
  asked.catch(() => {})
  late.catch(() => {})
  try {
    return await Promise.race([asked, late])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * One plugin's current module body, read back from the table so it can be put in front of a
 * document that expects a grouping the table no longer keeps.
 */
async function currentEntryBody(clientModules, graph, id) {
  const entries = Array.isArray(graph?.entries) ? graph.entries : []
  const entry = entries.find((candidate) => candidate?.id === id)
  const raw = typeof entry?.url === 'string' ? entry.url : ''
  if (raw === '') return null
  const target = raw.startsWith('/') ? raw : `/${raw}`
  const response = await fetchBundleAt(clientModules, target, 'GET')
  if (response.status !== 200) return null
  const body = Buffer.from(await response.arrayBuffer())
  return body.length === 0 ? null : body
}

/**
 * A plugin set from a generation the table no longer groups the same way. An app that started
 * before plugins were installed asks for exactly the sets its document listed; those sets are not
 * kept as sets any more, but every plugin in them is still served on its own. Reading each one and
 * answering with them in the requested order registers exactly the plugins the document expects,
 * so a boot that would otherwise 404 and end the app comes up instead.
 */
async function regroupedBundleAnswer(clientModules, graph, request, deadline = Date.now() + answerBudgetMs()) {
  if (request.sourceMap) return null
  const parts = []
  for (const id of request.ids) {
    if (Date.now() > deadline) return null
    const body = await currentEntryBody(clientModules, graph, id)
    if (body === null) return null
    parts.push(body)
  }
  if (parts.length === 0) return null
  /**
   * Each entry body is a script of its own and need not end where another can begin: an entry
   * that ends in `})` followed by one that starts with an identifier is a syntax error, and a
   * document runs neither. A line holding only `;` between them keeps every body its own
   * statement whatever the two sides end and start with, and leaves each body itself untouched.
   */
  const body = Buffer.concat(parts.flatMap((part, index) => (index === parts.length - 1 ? [part] : [part, Buffer.from('\n;\n')])))
  // A substring proves nothing: an id like "ui" is inside a body registering "ui-conversation".
  // Only ids the assembled script really registers through the loader count as an answer.
  const text = body.toString('utf8')
  if (!request.ids.every((id) => bodyNamesId(text, id))) return null
  return { body, contentType: 'text/javascript; charset=utf-8', ids: request.ids }
}

/**
 * A stale request can name a plugin the profile no longer has at all: it was turned off or removed
 * after the document that asks was made. Every plugin in the request is still served on its own, so
 * the ones that remain are answered and the ones that are gone take a comment's place, which a
 * script can hold without registering anything. The app's own answer here is 404, and a document
 * booting from an old startup list that meets one ends the whole app: a boot that comes up without
 * a plugin it no longer has beats that.
 */
async function survivingBundleAnswer(clientModules, graph, request, deadline = Date.now() + answerBudgetMs()) {
  if (request.sourceMap) return null
  const entries = Array.isArray(graph?.entries) ? graph.entries : []
  const served = new Set(entries.filter((row) => typeof row?.id === 'string').map((row) => row.id))
  const gone = request.ids.filter((id) => !served.has(id))
  if (gone.length === 0) return null
  const parts = []
  for (const id of request.ids) {
    if (Date.now() > deadline) return null
    if (served.has(id)) {
      const body = await currentEntryBody(clientModules, graph, id)
      if (body === null) return null
      parts.push(body)
      continue
    }
    parts.push(Buffer.from(`/* ${id.replace(/[^a-z0-9@/._-]/giu, '')} is not part of the plugin set served now */`))
  }
  if (parts.length === 0) return null
  const body = Buffer.concat(parts.flatMap((part, index) => (index === parts.length - 1 ? [part] : [part, Buffer.from('\n;\n')])))
  return { body, contentType: 'text/javascript; charset=utf-8', ids: request.ids, gone }
}

/**
 * The plugin set one stale request names, answered at the revision the app serves now. Only a body
 * that really contains every plugin it claims is handed back; anything unsure answers null, so the
 * route then behaves exactly as before and an unknown id still ends as a plain 404.
 */
async function currentBundleAnswer(clientModules, method, url, deadline = Date.now() + answerBudgetMs()) {
  const request = bundleRequest(url)
  if (request === null) return null
  const graph = clientModules.graph()
  // A request already at the generation the table serves is the table's to answer.
  if (typeof graph?.rev === 'string' && graph.rev !== '' && request.rev === graph.rev) return null
  const urls = currentBundleUrls(graph, request)
  if (urls.length > 0 && (request.rev === '' || !urls.some((target) => target.endsWith(`&rev=${request.rev}`)))) {
    for (const target of urls) {
      const response = await fetchBundleAt(clientModules, target, 'GET')
      if (response.status !== 200) continue
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length === 0) continue
      if (!request.sourceMap) {
        // Every plugin the request names has to appear in the body as a whole id, not as part of
        // a longer one.
        const text = body.toString('utf8')
        if (!request.ids.every((id) => bodyNamesId(text, id))) continue
      }
      return {
        body,
        contentType: String(response.headers.get('content-type') ?? 'text/javascript; charset=utf-8'),
        ids: request.ids,
      }
    }
  }
  return (await regroupedBundleAnswer(clientModules, graph, request, deadline)) ?? survivingBundleAnswer(clientModules, graph, request, deadline)
}

/** Answer one stale request over the plain request/response route an app registers. */
async function serveCurrentBundle(clientModules, req, res) {
  try {
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return false
    const answer = await currentBundleAnswer(clientModules, method, req?.url)
    if (answer === null) return false
    if (res.writableEnded === true || res.destroyed === true) return true
    res.writeHead(200, {
      'content-type': answer.contentType,
      'cache-control': 'no-store',
      'content-length': String(answer.body.length),
    })
    res.end(method === 'HEAD' ? undefined : answer.body)
    if (Array.isArray(answer.gone) && answer.gone.length > 0) {
      const kept = answer.ids.filter((id) => !answer.gone.includes(id))
      log(
        kept.length === 0
          ? `answered an older set with an empty script in place of ${answer.gone.join(', ')}: the app would have ended on the table's 404`
          : `served ${kept.join(', ')} at the current revision and left out ${answer.gone.join(', ')}: a page asked for an older set`,
      )
    } else {
      log(`served ${answer.ids.join(', ')} at the current revision: a page asked for an older one`)
    }
    return true
  } catch (error) {
    log(`cannot serve a bundle from an older revision: ${error?.message ?? error}`)
    return false
  }
}

/** The revision the table serves one plugin at, or null when the set no longer holds it. */
function entryRevisionFor(graph, rawUrl) {
  let path = ''
  try {
    path = new URL(String(rawUrl ?? ''), 'http://unlag.invalid').pathname
  } catch {
    return null
  }
  if (!path.startsWith(`${BUNDLE_ROUTE}/`)) return null
  const rows = Array.isArray(graph?.entries) ? graph.entries : []
  for (const row of rows) {
    if (typeof row?.id !== 'string' || row.id === '' || typeof row?.rev !== 'string' || row.rev === '') continue
    if (path === `${BUNDLE_ROUTE}/${row.id}` || path.startsWith(`${BUNDLE_ROUTE}/${row.id}/`)) return row.rev
  }
  return null
}

/**
 * Point a request for one plugin's file at the revision the table serves that plugin at.
 *
 * A document and every chunk it later loads ask with the revision they booted from. The table keeps
 * whole documents from the previous generation only, and a chunk is served at exactly the revision of
 * its own entry: asking for one plugin's chunk at the set's revision, or at another plugin's revision,
 * answers 404 and ends a document that already runs. The plugin path alone decides the revision, so
 * only the revision of the file named in the path is replaced; everything else is left alone.
 */
function retargetRevision(url, revision) {
  if (revision === null || typeof url !== 'string') return null
  const match = /([?&])rev=([^&#]*)/u.exec(url)
  if (match !== null && match[2] === revision) return null
  if (match !== null) return `${url.slice(0, match.index)}${match[1]}rev=${revision}${url.slice(match.index + match[0].length)}`
  return `${url}${url.includes('?') ? '&' : '?'}rev=${revision}`
}

/** The same answer over the request-in/response-out route a newer app registers. */
async function serveCurrentBundleResource(clientModules, request) {
  try {
    const method = String(request?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return null
    const answer = await currentBundleAnswer(clientModules, method, request?.url)
    if (answer === null) return null
    if (Array.isArray(answer.gone) && answer.gone.length > 0) {
      const kept = answer.ids.filter((id) => !answer.gone.includes(id))
      log(
        kept.length === 0
          ? `answered an older set with an empty script in place of ${answer.gone.join(', ')}: the app would have ended on the table's 404`
          : `served ${kept.join(', ')} at the current revision and left out ${answer.gone.join(', ')}: a page asked for an older set`,
      )
    } else {
      log(`served ${answer.ids.join(', ')} at the current revision: a page asked for an older one`)
    }
    return new Response(method === 'HEAD' ? null : answer.body, {
      status: 200,
      headers: {
        'content-type': answer.contentType,
        'cache-control': 'no-store',
        'content-length': String(answer.body.length),
      },
    })
  } catch (error) {
    log(`cannot serve a bundle from an older revision: ${error?.message ?? error}`)
    return null
  }
}

/**
 * Wrap the bundle route so a document booting from an older startup list still runs. The route
 * belongs to the module table, and a second registration of the same prefix is refused, so what is
 * already there is wrapped in place and put back on dispose. A newer app registers the route as a
 * request-in/response-out resource instead of a handler, and the dispatch prefers that one, so the
 * shape the app actually registers is the shape wrapped — otherwise the guard would be a no-op.
 */
function serveBundlesAtCurrentRevision(ctx) {
  const server = ctx.get('webServer')
  const clientModules = ctx.get('clientModules')
  if (server?.prefixes?.get === undefined) return null
  if (typeof clientModules?.fetchBundle !== 'function' || typeof clientModules?.graph !== 'function') return null
  const route = server.prefixes.get(BUNDLE_ROUTE)
  if (route === null || route === undefined) return null
  // The mark names the wrapper it belongs to: a route copied from a wrapped one carries a stale
  // mark, and only a mark pointing at the function installed right now means "already wrapped".
  const installed = typeof route.resource === 'function' ? route.resource : route.handler
  if (route[SHIM_MARK] === installed && installed !== undefined) return null
  if (typeof route.resource === 'function') {
    const original = route.resource
    const wrapped = async (request) => {
      /**
       * The table's own answer comes first: it still holds the document generation this page booted
       * from. Only when it has nothing is the same request tried at the revision of the plugin it
       * names, because a chunk is served at its entry's revision and nowhere else.
       */
      const url = String(request?.url ?? '')
      // Same reason as the handler shape below: a rejection here is unhandled and ends the process.
      let retargeted = null
      try {
        retargeted = retargetRevision(url, entryRevisionFor(clientModules.graph(), url))
      } catch (error) {
        log(`cannot read the plugin table for a bundle request: ${error?.message ?? error}`)
      }
      const method = String(request?.method ?? 'GET').toUpperCase()
      let answer = null
      try {
        answer = await original(request)
      } catch (error) {
        log(`cannot answer a bundle request: ${error?.message ?? error}`)
      }
      if (retargeted !== null && (answer === null || answer === undefined || answer.status === 404)) {
        try {
          const next = method === 'GET' || method === 'HEAD' ? new Request(retargeted, { method, headers: request.headers }) : request
          const second = await original(next)
          if (second !== null && second !== undefined) answer = second
        } catch (error) {
          log(`cannot answer a bundle request: ${error?.message ?? error}`)
        }
      }
      if (answer !== null && answer !== undefined && answer.status !== 404) return answer
      try {
        const served = await serveCurrentBundleResource(clientModules, request)
        if (served !== null) return served
      } catch (error) {
        log(`cannot answer a bundle request: ${error?.message ?? error}`)
      }
      return answer
    }
    route.resource = wrapped
    route[SHIM_MARK] = wrapped
    log('bundles asked for under an older revision are answered at the current one')
    return { route, slot: 'resource', original, wrapped }
  }
  if (typeof route.handler !== 'function') return null
  const original = route.handler
  /**
   * The table's own answer is kept, and only a 404 is held back long enough to ask whether the
   * current generation can answer instead; the plugin set is retargeted at the current revision
   * first, so the served document and the chunks it later asks for are one generation.
   */
  const wrapped = async (req, res) => {
    const originalUrl = String(req?.url ?? '')
    // Reading the table can throw while the plugin set is being swapped. This runs inside an async
    // route handler, where a rejection is an unhandled one and takes the whole app with it, so the
    // failure has to end here: answer the request as the table left it and say why in the log.
    let retargeted = null
    try {
      retargeted = retargetRevision(originalUrl, entryRevisionFor(clientModules.graph(), originalUrl))
    } catch (error) {
      log(`cannot read the plugin table for a bundle request: ${error?.message ?? error}`)
    }
    const realWriteHead = res.writeHead
    const realEnd = res.end
    const ask = async (url) => {
      let held = null
      let body
      let failed = false
      if (url !== originalUrl) {
        try {
          req.url = url
        } catch {
          /* a frozen request keeps its own address */
        }
      }
      if (typeof realWriteHead === 'function') {
        res.writeHead = (status, ...rest) => {
          if (status === 404) {
            held = { status, headers: rest[0] }
            return res
          }
          return realWriteHead.call(res, status, ...rest)
        }
      }
      if (typeof realEnd === 'function') {
        res.end = (...args) => {
          if (held !== null) {
            body = typeof args[0] === 'string' || Buffer.isBuffer(args[0]) ? args[0] : ''
            return res
          }
          return realEnd.apply(res, args)
        }
      }
      try {
        await Promise.resolve(original(req, res))
      } catch (error) {
        failed = true
        log(`cannot answer a bundle request: ${error?.message ?? error}`)
      } finally {
        try {
          res.writeHead = realWriteHead
          res.end = realEnd
        } catch {
          /* the response object owns its own shape */
        }
      }
      return { held, body, failed }
    }
    // The table's own answer first: it still holds the generation this page booted from.
    let outcome = await ask(originalUrl)
    if (outcome.held !== null && retargeted !== null) outcome = await ask(retargeted)
    if (outcome.held === null) {
      /**
       * The table started writing and then failed. A body that already sent its status cannot take
       * another one, and a socket left open is a document that waits for a script forever; ending it
       * lets the page see the failure and carry on.
       */
      if (outcome.failed === true) {
        try {
          if (res.headersSent === true && res.writableEnded !== true && res.destroyed !== true) realEnd.call(res)
        } catch {
          /* the response is gone; nothing left to answer */
        }
      }
      return undefined
    }
    // The shim resolves the set from the address the page asked for, not the retried one.
    try {
      req.url = originalUrl
    } catch {
      /* a frozen request keeps its own address */
    }
    let served = false
    try {
      served = await serveCurrentBundle(clientModules, req, res)
    } catch (error) {
      log(`cannot answer a bundle request: ${error?.message ?? error}`)
    }
    if (served === true) return undefined
    try {
      // A body that already wrote a status cannot take another one; ending is what the document
      // needs, and leaving the socket open is what hangs it.
      if (res.headersSent === true) {
        if (res.writableEnded !== true && res.destroyed !== true) realEnd.call(res, outcome.body)
        return undefined
      }
      realWriteHead.call(res, outcome.held.status, outcome.held.headers)
      realEnd.call(res, outcome.body)
    } catch {
      try {
        if (res.writableEnded !== true && res.destroyed !== true) realEnd.call(res)
      } catch {
        /* the response is gone; nothing left to answer */
      }
    }
    return undefined
  }
  route.handler = wrapped
  route[SHIM_MARK] = wrapped
  log('bundles asked for under an older revision are answered at the current one')
  return { route, slot: 'handler', original, wrapped }
}

/** Put the bundle route back the way it was found; a route replaced since then is left alone. */
function releaseBundleShim(shim) {
  try {
    if (shim === null || shim === undefined) return
    /**
     * Only the wrapper this record installed may be removed. Without the identity check a dispose
     * that lands after the next apply would put the original back over a newer wrapper, or strip the
     * mark off one it does not own and let the route be wrapped twice around one response.
     */
    const current = shim.slot === 'resource' ? shim.route.resource : shim.route.handler
    if (current === shim.wrapped) {
      if (shim.slot === 'resource') shim.route.resource = shim.original
      else shim.route.handler = shim.original
    }
    // The mark belongs to this wrapper only; a mark left by a newer one stays on the route.
    if (shim.route[SHIM_MARK] === shim.wrapped) delete shim.route[SHIM_MARK]
  } catch (error) {
    // A route left wrapped here would answer pages from a context that is going away.
    log(`cannot unwrap the bundle route: ${oneLine(error?.message ?? error)}`)
  }
}

/**
 * Wrap the bundle route unless the wrap already there is the one still on the route. The route can
 * appear after this plugin starts and can be replaced afterwards, so every caller that is about to
 * matter (a reload, a page asking for the graph) asks again instead of trusting an earlier answer.
 */
function ensureBundleShim(ctx) {
  const shim = globalThis[SHIM_KEY]
  if (shim !== null && shim !== undefined) {
    const route = ctx.get('webServer')?.prefixes?.get?.(BUNDLE_ROUTE)
    if (route === shim.route && route[shim.slot] === shim.wrapped && route[SHIM_MARK] === shim.wrapped) return shim
    releaseBundleShim(shim)
    globalThis[SHIM_KEY] = null
  }
  globalThis[SHIM_KEY] = serveBundlesAtCurrentRevision(ctx)
  return globalThis[SHIM_KEY]
}

/** What the bundle route looks like from here, so a stale answer can be told from a missing wrap. */
function bundleShimStatus(ctx) {
  const route = ctx.get('webServer')?.prefixes?.get?.(BUNDLE_ROUTE)
  const clientModules = ctx.get('clientModules')
  const shape =
    typeof route?.resource === 'function' ? 'resource' : typeof route?.handler === 'function' ? 'handler' : 'none'
  return {
    route: route !== null && route !== undefined,
    kind: shape,
    wrapped: route?.[SHIM_MARK] !== undefined && route?.[SHIM_MARK] === route?.[shape === 'none' ? 'handler' : shape],
    fetch: typeof clientModules?.fetchBundle === 'function',
    graph: typeof clientModules?.graph === 'function',
  }
}

/**
 * Whether a served body names one plugin as a whole word. A bare substring is not enough: "ui" is
 * inside "ui-conversation", and a body for the wrong generation would then be served as if sound.
 */
function bodyNamesId(body, id) {
  let at = body.indexOf(id)
  while (at >= 0) {
    const next = body[at + id.length]
    if (next === undefined || /[-\w$./@]/u.test(next) === false) return true
    at = body.indexOf(id, at + 1)
  }
  return false
}

/** Ids a classic-script body registers through the module loader's public entry point. */
function registeredIds(body) {
  const ids = new Set()
  for (const match of body.matchAll(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,8192}?\bid\s*:\s*(["'`])([^"'`]+)\1/gu)) ids.add(match[2])
  return ids
}

/** Ids a body reads from the loader's table through `require`, which must already be registered. */
function requiredIds(body) {
  const ids = new Set()
  for (const match of body.matchAll(/\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/gu)) ids.add(match[2])
  return ids
}

/**
 * Compile one body the way the document compiles it, and never run it: running a plugin body here
 * would execute its top level inside the app that owns every running turn.
 * @returns the parser's complaint, or null when the body compiles as a classic script.
 */
function parseAsScript(body, name) {
  try {
    new Script(body, { filename: name })
    return null
  } catch (error) {
    return String(error?.message ?? error)
  }
}

/**
 * Answer whether the next document would come up from the scripts a startup list names.
 *
 * The page cannot answer this itself: `new Function` is not the parser a script tag uses, and running
 * a candidate body there would execute the plugin inside the page that carries the turn. Here every
 * body is read from the address the document would use, compiled with the real parser, and checked
 * for the ids it registers and the modules it reads. The desktop shell boots every document from one
 * startup list captured at launch, so bytes that change after this answer stay outside what any check
 * can promise: disagreement between the bytes and the plugin list is a hold, never a rebuild.
 * @param graph the plugin table's live description.
 * @param fetchBody reads one script address and answers a response-like, or null when it cannot.
 * @param rows the startup script addresses, as the next document would request them.
 */
export async function verifyStartupRows(graph, fetchBody, rows, budgetMs = MAX_VERIFY_MS) {
  const entries = new Map(
    (Array.isArray(graph?.entries) ? graph.entries : [])
      .filter((row) => typeof row?.id === 'string' && row.id !== '')
      .map((row) => [row.id, row]),
  )
  // A startup list is a handful of addresses. Anything past that bound is not a list this app could
  // boot from, and reading it would turn one request into unbounded work on the process that owns
  // every running turn.
  const offered = Array.isArray(rows) ? rows.slice(0, MAX_STARTUP_ROWS) : []
  const wanted = []
  for (const row of offered) {
    if (typeof row !== 'string' || row === '') continue
    // A row past the bound is a script that will not be read, and a script this check does not read
    // is one nothing proved the next document could load: refuse the list instead of approving the
    // part that happened to be readable.
    if (row.length > MAX_STARTUP_ROW_CHARS) {
      return { status: 'blocked', reason: 'list', detail: 'the startup list names an address longer than a document loads' }
    }
    const path = row.includes('://') ? row.replace(/^[a-z]+:\/\/[^/]+/iu, '') : row
    const url = path.startsWith('/') ? path : `/${path.replace(/^\.?\//u, '')}`
    const request = bundleRequest(url)
    wanted.push({ url, ids: request === null ? [] : request.ids })
  }
  if (wanted.length === 0) return { status: 'blocked', reason: 'list', detail: 'the startup list names no script' }
  /**
   * A row can name a plugin the profile no longer has: the document that made it was composed
   * before that plugin was turned off. The route answers such a row with a stand-in that registers
   * nothing, so the boot comes up without the plugin; the check reads the same way and does not
   * demand a registration the set cannot give.
   */
  const served = new Set(entries.keys())
  const leftOut = new Set()
  const listed = new Set()
  const bodies = []
  const began = Date.now()
  let totalBytes = 0
  for (const item of wanted) {
    if (Date.now() - began > budgetMs) {
      return { status: 'blocked', reason: 'slow', detail: 'the startup list took longer than this check waits' }
    }
    for (const id of item.ids) if (served.has(id)) listed.add(id)
    for (const id of item.ids) if (!served.has(id)) leftOut.add(id)
    let response = null
    try {
      response = await fetchBody(item.url)
    } catch (error) {
      return { status: 'blocked', reason: 'network', detail: `${item.url}: ${String(error?.message ?? error)}` }
    }
    if (response === null || response === undefined || response.status !== 200) {
      return { status: 'blocked', reason: 'missing', detail: `${item.url} answers ${String(response?.status ?? 'nothing')}` }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) return { status: 'blocked', reason: 'empty', detail: `${item.url} answers an empty body` }
    totalBytes += bytes.length
    if (bytes.length > MAX_SCRIPT_BYTES || totalBytes > MAX_TOTAL_SCRIPT_BYTES) {
      return { status: 'blocked', reason: 'size', detail: `${item.url} answers ${String(bytes.length)} bytes; this check reads at most ${String(MAX_SCRIPT_BYTES)} per script and ${String(MAX_TOTAL_SCRIPT_BYTES)} in all` }
    }
    const text = bytes.toString('utf8')
    const complaint = parseAsScript(text, item.url)
    if (complaint !== null) return { status: 'blocked', reason: 'parse', detail: `${item.url}: ${complaint}` }
    const registered = registeredIds(text)
    const required = item.ids.filter((id) => served.has(id))
    const missing = required.filter((id) => !registered.has(id))
    if (required.length > 0 && missing.length > 0) {
      return { status: 'blocked', reason: 'register', detail: `${item.url} does not register ${missing.join(', ')}` }
    }
    // Only what the cross-checks below need from this body is kept; the text itself is let go here,
    // so a list of large scripts costs one script of memory rather than the whole list.
    const record = { url: item.url, ids: item.ids, registered, required: requiredIds(text) }
    record.digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    bodies.push(record)
  }
  /**
   * A body can read a plugin its own document does not list: the set changed after that document was
   * composed, and the missing module only shows up inside the new page as a failed import. Every id
   * that is one of the app's client entries and is neither registered by a listed script nor listed
   * itself is that case, so the press is held rather than booting a page that dies half way.
   */
  const available = new Set(listed)
  for (const body of bodies) for (const id of body.registered) available.add(id)
  const absent = new Set()
  for (const body of bodies) {
    for (const id of body.required) {
      if (available.has(id) || !entries.has(id)) continue
      absent.add(id)
    }
  }
  if (absent.size > 0) {
    return {
      status: 'blocked', // ui-copy-ignore
      reason: 'dependencies', // ui-copy-ignore
      detail: `not registered by the startup list: ${[...absent].slice(0, 4).join(', ')}`,
    }
  }
  return {
    status: 'ok', // ui-copy-ignore
    reason: 'ok', // ui-copy-ignore
    revision: typeof graph?.rev === 'string' ? graph.rev : null,
    scripts: bodies.map((body) => ({ url: body.url, digest: body.digest, ids: body.ids })),
    ...(leftOut.size > 0 ? { leftOut: [...leftOut] } : {}),
  }
}

/**
 * Read one startup script the way the document itself would get it.
 *
 * The route answers a script from an older generation at the revision that still holds it, so a
 * document booting from the shell's frozen list comes up instead of 404. Reading the address
 * directly would see that same 404 and refuse a rebuild the button can actually carry out, so the
 * answer is taken through the same mapping and only falls back to the raw address when the mapping
 * has nothing to say.
 */
export async function readStartupScript(clientModules, url) {
  try {
    const answer = await currentBundleAnswer(clientModules, 'GET', url)
    if (answer !== null) return { status: 200, arrayBuffer: async () => answer.body }
  } catch (error) {
    // The fallback is still the right answer; the failure itself must not vanish.
    log(`cannot answer ${oneLine(url)} at the revision the app serves now: ${oneLine(error?.message ?? error)}; asking the app's own route`)
  }
  return fetchBundleAt(clientModules, url, 'GET')
}

/** Ask the same question of the plugin table the plugin itself talks to. */
export async function verifyStartup(clientModules, rows) {
  let graph = null
  try {
    graph = clientModules.graph()
  } catch (error) {
    return { status: 'blocked', reason: 'list', detail: String(error?.message ?? error) }
  }
  return verifyStartupRows(graph, (url) => readStartupScript(clientModules, url), rows)
}

/**
 * The entry points the header button calls. Each answers with the current switches so the page
 * never guesses: with both off it does nothing, and a turn still running is reported rather than
 * cut. The press outcome is written to the log, because a press that stopped before rebuilding
 * leaves no other trace once the page goes on running.
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
        // A disposed context answers with a status instead of a throw the server has to guess at.
        try {
          sendJson(res, 200, { version: VERSION, code: CODE_STAMP, plugins: settings.reloadPlugins, page: settings.reloadInterface, shim: bundleShimStatus(ctx) })
        } catch (error) {
          log(`cannot describe this copy of the plugin: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
        }
      },
    ],
    [
      `${BASE_PATH}/graph`,
      (_req, res) => {
        // The page reads this before a rebuild; an answer that throws would leave the press with
        // no verdict at all, so the whole body is bounded and answers either way.
        try {
          ensureBundleShim(ctx)
          sendJson(res, 200, { graph: liveBootGraph(ctx) })
        } catch (error) {
          sendJson(res, 500, { status: 'error', detail: String(error?.message ?? error) })
        }
      },
    ],
    [
      `${BASE_PATH}/verify`,
      async (req, res) => {
        // Nothing a request does may reject: an unhandled rejection ends the whole app, and with
        // it every turn running in it.
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
          if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
          const clientModules = ctx.get('clientModules')
          if (typeof clientModules?.fetchBundle !== 'function' || typeof clientModules?.graph !== 'function') {
            return sendJson(res, 200, { status: 'blocked', reason: 'list', detail: 'the plugin table is not running' })
          }
          const body = await readJsonBody(req)
          let verdict = null
          try {
            verdict = await verifyStartup(clientModules, Array.isArray(body?.rows) ? body.rows : [])
          } catch (error) {
            verdict = { status: 'blocked', reason: 'list', detail: String(error?.message ?? error) }
          }
          if (verdict?.status !== 'ok') {
            log(`a startup check refused the page: ${String(verdict?.reason ?? 'list')} (${String(verdict?.detail ?? 'no detail')})`)
          }
          if (Array.isArray(verdict?.leftOut) && verdict.leftOut.length > 0) {
            log(`a startup row names a plugin this app no longer serves: ${verdict.leftOut.join(', ')}; the page comes up without it`)
          }
          sendJson(res, 200, verdict)
        } catch (error) {
          log(`cannot answer ${BASE_PATH}/verify: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
        }
      },
    ],
    [
      `${BASE_PATH}/report`,
      (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
          /**
           * A page on any site can post to a local address without asking first, and a log is
           * evidence: a made-up outcome must not get in. The header the page's own script sends
           * makes the request one a browser has to ask about first, and this app never agrees.
           */
          if (typeof req?.headers?.[BUTTON_HEADER] !== 'string') return sendJson(res, 403, { status: 'forbidden' })
          let query = ''
          try {
            query = new URL(String(req?.url ?? ''), 'http://x').searchParams.toString()
          } catch {}
          const params = new URLSearchParams(query)
          const event = params.get('event') ?? ''
          // A query comes from outside: one shaped gate keeps a forged line out of the log.
          const gate = (params.get('gate') ?? '').replace(/[^a-z-]/gu, '').slice(0, 24)
          // Which generation of the page came up. A rebuild that lands on older bytes then says so.
          const pageRev = (params.get('rev') ?? '').replace(/[^a-z0-9]/gu, '').slice(0, 24)
          const from = pageRev === '' ? '' : ` (page ${pageRev})`
          /**
           * Every outcome the page reports is written down. A press whose line was missing left the
           * log unable to say what happened; an outcome with no line of its own (a failed
           * replacement, a press when both switches are off) says so in its own words.
           */
          const named = event.replace(/[^a-z-]/gu, '').slice(0, 24)
          if (named === 'mounted') log(`interface rebuilt; the page runs the plugins as served now${from}`)
          else if (named === 'rebuild') log('rebuild allowed: the page re-enters on the served modules')
          else if (named === 'held') log(`rebuild held back: ${gate === '' ? 'unknown' : gate}`)
          else if (named === '') log('a press reported nothing')
          else log(`a press ended: ${named}${gate === '' ? '' : ` (${gate})`}${from}`)
          sendJson(res, 200, { status: 'done' })
        } catch (error) {
          log(`cannot record a press report: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
        }
      },
    ],
    [
      `${BASE_PATH}/reload`,
      async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
          if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
          if (!settings.reloadPlugins) return sendJson(res, 200, { status: 'off' })
          const limit = Number(process.env.DSH_UNLAG_ANSWER_MS ?? '') || RELOAD_ANSWER_MS
          let timer = null
          const stillApplying = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ status: 'applying', warnings: [], pending: [], restartReason: null, failedEntries: [] }), limit)
          })
          let answeredEarly = false
          try {
            const work = controller.reloadNow()
            /**
             * The answer the page waits for is bounded, but the update is not. Whatever the update
             * did after the page was told it is still applying is written down here: a replacement
             * that failed a moment later must not look like one that succeeded.
             */
            work.then(
              (late) => {
                if (answeredEarly) log(`the update finished after the page was told it is still applying: ${String(late?.status ?? 'no status')}`)
              },
              (error) => {
                if (answeredEarly) log(`the update failed after the page was told it is still applying: ${error?.message ?? error}`)
              },
            )
            const outcome = await Promise.race([work, stillApplying])
            if (outcome?.status === 'applying') {
              answeredEarly = true
              log('the update outlasted the answer the page waits for: the press is told it is still applying')
            }
            sendJson(res, 200, outcome)
          } finally {
            if (timer !== null) clearTimeout(timer)
          }
        } catch (error) {
          log(`cannot apply a plugin reload: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'failed', detail: String(error?.message ?? error) })
        }
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
    const instance = {}
    closeAll(globalThis[WATCHER_KEY])
    closeAll(globalThis[ROUTES_KEY])
    releaseBundleShim(globalThis[SHIM_KEY])
    globalThis[WATCHER_KEY] = null
    globalThis[ROUTES_KEY] = null
    globalThis[SHIM_KEY] = null

    const controller = pluginReloader(ctx, config ?? {})
    /**
     * The bundle route can be wrapped as soon as the module table has registered it. Doing it here
     * as well as on the service event covers both orders: a table that is already up when this
     * half starts, and one that appears after it.
     */
    const syncBundles = () => {
      ensureBundleShim(ctx)
    }
    /**
     * Watching needs both the HMR service and an explicit opt-in: the switch defaults off, so no
     * root is installed and no saved file applies anything by itself.
     */
    const syncWatching = () => {
      if (settingsOf(config ?? {}).autoReload !== true) return
      if (controller.available() === false) {
        closeAll(globalThis[WATCHER_KEY])
        globalThis[WATCHER_KEY] = null
        return
      }
      if (globalThis[WATCHER_KEY] !== null) return
      globalThis[WATCHER_KEY] = controller.startWatching()
    }
    // Printed on every start so a reader of the log knows which action applies a change: a person
    // pressing the button, never this plugin, and never a restart of the app.
    log(`dsh-unlag ${VERSION} loaded (code ${CODE_STAMP})`)
    log('plugin reload is manual: ask the user to press the refresh button; do not restart the app')
    if (settingsOf(config ?? {}).autoReload === true) {
      syncWatching()
      if (globalThis[WATCHER_KEY] === null) log('auto reload is on but the hmr entry is not running; a press still works')
      else log('auto reload is on: a saved plugin change applies without a press')
    } else {
      log('auto reload is off: no plugin source is watched')
    }
    if (typeof ctx.on === 'function') {
      ctx.on('internal/service', (service) => {
        if (service === 'hmr') syncWatching()
        if (service === 'clientModules') syncBundles()
      })
    }
    globalThis[ROUTES_KEY] = serveButton(ctx, controller, config ?? {})
    syncBundles()
    globalThis[INSTANCE_KEY] = instance

    ctx.on('dispose', () => {
      /**
       * A dispose that lands after the next apply belongs to an instance that no longer owns
       * anything; tearing the routes or the shim down here would break the newer one, and a page
       * that then cannot read a startup script ends the app.
       */
      if (globalThis[INSTANCE_KEY] !== instance) return
      controller.stop()
      closeAll(globalThis[WATCHER_KEY])
      closeAll(globalThis[ROUTES_KEY])
      releaseBundleShim(globalThis[SHIM_KEY])
      globalThis[WATCHER_KEY] = null
      globalThis[ROUTES_KEY] = null
      globalThis[SHIM_KEY] = null
      globalThis[INSTANCE_KEY] = null
    })
  } catch (error) {
    log(`plugin reload did not start: ${error?.message ?? error}`)
  }
}
