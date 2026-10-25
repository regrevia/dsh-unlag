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
/** Tests point this at a scratch file, so a test run leaves the live log readable. */
const logTarget = () => process.env.DSH_UNLAG_LOG ?? LOG_PATH
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
/** The route the app publishes client bundles under; the same key the module table registers. */
const BUNDLE_ROUTE = '/plugins'
/** Marks a route handler already wrapped here, so a plugin reload cannot wrap it twice. */
const SHIM_MARK = Symbol.for('dsh-unlag.bundle-shim')
/** Holds the wrapper across a module replacement, so a reload can put the route back. */
const SHIM_KEY = Symbol.for('dsh-unlag.shim')

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
    appendFileSync(logTarget(), `${new Date().toISOString()} ${line}\n`)
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
 * button (immediate). A swap never waits for turns, never interrupts them, and never re-enters.
 */
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

  let timer = null
  let running = false
  let again = false
  let deferrals = 0
  let lastRun = 0

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
    let result = null
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await hmr.runExclusive(() => hmr.reconcileProfile([]))
        break
      } catch (error) {
        const message = String(error?.message ?? error)
        if (message.includes('nested') === false) throw error
        if (attempt >= 9) throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    const warnings = Array.isArray(result?.warnings) ? result.warnings : []
    const pending = Array.isArray(result?.pending) ? result.pending : []
    const restartReason = typeof result?.restartReason === 'string' ? result.restartReason : null
    log(
      `plugins reloaded (warnings=${warnings.length} pending=${pending.length}${restartReason === null ? '' : ` restart=${restartReason}`})`,
    )
    return { status: 'done', warnings, pending, restartReason }
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
          log('reloading while turns are still running; they keep running')
        } else {
          timer = setTimeout(() => void flush(), 500)
          return
        }
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
      log(`reload did not finish; the plugin set may be partly applied: ${error?.message ?? error}`)
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
   * Opt-in (`idleOnly`) quiet-moment mode: wait for a gap, and after a short grace swap anyway,
   * because waiting forever would leave busy machines with a dead button.
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

  /** The answer shape a press always gets, whether or not a reload was started. */
  const queuedAnswer = (answer) => ({
    status: answer === 'unavailable' ? 'unavailable' : 'queued',
    warnings: [],
    pending: [],
    restartReason: null,
  })

  /**
   * The button path: run now and report what happened, so the page can tell the user why the
   * press did not replace anything instead of looking broken.
   * @returns {{status: string, warnings: string[], pending: string[], restartReason: string|null}}
   */
  const reloadNow = async (force = false) => {
    const hmr = hmrService()
    if (hmr === null) return { status: 'unavailable', warnings: [], pending: [], restartReason: null }
    if (turnsRunning()) log('reloading while turns are still running; they keep running')
    if (running || (force === false && busy())) return queuedAnswer(queueReload())
    const wait = lastRun + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 2000)))
    if (running || (force === false && busy())) return queuedAnswer(queueReload())
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    running = true
    deferrals = 0
    lastRun = Date.now()
    try {
      const outcome = await reload(hmr)
      if (outcome.pending.length > 0 || outcome.restartReason !== null) {
        // The app accepted the update but has not finished starting the new plugin set. Rebuilding
        // the page now would start a document against a set that is still settling.
        return { status: 'failed', warnings: outcome.warnings, pending: outcome.pending, restartReason: outcome.restartReason }
      }
      return outcome
    } catch (error) {
      log(`reload did not finish; the plugin set may be partly applied: ${error?.message ?? error}`)
      return { status: 'failed', warnings: [], pending: [], restartReason: null }
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
 * The startup list the server would hand the next document, read from the live index injection
 * table. The page's own copy describes the page already running: a plugin swapped since then
 * leaves it naming a module graph that no longer resolves, which is exactly the list a rebuild
 * must not trust.
 */
function liveBootGraph(server) {
  try {
    if (typeof server.collectIndexInjections !== 'function') return null
    const rows = server.collectIndexInjections()
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
  if (ids.length === 0) return null
  return { ids, sourceMap, rev: revAt < 0 ? '' : rest.slice(revAt + '&rev='.length) }
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
  if (typeof Request === 'function') {
    try {
      return await clientModules.fetchBundle(new Request(address, { method, headers: {} }))
    } catch (error) {
      if (error?.name !== 'TypeError') throw error
    }
  }
  return clientModules.fetchBundle({ method, url: address })
}

/**
 * The plugin set one stale request names, answered at the revision the app serves now. Only a body
 * that really contains every plugin it claims is handed back; anything unsure answers null, so the
 * route then behaves exactly as before and an unknown id still ends as a plain 404.
 */
async function currentBundleAnswer(clientModules, method, url) {
  const request = bundleRequest(url)
  if (request === null) return null
  const urls = currentBundleUrls(clientModules.graph(), request)
  if (urls.length === 0) return null
  if (request.rev !== '' && urls.some((target) => target.endsWith(`&rev=${request.rev}`))) return null
  for (const target of urls) {
    const response = await fetchBundleAt(clientModules, target, 'GET')
    if (response.status !== 200) continue
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length === 0) continue
    if (!request.sourceMap && !request.ids.every((id) => body.includes(id))) continue
    return {
      body,
      contentType: String(response.headers.get('content-type') ?? 'text/javascript; charset=utf-8'),
      ids: request.ids,
    }
  }
  return null
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
    log(`served ${answer.ids.join(', ')} at the current revision: a page asked for an older one`)
    return true
  } catch (error) {
    log(`cannot serve a bundle from an older revision: ${error?.message ?? error}`)
    return false
  }
}

/** The same answer over the request-in/response-out route a newer app registers. */
async function serveCurrentBundleResource(clientModules, request) {
  try {
    const method = String(request?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return null
    const answer = await currentBundleAnswer(clientModules, method, request?.url)
    if (answer === null) return null
    log(`served ${answer.ids.join(', ')} at the current revision: a page asked for an older one`)
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
  if (route === null || route === undefined || route[SHIM_MARK] === true) return null
  if (typeof route.resource === 'function') {
    const original = route.resource
    const wrapped = async (request) => {
      try {
        const served = await serveCurrentBundleResource(clientModules, request)
        if (served !== null) return served
      } catch (error) {
        log(`cannot answer a bundle request: ${error?.message ?? error}`)
      }
      return original(request)
    }
    route[SHIM_MARK] = true
    route.resource = wrapped
    log('bundles asked for under an older revision are answered at the current one')
    return { route, slot: 'resource', original, wrapped }
  }
  if (typeof route.handler !== 'function') return null
  const original = route.handler
  const wrapped = (req, res) => {
    const fallback = () => original(req, res)
    const answered = serveCurrentBundle(clientModules, req, res).catch((error) => {
      log(`cannot answer a bundle request: ${error?.message ?? error}`)
      return false
    })
    if (typeof answered?.then !== 'function') return fallback()
    return answered.then((served) => (served === true ? undefined : fallback()))
  }
  route[SHIM_MARK] = true
  route.handler = wrapped
  log('bundles asked for under an older revision are answered at the current one')
  return { route, slot: 'handler', original, wrapped }
}

/** Put the bundle route back the way it was found; a route replaced since then is left alone. */
function releaseBundleShim(shim) {
  try {
    if (shim === null || shim === undefined) return
    if (shim.slot === 'resource') {
      if (shim.route.resource === shim.wrapped) shim.route.resource = shim.original
    } else if (shim.route.handler === shim.wrapped) shim.route.handler = shim.original
    if (shim.route[SHIM_MARK] === true) delete shim.route[SHIM_MARK]
  } catch {}
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
    if (route === shim.route && route[shim.slot] === shim.wrapped && route[SHIM_MARK] === true) return shim
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
    wrapped: route?.[SHIM_MARK] === true && typeof route?.[shape === 'none' ? 'handler' : shape] === 'function',
    fetch: typeof clientModules?.fetchBundle === 'function',
    graph: typeof clientModules?.graph === 'function',
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
  const settings = settingsOf(config)
  const handlers = [
    [
      `${BASE_PATH}/state`,
      (_req, res) => {
        sendJson(res, 200, { plugins: settings.reloadPlugins, page: settings.reloadInterface, shim: bundleShimStatus(ctx) })
      },
    ],
    [
      `${BASE_PATH}/graph`,
      (_req, res) => {
        ensureBundleShim(ctx)
        sendJson(res, 200, { graph: liveBootGraph(server) })
      },
    ],
    [
      `${BASE_PATH}/report`,
      (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { status: 'method' })
        let query = ''
        try {
          query = new URL(String(req?.url ?? ''), 'http://x').searchParams.toString()
        } catch {}
        const params = new URLSearchParams(query)
        const event = params.get('event') ?? ''
        const gate = params.get('gate') ?? ''
        if (event === 'mounted') log('interface rebuilt; the page runs the plugins as served now')
        else if (event === 'rebuild') log('rebuild allowed: the page re-enters on the served modules')
        else if (event === 'held') log(`rebuild held back: ${gate === '' ? 'unknown' : gate}`)
        sendJson(res, 200, { status: 'done' })
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
        const outcome = await controller.reloadNow()
        sendJson(res, 200, outcome)
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
        if (service === 'clientModules') syncBundles()
      })
    }
    globalThis[ROUTES_KEY] = serveButton(ctx, controller, config ?? {})
    syncBundles()

    ctx.on('dispose', () => {
      controller.stop()
      closeAll(globalThis[WATCHER_KEY])
      closeAll(globalThis[ROUTES_KEY])
      releaseBundleShim(globalThis[SHIM_KEY])
      globalThis[WATCHER_KEY] = null
      globalThis[ROUTES_KEY] = null
      globalThis[SHIM_KEY] = null
    })
  } catch (error) {
    log(`plugin reload did not start: ${error?.message ?? error}`)
  }
}
