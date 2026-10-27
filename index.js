import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'node:fs'
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
/** The longest batch address kept from a page's startup report; whole or refused, never cut. */
const MAX_BOOT_URL = 16 * 1024
/** How long a press waits for the boot snapshot the page's own report started. */
const MAX_BOOT_PROOF_WAIT_MS = 800
/** How many finished presses keep their own answer, and for how long. */
const MAX_PRESSES = 32
const MAX_PRESS_AGE_MS = 10 * 60 * 1000


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
/** Tests point this at a scratch file, so a test run leaves the live log readable. */
const logTarget = () => process.env.DSH_UNLAG_LOG ?? LOG_PATH

/** The last rebuild line written, so one rebuild reported twice is written once. */
let lastRebuilt = { key: '', at: 0 }
/** Survives a module replacement, so a reload cannot leave a second watcher behind. */
const WATCHER_KEY = Symbol.for('dsh-unlag.watchers')
/** The same, for the HTTP entry points the header button calls. */
const ROUTES_KEY = Symbol.for('dsh-unlag.routes')
/** The queue request this plugin is waiting on, shared across a replacement of this plugin. */
const WORK_KEY = Symbol.for('dsh-unlag.work')
const BASE_PATH = '/dsh-unlag'
/** A same-origin page sets this itself; a cross-site form post cannot, and fails the preflight. */
const BUTTON_HEADER = 'x-dsh-unlag'

/**
 * The startup list the running page really was frozen with, as that page reported it. The desktop
 * shell pins the list when a window starts, so the only place the truth about a live document
 * exists is inside that document; this is where it is kept for a check to read.
 */
const liveBoot = { current: null, snapshot: null, capture: 0 }
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
 * Compiling a body costs several times its size in memory before it is thrown away, and up to three
 * checks may run at once, so the bound is set close to what a profile actually serves: this one
 * measured 15.7 MB across three bundles, its largest 9.2 MB. A body past 24 MB is not a profile
 * this app ships with, and reading one would let a request make the process that owns every running
 * turn hold text no page boots from.
 */
const MAX_SCRIPT_BYTES = 24 * 1024 * 1024
/**
 * The same bound for one whole startup list. This one bounds work, not memory: a body's text is let
 * go before the next one is read, so what the list costs is summed compile time, and this profile
 * measured 158 ms for 15.7 MB. A bound this far above a real profile keeps a large profile
 * rebuildable while still stopping a list from asking for minutes of compiling.
 */
const MAX_TOTAL_SCRIPT_BYTES = 256 * 1024 * 1024
/**
 * How large the request that carries the list may be. The list itself is bounded (64 addresses of at
 * most 8 KB, plus JSON escaping), so a bound below that would refuse a sound startup list from a
 * profile with many bundles and report it as an empty one. A body past this bound is not a list this
 * app could boot from, and it is answered as such instead of being read.
 */
const MAX_LIST_BODY_BYTES = 1024 * 1024
/** Checks that may read the plugin table at the same time. Each one holds a script at a time. */
const MAX_CONCURRENT_CHECKS = 3
/** The body reader's answer for a request past its bound: not JSON, and not an empty list either. */
const TOO_LARGE = Symbol('too-large')

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
    8: { type: 'boolean', meta: { default: false, description: '允许在 Agent 里按刷新按钮' } }, // ui-copy-ignore
    6: { type: 'object', meta: { default: {} }, dict: { reloadPlugins: 2, reloadInterface: 5, autoReload: 7, agentRefresh: 8 } }, // ui-copy-ignore
  },
}

/** The same rows as plain nodes, which is the shape the settings form projects values through. */
const FIELDS = {
  reloadPlugins: { type: 'boolean', meta: { default: true, description: '按下刷新时换掉插件代码' } },
  reloadInterface: { type: 'boolean', meta: { default: true, description: '按下刷新时重建界面' } },
  autoReload: { type: 'boolean', meta: { default: false, description: '改完文件自动刷新，不必按按钮' } },
  agentRefresh: { type: 'boolean', meta: { default: false, description: '允许在 Agent 里按刷新按钮' } },
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

/** Switches already reported, so a settings form read repeatedly writes one line, not many. */
const STRANGE_SWITCHES = new Set()
/**
 * One switch. Absent means the default; a boolean means itself; anything else — a hand-edited
 * string, a number, a list — is not a yes and is read as off, with one line saying so. A row that
 * says "off" must not swap plugin code because the value happened to be the word "no".
 */
function booleanSwitch(config, key, fallback) {
  const value = config?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const seen = `${key}=${oneLine(value, 40)}`
  if (!STRANGE_SWITCHES.has(seen) && STRANGE_SWITCHES.size < 32) {
    STRANGE_SWITCHES.add(seen)
    log(`a switch that is not a boolean was read as off: ${seen}`)
  }
  return false
}

/**
 * The three switches from any config shape. The press switches default on; automatic reloading
 * defaults off, and the undocumented `plugins: 'off'` from older configs keeps meaning off.
 */
function settingsOf(config) {
  return {
    reloadPlugins: booleanSwitch(config, 'reloadPlugins', true),
    reloadInterface: booleanSwitch(config, 'reloadInterface', true),
    autoReload: config?.plugins === 'off' ? false : booleanSwitch(config, 'autoReload', false),
    agentRefresh: booleanSwitch(config, 'agentRefresh', false),
  }
}

/**
 * One log line, whatever the message. An address, a plugin id or an error can carry a line break,
 * and a forged line in a file that is read as evidence is worse than a missing one; a message can
 * also be arbitrarily long, and the log is one line per event.
 */
export function oneLine(value, limit = 2000) {
  // A line break is not the only thing that forges a log line: an escape sequence can move the
  // cursor and paint over earlier lines when a person reads the file, and a bare control byte can
  // make a terminal misbehave. Page-supplied text reaches this function, so every control byte
  // becomes a space, not only the line breaks.
  const text = String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text
}

/** Whether the directory holding the log has already been made, so one attempt per process. */
let logDirTried = false
/**
 * The log is the only evidence a failed update leaves behind, and a home directory that never ran
 * this app yet has no directory for it: one attempt per process to make that directory, then the
 * write is retried. Every failure stays silent, because logging must never take a press down.
 */
function ensureLogDir(target) {
  if (logDirTried) return
  logDirTried = true
  const cut = target.lastIndexOf('/')
  if (cut <= 0) return
  try {
    mkdirSync(target.slice(0, cut), { recursive: true })
  } catch {}
}

function log(line) {
  try {
    const target = logTarget()
    // A line written by the test suite says so, so a reader never reads a test as the live app.
    const source = process.env.DSH_UNLAG_SOURCE === 'test' ? 'test: ' : ''
    const text = `${new Date().toISOString()} ${source}${oneLine(line)}\n`
    /**
     * A file that only grows eventually costs the app its own memory budget, and a burst of lines
     * can land between two periodic checks: the size is read before every write and the whole
     * line has to fit, so the file never passes the cap even for one event.
     *
     * A full file is moved aside rather than emptied: its lines are the evidence for what led up to
     * the write that filled it, which is the event a reader wants. One previous generation is
     * kept, so a page that floods the log can cost at most one past million bytes.
     */
    try {
      if (statSync(target).size + Buffer.byteLength(text) > LOG_MAX_BYTES) {
        try {
          renameSync(target, `${target}.1`)
        } catch {
          writeFileSync(target, '')
        }
      }
    } catch {
      /* a missing or unreadable log is created by the append below */
    }
    try {
      appendFileSync(target, text)
    } catch {
      ensureLogDir(target)
      try {
        appendFileSync(target, text)
      } catch {}
    }
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

/** The id this plugin is inserted under; a self-update replaces it on purpose, so it is never judged. */
const SELF_ENTRY_ID = 'dsh-unlag'

/**
 * Every Loader entry and its fiber state, keyed by the id a profile uses. `null` means the Loader
 * cannot be read at all, which is different from "nothing is running": an update whose health cannot
 * be read is not one that can be called finished.
 * @returns {Map<string, number|null>|null}
 */
function loaderEntryStates(ctx) {
  try {
    const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : undefined
    if (typeof loader?.entries !== 'function') return null
    const states = new Map()
    for (const entry of loader.entries()) {
      const id = entry?.options?.id
      if (typeof id === 'string' && id !== '') states.set(id, entry?.fiber?.state ?? null)
    }
    return states
  } catch {
    return null
  }
}

/** The ids of the Loader entries that are running now, read defensively: this is diagnostics. */
function activeEntryIds(ctx) {
  const states = loaderEntryStates(ctx)
  if (states === null) return []
  return [...states].filter(([, state]) => state === 2).map(([id]) => id)
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
  /** The press waiting out the minimum interval, so a dispose can end that wait instead of leaving it. */
  let pressWait = null
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
  /**
   * What the app said was not running at the end of the last settled update. A warning that shows up
   * here again was already true before this press; one that does not is a breakage this press caused,
   * and a press that broke something must not be followed by a page built on it.
   */
  const knownInactive = globalThis[Symbol.for('dsh-unlag.health')] ?? (globalThis[Symbol.for('dsh-unlag.health')] = { unhealthy: [] })

  /**
   * Which required entries are still not running. Required means: running at the moment this update
   * started, minus this plugin's own entry (a self-update replaces it deliberately). The set is kept
   * by id, not by warning prose: a warning is a sentence, and a sentence is not something a later
   * update can compare against. A remembered entry stops blocking when it runs again or is gone from
   * the profile; until then every later update stays unfinished, because a page built on it would
   * start against a set that is still missing part of itself.
   * @returns {{unhealthy: string[], readable: boolean}}
   */
  const settleEntryHealth = (required) => {
    const remembered = (Array.isArray(knownInactive.unhealthy) ? knownInactive.unhealthy : []).filter((id) => typeof id === 'string' && id !== '')
    const states = loaderEntryStates(ctx)
    /**
     * A list that cannot be read is not a set of stopped entries either. Nothing was looked at, so
     * no id here is a breakage this update caused: the answer says the health could not be read and
     * holds no entry back, because a press failed on a list nobody saw is worse than an unverified
     * done. The memory itself is left untouched for the next press that can read it.
     */
    if (states === null) {
      return { unhealthy: [], readable: false, carried: [] }
    }
    const asked = new Set(required)
    const unhealthy = []
    /**
     * The set to judge is this press's own required entries plus everything an earlier press left
     * stopped. A plugin that broke under an earlier update is still broken, and a record that forgot
     * it would let the next press answer `done` for a set that is missing part of itself. Only the
     * Loader dropping an entry clears it: absent means the profile no longer has it at all.
     */
    const wanted = new Set([...asked, ...remembered])
    for (const id of wanted) {
      if (id === SELF_ENTRY_ID) continue
      const state = states.get(id)
      // Absent from the Loader means the profile no longer has it: nothing left to wait for.
      if (state === undefined) continue
      if (state !== 2) unhealthy.push(id)
    }
    /**
     * The two reasons a stopped entry is in the refusal are said apart in the log: one was running
     * when this press started, the other was already stopped by an earlier press and is still down.
     * Both are held, neither is dropped: the first may be this press's doing, the second is the
     * memory the next press needs.
     */
    const carried = unhealthy.filter((id) => !asked.has(id))
    if (carried.length > 0) log(`still stopped from an earlier press: ${carried.slice(0, 5).join(', ')}`)
    knownInactive.unhealthy = unhealthy.slice(0, 64)
    return { unhealthy, readable: true, carried }
  }

  /**
   * What the last operation really ended as. The answer to a press is bounded by the time a page
   * waits, so an update that outlasts it is answered as still applying; this record is where the
   * same operation writes its real end, and the page reads it back instead of guessing.
   */
  /**
   * The operation record outlives this copy of the plugin: an update can replace the plugin that
   * started it, and the page reading the record afterwards must still find it. It is kept on the
   * process, not in this closure, so a self-update does not restart the count or lose the end.
   */
  const operation = globalThis[Symbol.for('dsh-unlag.operation')] ?? (globalThis[Symbol.for('dsh-unlag.operation')] = { id: 0, state: null })

  /**
   * Every press keeps its own answer for a while, keyed by the id the page made up for it. The
   * operation record above only holds the newest one, so a page that lost its answer and asked again
   * after another press would be told about somebody else's update — or start a second one. The
   * record is bounded and old entries are dropped by age, never kept for the life of the process.
   */
  const presses = globalThis[Symbol.for('dsh-unlag.presses')] ?? (globalThis[Symbol.for('dsh-unlag.presses')] = new Map())
  /**
   * Whether the page that asked may be rebuilt on what this update left behind. It is a separate
   * word from `status` on purpose: an update can arrive with every plugin stopped cleanly and still
   * leave a set nobody could read, and a page built on that set is the one thing that must not
   * happen. `unknown` is not a soft `safe`: it means no verdict was reached.
   */
  const rebuildOf = (outcome) => {
    const explicit = outcome?.rebuild
    if (explicit === 'safe' || explicit === 'unsafe' || explicit === 'unknown' || explicit === 'pending') return explicit
    if (outcome?.healthReadable === false) return 'unknown'
    const pending = Array.isArray(outcome?.pending) ? outcome.pending : []
    const restart = typeof outcome?.restartReason === 'string' && outcome.restartReason !== ''
    const failed = Array.isArray(outcome?.failedEntries) ? outcome.failedEntries : []
    if (pending.length > 0 || restart || failed.length > 0) return 'unsafe'
    return String(outcome?.status ?? '') === 'done' ? 'safe' : 'unsafe'
  }
  const doneOf = (outcome, id = null) => ({
    id,
    // The same rule noteOperation uses: one record, one meaning, so a retry of the same request id
    // cannot be told `done` while the newest operation says `restart` for the same update.
    status:
      (Array.isArray(outcome?.pending) && outcome.pending.length > 0) ||
      (typeof outcome?.restartReason === 'string' && outcome.restartReason !== '')
        ? 'restart' // ui-copy-ignore
        : String(outcome?.status ?? 'failed'), // ui-copy-ignore
    pending: (Array.isArray(outcome?.pending) ? outcome.pending : []).slice(0, 16),
    failed: (Array.isArray(outcome?.failedEntries) ? outcome.failedEntries : []).slice(0, 16),
    restart: typeof outcome?.restartReason === 'string' && outcome.restartReason !== '' ? outcome.restartReason : null,
    rebuild: rebuildOf(outcome), // ui-copy-ignore
    healthReadable:
      outcome?.healthReadable === true || outcome?.healthReadable === false ? outcome.healthReadable : null,
    at: Date.now(),
  })
  /** Remember one press's end, dropping the oldest and the stale as it goes. */
  const rememberPress = (requestId, outcome, id = null) => {
    if (typeof requestId !== 'string' || requestId === '') return
    presses.set(requestId, doneOf(outcome, id))
    const limit = Date.now() - MAX_PRESS_AGE_MS
    for (const [id, row] of presses) {
      if (row.at < limit || presses.size > MAX_PRESSES) presses.delete(id)
    }
  }

  /**
   * The one place an update's end is written down. Every path that can finish an update passes
   * through here, so the route answer, `/state.operation` and the page read the same record for the
   * same operation instead of each judging from its own partial view.
   */
  const noteOperation = (id, outcome, requestId = null) => {
    const pending = Array.isArray(outcome?.pending) ? outcome.pending : []
    const restart = typeof outcome?.restartReason === 'string' && outcome.restartReason !== '' ? outcome.restartReason : null
    /**
     * A set that is not running cannot end as `done`, whichever path wrote the end: the queue's
     * late answer carries no status of its own, and the same record is read by the route, by
     * `/state`, and by a retry of the same request id. Normalizing here keeps those three in
     * agreement instead of letting each caller judge the raw shape.
     */
    const status = pending.length > 0 || restart !== null ? 'restart' : String(outcome?.status ?? 'failed') // ui-copy-ignore
    operation.state = {
      id,
      status, // ui-copy-ignore
      pending: pending.length,
      failed: Array.isArray(outcome?.failedEntries) ? outcome.failedEntries.length : 0,
      restart,
      // The verdict the page reads before it rebuilds, written by the same single writer as the
      // status so the two cannot disagree about the same update.
      rebuild: rebuildOf({ ...outcome, status }), // ui-copy-ignore
      healthReadable:
        outcome?.healthReadable === true || outcome?.healthReadable === false ? outcome.healthReadable : null,
      requestId: typeof requestId === 'string' && requestId !== '' ? requestId : (operation.state?.requestId ?? null),
    }
    rememberPress(requestId, outcome, id)
  }

  const reload = async (hmr) => {
    /**
     * Queue the recomposition through the service's own queue. A watcher callback created while a
     * reload was restarting this plugin inherits that reload's context, and the service reads any
     * request made from that context as a nested one even though the transaction is over. Leaving
     * that context first is what the service's own watcher does, and it keeps the request queued
     * instead of running a second recomposition beside the first.
     */
    const context = transactionContext(hmr)
    /**
     * The entries that are running now are the ones the page needs after the update. The app only
     * reports an entry that was already inactive as a warning; naming these as required makes the
     * app report the ones this update took down, so the press is judged against the state before it
     * instead of against a list the previous update already carried.
     */
    let requiredBefore = []
    const ask = (service) => {
      const inside = async () => {
        // Snapshot inside the queue, not before it: what is running at the moment the update starts
        // is what the page needs afterwards. Reading it earlier can name an entry another queued
        // update already replaced, and the update would then be failed for somebody else's change.
        requiredBefore = activeEntryIds(ctx).filter((id) => id !== SELF_ENTRY_ID)
        return service.reconcileProfile(requiredBefore)
      }
      return context === null
        ? service.runExclusive(inside)
        : context.exit(() => service.runExclusive(inside))
    }
    let deadline = null
    const abandoned = () =>
      new Promise((_resolve, reject) => {
        const limit = Number(process.env.DSH_UNLAG_TIMEOUT_MS ?? '') || RELOAD_TIMEOUT_MS
        deadline = setTimeout(() => reject(new Error('the plugin update did not finish in time')), limit)
        deadline.unref?.()
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
    /**
     * The whole update — asking the queue, then reading health, re-wrapping the route and writing
     * down what happened — is one promise. A press may stop waiting for it, but stopping the wait
     * must not stop the work: the page is told "still applying" while the chain runs on, and the end
     * it reaches is the end every reader is given, including a late one.
     */
    const work = (async () => {
    let result = null
    try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await ask(hmr)
        break
      } catch (error) {
        const message = String(error?.message ?? error)
        if (message.includes('nested')) {
          if (attempt >= 9) throw error
          const step = Number(process.env.DSH_UNLAG_RETRY_MS ?? '') || 250
          /**
           * This wait is another reload holding the queue, not work of this plugin's own: it may not
           * keep the app awake by itself. The queue request around it is what the page waits on.
           */
          await new Promise((resolve) => {
            const handle = setTimeout(resolve, step * (attempt + 1))
            handle.unref?.()
          })
          continue
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
    const listed = warnings.map((warning) => (typeof warning === 'string' ? warning : String(warning?.message ?? warning)))
    /**
     * The verdict comes from the Loader itself: which of the entries that were running before this
     * update are not running after it. The app's warnings are prose and are passed on as they read;
     * they are not parsed to decide anything, because a sentence can miss an entry or describe
     * something harmless and the same text must not mean different things on different runs.
     * An entry remembered from an earlier update keeps this press from ending `done` until it runs
     * again or leaves the profile.
     */
    const health = settleEntryHealth(requiredBefore)
    const failedEntries = health.unhealthy
    const inactiveEntries = listed
    if (!health.readable) log('the plugin list could not be read after the update; the update ends without a verdict on the set')
    log(
      `plugins reloaded (already not running=${inactiveEntries.length} newly not running=${failedEntries.length} still stopped=${health.carried.length} pending=${pending.length}${restartReason === null ? '' : ` restart=${restartReason}`})`,
    )
    for (const entry of inactiveEntries.slice(0, 5)) log(`a plugin was already not running and still is not: ${entry.slice(0, 200)}`)
    for (const entry of failedEntries.slice(0, 5)) log(`a plugin stopped running with this update: ${entry.slice(0, 200)}`)
    /**
     * A list that could not be read after the update leaves the entries unjudged, and unjudged is
     * not the same as broken: reporting `failed` here would tell the person the update broke
     * something nothing observed. The reading is written down beside the verdict instead, so a
     * press that ends `done` while the list was unreadable can be explained afterwards, and the
     * page is told the rebuild is not proven either way.
     */
    const rebuild = !health.readable ? 'unknown' : failedEntries.length > 0 || pending.length > 0 || restartReason !== null ? 'unsafe' : 'safe'
    return {
      status: failedEntries.length > 0 ? 'failed' : 'done', // ui-copy-ignore
      warnings,
      pending,
      restartReason,
      inactiveEntries,
      failedEntries,
      carriedEntries: health.carried,
      healthReadable: health.readable,
      rebuild, // ui-copy-ignore
    }
    } catch (error) {
      // The update failed part-way: what it was required to keep running is still the right list to
      // judge the next press against, so the memory is settled before the failure travels on.
      settleEntryHealth(requiredBefore)
      throw error
    }
    })()
    try {
      return await Promise.race([tracked(work), abandoned()])
    } catch (error) {
      error.stillRunning = workState.current !== null
      throw error
    } finally {
      /**
       * The deadline guards this wait and nothing else: once the work has settled there is nothing
       * left for it to time out, and a press that finished must not leave a timer armed for the rest
       * of the limit — one per press, all of them watching an update that is already over.
       */
      if (deadline !== null) {
        clearTimeout(deadline)
        deadline = null
      }
    }
  }

  const flush = async () => {
    timer = null
    // A callback armed before the plugin was disposed can still run: this plugin may be gone, and a
    // recomposition asked for by a plugin nothing owns any more can only end in a half-stopped set.
    if (stopped) return
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
            if (stopped) {
              again = false
              return
            }
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
      if (again && stopped === false) {
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

  /**
   * The answer shape a press always gets, whether or not a reload was started. `rebuild` is the
   * page's question, not the update's: only an update that ended `done` on a set that was read back
   * healthy lets a page rebuild, and an answer that carried no verdict says so instead of guessing.
   */
  const plainAnswer = (status, extra = {}) => ({
    status, // ui-copy-ignore
    warnings: [],
    pending: [],
    restartReason: null,
    failedEntries: [],
    rebuild: status === 'done' ? 'safe' : status === 'applying' || status === 'queued' || status === 'restart' ? 'pending' : 'unsafe', // ui-copy-ignore
    healthReadable: null,
    ...(extra ?? {}),
  })

  /** The answer shape a press always gets, whether or not a reload was started. */
  const queuedAnswer = (answer) => plainAnswer(answer === 'unavailable' ? 'unavailable' : 'queued')

  /** A press made while an update is still running joins that update instead of queueing another. */
  const busyAnswer = () => (workState.current !== null ? plainAnswer('applying') : queuedAnswer(queueReload()))

  /**
   * The button path: run now and report what happened, so the page can tell the user why the
   * press did not replace anything instead of looking broken.
   * @returns {{status: string, warnings: string[], pending: string[], restartReason: string|null}}
   */
  /**
   * One page press is one request id. The same id arriving again is the page asking about the press
   * it already made, not a second press: it gets that press's own record and never starts the work
   * twice. Only the terminal record is read, because a press that is still applying has nothing
   * final to say and the caller is told so.
   */
  const seenRequest = (requestId) => {
    if (typeof requestId !== 'string' || requestId === '') return null
    /**
     * The press's own record answers first: it is bound to that id and nothing can overwrite it.
     * The newest operation record is the fallback for the press still running, which has no end to
     * remember yet.
     */
    const remembered = presses.get(requestId)
    if (remembered !== undefined) {
      return {
        status: remembered.status, // ui-copy-ignore
        operationId: remembered.id,
        warnings: [],
        pending: remembered.pending.slice(), // ui-copy-ignore
        restartReason: remembered.restart,
        failedEntries: remembered.failed.slice(),
        rebuild: remembered.rebuild, // ui-copy-ignore
        healthReadable: remembered.healthReadable ?? null,
      }
    }
    const state = operation.state
    if (state === null || state.requestId !== requestId) return null
    if (state.status === 'applying') return plainAnswer('applying')
    return {
      status: state.status, // ui-copy-ignore
      warnings: [],
      pending: [],
      restartReason: state.restart,
      failedEntries: [],
      rebuild: state.rebuild ?? 'unknown', // ui-copy-ignore
      healthReadable: state.healthReadable ?? null,
    }
  }

  /**
   * One press, one run. The same request id arriving while its run is still going joins that run
   * instead of starting a second update: a page retries the press it lost the answer to, and two
   * updates at once would each meet the other's half-applied set. The map lives on the process so a
   * self-update replacing this closure does not lose the press it is waiting on.
   */
  const runningPresses = globalThis[Symbol.for('dsh-unlag.presses-live')] ?? (globalThis[Symbol.for('dsh-unlag.presses-live')] = new Map())

  const runPress = async (force = false, requestId = null) => {
    const hmr = hmrService()
    if (hmr === null) return plainAnswer('unavailable')
    const already = seenRequest(requestId)
    if (already !== null) return already
    log('manual reload: the refresh button was pressed')
    if (turnsRunning()) log('reloading while turns are still running; they keep running')
    if (running || workState.current !== null || (force === false && busy())) return busyAnswer()
    const wait = lastRun + minInterval - Date.now()
    if (wait > 0)
      /**
       * The gap is a wait, not work: a dispose ends it at once instead of leaving the press to sit
       * out the whole interval and then answer that the plugin is gone. Nothing has been applied
       * when this is cleared, so resolving here is the honest end of a press that will not run.
       */
      await new Promise((resolve) => {
        const settle = () => {
          if (pressWait !== null && pressWait.settle === settle) pressWait = null
          resolve()
        }
        const handle = setTimeout(settle, Math.min(wait, 2000))
        pressWait = { settle, timer: handle }
      })
    /**
     * The wait can outlive the plugin: if the app stopped it during that time, this closure's
     * context is gone and starting an update through it would leave half a set behind. The press is
     * answered as unavailable instead, which is what a stopped plugin is.
     */
    if (stopped || hmrService() === null) return plainAnswer('unavailable')
    if (running || workState.current !== null || (force === false && busy())) return busyAnswer()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = true
    deferrals = 0
    lastRun = Date.now()
    const id = (operation.id += 1)
    operation.state = { id, status: 'applying', pending: 0, failed: 0, restart: null, rebuild: 'pending', healthReadable: null, requestId } // ui-copy-ignore
    try {
      const outcome = await reload(hmr)
      noteOperation(id, outcome, requestId)
      /**
       * `pending` means the changed modules are not loaded yet and need a restart this plugin does
       * not perform; it is not a queued update that finishes on its own.
       */
      if (outcome.pending.length > 0 || outcome.restartReason !== null) {
        // The app accepted the update but has not finished starting the new plugin set. Rebuilding
        // the page now would start a document against a set that is still settling.
        return plainAnswer('restart', {
          warnings: outcome.warnings,
          pending: outcome.pending,
          restartReason: outcome.restartReason,
          failedEntries: outcome.failedEntries,
          rebuild: 'pending', // ui-copy-ignore
          healthReadable: outcome.healthReadable ?? null,
        })
      }
      return outcome
    } catch (error) {
      if (error?.stillRunning === true) {
        // The queue still holds the request: it may yet apply, so the press is not called failed.
        return plainAnswer('applying')
      }
      log(`reload did not finish; the plugin set may be partly applied: ${error?.message ?? error}`)
      noteOperation(id, { status: 'failed', pending: [], failedEntries: [] }, requestId)
      return plainAnswer('failed')
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
        // The update outlasted the press's answer: the operation it belongs to ends here, when the
        // queue request really ends, and that end is what the page is told is final.
        workState.current.then(
          (late) => {
            noteOperation(id, late, requestId)
            release()
          },
          (error) => {
            // The same press ends here, so the same request id is written with it; a record keyed
            // by nothing would leave the page's retry looking like a press with no answer at all.
            noteOperation(id, { status: 'failed', pending: [], failedEntries: [], restartReason: null }, requestId)
            release()
          },
        )
      }
    }
  }

  /**
   * The press path: one request id is one run, however many times the page asks. The answer is kept
   * for the life of the record, so a retry after a lost response reads the same end instead of
   * starting a second update under the same id.
   */
  const runNow = async (force = false, requestId = null) => {
    if (typeof requestId !== 'string' || requestId === '') return runPress(force, null)
    /**
     * A press already on the record is answered from that record whatever it says: a retry that
     * meets its own run in flight is told it is still applying now, and waiting here would hold the
     * retry until the update ends, which is the very answer the page is asking about.
     */
    const remembered = seenRequest(requestId)
    if (remembered !== null) return remembered
    const held = runningPresses.get(requestId)
    if (held !== undefined) {
      log('the same press arrived again; it joins the run already under way')
      return held.promise
    }
    const work = runPress(force, requestId).then(
      (answer) => answer,
      (error) => {
        log(`a press ended without an answer: ${error?.message ?? error}`)
        return plainAnswer('failed')
      },
    )
    runningPresses.set(requestId, { promise: work, at: Date.now() })
    const forget = () => {
      // Only entries past their age are dropped: a retry of the same id must still read the same end,
      // and deleting a live entry would let a third run start on the same press.
      const limit = Date.now() - MAX_PRESS_AGE_MS
      for (const [key, row] of runningPresses) {
        if (runningPresses.size > MAX_PRESSES * 4 || (typeof row?.at === 'number' && row.at < limit)) runningPresses.delete(key)
      }
    }
    work.then(forget, forget)
    return work
  }

  /**
   * The press path never rejects: a rejection here would be unhandled and end the app, and the page
   * would wait for an answer that never comes.
   */
  const reloadNow = async (force = false, requestId = null) => {
    try {
      if (stopped) {
        // A press can arrive while the plugin is being torn down. Nothing would finish that update,
        // so it is answered as not applied instead of starting work on a dead instance.
        log('a press arrived while this plugin was stopping; nothing was replaced')
        return plainAnswer('failed')
      }
      return await runNow(force, requestId)
    } catch (error) {
      log(`a press could not be answered: ${error?.message ?? error}`)
      return plainAnswer('failed')
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
    if (pressWait !== null) {
      const waiting = pressWait
      pressWait = null
      clearTimeout(waiting.timer)
      waiting.settle()
    }
  }

  return { reloadNow, startWatching, available, stop, operation: () => operation.state }
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
    // An opaque origin belongs to a document this machine did not open, and an origin that cannot
    // be read is one this check cannot judge. Both are refused, and both say so: a refusal nobody
    // can find afterwards is the kind of silence that makes a wrong answer look like a right one.
    if (origin === 'null') {
      log('refused a press from an opaque origin')
      return false
    }
    if (origin !== '') {
      let originSite = ''
      try {
        originSite = new URL(origin).host.toLowerCase() // ui-copy-ignore
      } catch {
        log(`refused a press from an origin that is not an address: ${oneLine(origin, 200)}`)
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
function readJsonBody(req, limit = MAX_LIST_BODY_BYTES) {

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
          finish(TOO_LARGE)
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
 * Freeze the scripts one startup list resolves to, while the page that booted with it is still the
 * only document running. The desktop shell pins the list per window, so those addresses keep being
 * requested after the plugin set behind them has changed; the digest recorded here is the only
 * record of what that window actually booted from. A list that cannot be read in full is recorded
 * as incomplete rather than as a shorter list: a shorter one would vouch for a generation nobody saw.
 * @param clientModules the module table that answers bundle requests.
 * @param boot the startup list the page reported.
 * @returns the snapshot, or null when the table cannot answer at all.
 */
async function captureBootSnapshot(clientModules, boot) {
  if (typeof clientModules?.fetchBundle !== 'function') return null
  const urls = []
  for (const url of Array.isArray(boot?.urls) ? boot.urls.slice(0, MAX_STARTUP_ROWS) : []) {
    // Stored in the shape the check and the snapshot lookup both use, so a row read at boot is a
    // row the check can recognise later.
    const path = startupPath(url)
    if (path !== '' && !urls.includes(path)) urls.push(path)
  }
  let revision = null
  let entries = []
  try {
    const graph = clientModules.graph?.()
    revision = typeof graph?.rev === 'string' ? graph.rev : null
    entries = (Array.isArray(graph?.entries) ? graph.entries : [])
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : null))
      .filter((id) => id !== null)
      .slice(0, MAX_STARTUP_ROWS)
  } catch {
    revision = null
    entries = []
  }
  const rows = []
  let bytes = 0
  for (const url of urls) {
    try {
      const response = await readStartupScript(clientModules, url)
      if (response?.status !== 200) {
        rows.push({ url, unreadable: true })
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (bytes + buffer.length > MAX_TOTAL_SCRIPT_BYTES) {
        rows.push({ url, unreadable: true })
        continue
      }
      bytes += buffer.length
      const text = buffer.toString('utf8')
      rows.push({
        url,
        bytes: buffer.length,
        digest: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
        ids: [...registeredIds(text)],
        required: [...requiredIds(text)],
        lazy: [...lazyChunkFiles(text)],
      })
    } catch (error) {
      log(`cannot freeze one startup script: ${oneLine(error?.message ?? error)}`)
      rows.push({ url, unreadable: true })
    }
  }
  return {
    rev: revision,
    entries,
    rows,
    complete: rows.length === urls.length && rows.every((row) => row.unreadable !== true && typeof row.digest === 'string'),
    at: Date.now(),
  }
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
/**
 * One address shape for every startup path. The app hands the document a document-relative address
 * (`plugins/??a/client.js&rev=1`), the check reads absolute paths (`/plugins/??...`), and a snapshot
 * key has to match both: every reader goes through this function so a row captured while booting is
 * found again by the check. Joining the page's address and a relative path by hand builds
 * `hostplugins/...`, which answers 404 for a script the app serves, so the address is resolved by the
 * URL parser instead.
 */
export function startupPath(url) {
  const text = typeof url === 'string' ? url.trim() : ''
  if (text === '') return ''
  try {
    const parsed = new URL(text, 'http://unlag.invalid')
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return text.startsWith('/') ? text : `/${text.replace(/^\.?\//u, '')}`
  }
}

async function fetchBundleAt(clientModules, url, method) {
  const address = new URL(startupPath(url), 'http://unlag.invalid').href
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
  const digest = bodyDigest(body)
  return {
    body,
    contentType: 'text/javascript; charset=utf-8',
    ids: request.ids,
    askedRev: askedRevisionOf(request),
    // Assembled from more than one entry, so no single generation revision describes these bytes;
    // the graph revision still rides along to say which startup list they were taken from.
    servedRev: digest === '' ? servedRevisionOf(graph) : `sha256:${digest}`,
    digest,
    graphRev: servedRevisionOf(graph),
  }
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
  const digest = bodyDigest(body)
  return {
    body,
    contentType: 'text/javascript; charset=utf-8',
    ids: request.ids,
    gone,
    askedRev: askedRevisionOf(request),
    servedRev: digest === '' ? servedRevisionOf(graph) : `sha256:${digest}`,
    digest,
    graphRev: servedRevisionOf(graph),
  }
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
      const servedAt = revisionInUrl(target)
      return {
        body,
        contentType: String(response.headers.get('content-type') ?? 'text/javascript; charset=utf-8'),
        ids: request.ids,
        askedRev: askedRevisionOf(request),
        // The bytes came from this address, so the revision in it is the one they are; the graph
        // revision is the list running now and is reported separately.
        servedRev: servedAt === '' ? servedRevisionOf(graph) : servedAt,
        digest: bodyDigest(body),
        graphRev: servedRevisionOf(graph),
      }
    }
  }
  const regrouped = await regroupedBundleAnswer(clientModules, graph, request, deadline)
  if (regrouped !== null) return regrouped
  // What is left is the last resort: the set itself is gone and the body is a stand-in that
  // registers nothing. The check passes, and the answer says so, because a page booting that row
  // comes up without the plugin rather than failing.
  const surviving = await survivingBundleAnswer(clientModules, graph, request, deadline)
  return surviving === null ? null : { ...surviving, standIn: true }
}

/** The revision a stale request named, or '' when it named none. */
function askedRevisionOf(request) {
  return typeof request?.rev === 'string' ? request.rev : ''
}

/** The revision the app serves now, or '' when the graph cannot say. */
function servedRevisionOf(graph) {
  return typeof graph?.rev === 'string' ? graph.rev : ''
}

/**
 * The digest of the bytes actually handed back. A revision names a generation of the whole list;
 * a body assembled from several entries of that generation has no single revision of its own, so
 * it says what it is by its own content instead of borrowing the generation's name.
 */
function bodyDigest(body) {
  try {
    return createHash('sha256').update(body).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/** What a substituted body says about itself: a generation name, or its own content when it has none. */
function servedRevisionOfAnswer(answer) {
  if (typeof answer?.servedRev === 'string' && answer.servedRev !== '') return answer.servedRev
  if (typeof answer?.digest === 'string' && answer.digest !== '') return `sha256:${answer.digest}`
  return ''
}

/** `rev a → b`, so the log says which revision was asked for and what it got instead. */
function revMigration(answer) {
  const asked = answer.askedRev === '' ? 'none' : answer.askedRev
  const served = servedRevisionOfAnswer(answer) === '' ? 'unknown' : servedRevisionOfAnswer(answer)
  return `rev ${asked} → ${served}`
}

/** The headers a replaced body carries: no cache, and which revision actually answered. */
function replacedHeaders(answer) {
  const headers = {
    'content-type': answer.contentType,
    'cache-control': 'no-store',
    'content-length': String(answer.body.length),
  }
  /**
   * Two revisions, because they answer two different questions: `served-rev` is the generation the
   * bytes came from, `graph-rev` is the startup list running now. A chunk answered at its entry's
   * revision is the normal case, and reading them as one value would call that mismatch a bug.
   */
  const served = servedRevisionOfAnswer(answer)
  const graph = answer.graphRev === undefined ? '' : String(answer.graphRev)
  if (served !== '') headers['x-dsh-unlag-served-rev'] = served
  if (graph !== '') headers['x-dsh-unlag-graph-rev'] = graph
  if (typeof answer.digest === 'string' && answer.digest !== '') headers['x-dsh-unlag-body-sha256'] = answer.digest
  const exposed = [
    served === '' ? null : 'x-dsh-unlag-served-rev',
    graph === '' ? null : 'x-dsh-unlag-graph-rev',
    typeof answer.digest === 'string' && answer.digest !== '' ? 'x-dsh-unlag-body-sha256' : null,
  ].filter(Boolean)
  if (exposed.length > 0) headers['access-control-expose-headers'] = exposed.join(', ')
  return headers
}

/** The revision a bundle address names, or '' when it names none. */
function revisionInUrl(url) {
  try {
    return new URL(String(url ?? ''), 'http://unlag.invalid').searchParams.get('rev') ?? ''
  } catch {
    return ''
  }
}

/** Headers that mark replaced bytes: no cache, and both the served and the running revision. */
function replacedHeaderList(headers, servedRev, graphRev) {
  try {
    const next = new Headers(headers)
    next.set('cache-control', 'no-store')
    if (servedRev !== '') next.set('x-dsh-unlag-served-rev', servedRev)
    if (graphRev !== '') next.set('x-dsh-unlag-graph-rev', graphRev)
    const exposed = [servedRev === '' ? null : 'x-dsh-unlag-served-rev', graphRev === '' ? null : 'x-dsh-unlag-graph-rev'].filter(Boolean)
    if (exposed.length > 0) next.set('access-control-expose-headers', exposed.join(', '))
    return next
  } catch {
    return headers
  }
}

/** Re-wrap a substituted response so the bytes carry the same mark as the route's own answers. */
function replacedResource(answer, servedRev, graphRev, method) {
  if (answer === null || answer === undefined || typeof answer !== 'object') return answer
  try {
    const headers = replacedHeaderList(answer.headers, servedRev, graphRev)
    const body = method === 'HEAD' ? null : answer.body
    return new Response(body, { status: answer.status, statusText: answer.statusText, headers })
  } catch {
    return answer
  }
}

/** Answer one stale request over the plain request/response route an app registers. */
async function serveCurrentBundle(clientModules, req, res) {
  try {
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return false
    const answer = await currentBundleAnswer(clientModules, method, req?.url)
    if (answer === null) return false
    if (res.writableEnded === true || res.destroyed === true) return true
    res.writeHead(200, replacedHeaders(answer))
    res.end(method === 'HEAD' ? undefined : answer.body)
    if (Array.isArray(answer.gone) && answer.gone.length > 0) {
      const kept = answer.ids.filter((id) => !answer.gone.includes(id))
      log(
        kept.length === 0
          ? `answered an older set with an empty script in place of ${answer.gone.join(', ')}: the app would have ended on the table's 404`
          : `served ${kept.join(', ')} (${revMigration(answer)}) and left out ${answer.gone.join(', ')}: a page asked for an older set`,
      )
    } else {
      log(`served ${answer.ids.join(', ')} (${revMigration(answer)}): a page asked for an older one`)
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
    // Only a request for one plugin's whole document is answered at that plugin's revision. A chunk
    // names a file of a generation, and rewriting its revision puts another generation's bytes next
    // to the document that asked for it: the document's main script is already running, its later
    // chunk is not, and the two meet in one page. A chunk is left to the table's own answer.
    if (path === `${BUNDLE_ROUTE}/${row.id}`) return row.rev
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
          : `served ${kept.join(', ')} (${revMigration(answer)}) and left out ${answer.gone.join(', ')}: a page asked for an older set`,
      )
    } else {
      log(`served ${answer.ids.join(', ')} (${revMigration(answer)}): a page asked for an older one`)
    }
    return new Response(method === 'HEAD' ? null : answer.body, {
      status: 200,
      headers: replacedHeaders(answer),
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
      // Reading the address is the first thing that runs, and a request object that cannot answer it
      // would reject this async handler before any guard below: it is read as no address instead.
      let url = ''
      try {
        url = String(request?.url ?? '')
      } catch {}
      // Same reason as the handler shape below: a rejection here is unhandled and ends the process.
      let retargeted = null
      let graphRev = ''
      try {
        const graph = clientModules.graph()
        graphRev = servedRevisionOf(graph)
        retargeted = retargetRevision(url, entryRevisionFor(graph, url))
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
          if (second !== null && second !== undefined) {
            // These bytes come from the entry's own revision, not from the startup list running
            // now: both revisions ride along, and the immutable caching the table puts on a
            // generation is not put on an answer this plugin substituted.
            answer = replacedResource(second, revisionInUrl(retargeted), graphRev, method)
          }
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
    // Same as the resource shape: an address that cannot be read is no address. Throwing here would
    // reject the handler the server is awaiting, and a rejection nobody catches ends the process.
    let originalUrl = ''
    try {
      originalUrl = String(req?.url ?? '')
    } catch {}
    // Reading the table can throw while the plugin set is being swapped. This runs inside an async
    // route handler, where a rejection is an unhandled one and takes the whole app with it, so the
    // failure has to end here: answer the request as the table left it and say why in the log.
    let retargeted = null
    let graphRev = ''
    try {
      const graph = clientModules.graph()
      graphRev = servedRevisionOf(graph)
      retargeted = retargetRevision(originalUrl, entryRevisionFor(graph, originalUrl))
    } catch (error) {
      log(`cannot read the plugin table for a bundle request: ${error?.message ?? error}`)
    }
    /**
     * Reading the response is the other thing that runs before any guard. A response that cannot
     * answer a read is treated as one that cannot be held: the table's answer goes through, and a
     * throw here would reject the handler the server is awaiting.
     */
    let realWriteHead
    let realEnd
    let realWriteRef
    let canHold = true
    try {
      realWriteHead = res.writeHead
      realEnd = res.end
      realWriteRef = res.write
    } catch {
      canHold = false
    }
    const ask = async (url) => {
      let held = null
      let body
      const parts = []
      let failed = false
      if (url !== originalUrl) {
        try {
          req.url = url
        } catch {
          /* a frozen request keeps its own address */
        }
      }
      /**
       * A held 404 can still be written to in pieces. Passing those pieces through would send the
       * implicit 200 headers Node writes on a first `write`, and the real answer could then never
       * be sent; so the pieces are kept with the body and the socket stays untouched. A held answer
       * also owes the caller the callbacks it passed: dropping one would leave a handler that waits
       * for the flush awaiting forever, and the answer after it would never run.
       */
      const answerCallback = (args) => {
        for (let at = args.length - 1; at >= 0; at -= 1) {
          if (typeof args[at] === 'function') {
            const done = args[at]
            try {
              process.nextTick(() => {
                try {
                  done()
                } catch {
                  /* the caller's own callback failed; the document still needs its script */
                }
              })
            } catch {
              /* no event loop to defer on; the answer matters more than the callback */
            }
            return
          }
        }
      }
      /**
       * Installing the hold means writing to the response object. A response that refuses that is
       * answered as the table left it instead of thrown at, because this runs in an async route
       * handler where a rejection would be an unhandled one.
       */
      if (canHold) {
        try {
          if (typeof realWriteRef === 'function') {
            res.write = (chunk, ...rest) => {
              if (held !== null) {
                if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) parts.push(Buffer.from(chunk))
                answerCallback(rest)
                return true
              }
              return realWriteRef.call(res, chunk, ...rest)
            }
          }
          if (typeof realEnd === 'function') {
            res.end = (...args) => {
              if (held !== null) {
                const last = args[0]
                if (typeof last === 'string' || Buffer.isBuffer(last)) parts.push(Buffer.from(last))
                body = parts.length === 0 ? '' : Buffer.concat(parts)
                answerCallback(args)
                return res
              }
              return realEnd.apply(res, args)
            }
          }
          if (typeof realWriteHead === 'function') {
            res.writeHead = (status, ...rest) => {
              if (status === 404) {
                held = { status, headers: rest[0] }
                return res
              }
              /**
               * A retried answer is a substitution even though the table produced it: it is served
               * at the entry's revision, so it carries the same two revision headers as every other
               * replaced body and the year-long immutable cache the table puts on one generation is
               * replaced with no cache.
               */
              if (url !== originalUrl) {
                const headers = replacedHeaderList(rest[0], revisionInUrl(url), graphRev)
                return typeof rest[1] === 'string'
                  ? realWriteHead.call(res, status, rest[1], headers)
                  : realWriteHead.call(res, status, headers)
              }
              return realWriteHead.call(res, status, ...rest)
            }
          }
        } catch (error) {
          canHold = false
          held = null
          log(`cannot hold a 404 for a moment: ${oneLine(error?.message ?? error)}`)
        }
      }
      try {
        await Promise.resolve(original(req, res))
      } catch (error) {
        failed = true
        log(`cannot answer a bundle request: ${error?.message ?? error}`)
      } finally {
        try {
          if (canHold) {
            res.writeHead = realWriteHead
            if (realWriteRef !== undefined) res.write = realWriteRef
            res.end = realEnd
          }
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
  const owner = globalThis[INSTANCE_KEY] ?? null
  const shim = globalThis[SHIM_KEY]
  if (shim !== null && shim !== undefined) {
    const route = ctx.get('webServer')?.prefixes?.get?.(BUNDLE_ROUTE)
    /**
     * A wrap made by an earlier copy of this plugin closes over that copy's context: reusing it
     * would answer pages from a closure the app already disposed, and a reload in this copy would
     * wait on a service lookup that belongs to nobody. Only a wrap this owner made is reused.
     */
    if (shim.owner === owner && route === shim.route && route[shim.slot] === shim.wrapped && route[SHIM_MARK] === shim.wrapped) return shim
    releaseBundleShim(shim)
    globalThis[SHIM_KEY] = null
  }
  const installed = serveBundlesAtCurrentRevision(ctx)
  if (installed !== null && installed !== undefined) installed.owner = owner
  globalThis[SHIM_KEY] = installed
  return installed
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

/**
 * The entry id a `require` address really names. The app serves a few aliases of the same module —
 * `@local/b`, `@local/b/client`, `@local/b/external`, `@local/b/inject` — and the startup list and
 * the plugin table both name the short one, so an alias read as an id would look like a plugin
 * nothing serves and be skipped instead of checked.
 */
function entryIdOf(id) {
  return id.replace(/\/(?:client|external|inject)$/u, '')
}

/** The chunk files a body loads after boot: the pieces of one plugin generation, by file name. */
function lazyChunkFiles(body) {
  const files = new Set()
  for (const match of body.matchAll(/\brequire\s*\.\s*async\s*\(\s*(["'])([^"']+)\1\s*\)/gu)) {
    const name = String(match[2]).split('/').pop() ?? ''
    if (name !== '') files.add(name)
  }
  return files
}

/** Ids a body reads from the loader's table through `require`, which must already be registered. */
function requiredIds(body) {
  const ids = new Set()
  for (const match of body.matchAll(/\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/gu)) ids.add(entryIdOf(match[2]))
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
export async function verifyStartupRows(graph, fetchBody, rows, budgetMs = MAX_VERIFY_MS, limits = null) {
  // The bounds are the shipped ones; the argument exists so a test can work them at a size a test
  // run can afford. Anything not a usable number falls back to the shipped bound.
  const maxScriptBytes = Number.isFinite(limits?.maxScriptBytes) ? limits.maxScriptBytes : MAX_SCRIPT_BYTES
  const maxTotalBytes = Number.isFinite(limits?.maxTotalBytes) ? limits.maxTotalBytes : MAX_TOTAL_SCRIPT_BYTES
  // A startup list is checked against the plugin set, so a set that cannot be read at all leaves
  // nothing to check against: approving anyway would vouch for addresses nothing backs, and the
  // next document would die on the first one that answers 404. An empty set is still a readable
  // one — a row it no longer names is served from the retained bundle and reported as left out.
  if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.entries)) {
    return { status: 'blocked', reason: 'list', detail: 'the plugin list cannot be read, so no startup row can be checked against it' }
  }
  // The list is the running app's own object and it is re-composed while a swap runs, so reading a
  // row is a step that can fail like any other: a row that cannot be read leaves the list unread,
  // which is a refusal with a reason, not an exception out of the route.
  let entries
  try {
    entries = new Map(
      (Array.isArray(graph.entries) ? graph.entries : [])
        .filter((row) => typeof row?.id === 'string' && row.id !== '')
        .map((row) => [row.id, row]),
    )
  } catch (error) {
    return { status: 'blocked', reason: 'list', detail: `the plugin list cannot be read: ${String(error?.message ?? error)}` }
  }
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
    // A list can name the same address more than once, and one address can be most of a profile's
    // bytes: read each address once so a repeated row cannot make one check read the profile's
    // scripts tens of times.
    if (wanted.some((entry) => entry.url === url)) continue
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
  // The set a check reads is the one the next document boots, so the revision that set was at when
  // the first body left must still be the revision when the last one arrives: a recomposition in
  // between means the bodies came from two different generations and no one answer describes them.
  let revisionAtStart = null
  try {
    revisionAtStart = typeof graph?.rev === 'string' ? graph.rev : null
  } catch {}
  const served = new Set(entries.keys())
  const leftOut = new Set()
  const listed = new Set()
  const bodies = []
  const began = Date.now()
  let totalBytes = 0
  let standInRows = 0
  for (const item of wanted) {
    if (Date.now() - began > budgetMs) {
      return { status: 'blocked', reason: 'slow', detail: 'the startup list took longer than this check waits' }
    }
    for (const id of item.ids) if (served.has(id)) listed.add(id)
    for (const id of item.ids) if (!served.has(id)) leftOut.add(id)
    let response = null
    const read = await withDeadline(() => fetchBody(item.url), budgetMs - (Date.now() - began))
    if (read.timedOut === true) {
      return { status: 'blocked', reason: 'slow', detail: `${item.url} did not answer within the time this check waits` }
    }
    if ('error' in read) {
      return { status: 'blocked', reason: 'network', detail: `${item.url}: ${String(read.error?.message ?? read.error)}` }
    }
    response = read.value
    // Reading the answer is the same kind of step as fetching it: a response whose status or body
    // cannot be read is one this check cannot approve, and saying which script failed beats
    // abandoning the whole list without a name in the reason.
    let status = null
    let readable = true
    try {
      status = response?.status ?? null
    } catch {
      readable = false
    }
    if (!readable || response === null || response === undefined || status !== 200) {
      return { status: 'blocked', reason: 'missing', detail: `${item.url} answers ${readable ? String(status ?? 'nothing') : 'nothing readable'}` }
    }
    try {
      if (response?.standIn === true) standInRows += 1
    } catch {}
    let bytes = null
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      return { status: 'blocked', reason: 'missing', detail: `${item.url} cannot be read: ${String(error?.message ?? error)}` }
    }
    if (bytes.length === 0) return { status: 'blocked', reason: 'empty', detail: `${item.url} answers an empty body` }
    totalBytes += bytes.length
    if (bytes.length > maxScriptBytes || totalBytes > maxTotalBytes) {
      return { status: 'blocked', reason: 'size', detail: `${item.url} answers ${String(bytes.length)} bytes; this check reads at most ${String(maxScriptBytes)} per script and ${String(maxTotalBytes)} in all` }
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
    const record = { url: item.url, ids: item.ids, registered, required: requiredIds(text), lazy: [...lazyChunkFiles(text)] }
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
  /**
   * A row whose plugin is gone cannot boot the next page, whatever the route answers for it: the
   * shell still holds a frozen list naming that entry and the app's loader still imports it, so a
   * stand-in body that registers nothing fails the boot after the press was allowed. Refusing here
   * costs one press; the page that would come up costs the running turns.
   */
  if (revisionAtStart !== null) {
    let revisionNow = revisionAtStart
    try {
      const after = graph?.rev
      revisionNow = typeof after === 'string' ? after : revisionAtStart
    } catch {}
    if (revisionNow !== revisionAtStart) {
      return { status: 'blocked', reason: 'generation', detail: 'the plugin set was replaced while its scripts were read' }
    }
  }
  if (leftOut.size > 0) {
    return {
      status: 'blocked', // ui-copy-ignore
      reason: 'entries', // ui-copy-ignore
      leftOut: [...leftOut],
      ...(standInRows > 0 ? { standInRows } : {}),
      detail: `the startup list names plugins this app no longer serves: ${[...leftOut].slice(0, 4).join(', ')}`,
    }
  }
  return {
    status: 'ok', // ui-copy-ignore
    reason: 'ok', // ui-copy-ignore
    revision: typeof graph?.rev === 'string' ? graph.rev : null,
    scripts: bodies.map((body) => ({ url: body.url, digest: body.digest, ids: body.ids })),
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
    // The document asks the app's own route first and the mapping only answers a request that route
    // no longer knows, so the check reads in that same order: bytes taken from the mapping while the
    // route had an answer were bytes the next page would never run.
    const served = await fetchBundleAt(clientModules, url, 'GET')
    if (served !== null && served.status === 200) return served
    const answer = await currentBundleAnswer(clientModules, 'GET', url)
    // `standIn` rides along: these bytes stand in for a plugin the set no longer has, and the check
    // says so when it refuses, so the log can tell that from a body the app really serves.
    if (answer !== null) return { status: 200, standIn: answer.standIn === true, arrayBuffer: async () => answer.body }
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
  const answer = await verifyStartupRows(graph, (url) => readStartupScript(clientModules, url), rows)
  /**
   * The update installs a new graph object and never mutates the old one, so a replacement during
   * the read cannot be seen on the object the check started with; it is found by asking the table
   * for its graph again. Bodies read from two different generations would describe a page that
   * never boots, so a swap during the check refuses it instead of approving either side.
   */
  let after = null
  try {
    after = clientModules.graph()
  } catch (error) {
    // The table answered the scripts; only the second look failed. The checked answer stands, and
    // the log keeps the reason a swap could not be ruled out.
    log(`cannot read the plugin table again after a startup check: ${oneLine(error?.message ?? error)}`)
    return answer
  }
  if (answer?.status === 'ok' && (after !== graph || servedRevisionOf(after) !== servedRevisionOf(graph))) {
    return { status: 'blocked', reason: 'generation', detail: 'the plugin set was replaced while its scripts were read' }
  }
  if (answer?.status === 'ok') {
    const proof = await bootGenerationProof(answer)
    if (proof !== null) return proof
  }
  return answer
}

/**
 * Whether the frozen generation a page booted with can still become one document after a rebuild.
 *
 * The shell freezes the startup list per window, so after a plugin was swapped those addresses are
 * answered with today's bytes: the main script comes from the frozen list and each chunk from
 * whatever the table serves now. That is the designed path and it is sound only while the newer body
 * still registers what the older one expects to find — the ids it loaded and the modules it required.
 * The snapshot taken when the page reported its list is what those expectations are read from; a
 * newer body that drops one of those ids is a document that boots half way, so the press is held
 * before it can take the running turns with it. A record that could not be taken, all of it, is not
 * that evidence: addresses stop answering as the set moves on, and a page whose history cannot be
 * read still has to be able to press, so such a press rests on the startup check alone.
 * @param answer the startup check's own verdict, over the rows the page reported.
 * @returns a refusal, or null when the two generations can meet in one document.
 */
async function bootGenerationProof(answer) {
  // A window that never reported its list is not proven wrong; its addresses are checked as before.
  if (liveBoot.current === null) return null
  let snapshot = liveBoot.snapshot
  if (snapshot !== null && typeof snapshot === 'object' && snapshot.pending === true) {
    // The capture is a handful of script reads; the press waits for them rather than treating a
    // record that is still being written as one that disagrees.
    const deadline = Date.now() + MAX_BOOT_PROOF_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      snapshot = liveBoot.snapshot
      if (!(snapshot !== null && typeof snapshot === 'object' && snapshot.pending === true)) break
    }
  }
  /**
   * A record that is missing or short is not evidence against the press: the old addresses may have
   * stopped answering before the capture could read them, and that says nothing about the document
   * the press would boot. Refusing on it would leave the button dead for a window that has no other
   * way back, so the press goes on the startup check's own verdict over the rows the page reported.
   */
  if (snapshot === null || typeof snapshot !== 'object' || snapshot.pending === true) {
    log('the scripts this page booted with could not be frozen; the press is checked against the list it reported')
    return null
  }
  if (snapshot.complete !== true) {
    log('the scripts this page booted with could not all be read; the press is checked against the list it reported')
    return null
  }
  /**
   * A body the app serves now is allowed to differ from the frozen one — that is the update being
   * pressed. What it may not do is drop an id the frozen document loads: the list this window boots
   * with names those ids, and a newer body that registers fewer of them leaves the rebuilt document
   * requiring a module nothing provides. Modules the older body required are not checked: after the
   * rebuild it is the newer body that runs, and its own dependencies were checked against the table.
   */
  const known = new Map((Array.isArray(snapshot.rows) ? snapshot.rows : []).map((row) => [row.url, row]))
  const scripts = Array.isArray(answer?.scripts) ? answer.scripts : []
  const currentIds = new Set()
  for (const script of scripts) for (const id of Array.isArray(script?.ids) ? script.ids : []) currentIds.add(id)
  for (const script of scripts) {
    const row = known.get(script?.url)
    if (row === undefined || row.unreadable === true || typeof row.digest !== 'string') continue
    if (script?.digest === row.digest) continue
    for (const id of Array.isArray(row.ids) ? row.ids : []) {
      if (currentIds.has(id)) continue
      return { status: 'blocked', reason: 'boot', detail: `the newer scripts no longer register ${oneLine(String(id))}, which this page loads` }
    }
    /**
     * The same rule for the files a body loads after boot. Those are asked for under this page's own
     * revision, so a newer generation that renamed them answers 404 to the page that is already
     * running; a rebuild is held here rather than handed documents whose later chunks are gone.
     */
    const frozenChunks = Array.isArray(row.lazy) ? row.lazy : []
    const currentChunks = new Set([...(script?.lazy ?? [])])
    for (const file of frozenChunks) {
      if (currentChunks.has(file)) continue
      return { status: 'blocked', reason: 'generation', detail: `the newer plugin no longer loads ${oneLine(String(file))}, which this page's copy asks for` }
    }
  }
  return null
}

/** The sentinel a read that ran past its time resolves to: a value, never an error. */
const LATE = Symbol('late')

/**
 * One read the check will not wait past. The budget is counted between rows already; a single
 * address that never answers would otherwise hold the press past the moment the page stops waiting
 * for it, and the page would be told the check timed out with nothing naming what hung. Racing the
 * read keeps the reason the check's own, and the read itself is left to finish with its bytes
 * dropped, so nothing is left half-read.
 */
async function withDeadline(work, ms) {
  let timer = null
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, ms))
  })
  const settled = Promise.resolve().then(work).then((value) => ({ value }), (error) => ({ error }))
  const answer = await Promise.race([settled, late])
  if (timer !== null) clearTimeout(timer)
  return answer === LATE ? { timedOut: true } : answer
}

/** What one press is told when the update it waits for did not answer in time. */
const STILL_APPLYING = Object.freeze({ status: 'applying', warnings: [], pending: [], restartReason: null, failedEntries: [], rebuild: 'pending', healthReadable: null });

/**
 * The answer a press waits for, bounded in time. The update is asked for at most once and its
 * answer is settled the same way whether it is a promise, a plain value, or a promise that cannot
 * even be awaited: the page is always told one status, and nothing a plugin swap answers can turn
 * the route into an error.
 * @returns {{ outcome: object, timeRanOut: boolean, work: Promise<unknown> }}
 */
export async function answerReload(controller, limitMs, requestId = null) {
  let work = null
  try {
    work = Promise.resolve(controller.reloadNow(false, requestId))
  } catch (error) {
    log(`a press could not be started: ${error?.message ?? error}`)
    return { outcome: { status: 'failed', warnings: [], pending: [], restartReason: null, failedEntries: [], rebuild: 'unsafe', healthReadable: null }, timeRanOut: false, work: Promise.resolve() }
  }
  let timer = null
  let timeRanOut = false
  const ranOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      timeRanOut = true
      resolve(STILL_APPLYING)
    }, limitMs)
  })
  try {
    const outcome = await Promise.race([work.catch(() => null), ranOut])
    // Reading the status can throw too; an answer that cannot be read is not one the page can use.
    try {
      if (outcome !== null && typeof outcome === 'object' && typeof outcome.status === 'string') return { outcome, timeRanOut, work }
    } catch {}
    // An update that answers nothing usable is still a press that has to be answered.
    return { outcome: { status: 'failed', warnings: [], pending: [], restartReason: null, failedEntries: [], rebuild: 'unsafe', healthReadable: null }, timeRanOut, work }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * The two switches a press reads. They start from the plugin's settings row, and the button's own
 * menu can change them without reopening the app. The saved choice is filed next to the settings
 * it was made against: editing that row changes the file it was read from, and the saved choice is
 * then stale rather than silently overriding a person's newer decision.
 */
const SWITCH_PATH = join(homedir(), '.dsh', 'unlag-switches.json') // ui-copy-ignore

/** The settings row this plugin was started with, written down so a saved choice can tell. */
function switchFingerprint(settings) {
  return createHash('sha256').update(JSON.stringify({ plugins: settings.reloadPlugins, page: settings.reloadInterface, auto: settings.autoReload, agent: settings.agentRefresh })).digest('hex').slice(0, 16)
}

/** The switches a press uses: the saved menu choice when it was made against this settings row. */
function switchesFor(config) {
  const settings = settingsOf(config ?? {})
  const fingerprint = switchFingerprint(settings)
  const fallback = { plugins: settings.reloadPlugins, page: settings.reloadInterface, agent: settings.agentRefresh, fingerprint, saved: false }
  try {
    if (!existsSync(SWITCH_PATH)) return fallback
    const raw = JSON.parse(readFileSync(SWITCH_PATH, 'utf8'))
    if (raw === null || typeof raw !== 'object') return fallback
    if (raw.fingerprint !== fingerprint) return fallback
    if (typeof raw.plugins !== 'boolean' || typeof raw.page !== 'boolean') return fallback
    // A file written before the agent switch existed has no word for it: the settings row answers.
    const agent = typeof raw.agent === 'boolean' ? raw.agent : settings.agentRefresh
    return { plugins: raw.plugins, page: raw.page, agent, fingerprint, saved: true }
  } catch {
    return fallback
  }
}

/** Write the menu choice down. A press that cannot save it still uses it until the app restarts. */
function saveSwitches(switches) {
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    const body = JSON.stringify({ plugins: switches.plugins, page: switches.page, agent: switches.agent === true, fingerprint: switches.fingerprint })
    const temporary = `${SWITCH_PATH}.${process.pid}.tmp`
    writeFileSync(temporary, body)
    renameSync(temporary, SWITCH_PATH)
    return true
  } catch (error) {
    log(`cannot save the button settings: ${error?.message ?? error}`)
    return false
  }
}

/** What a tool call is told when the switch that allows it is off. */
const AGENT_REFRESH_OFF = '在右键菜单里打开 Agent 可以自己刷新' // ui-copy-ignore

/** One answer for the tool: a status, one line a model can repeat, and what the rebuild proved. */
function agentAnswer(outcome) {
  const status = typeof outcome?.status === 'string' ? outcome.status : 'failed'
  const rebuild = typeof outcome?.rebuild === 'string' ? outcome.rebuild : 'unknown'
  const answer = { status, rebuild, reason: '刷新没有完成，插件还在用旧代码' }
  if (typeof outcome?.healthReadable === 'boolean') answer.healthReadable = outcome.healthReadable
  if (status === 'done') answer.reason = '插件已换成新代码'
  else if (status === 'applying' || status === 'queued') answer.reason = '还在刷新，稍后再按一次'
  else if (status === 'restart') answer.reason = '有新插件要重启后才能生效'
  else if (status === 'unavailable') answer.reason = '这里没有可以换插件的服务'
  return answer
}

/**
 * The press as a tool, so an agent working in the app can refresh without a person. It is offered
 * only when the settings row says so, and it goes through the same press, the same switches and the
 * same safety gate as the button: the process is never restarted and no service is ever started.
 */
/**
 * One property read that a context which throws on undeclared reads cannot turn into a failure.
 * Even `typeof ctx.inject` reads the property, and the read itself is what throws in Cordis.
 */
function propOf(target, name) {
  try {
    return target?.[name]
  } catch {
    return undefined
  }
}

function toolsOf(ctx) {
  /**
   * A Cordis context refuses a plain property read of a service this plugin did not declare, by
   * throwing. That refusal is not an error worth ending a start-up for: the tool is an extra, and
   * the same context answers the same question through reflect() and get().
   */
  const direct = propOf(ctx, 'tools')
  if (direct !== undefined && direct !== null) return direct
  const reflect = propOf(ctx, 'reflect')
  try {
    const reflected = typeof reflect?.get === 'function' ? reflect.get('tools', false) : undefined
    if (reflected !== undefined && reflected !== null) return reflected
  } catch {}
  const get = propOf(ctx, 'get')
  try {
    const gotten = typeof get === 'function' ? get.call(ctx, 'tools') : undefined
    if (gotten !== undefined && gotten !== null) return gotten
  } catch {}
  return null
}

function registerAgentTool(ctx, controller, config) {
  const tools = toolsOf(ctx)
  if (tools === null || typeof tools.register !== 'function') return false
  const effect = propOf(ctx, 'effect')
  if (typeof effect !== 'function') return false
  try {
    effect.call(ctx, () => tools.register({
      name: 'unlag_refresh', // ui-copy-ignore
      description: '按一下刷新按钮；关闭时说明原因',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          requestId: { type: 'string', description: '这次刷新的名字；同样的名字只刷新一次' },
        },
        additionalProperties: false,
      },
      output: { // ui-copy-ignore
        presentationMeta: (_args, value) => ({ kind: 'unlag-refresh', status: value.status }),
        schema: {
          type: 'object', // ui-copy-ignore
          properties: {
            status: { type: 'string', enum: ['done', 'failed', 'blocked', 'applying', 'queued', 'restart', 'unavailable'] },
            reason: { type: 'string' }, // ui-copy-ignore
            rebuild: { type: 'string', enum: ['safe', 'unsafe', 'unknown', 'pending'] },
            healthReadable: { type: 'boolean' },
          },
          required: ['status'], // ui-copy-ignore
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `刷新 · ${value.reason ?? value.status}` }],
      },
      execute: async (args) => { // ui-copy-ignore
        try {
          const switches = switchesFor(config ?? {})
          if (switches.agent !== true) return { status: 'blocked', reason: AGENT_REFRESH_OFF, rebuild: 'unknown' }
          if (switches.plugins !== true) return { status: 'blocked', reason: '刷新按钮里的换插件是关的，先在那里打开', rebuild: 'unknown' }
          const raw = args?.requestId
          const requestId = typeof raw === 'string' && raw !== '' && raw.length <= 120 ? raw : null
          const { outcome } = await answerReload(controller, RELOAD_ANSWER_MS, requestId)
          return agentAnswer(outcome)
        } catch (error) {
          log(`the refresh tool could not press: ${error?.message ?? error}`)
          return { status: 'failed', reason: '刷新没有完成，插件还在用旧代码', rebuild: 'unknown' }
        }
      },
    }), 'unlag: unlag_refresh')
    return true
  } catch (error) {
    log(`cannot offer the refresh tool: ${error?.message ?? error}`)
    return false
  }
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
  const switches = switchesFor(config)
  /** One counter for the whole route set: the check is the only body that reads scripts. */
  let checking = 0
  const handlers = [
    [
      `${BASE_PATH}/state`,
      (req, res) => {
        // A disposed context answers with a status instead of a throw the server has to guess at.
        try {
          // These two are reads. Any other method is told so, the way the app's own bundle route
          // answers a method it does not serve.
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { status: 'method' })
          sendJson(res, 200, { version: VERSION, code: CODE_STAMP, plugins: switches.plugins, page: switches.page, agentRefresh: switches.agent === true, saved: switches.saved, shim: bundleShimStatus(ctx), operation: controller.operation?.() ?? null, boot: liveBoot.current, bootSnapshot: liveBoot.snapshot })
        } catch (error) {
          log(`cannot describe this copy of the plugin: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
        }
      },
    ],
    [
      `${BASE_PATH}/graph`,
      (req, res) => {
        // The page reads this before a rebuild; an answer that throws would leave the press with
        // no verdict at all, so the whole body is bounded and answers either way.
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { status: 'method' })
          ensureBundleShim(ctx)
          sendJson(res, 200, { graph: liveBootGraph(ctx) })
        } catch (error) {
          // A press that cannot read the plugin list has to say so somewhere: the page only learns
          // that the answer was empty, and this line is what explains it afterwards.
          log(`cannot describe the plugin list: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error', detail: String(error?.message ?? error) })
        }
      },
    ],
    [
      `${BASE_PATH}/boot`,
      async (req, res) => {
        // A page saying what it booted with. Nothing here acts on it: it is the frozen list a check
        // compares the served scripts against, and a malformed report is refused rather than stored.
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
          if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
          const body = await readJsonBody(req)
          if (body === TOO_LARGE) return sendJson(res, 200, { status: 'blocked' })
          const boot = body?.boot
          if (boot === null || typeof boot !== 'object') return sendJson(res, 200, { status: 'blocked' })
          const urls = []
          for (const batch of Array.isArray(boot.batches) ? boot.batches.slice(0, 200) : []) {
            const url = typeof batch?.url === 'string' ? batch.url : ''
            if (url === '') continue
            /**
             * A batch address is real evidence or it is nothing: the app's own list runs to several
             * kilobytes, and a shortened address would name a different set. One too long to keep
             * refuses the report rather than storing a value that cannot be compared later.
             */
            if (url.length > MAX_BOOT_URL) return sendJson(res, 200, { status: 'blocked', reason: 'url' })
            urls.push(url)
          }
          const entries = (Array.isArray(boot.entries) ? boot.entries : [])
            .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
            .filter((id) => typeof id === 'string')
            .slice(0, 200)
          liveBoot.current = {
            rev: typeof boot.rev === 'string' ? boot.rev.slice(0, 64) : null,
            entries: entries.length,
            urls,
            at: Date.now(),
          }
          log(`the page reported the startup list it was frozen with (${String(urls.length)} script address(es))`)
          /**
           * The list is frozen per window and those addresses keep being requested after the plugin
           * set behind them changed, so the bytes it resolves to are written down now, in the same
           * turn: reading them later would capture whatever generation happened to be serving then.
           * The capture is left to finish on its own; a press that needs it waits for it below.
           */
          try {
            liveBoot.snapshot = null
            const reportStamp = liveBoot.capture + 1
            liveBoot.capture = reportStamp
            const clientModules = ctx.get('clientModules')
            void captureBootSnapshot(clientModules, { urls })
              .then((snapshot) => {
                // A newer report owns the record: this one describes a window that is no longer
                // the document asking for a rebuild.
                if (liveBoot.capture !== reportStamp) return
                liveBoot.snapshot = snapshot
                if (snapshot !== null) {
                  log(`froze the startup scripts the page booted with (${String(snapshot.rows.filter((row) => row.unreadable !== true).length)} of ${String(snapshot.rows.length)} readable, ${snapshot.complete ? 'complete' : 'incomplete'})`)
                }
              })
              .catch((error) => {
                if (liveBoot.capture !== reportStamp) return
                liveBoot.snapshot = null
                log(`cannot freeze the startup scripts the page booted with: ${oneLine(error?.message ?? error)}`)
              })
            // Set before the capture resolves: a check that reads it sees "not yet known" rather
            // than the previous window's generation.
            liveBoot.snapshot = { pending: true }
          } catch (error) {
            log(`cannot freeze the startup scripts the page booted with: ${oneLine(error?.message ?? error)}`)
            liveBoot.snapshot = null
          }
          sendJson(res, 200, { status: 'done' })
        } catch (error) {
          log(`cannot record the page's startup list: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
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
          /**
           * Each check holds the bytes of one script while it reads them, so a page that asks in a
           * loop, or several windows asking at once, must not stack those reads without a ceiling: the
           * app is the process that would run out of memory. Past three the check is refused in its
           * own words rather than served slowly or not at all.
           */
          if (checking >= MAX_CONCURRENT_CHECKS) {
            log(`a startup check was refused: ${String(checking)} checks are already reading the plugin table`)
            return sendJson(res, 200, { status: 'blocked', reason: 'busy', detail: 'another startup check is still running' })
          }
          checking += 1
          try {
          const clientModules = ctx.get('clientModules')
          if (typeof clientModules?.fetchBundle !== 'function' || typeof clientModules?.graph !== 'function') {
            return sendJson(res, 200, { status: 'blocked', reason: 'list', detail: 'the plugin table is not running' })
          }
          const body = await readJsonBody(req)
          // A list larger than the bound is refused in its own words: an oversized request is not an
          // empty list, and a person told their startup list names nothing would look in the wrong place.
          if (body === TOO_LARGE) {
            log('a startup check refused the page: size (the startup list is longer than this check reads)')
            return sendJson(res, 200, { status: 'blocked', reason: 'size', detail: 'the startup list is longer than this check reads' })
          }
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
            log(`a startup row names a plugin this app no longer serves: ${verdict.leftOut.join(', ')}; a stand-in body registers nothing, so the boot would fail and this press is held`)
          }
          sendJson(res, 200, verdict)
          } finally {
            checking -= 1
          }
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
           * The same address check the press uses applies here too: the log is the record a press
           * leaves behind, so a page that may not press may not write into it either.
           */
          if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
          let query = ''
          try {
            query = new URL(String(req?.url ?? ''), 'http://x').searchParams.toString()
          } catch {}
          const params = new URLSearchParams(query)
          const event = params.get('event') ?? ''
          // A query comes from outside: one shaped gate keeps a forged line out of the log. A press
          // that got a plugin set applied and then stopped says which two things happened
          // (`applied:<gate>`); keeping the two apart is what makes the line say what stopped it.
          const askedGate = (params.get('gate') ?? '').replace(/[^a-z:]/gu, '').slice(0, 32)
          const gate = askedGate
            .split(':')
            .filter((part) => part !== '')
            .join(' then ')
          // Which generation of the page came up. A rebuild that lands on older bytes then says so.
          const pageRev = (params.get('rev') ?? '').replace(/[^a-z0-9]/gu, '').slice(0, 24)
          // Each document has its own time origin, so the log can tell one page reporting twice
          // from two documents coming up. Without it a double reload and a doubled report read
          // the same.
          const born = (params.get('born') ?? '').replace(/[^0-9]/gu, '').slice(0, 16)
          const navType = (params.get('nav') ?? '').replace(/[^a-z_]/gu, '').slice(0, 16)
          const loadFrom = (params.get('from') ?? '').replace(/[^a-z]/gu, '').slice(0, 12)
          const viewRaw = (params.get('view') ?? '').replace(/[^a-zA-Z0-9/._x|-]/gu, '').slice(0, 64)
          const [viewPath = '', viewBox = '', viewOuter = '', viewTab = '', viewHist = '', viewVis = ''] = viewRaw.split('|')
          const view = [
            viewPath === '' && viewBox === '' ? '' : `at ${viewPath === '' ? '?' : viewPath} ${viewBox === '' ? '?' : viewBox}`,
            viewOuter === '' ? '' : `win ${viewOuter}`,
            viewTab === '' || viewTab === '0' ? '' : `tab ${viewTab}`,
            viewHist === '' || viewHist === '0' ? '' : `hist ${viewHist}`,
            viewVis === '' ? '' : viewVis
          ].filter((part) => part !== '').join(', ')
          const first = [pageRev === '' ? '' : `page ${pageRev}`, born === '' ? '' : `born ${born}`, navType === '' ? '' : `nav ${navType}`, loadFrom === '' ? '' : `from ${loadFrom}`, view === '' ? '' : `at ${view}`]
            .filter((part) => part !== '')
            .join(', ')
          const suffix = first === '' ? '' : ` (${first})`
          /**
           * Every outcome the page reports is written down. A press whose line was missing left the
           * log unable to say what happened; an outcome with no line of its own (a failed
           * replacement, a press when both switches are off) says so in its own words.
           */
          const named = event.replace(/[^a-z-]/gu, '').slice(0, 24)
          if (named === 'mounted') {
            // One rebuild can report twice: the page's own readiness and the press that caused it.
            // The same page born at the same moment is one event, so the second line is skipped.
            const now = Date.now()
            const key = `${pageRev}|${born}`
            if (lastRebuilt.key === key && now - lastRebuilt.at < 2000) {
              // ui-copy-ignore
            } else {
              lastRebuilt = { key, at: now }
              log(`interface rebuilt; the page runs the plugins as served now${suffix}`)
            }
          }
          else if (named === 'rebuild') log('rebuild allowed: the page re-enters on the served modules')
          else if (named === 'navigating') log('the page is going for a fresh document')
          else if (named === 'held') log(`rebuild held back: ${gate === '' ? 'unknown' : gate}`)
          else if (named === '') log('a press reported nothing')
          else log(`a press ended: ${named}${gate === '' ? '' : ` (${gate})`}${suffix}`)
          sendJson(res, 200, { status: 'done' })
        } catch (error) {
          log(`cannot record a press report: ${error?.message ?? error}`)
          sendJson(res, 500, { status: 'error' })
        }
      },
    ],
    [
      `${BASE_PATH}/switches`,
      async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
          if (buttonAllowed(req) === false) return sendJson(res, 403, { status: 'forbidden' })
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object') return sendJson(res, 400, { status: 'body' })
          const plugins = body.plugins
          const page = body.page
          const agent = body.agentRefresh
          if (typeof plugins !== 'boolean' || typeof page !== 'boolean') return sendJson(res, 400, { status: 'body' })
          if (agent !== undefined && typeof agent !== 'boolean') return sendJson(res, 400, { status: 'body' })
          switches.plugins = plugins
          switches.page = page
          if (agent !== undefined) switches.agent = agent
          switches.saved = saveSwitches(switches)
          log(`the button switches were changed: plugins=${plugins ? 'on' : 'off'} page=${page ? 'on' : 'off'} agent=${switches.agent === true ? 'on' : 'off'}`)
          sendJson(res, 200, { status: 'done', plugins: switches.plugins, page: switches.page, agentRefresh: switches.agent === true, saved: switches.saved })
        } catch (error) {
          log(`cannot change the button switches: ${error?.message ?? error}`)
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
          if (!switches.plugins) return sendJson(res, 200, { status: 'off' })
          const limit = Number(process.env.DSH_UNLAG_ANSWER_MS ?? '') || RELOAD_ANSWER_MS
          // The page names this press so a lost answer can be checked against the same operation
          // instead of against a revision that anything else could have moved.
          let requestId = null
          try {
            requestId = new URL(String(req?.url ?? ''), 'http://dsh.invalid').searchParams.get('requestId')
          } catch {}
          if (requestId !== null && (requestId === '' || requestId.length > 120)) requestId = null
          const { outcome, timeRanOut, work } = await answerReload(controller, limit, requestId)
          /**
           * The answer the page waits for is bounded, but the update is not. Whatever the update
           * did after the page was told it is still applying is written down here: a replacement
           * that failed a moment later must not look like one that succeeded.
           */
          if (outcome.status === 'applying') {
            if (timeRanOut) log('the update outlasted the answer the page waits for: the press is told it is still applying')
            else log('a press arrived while an update is already applying: the press is told it is still applying')
            work.then(
              (late) => log(`the update finished after the page was told it is still applying: ${String(late?.status ?? 'no status')}`),
              (error) => log(`the update failed after the page was told it is still applying: ${error?.message ?? error}`),
            )
          }
          sendJson(res, 200, { ...outcome, operationId: outcome.operationId ?? controller.operation?.()?.id ?? null })
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
      const dispose = server.register({ kind: 'exact', path, handler: guardRoute(path, handler) })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`cannot answer ${path}: ${error?.message ?? error}`)
    }
  }
  return () => {
    for (const dispose of disposers) closeAll(dispose)
  }
}

export function guardRoute(path, handler) {
  /**
   * Nothing a route body does may reach the server as a rejection or a throw: an answer that never
   * settles is a page that waits forever, and a rejected handler can take the request down instead
   * of saying what happened. Each body answers from its own guard already; this is the floor under
   * them, so a future edit that misses a path costs a status rather than the answer.
   */
  return (req, res) => {
    const fallback = (error) => {
      log(`cannot answer ${path}: ${error?.message ?? error}`)
      try {
        if (res?.headersSent !== true) sendJson(res, 503, { status: 'error' })
        else if (res?.writableEnded !== true && res?.destroyed !== true) res.end()
      } catch {
        /* the response is already gone; the log line is what is left to say */
      }
    }
    try {
      const answer = handler(req, res)
      // The answer is handed back as it came: a caller that waits on the body still waits on it,
      // and the rejection is watched here as well rather than instead.
      if (answer !== null && typeof answer === 'object' && typeof answer.then === 'function') {
        answer.then(undefined, fallback)
      }
      return answer
    } catch (error) {
      fallback(error)
      return undefined
    }
  }
}

export function apply(ctx, config) {
  try {
    const instance = {}
    /**
     * What this copy of the plugin owns. An update replaces the plugin that started a watcher, a
     * route or a bundle wrap; the newer copy installs its own and the older one is never disposed in
     * the normal flow, so whatever this copy made is closed from its own record. Clearing a global
     * slot is done only where that slot still names this copy's own handle.
     */
    const own = { watchers: null, routes: null, shim: null }
    closeAll(globalThis[WATCHER_KEY])
    closeAll(globalThis[ROUTES_KEY])
    releaseBundleShim(globalThis[SHIM_KEY])
    // A press still running belongs to the copy being replaced: its record, not its promise, is what
    // a retry after this composition reads, and holding the dead run here would answer the new page
    // with an update it never made.
    globalThis[Symbol.for('dsh-unlag.presses-live')]?.clear?.()
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
      own.shim = ensureBundleShim(ctx)
    }
    /**
     * Watching needs both the HMR service and an explicit opt-in: the switch defaults off, so no
     * root is installed and no saved file applies anything by itself.
     */
    const syncWatching = () => {
      // Automatic reloading is an extra, and the press is the feature: anything that goes wrong
      // while setting a watch up is said in one line and left off, never turned into a plugin that
      // did not load.
      try {
        if (settingsOf(config ?? {}).autoReload !== true) return
        if (controller.available() === false) {
          closeAll(globalThis[WATCHER_KEY])
          globalThis[WATCHER_KEY] = null
          return
        }
        if (globalThis[WATCHER_KEY] !== null) return
        globalThis[WATCHER_KEY] = controller.startWatching()
        own.watchers = globalThis[WATCHER_KEY]
      } catch (error) {
        closeAll(globalThis[WATCHER_KEY])
        globalThis[WATCHER_KEY] = null
        log(`cannot watch for saved plugin changes: ${error?.message ?? error}; a press still works`)
      }
    }
    // Printed on every start so a reader of the log knows which action applies a change: a person
    // pressing the button, never this plugin, and never a restart of the app.
    let composerMounted = false
    try {
      const ids = activeEntryIds(ctx)
      composerMounted = ids.some((id) => typeof id === 'string' && id.includes('conversation'))
    } catch {
      composerMounted = false
    }
    log(`dsh-unlag ${VERSION} loaded (code ${CODE_STAMP}, composer: ${composerMounted ? 'mounted' : 'no-composer'})`)
    log('plugin reload is manual: ask the user to press the refresh button; do not restart the app')
    if (settingsOf(config ?? {}).autoReload === true) {
      syncWatching()
      if (globalThis[WATCHER_KEY] === null) log('auto reload is on but the hmr entry is not running; a press still works')
      else log('auto reload is on: a saved plugin change applies without a press')
    } else {
      log('auto reload is off: no plugin source is watched')
    }
    /** A context that throws on every undeclared read must not be able to refuse a listener. */
    const listen = (event, handler) => {
      const on = propOf(ctx, 'on')
      if (typeof on !== 'function') return false
      try {
        on.call(ctx, event, handler)
        return true
      } catch (error) {
        log(`cannot listen for ${event}: ${error?.message ?? error}`)
        return false
      }
    }
    if (listen('internal/service', (service) => {
        // A service event is dispatched by the app itself; an exception here would travel back into
        // whatever asked, so each answer is kept to its own line.
        try {
          if (service === 'hmr') syncWatching()
          if (service === 'clientModules') syncBundles()
        } catch (error) {
          log(`cannot follow the ${oneLine(service, 40)} service: ${error?.message ?? error}`)
        }
      })) {
      // The listener above is optional; its failure is already in the log.
    }
    /**
     * One start-up step whose failure is said in a line and does not keep the rest of the start-up
     * from finishing. A half-applied start-up is worse than a missing extra: routes that were
     * never recorded are never closed, and an instance that was never set makes the next copy
     * believe it owns nothing.
     */
    const step = (what, work) => {
      try {
        return work()
      } catch (error) {
        log(`cannot ${what}: ${error?.message ?? error}`)
        return undefined
      }
    }
    globalThis[ROUTES_KEY] = step('serve the button routes', () => serveButton(ctx, controller, config ?? {})) ?? null
    own.routes = globalThis[ROUTES_KEY]
    step('prepare the served bundles', syncBundles)
    globalThis[INSTANCE_KEY] = instance
    // The wrap made during startup was stamped with the copy that was current a line ago; it is
    // this instance's now, and the next reload must be able to reuse it instead of wrapping again.
    if (own.shim !== null && own.shim !== undefined) own.shim.owner = instance

    listen('dispose', () => {
      /**
       * A dispose that lands after the next apply belongs to an instance that no longer owns
       * anything; tearing the routes or the shim down here would break the newer one, and a page
       * that then cannot read a startup script ends the app.
       */
      /**
       * This copy stops its own work whichever copy is current. The controller is stopped before the
       * check: its timers and queued reloads are this copy's, and leaving them to run would let a
       * plugin that was replaced press the update again. The watcher, the routes and the wrap are
       * closed only while this copy is still the one holding them — a newer copy installs its own by
       * replacing those slots, and tearing them down from a stale dispose would blind the page.
       */
      controller.stop()
      if (globalThis[INSTANCE_KEY] !== instance) return
      closeAll(own.watchers)
      closeAll(own.routes)
      // Only a wrap this instance owns is put back: one a newer copy installed answers from that
      // copy's context, and unwrapping it here would leave the route answering from nobody's.
      if (own.shim !== null && own.shim !== undefined && own.shim.owner === instance) releaseBundleShim(own.shim)
      if (globalThis[WATCHER_KEY] === own.watchers) globalThis[WATCHER_KEY] = null
      if (globalThis[ROUTES_KEY] === own.routes) globalThis[ROUTES_KEY] = null
      if (globalThis[SHIM_KEY] === own.shim) globalThis[SHIM_KEY] = null
      globalThis[INSTANCE_KEY] = null
    })

    /**
     * The refresh tool is offered last, because it is the one start-up step that needs a service
     * the host may not have or may not have declared. It is also offered through a dynamic inject ui-copy-ignore
     * scope rather than a static dependency: a static one would keep the whole plugin, button
     * included, from loading on a host without a tools service. A missing service is said once and ui-copy-ignore
     * changes nothing else this copy started.
     */
    let toolService = null
    let toolMissingSaid = false
    const offerTool = (scope) => {
      try {
        const tools = toolsOf(scope)
        if (tools === null) {
          if (toolMissingSaid === false) {
            toolMissingSaid = true
            log('no tools service: the refresh tool is not offered to the agent; the button still applies changes')
          }
          return
        }
        // The inject scope replays whenever the service is registered again; the tool is registered once.
        if (toolService === tools) return
        toolService = tools
        registerAgentTool(scope, controller, config ?? {})
      } catch (error) {
        log(`cannot offer the refresh tool: ${error?.message ?? error}`)
      }
    }
    if (toolsOf(ctx) === null) {
      // Said here as well as in the scope: on a host whose service exists only later the inject ui-copy-ignore
      // scope does not run yet, and a reader of the log must still see why no tool was offered.
      toolMissingSaid = true
      log('no tools service: the refresh tool is not offered to the agent; the button still applies changes')
    }
    const inject = propOf(ctx, 'inject')
    if (typeof inject === 'function') {
      try {
        const fiber = inject.call(ctx, ['tools'], offerTool)
        // The inject scope is a thenable that replays with the service and can reject when the
        // service goes away. A rejection that lands after apply() returned would otherwise be an
        // unhandled rejection for the whole host, so it is said in a line and dropped. ui-copy-ignore
        Promise.resolve(fiber).catch((error) => {
          log(`cannot offer the refresh tool: ${error?.message ?? error}`)
        })
      } catch (error) {
        log(`cannot offer the refresh tool: ${error?.message ?? error}`)
        offerTool(ctx)
      }
    } else {
      offerTool(ctx)
    }
  } catch (error) {
    log(`plugin reload did not start: ${error?.message ?? error}`)
  }
}
