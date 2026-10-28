/**
 * A seeded chaos and soak lab for the refresh button.
 *
 * What is here is a world, not a test: the plugin is applied to a host stand-in whose answers can be
 * made wrong on purpose (an update that throws, hangs, reports a half-applied set, a health read that
 * cannot see the loader, a module table that is slow or broken, a bundle asked for under an old
 * revision, a chunk of an older generation). Every fault is chosen from a seeded generator, so a run
 * that finds something can be run again by its seed alone.
 *
 * The tests in `test/chaos-*.test.mjs` import this module; running it directly is the long soak:
 *
 *   node scripts/soak.mjs                          # 30s, seeds 1,2,3
 *   DSH_UNLAG_SOAK_MS=90000 node scripts/soak.mjs  # 90s
 *   DSH_UNLAG_SOAK_SEEDS=7,8 DSH_UNLAG_SOAK_OPS=20000 node scripts/soak.mjs
 *
 * Metrics: press latency p50/p95/p99, heap/RSS growth, timer count, route count, entry-table size,
 * and the answers seen. Thresholds fail the run (non-zero exit), because a soak that only prints is
 * a soak nobody reads.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** A small seeded generator: every fault, delay and id in a run comes from here, never Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One percentile of a list of numbers, or 0 for an empty one. */
export function percentile(list, p) {
  if (!Array.isArray(list) || list.length === 0) return 0
  const sorted = [...list].sort((left, right) => left - right)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[at]
}

const STATUSES = new Set(['done', 'failed', 'blocked', 'applying', 'queued', 'restart', 'unavailable', 'off'])
const REBUILDS = new Set(['safe', 'unsafe', 'unknown', 'pending'])
const REFUSALS = new Set(['off', 'blocked'])
const TERMINAL = new Set(['done', 'failed', 'restart', 'unavailable'])

const SELF_ID = 'dsh-unlag'
const BUNDLE_PATH = '/plugins'

const until = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A response stand-in close enough to what the routes and the bundle wrap write to. */
function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? null
      return this
    },
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(chunk)
      this.body += this.chunks.map((part) => (typeof part === 'string' ? part : String(part))).join('')
      this.writableEnded = true
      return this
    },
    destroy() {},
  }
  return res
}

/**
 * The invariants an answer has to hold, whichever fault produced it.
 *
 * The point is not that every answer says "done"; it is that an answer never claims more than it
 * proved: a done answer carries readable health and no failed entry, a safe rebuild belongs to a
 * done answer, an unreadable health read can never be called safe, and a restart is always a stated
 * reason rather than a silent failure.
 */
export function auditAnswer(answer, where, violations) {
  const add = (text) => violations.push(`${where}: ${text}`)
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    add('an answer that is not an object')
    return
  }
  const status = answer.status
  if (typeof status !== 'string' || status === '') {
    add('an answer with no status')
    return
  }
  if (STATUSES.has(status) === false) add(`status ${JSON.stringify(status)} is not one of the shipped ones`)
  const rebuild = answer.rebuild
  if (rebuild === undefined || rebuild === null) {
    if (REFUSALS.has(status) === false) add(`status ${status} carries no rebuild`)
  } else if (REBUILDS.has(rebuild) === false) {
    add(`rebuild ${JSON.stringify(rebuild)} is not one of the shipped ones`)
  }
  if (status === 'done') {
    // `unknown` is the honest answer when the loader cannot be read: nothing failed, and nothing
    // can be promised either. `unsafe` is never a finished answer.
    if (rebuild !== 'safe' && rebuild !== 'unknown') add(`done with rebuild ${String(rebuild)}`)
    if (rebuild === 'unknown' && answer.healthReadable !== false) add('done with an unknown rebuild while health was readable')
    if (rebuild === 'safe' && answer.healthReadable !== true) add('done without a readable health read')
    if (Array.isArray(answer.failedEntries) && answer.failedEntries.length > 0) add(`done with failed entries ${answer.failedEntries.join(',')}`)
    if (Array.isArray(answer.pending) && answer.pending.length > 0) add(`done with pending entries ${answer.pending.join(',')}`)
    if (typeof answer.restartReason === 'string' && answer.restartReason !== '') add('done with a restart reason')
  }
  if (rebuild === 'safe' && status !== 'done') add(`rebuild safe on status ${status}`)
  if (rebuild === 'pending' && status !== 'applying' && status !== 'queued' && status !== 'restart') add(`rebuild pending on status ${status}`)
  if ((status === 'applying' || status === 'queued') && rebuild !== 'pending') add(`${status} without rebuild pending`)
  if (answer.healthReadable === false && rebuild === 'safe') add('unreadable health reported as a safe rebuild')
  if (status === 'restart') {
    const reason = typeof answer.restartReason === 'string' && answer.restartReason !== ''
    const waiting = Array.isArray(answer.pending) && answer.pending.length > 0
    // A press that needs a new process has to say why the page cannot refresh on its own: a named
    // reason or a named unfinished entry. Either one is actionable; silence is not.
    if (reason === false && waiting === false) add('a restart with no stated reason')
    // `unknown` rides along when health could not be read: the press still needs a new process,
    // and the page is told what the plugin does not know.
    const allowed = rebuild === 'pending' || rebuild === 'unsafe' || (rebuild === 'unknown' && answer.healthReadable === false)
    if (allowed === false) add(`a restart with rebuild ${String(rebuild)}`)
  }
  if (status === 'unavailable' && rebuild === 'safe') add('an unavailable press reported a safe rebuild')
}

/** The update record `/state.operation` (and a page reload) reads: never half written, never done without proof. */
export function auditOperation(operation, where, violations) {
  if (operation === null || operation === undefined) return
  const add = (text) => violations.push(`${where}: ${text}`)
  if (typeof operation !== 'object') return add('the operation record is not an object')
  if (typeof operation.status !== 'string' || operation.status === '') add('the operation record has no status')
  if (REBUILDS.has(operation.rebuild) === false) add(`the operation record has rebuild ${String(operation.rebuild)}`)
  if (operation.status === 'applying' && operation.rebuild !== 'pending') add('an applying operation is not marked pending')
  if (operation.status === 'done' && operation.rebuild !== 'safe' && operation.rebuild !== 'unknown') add(`a done operation is marked ${String(operation.rebuild)}`)
  if (operation.status === 'done' && operation.rebuild === 'safe' && operation.healthReadable === false) add('a done operation calls itself safe after reading no health')
  if (operation.status === 'restart') {
    // The record stores the reason as `restart` and the unfinished work as a count in `pending`,
    // while the answer spells them `restartReason` and an array -- both are read here.
    const reason = [operation.restart, operation.restartReason].some((text) => typeof text === 'string' && text !== '')
    const waiting = Array.isArray(operation.pending) ? operation.pending.length > 0 : Number(operation.pending ?? 0) > 0
    if (reason === false && waiting === false) add('a restart operation states no reason')
    if (['unsafe', 'pending', 'unknown'].includes(operation.rebuild) === false) add(`a restart operation is marked ${String(operation.rebuild)}`)
  }
}

/** The memory a press keeps: never bigger than the shipped bound, never a row without its proof. */
export function auditPresses(presses, where, violations, limit = 32) {
  const add = (text) => violations.push(`${where}: ${text}`)
  if (!(presses instanceof Map)) return add('the press memory is not a Map')
  if (presses.size > limit) add(`the press memory holds ${presses.size} rows, above ${limit}`)
  for (const [id, row] of presses) {
    if (typeof id !== 'string' || id === '') add('a press row is stored under an empty id')
    if (row === null || typeof row !== 'object') {
      add(`press ${String(id)} holds no record`)
      continue
    }
    if (typeof row.status !== 'string' || row.status === '') add(`press ${id} has no status`)
    if (REBUILDS.has(row.rebuild) === false) add(`press ${id} has rebuild ${String(row.rebuild)}`)
    if (row.status === 'done' && row.rebuild !== 'safe' && row.rebuild !== 'unknown') add(`press ${id} ended done with rebuild ${String(row.rebuild)}`)
  }
}

/** Every global entry the plugin keeps, by name, so a leak is named instead of guessed at. */
export function globalEntries() {
  const rows = []
  for (const key of Reflect.ownKeys(globalThis)) {
    if (typeof key !== 'symbol') continue
    const description = typeof key.description === 'string' ? key.description : ''
    if (description.startsWith('dsh-unlag') === false) continue
    rows.push({ name: description, value: globalThis[key] })
  }
  return rows
}

/**
 * Real elapsed milliseconds. The run's budget is spent in real time, so it must not be measured on
 * the lab clock that pressing moves forward.
 */
export function budgetNow() {
  return Number(process.hrtime.bigint()) / 1e6
}

/** Active timers, the cheapest signal that a press left a wait behind. */
export function activeTimers() {
  try {
    return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
  } catch {
    return -1
  }
}

let chaosHome = null

/**
 * One temp HOME for this process. The plugin resolves its switches file at import time, so the
 * directory has to exist before the module is loaded and must be the same one for every seed.
 */
export function ensureChaosHome() {
  if (chaosHome !== null) return chaosHome
  const home = mkdtempSync(join(tmpdir(), 'unlag-chaos-'))
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  process.env.DSH_UNLAG_LOG = join(home, 'chaos.log')
  process.env.DSH_UNLAG_CHAOS_HOME = home
  chaosHome = { home, log: process.env.DSH_UNLAG_LOG }
  return chaosHome
}

/** Remove the temp HOME this process made. A no-op when a caller owned the directory. */
export function removeChaosHome() {
  if (chaosHome === null) return
  try {
    rmSync(chaosHome.home, { recursive: true, force: true })
  } catch {
    /* the directory is a scratch copy; failing to remove it must not fail a run */
  }
  chaosHome = null
}

/**
 * The press path spaces presses by a fixed `MIN_INTERVAL_MS` (the button is a person, not a loop),
 * so a soak that pressed as fast as the code answers would spend its whole run waiting out a gap
 * measured on `Date.now`. The lab therefore owns the wall clock: every press advances it by more
 * than one gap, which is what "the same person pressing again a moment later" looks like. Node's
 * timers keep running on the monotonic clock, so answers and timeouts stay real.
 */
const GAP_MS = 1600
/** The plugin forgets a press after this long; past it, a repeated id is a new press. */
const MAX_PRESS_AGE_MS = 10 * 60 * 1000
let realDateNow = null
let clockSkew = 0
function installClock() {
  if (realDateNow === null) {
    realDateNow = Date.now
    Date.now = () => realDateNow() + clockSkew
  }
}
function removeClock() {
  if (realDateNow !== null) {
    Date.now = realDateNow
    realDateNow = null
    clockSkew = 0
  }
}
/** Move the lab's wall clock forward; the press gap is measured on it. */
export function advanceClock(ms) {
  clockSkew += Math.max(0, ms)
  return clockSkew
}
/** The lab's own wall clock, which is what the plugin's gap arithmetic reads. */
export function clockNow() {
  return Date.now()
}

/**
 * Apply the plugin to a host stand-in that can be made hostile, and give back the handles a lab
 * needs: press, read, inject, and audit.
 *
 * Faults are set through `model.fault({...})`; the seeded soak sets them per operation.
 */
export async function createChaosModel(options = {}) {
  const { seed = 1, answerMs = 25, timeoutMs = 40, retryMs = 2, config = {} } = options
  ensureChaosHome()
  process.env.DSH_UNLAG_ANSWER_MS = String(answerMs)
  process.env.DSH_UNLAG_TIMEOUT_MS = String(timeoutMs)
  process.env.DSH_UNLAG_RETRY_MS = String(retryMs)

  const { apply } = await import('../index.js')

  const routes = new Map()
  const registrations = []
  const rand = mulberry32(seed)
  const violations = []
  installClock()

  const world = {
    seed,
    gen: 0,
    rev: 'rev-0',
    entryRev: new Map(),
    entries: [
      { id: '@local/a', state: 2 },
      { id: '@local/b', state: 2 },
      { id: SELF_ID, state: 2 },
    ],
    fault: { hmr: 'ok', health: 'active', delay: 0, warnings: false, restartReason: null, pending: null, stopId: null, nestedLeft: 0, dropAnswer: false },
  }

  const counters = {
    presses: 0,
    applies: 0,
    commits: 0,
    appliesInFlight: 0,
    maxConcurrent: 0,
    nestedThrows: 0,
    bundleRequests: 0,
    bundleHeld: 0,
    queueOverlap: 0,
    healthUnreadable: 0,
    healthPending: 0,
    lateAnswers: 0,
    sawApplying: 0,
    answers: new Map(),
    violations,
  }

  for (const entry of world.entries) if (entry.id !== SELF_ID) world.entryRev.set(entry.id, `${world.rev}-${entry.id}`)

  // A hanging update: the press is answered "still applying" while this gate holds the work.
  let hangGate = null
  const hang = () => {
    let release = () => {}
    const promise = new Promise((resolve) => {
      release = resolve
    })
    hangGate = { promise, release }
    return hangGate
  }
  const releaseHang = () => {
    if (hangGate !== null) {
      const gate = hangGate
      hangGate = null
      gate.release()
    }
  }

  /** The set after an update the service reported as applied. */
  const commit = () => {
    world.gen += 1
    world.rev = `rev-${world.gen}`
    for (const entry of world.entries) {
      if (entry.id === SELF_ID) continue
      entry.state = 2
      world.entryRev.set(entry.id, `${world.rev}-${entry.id}`)
    }
    counters.commits += 1
    const warnings = world.fault.warnings ? ['a plugin loaded a little late'] : []
    return { warnings, pending: [] }
  }

  const clientModules = {
    graph: () => {
      if (world.fault.health === 'table-throw') throw new Error('the plugin table cannot be read')
      return {
        rev: world.rev,
        entries: world.entries
          .filter((entry) => entry.id !== SELF_ID)
          .map((entry) => ({ id: entry.id, rev: world.entryRev.get(entry.id) ?? world.rev, state: entry.state })),
        batches: [{ id: 'batch-0', entries: world.entries.filter((entry) => entry.id !== SELF_ID).map((entry) => entry.id) }],
      }
    },
    fetchBundle: async () => {
      if (world.fault.health === 'table-hang') await until(2000)
      if (world.fault.health === 'table-throw') throw new Error('the bundle table cannot be read')
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }
    },
  }

  /**
   * The module table's own bundle route. It serves one generation: a document or chunk asked for at
   * another generation is a 404, which is exactly the answer the plugin's wrap exists to survive.
   */
  const tableRoute = async (req, res) => {
    counters.bundleRequests += 1
    const url = String(req?.url ?? '')
    if (world.fault.health === 'table-hang') await until(2000)
    if (world.fault.health === 'table-throw') throw new Error('the module table cannot answer a bundle')
    // Entry ids carry slashes (`@local/a`), so the path is matched against the ids themselves
    // rather than split on one: `/plugins/@local/a/chunk.js` belongs to `@local/a`.
    const [pathPart = '', query = ''] = url.split('?')
    const rest = pathPart.startsWith(`${BUNDLE_PATH}/`) ? pathPart.slice(BUNDLE_PATH.length + 1) : ''
    const entry = world.entries.find((row) => rest === row.id || rest.startsWith(`${row.id}/`))
    const id = entry?.id ?? ''
    const rev = new URLSearchParams(query).get('rev') ?? ''
    const expected = world.entryRev.get(id) ?? ''
    if (id === '' || expected === '' || rev !== expected) {
      res.writeHead(404, {})
      res.end('')
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('export default 1')
  }

  const server = {
    prefixes: new Map([[BUNDLE_PATH, { handler: tableRoute }]]),
    collectIndexInjections: () => [],
    register: (route) => {
      registrations.push(route.path)
      routes.set(route.path, route.handler ?? route.resource)
      return () => {
        if (routes.get(route.path) === (route.handler ?? route.resource)) routes.delete(route.path)
      }
    },
  }

  const loaderEntries = () => {
    if (world.fault.health === 'unreadable') throw new Error('the loader cannot be read')
    return world.entries.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state }, state: entry.state }))
  }

  const hmr = {
    baseDir: join(ensureChaosHome().home, 'profile'),
    runExclusive: async (work) => work(),
    reconcileProfile: async () => {
      counters.applies += 1
      counters.appliesInFlight += 1
      counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.appliesInFlight)
      try {
        if (world.fault.delay > 0) await until(world.fault.delay)
        switch (world.fault.hmr) {
          case 'throw':
            throw new Error('the swap failed halfway')
          case 'nested': {
            if (world.fault.nestedLeft > 0) {
              world.fault.nestedLeft -= 1
              counters.nestedThrows += 1
              throw new Error('the profile is nested; ask again')
            }
            return commit()
          }
          case 'hang': {
            await hang().promise
            return commit()
          }
          case 'slow':
            await until(Math.max(answerMs * 3, timeoutMs * 2))
            return commit()
          case 'partial': {
            const victim = world.entries.find((entry) => entry.id !== SELF_ID)
            if (victim !== undefined) victim.state = 1
            return { warnings: ['one plugin was left stopped'], pending: [] }
          }
          case 'restart':
            return { warnings: [], pending: [], restartReason: 'the swap needs a fresh process' }
          case 'pending':
            return { warnings: [], pending: ['@local/b'] }
          case 'stop':
            if (world.fault.stopId !== null) {
              const victim = world.entries.find((entry) => entry.id === world.fault.stopId)
              if (victim !== undefined) victim.state = 1
            }
            return commit()
          default:
            return commit()
        }
      } finally {
        counters.appliesInFlight -= 1
      }
    },
  }

  const ctx = {
    get: (key) => {
      if (key === 'webServer') return server
      if (key === 'loader') return { entries: loaderEntries }
      if (key === 'clientModules') return clientModules
      if (key === 'hmr') return hmr
      if (key === 'agents') return { list: () => [] }
      return undefined
    },
    on: (event, fn) => {
      if (event === 'dispose') ctx.dispose = fn
    },
  }

  apply(ctx, { minIntervalMs: 0, ...config })

  const symbol = (name) => globalThis[Symbol.for(`dsh-unlag.${name}`)]
  const operation = () => symbol('operation')?.state ?? null
  const presses = () => symbol('presses')
  const runningPresses = () => symbol('presses-live')

  const call = async (path, { method = 'GET', headers = {}, body = null, drop = false } = {}) => {
    const handler = routes.get(path.split('?')[0])
    if (typeof handler !== 'function') throw new Error(`no route for ${path}`)
    const res = fakeRes()
    const req = { method, url: path, headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:50802', ...headers } }
    await handler(req, res)
    const text = drop ? '' : res.body
    let json = null
    try {
      json = JSON.parse(text === '' ? '{}' : text)
    } catch {
      json = { status: 'unparsable', detail: text.slice(0, 120) }
    }
    return { status: res.status, body: json, text, ended: res.writableEnded }
  }

  const model = {
    seed,
    rand,
    world,
    counters,
    violations,
    routes,
    registrations,
    server,

    setFault(partial) {
      Object.assign(world.fault, partial ?? {})
    },

    operation,
    presses,
    runningPresses,

    /** One press, as the page makes it: POST with the header, a request id, and a bounded wait. */
    async press(requestId = null) {
      counters.presses += 1
      const id = typeof requestId === 'string' && requestId !== '' ? requestId : null
      const path = `/dsh-unlag/reload${id === null ? '' : `?requestId=${encodeURIComponent(id)}`}`
      const drop = world.fault.dropAnswer === true
      advanceClock(GAP_MS)
      const started = process.hrtime.bigint()
      const answer = await call(path, { method: 'POST', drop })
      const latency = Number(process.hrtime.bigint() - started) / 1e6
      const status = answer.body?.status
      counters.answers.set(status, (counters.answers.get(status) ?? 0) + 1)
      if (status === 'applying' || status === 'queued') counters.sawApplying += 1
      // A hanging service is let go once its press has been answered, so the next press is a new
      // press rather than a retry of a run nobody will ever finish.
      if (world.fault.hmr === 'hang' && hangGate !== null) {
        releaseHang()
        await until(4)
      }
      return { ...answer, latency, requestId: id, dropped: drop }
    },

    async state() {
      const answer = await call('/dsh-unlag/state')
      return answer.body
    },

    /**
     * A bundle request as a page makes it, bounded: a table that never answers must not hang the lab.
     */
    async bundle(path) {
      const route = server.prefixes.get(BUNDLE_PATH)
      if (route === undefined || typeof route.handler !== 'function') return { missing: true, status: 0, hung: false }
      const res = fakeRes()
      const req = { url: path, method: 'GET', headers: {} }
      const work = Promise.resolve()
        .then(() => route.handler(req, res))
        .then(() => 'done', (error) => ({ error }))
      const raced = await Promise.race([work, until(400).then(() => 'timeout')])
      const hung = raced === 'timeout'
      if (hung) counters.bundleHeld += 1
      return { status: res.status, body: res.body, hung, error: raced?.error ?? null, missing: false }
    },

    /** Every invariant that can be read from the outside, at one moment. */
    audit(where = 'audit') {
      const found = []
      const op = operation()
      auditOperation(op, `${where}/operation`, found)
      auditPresses(presses(), `${where}/presses`, found)
      const live = runningPresses()
      if (live instanceof Map && live.size > 128) found.push(`${where}/presses-live: ${live.size} rows`)
      const entries = globalEntries()
      // Eleven: the page's frozen startup list is kept beside the ten records of this plugin's own
      // work, because a press replaces the plugin and that list has to outlive the copy that took it.
      if (entries.length > 11) found.push(`${where}/globals: ${entries.length} dsh-unlag entries on globalThis`)
      return found
    },

    /** Let every deferred fault finish, then read the late record it should have written. */
    async drain(waitMs = 120) {
      releaseHang()
      await until(waitMs)
      let left = counters.appliesInFlight
      for (let attempt = 0; attempt < 40 && left > 0; attempt += 1) {
        releaseHang()
        await until(25)
        left = counters.appliesInFlight
      }
      return left
    },

    async finish() {
      releaseHang()
      await until(20)
      try {
        ctx.dispose?.()
      } catch {
        /* a dispose that throws is itself reported by the caller's audit, not swallowed here */
      }
      await until(20)
      removeClock()
    },
  }

  return model
}

/* ------------------------------------------------------------------------------------------------
 * The soak: a seeded stream of operations against one model, with metrics and thresholds.
 * ---------------------------------------------------------------------------------------------- */

const SOAK_DEFAULTS = {
  seeds: [1, 2, 3],
  ms: 6000,
  opsPerSeed: 4000,
  answerMs: 20,
  timeoutMs: 30,
  heapGrowthMb: 48,
  rssGrowthMb: 320,
  p99Ms: 2000,
  maxTimers: 512,
}

/** One operation, chosen from the seed: mostly presses, some retries, some reads, some bundles. */
function nextOp(rand, pool) {
  const roll = rand()
  if (roll < 0.06 && pool.length > 0) {
    const at = Math.floor(rand() * pool.length)
    return { kind: 'retry', id: pool[at] }
  }
  if (roll < 0.11) return { kind: 'state' }
  if (roll < 0.16) return { kind: 'bundle' }
  if (roll < 0.20) return { kind: 'drop' }
  return { kind: 'press' }
}

/** The fault profile for the next operation, drawn from the seed. */
function nextFault(rand, world) {
  const hmrRoll = rand()
  const fault = {
    hmr: 'ok',
    health: 'active',
    delay: Math.floor(rand() * 3),
    warnings: rand() < 0.15,
    restartReason: null,
    pending: null,
    stopId: null,
    nestedLeft: 0,
    dropAnswer: false,
  }
  if (hmrRoll < 0.08) fault.hmr = 'throw'
  else if (hmrRoll < 0.13) {
    fault.hmr = 'nested'
    fault.nestedLeft = 1 + Math.floor(rand() * 2)
  } else if (hmrRoll < 0.18) fault.hmr = 'hang'
  else if (hmrRoll < 0.26) fault.hmr = 'slow'
  else if (hmrRoll < 0.32) fault.hmr = 'partial'
  else if (hmrRoll < 0.36) fault.hmr = 'restart'
  else if (hmrRoll < 0.40) fault.hmr = 'pending'
  else if (hmrRoll < 0.46) {
    fault.hmr = 'stop'
    const victim = world.entries[Math.floor(rand() * (world.entries.length - 1))]
    fault.stopId = victim?.id ?? null
  }
  const healthRoll = rand()
  if (healthRoll < 0.06) fault.health = 'unreadable'
  else if (healthRoll < 0.16) fault.health = 'pending'
  else if (healthRoll < 0.20) fault.health = 'table-throw'
  else if (healthRoll < 0.23) fault.health = 'table-hang'
  if (fault.health === 'pending') {
    for (const entry of world.entries) if (entry.id !== SELF_ID && rand() < 0.5) entry.state = 1
  }
  return fault
}

/**
 * Run one seed's stream. The caller owns HOME (this function does not create one) so a process can
 * run several seeds against the same loaded plugin.
 */
export async function runOneSeed(options = {}) {
  const config = { ...SOAK_DEFAULTS, ...options }
  const { seed = 1, opsPerSeed = SOAK_DEFAULTS.opsPerSeed, deadline = Infinity } = config
  const model = await createChaosModel({ seed, answerMs: config.answerMs, timeoutMs: config.timeoutMs })
  const rand = mulberry32(seed)
  const violations = model.violations

  const latencies = []
  const trace = []
  const ids = []
  let ops = 0
  let lastId = null
  let droppedButRecorded = 0
  let retriesChecked = 0
  let retriesHonoured = 0
  let statusCounts = new Map()
  /** When each request id was first used, on the lab's clock: the plugin ages its rows out. */
  const idBorn = new Map()

  const heapStart = process.memoryUsage()
  const timerBaseline = activeTimers()
  let timerMax = timerBaseline

  // A short warm-up: V8, the module table and the log all settle before the first sample.
  for (let warm = 0; warm < 20; warm += 1) {
    model.setFault({ hmr: 'ok', health: 'active', delay: 0, dropAnswer: false })
    await model.press(`warm-${warm}`)
  }
  await model.drain(60)
  const heapWarm = process.memoryUsage()

  while (ops < opsPerSeed && budgetNow() < deadline) {
    ops += 1
    const op = nextOp(rand, ids)
    model.setFault(nextFault(rand, model.world))

    // Multi-generation combo: the set is replaced again from under a press.
    if (rand() < 0.12) {
      model.world.gen += 1
      model.world.rev = `rev-${model.world.gen}`
    }

    const before = model.counters.applies
    let requestId = null
    if (op.kind === 'press' || op.kind === 'drop') {
      requestId = `s${seed}-${ops}-${Math.floor(rand() * 1e6).toString(36)}`
      ids.push(requestId)
      // The pool of retryable ids stays inside the plugin's own bounded memory (MAX_PRESSES), so a
      // retry always asks about a press the plugin should still remember.
      if (ids.length > 24) ids.shift()
      idBorn.set(requestId, clockNow())
      if (idBorn.size > 64) idBorn.delete(idBorn.keys().next().value)
      lastId = requestId
    } else if (op.kind === 'retry') {
      requestId = op.id
    }

    if (op.kind === 'state') {
      const state = await model.state()
      auditOperation(state?.operation ?? null, `seed ${seed} op ${ops}/state`, violations)
      if (state?.shim?.wrapped !== undefined && typeof state.shim.wrapped !== 'boolean') violations.push(`seed ${seed} op ${ops}/state: shim.wrapped is not a boolean`)
      trace.push(`state:${state?.operation?.status ?? 'null'}`)
      continue
    }

    if (op.kind === 'bundle') {
      const id = model.world.entries[Math.floor(rand() * (model.world.entries.length - 1))]?.id ?? '@local/a'
      const entryRev = model.world.entryRev.get(id) ?? 'rev-0'
      const doc = await model.bundle(`${BUNDLE_PATH}/${id}?rev=${entryRev}`)
      const chunk = await model.bundle(`${BUNDLE_PATH}/${id}/chunk.js?rev=${entryRev}`)
      const stale = await model.bundle(`${BUNDLE_PATH}/${id}?rev=rev-older-generation`)
      // A module table that throws or hangs cannot promise a document; that is the fault, not a
      // broken contract. Everything read from a working table is the contract.
      const tableWorks = model.world.fault.health !== 'table-throw' && model.world.fault.health !== 'table-hang'
      if (tableWorks && (doc.hung || chunk.hung || stale.hung)) violations.push(`seed ${seed} op ${ops}/bundle: a bundle request never answered (table ${model.world.fault.health})`)
      if (tableWorks && doc.status !== 200) violations.push(`seed ${seed} op ${ops}/bundle: the current document answered ${doc.status}`)
      if (tableWorks && stale.status === 0) violations.push(`seed ${seed} op ${ops}/bundle: a stale generation was left unanswered`)
      // A stale generation url is retargeted to the current revision by design, so the answer may be
      // current code or a held page -- but never a promise with nothing behind it, and never silence.
      if (tableWorks && stale.status === 200 && String(stale.body ?? '') === '') violations.push(`seed ${seed} op ${ops}/bundle: the stale generation answered 200 with an empty body`)
      if (tableWorks && stale.status !== 200 && ![403, 404, 503].includes(stale.status)) violations.push(`seed ${seed} op ${ops}/bundle: the stale generation answered ${stale.status}`)
      trace.push(`bundle:${doc.status}/${chunk.status}/${stale.status}`)
      continue
    }

    // A person presses, waits for the button to come back, then presses again. Without this the
    // stream outruns every update and most presses would only ever measure the busy path.
    if (op.kind === 'press' && rand() < 0.7) {
      const quietUntil = budgetNow() + 60
      while (model.counters.appliesInFlight > 0 && budgetNow() < quietUntil) await until(2)
    }

    const prior = requestId === null ? null : model.presses()?.get(requestId) ?? null
    // The plugin forgets a press after ten minutes or when newer presses push it out; past that a
    // repeated id is a new press and nothing was promised about it. The lab keeps its own birth
    // time because the row that would carry it may be gone.
    const born = requestId === null ? null : idBorn.get(requestId) ?? null
    const remembered = prior !== null && born !== null && clockNow() - born <= MAX_PRESS_AGE_MS
    const answer = await model.press(requestId)
    latencies.push(answer.latency)
    const status = answer.body?.status
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
    trace.push(`${op.kind}:${status}:${answer.body?.rebuild ?? '-'}`)
    const where = `seed ${seed} op ${ops}/${op.kind}`
    auditAnswer(answer.body, where, violations)
    if (answer.status !== 200 && answer.status !== 403) violations.push(`${where}: the route answered HTTP ${answer.status}`)

    // One press starts at most one update, and a press that was already answered never starts one.
    const delta = model.counters.applies - before
    // A press answered `applying` started nothing: the update it met was already in flight. Only a
    // press that was answered from work of its own may have started one, and only one. A busy press
    // also leaves a queued tick behind by design, and that tick can land inside the next press's
    // window, so more than one update in a window is attributed to the queue instead of counted as
    // a second update for the same press.
    // `applying` is one word for two situations -- a busy press that started nothing, and a press
    // whose own update outlasted the answer. They are indistinguishable from the answer alone, so a
    // single update in the window is accepted for both; the deterministic busy case lives in
    // test/chaos-core.test.mjs, where the work in flight is held still on purpose.
    if (delta > 1) model.counters.queueOverlap += 1
    if (remembered && delta !== 0) violations.push(`${where}: a repeated request id started ${delta} update(s) after it was already answered`)
    if (remembered) {
      retriesChecked += 1
      const sameStatus = prior.status === status
      const sameRebuild = prior.rebuild === (answer.body?.rebuild ?? null)
      if (sameStatus && sameRebuild) retriesHonoured += 1
      else violations.push(`${where}: a repeated request id answered ${String(status)}/${String(answer.body?.rebuild)} instead of ${prior.status}/${String(prior.rebuild)}`)
    }

    // A press whose answer was lost on the way to the page still has to leave a record the page can
    // read on its next load: that is what `/state.operation` is for.
    if (answer.dropped) {
      const state = await model.state()
      const record = state?.operation ?? null
      auditOperation(record, `${where}/dropped`, violations)
      if (record === null) violations.push(`${where}: a press whose answer was dropped left no operation record`)
      else droppedButRecorded += 1
    }

    // A press that started work must leave its own record under the id the page will ask about.
    if (delta === 1 && model.world.fault.hmr !== 'hang') {
      const settled = model.presses()?.get(requestId) ?? null
      if (TERMINAL.has(status) && settled === null) {
        await model.drain(40)
        if ((model.presses()?.get(requestId) ?? null) === null) violations.push(`${where}: a press that ended ${String(status)} left no record for its request id`)
      }
    }

    const timers = activeTimers()
    if (timers > timerMax) timerMax = timers
    if (timers > config.maxTimers) violations.push(`${where}: ${timers} active timers, above ${config.maxTimers}`)

    if (ops % 200 === 0) {
      // Reading `/state` is also the check that the plugin still answers while the set is hostile.
      const state = await model.state()
      if (state === null || typeof state !== 'object') violations.push(`${where}: /state answered nothing usable`)
      model.audit(where).forEach((text) => violations.push(text))
    }
  }

  // Settle first: a pending update whose answer outlived its press is not a leak, a pending one that
  // never ends is.
  // The queue tick is a second long by design; drain past it so "settled" means settled.
  await model.drain(1300)
  const stillApplying = await model.drain(200)
  if (stillApplying > 0) violations.push(`seed ${seed}: ${stillApplying} update(s) never finished`)
  await until(60)
  const timersAfterDrain = activeTimers()
  if (timerBaseline >= 0 && timersAfterDrain > timerBaseline + 8) violations.push(`seed ${seed}: ${timersAfterDrain} timers after the stream settled, baseline ${timerBaseline}`)

  model.audit(`seed ${seed}/end`).forEach((text) => violations.push(text))
  const op = model.operation()
  auditOperation(op, `seed ${seed}/end`, violations)

  // The last press must have left the set in a state a page can read: the shipped routes are all
  // there and nothing else was registered.
  if (model.routes.size !== 7) violations.push(`seed ${seed}: ${model.routes.size} routes are registered, expected 7`)
  if (new Set(model.registrations).size !== 7) violations.push(`seed ${seed}: ${new Set(model.registrations).size} distinct routes were registered, expected 7`)
  if (model.counters.maxConcurrent > 1) violations.push(`seed ${seed}: ${model.counters.maxConcurrent} updates ran at once`)

  const heapEnd = process.memoryUsage()
  global.gc?.()
  const heapAfter = process.memoryUsage()
  const metrics = {
    seed,
    ops,
    presses: model.counters.presses,
    applies: model.counters.applies,
    commits: model.counters.commits,
    nestedThrows: model.counters.nestedThrows,
    lateAnswers: model.counters.lateAnswers,
    applyingAnswers: model.counters.sawApplying,
    maxConcurrent: model.counters.maxConcurrent,
    retriesChecked,
    retriesHonoured,
    droppedButRecorded,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    maxLatency: latencies.length === 0 ? 0 : Math.max(...latencies),
    heapGrowthMb: (heapAfter.heapUsed - heapWarm.heapUsed) / 1024 / 1024,
    rssGrowthMb: (heapEnd.rss - heapStart.rss) / 1024 / 1024,
    timersBefore: timerBaseline,
    timersMax: timerMax,
    timersAfterDrain,
    pressesHeld: model.presses()?.size ?? 0,
    liveHeld: model.runningPresses()?.size ?? 0,
    globals: globalEntries().length,
    statusCounts: Object.fromEntries([...statusCounts].sort((left, right) => left[0].localeCompare(right[0]))),
    trace,
    latencies,
    violations: [...violations],
  }

  if (metrics.p99 > config.p99Ms) violations.push(`seed ${seed}: p99 press latency ${metrics.p99.toFixed(1)}ms, above ${config.p99Ms}ms`)
  if (metrics.heapGrowthMb > config.heapGrowthMb) violations.push(`seed ${seed}: heap grew ${metrics.heapGrowthMb.toFixed(1)}MB, above ${config.heapGrowthMb}MB`)
  if (metrics.rssGrowthMb > config.rssGrowthMb) violations.push(`seed ${seed}: RSS grew ${metrics.rssGrowthMb.toFixed(1)}MB, above ${config.rssGrowthMb}MB`)
  if (metrics.pressesHeld > 32) violations.push(`seed ${seed}: ${metrics.pressesHeld} press records held, above 32`)
  if (metrics.liveHeld > 128) violations.push(`seed ${seed}: ${metrics.liveHeld} live press rows held, above 128`)

  await model.finish()
  if (model.routes.size !== 0) violations.push(`seed ${seed}: ${model.routes.size} route(s) survived dispose`)
  releaseGlobals()
  return metrics
}

/** Drop the per-process globals the plugin keeps, so a second seed starts from the same world. */
function releaseGlobals() {
  for (const key of Reflect.ownKeys(globalThis)) {
    if (typeof key !== 'symbol') continue
    const description = typeof key.description === 'string' ? key.description : ''
    if (description.startsWith('dsh-unlag') === false) continue
    try {
      globalThis[key] = null
    } catch {
      /* a non-writable global is reported by the next audit, not here */
    }
  }
}

/**
 * Run several seeds inside one budget and report the aggregate.
 *
 * `ms` bounds the whole run; `opsPerSeed` bounds a single seed so a slow fault profile cannot eat the
 * budget of the seeds after it.
 */
export async function runSoak(options = {}) {
  const config = { ...SOAK_DEFAULTS, ...options }
  const seeds = Array.isArray(config.seeds) && config.seeds.length > 0 ? config.seeds : SOAK_DEFAULTS.seeds
  const ms = Number(process.env.DSH_UNLAG_SOAK_MS ?? '') > 0 ? Number(process.env.DSH_UNLAG_SOAK_MS) : config.ms
  const started = Date.now()
  ensureChaosHome()
  const runs = []
  const violations = []
  for (let at = 0; at < seeds.length; at += 1) {
    const left = ms - (Date.now() - started)
    if (left <= 0 && runs.length > 0) break
    const share = Math.max(800, Math.floor(left / (seeds.length - at)))
    const run = await runOneSeed({
      ...config,
      seed: seeds[at],
      deadline: budgetNow() + share,
    })
    runs.push(run)
    violations.push(...run.violations ?? [])
  }
  const allLatencies = runs.flatMap((run) => run.latencies ?? [])
  return {
    runs,
    violations: runs.flatMap((run) => run.violations ?? []),
    ops: runs.reduce((sum, run) => sum + run.ops, 0),
    presses: runs.reduce((sum, run) => sum + run.presses, 0),
    applies: runs.reduce((sum, run) => sum + run.applies, 0),
    elapsedMs: Date.now() - started,
    p50: percentile(allLatencies, 50),
    p95: percentile(allLatencies, 95),
    p99: percentile(allLatencies, 99),
  }
}

/** Print a metric block a person can paste into the findings report. */
export function formatMetrics(run) {
  const mb = (value) => `${value.toFixed(1)}MB`
  const lines = [
    `seed ${run.seed}: ${run.ops} ops, ${run.presses} presses, ${run.applies} updates, ${run.commits} committed`,
    `  latency p50 ${run.p50.toFixed(1)}ms  p95 ${run.p95.toFixed(1)}ms  p99 ${run.p99.toFixed(1)}ms  max ${run.maxLatency.toFixed(1)}ms`,
    `  heap ${mb(run.heapGrowthMb)}  rss ${mb(run.rssGrowthMb)}  timers ${run.timersBefore}→max ${run.timersMax}→settled ${run.timersAfterDrain}`,
    `  press memory ${run.pressesHeld}/32  live rows ${run.liveHeld}/128  globalThis entries ${run.globals}`,
    `  retries ${run.retriesHonoured}/${run.retriesChecked} answered from the record  dropped answers recorded ${run.droppedButRecorded}`,
    `  answers ${JSON.stringify(run.statusCounts)}`,
  ]
  return lines.join('\n')
}

async function main() {
  const seeds = (process.env.DSH_UNLAG_SOAK_SEEDS ?? '1,2,3')
    .split(',')
    .map((text) => Number(text.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  const opsPerSeed = Number(process.env.DSH_UNLAG_SOAK_OPS ?? '') > 0 ? Number(process.env.DSH_UNLAG_SOAK_OPS) : SOAK_DEFAULTS.opsPerSeed
  const ms = Number(process.env.DSH_UNLAG_SOAK_MS ?? '') > 0 ? Number(process.env.DSH_UNLAG_SOAK_MS) : 30000
  console.log(`dsh-unlag soak: seeds ${seeds.join(',')} up to ${opsPerSeed} ops each, ${ms}ms budget`)

  const startedAt = Date.now()
  const results = []
  const violations = []
  let model = null
  for (const seed of seeds) {
    const left = ms - (Date.now() - startedAt)
    if (left <= 0 && results.length > 0) break
    const one = await runOneSeed({
      seed,
      opsPerSeed,
      deadline: budgetNow() + Math.max(600, Math.floor(left / Math.max(1, seeds.length - results.length))),
    }).catch((error) => {
      violations.push(`seed ${seed}: the run itself threw: ${error?.stack ?? error}`)
      return null
    })
    if (one === null) continue
    results.push(one)
    violations.push(...one.violations)
    console.log(formatMetrics(one))
  }
  console.log(`\n${results.length} seed(s), ${results.reduce((sum, run) => sum + run.ops, 0)} ops in ${Date.now() - startedAt}ms`)
  if (violations.length === 0) {
    console.log('ok')
    removeChaosHome()
    return
  }
  console.log(`FAILED: ${violations.length} violation(s)`)
  for (const text of violations.slice(0, 60)) console.log(`  - ${text}`)
  if (violations.length > 60) console.log(`  ... and ${violations.length - 60} more`)
  model = null
  removeChaosHome()
  process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error)
    process.exitCode = 1
  })
}
