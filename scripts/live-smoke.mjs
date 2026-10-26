import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// The shipped page half, the shipped host half, and the running app: this smoke asks the real
// button whether it could rebuild right now, using the startup list the app really renders, and
// prints the answer. It never presses: only a person may swap plugin code. A host that is not
// listening is a skip, so the script is safe to run anywhere the app is not.
const HOST = process.env.DSH_UNLAG_HOST ?? 'http://127.0.0.1:52847'
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

async function json(path) {
  const response = await fetch(`${HOST}${path}`, { headers: { 'x-dsh-unlag': '1' } })
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  return response.json()
}

const stated = await json('/dsh-unlag/state').catch(() => null)
if (stated === null) {
  console.log(`skip: no host at ${HOST}`)
  process.exit(0)
}
const graph = (await json('/dsh-unlag/graph')).graph
const stale = (url) => String(url).replace(/rev=[0-9a-f]+/u, 'rev=0000000000ff')
const rows = [
  { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__={};' },
  ...graph.batches.map((batch) => ({ kind: 'script-preload', src: stale(batch.url) })),
  ...graph.batches.map((batch) => ({ kind: 'script-src', placement: 'head', src: stale(batch.url) })),
  { kind: 'global', name: '__DSH_BOOT__', value: { ...graph, rev: '0000000000ff' } },
]
const frozen = { ...graph, rev: '0000000000ff' }

const requests = []
const fetchForPage = async (url, init = {}) => {
  const target = String(url).startsWith('/') ? `${HOST}${url}` : String(url)
  requests.push(target.replace(HOST, ''))
  return fetch(target, init)
}
const location = { href: `${HOST}/`, replace: () => { throw new Error('the smoke never navigates') } }
let registration
const window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  __DSH_UNLAG_PROBE__: true,
  __DSH_BOOT__: frozen,
  dshDesktopBoot: { ready: async () => ({ injections: rows }) },
  sessionStorage: { getItem: () => '0', setItem() {} },
  location,
  dispatchEvent: () => true,
}
const sandbox = {
  window,
  navigator: { language: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0' },
  location,
  document: { activeElement: null, querySelector: () => null },
  sessionStorage: window.sessionStorage,
  fetch: fetchForPage,
  URL,
  Response,
  Buffer,
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => fn(),
  Event,
  CustomEvent,
  JSON,
  RegExp,
}
sandbox.globalThis = sandbox
runInNewContext(source, sandbox)
const probe = registration.factory(() => ({ createElement: () => null })).probe

// The routes' own contract, proven against the running app: the two reads answer reads only, a
// press route without the page's header refuses, and the verify route answers a verdict. None of
// this swaps plugin code; the reload route is never called here.
const contract = []
const status = async (path, init) => {
  try {
    const response = await fetch(`${HOST}${path}`, init)
    await response.arrayBuffer()
    return response.status
  } catch {
    return 0
  }
}
contract.push(['state GET', await status('/dsh-unlag/state'), 200])
contract.push(['state DELETE', await status('/dsh-unlag/state', { method: 'DELETE' }), 405])
contract.push(['graph PUT', await status('/dsh-unlag/graph', { method: 'PUT' }), 405])
contract.push(['reload without header', await status('/dsh-unlag/reload', { method: 'POST' }), 403])
contract.push(['verify without header', await status('/dsh-unlag/verify', { method: 'POST' }), 403])
// The button header is one half of the gate; the other half is that a page on another origin can
// never send it, so the same request carrying a foreign origin must be refused too.
contract.push(['report without header', await status('/dsh-unlag/report', { method: 'POST' }), 403])
contract.push(['verify from another origin', await status('/dsh-unlag/verify', { method: 'POST', headers: { 'x-dsh-unlag': '1', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"rows":[]}' }), 403])
contract.push(['report from another origin', await status('/dsh-unlag/report', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"kind":"done"}' }), 403])
const contractHeld = contract.every(([, got, want]) => got === want)

// The shim's one promise, asked of the running app: a document that replays the startup list the
// shell froze must be able to load every script in it, so a fabricated revision still answers the
// current bytes. A 404 here is the crash this plugin exists to prevent; a plugin the set no longer
// lists answers nothing, which is the module table's own answer and is left as it is.
const staleUrl = `/${stale(graph.batches[0]?.url ?? '')}`
const staleReply = await fetch(`${HOST}${staleUrl}`, { headers: { 'x-dsh-unlag': '1' } }).catch(() => null)
const staleBytes = staleReply === null ? 0 : (await staleReply.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength
const oldestReply = await fetch(`${HOST}/plugins/not-a-plugin/client.js?rev=0000000000ff`, { headers: { 'x-dsh-unlag': '1' } }).catch(() => null)
const shimBehaviour = {
  staleRev: { status: staleReply?.status ?? 0, bytes: staleBytes },
  unknownPlugin: oldestReply?.status ?? 0,
}
const shimHeld = shimBehaviour.staleRev.status === 200 && shimBehaviour.staleRev.bytes > 0 && shimBehaviour.unknownPlugin === 404

// Rehearsal, not a press: run the bytes the next document would load for the startup list the
// desktop shell froze, with the same loader surface a document gives them, and see whether every
// plugin in the list registers. Nothing is swapped here; when this passes, the press's own page
// load is the only unproven step.
async function rehearseBoot() {
  const stamped = (url) => {
    const path = String(url).startsWith('/') ? String(url) : `/${String(url)}`
    return `${HOST}${path}`
  }
  const registered = new Set()
  const load = (row) => {
    if (row !== null && typeof row === 'object' && typeof row.id === 'string') registered.add(row.id)
  }
  const noop = () => {}
  const element = () => ({ style: {}, setAttribute: noop, append() {}, appendChild() {}, remove() {}, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop }, querySelector: () => null })
  const rehearsalWindow = {
    __ModuleLoader__: { load, ensure: () => ({}) },
    document: { head: element(), body: element(), createElement: element, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: noop, removeEventListener: noop },
    location: { href: `${HOST}/`, origin: HOST, pathname: '/', search: '', hash: '', replace: noop, assign: noop, reload: noop },
    navigator: { language: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh) Electron/44.7.0', platform: 'MacIntel' },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    requestAnimationFrame: (fn) => { try { fn(0) } catch {} return 0 },
    cancelAnimationFrame: noop,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    fetch: async (url, init) => fetch(stamped(url), init),
    URL,
    Response,
    Request,
    Headers,
    AbortController,
    Blob,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    Event,
    CustomEvent,
    JSON,
    Math,
    Date,
    Promise,
    RegExp,
    Error,
    Buffer,
  }
  rehearsalWindow.window = rehearsalWindow
  rehearsalWindow.globalThis = rehearsalWindow
  rehearsalWindow.self = rehearsalWindow
  rehearsalWindow.document.defaultView = rehearsalWindow
  const ran = []
  for (const batch of graph.batches) {
    const path = String(batch.url).startsWith('/') ? String(batch.url) : `/${String(batch.url)}`
    const response = await fetch(`${HOST}${path}`, { headers: { 'x-dsh-unlag': '1' } })
    const body = await response.text()
    ran.push({ url: path, status: response.status, bytes: body.length })
    if (!response.ok) continue
    try {
      runInNewContext(body, rehearsalWindow, { timeout: 5000 })
    } catch (error) {
      ran[ran.length - 1].threw = String(error?.message ?? error)
    }
  }
  const wanted = graph.entries.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter((id) => typeof id === 'string')
  const missing = wanted.filter((id) => !registered.has(id))
  return { registered: registered.size, wanted: wanted.length, missing, ran }
}

const rehearsal = await rehearseBoot().catch((error) => ({ threw: String(error?.message ?? error) }));
const rehearsalOk = rehearsal.threw === undefined && rehearsal.missing !== undefined && rehearsal.missing.length === 0 && rehearsal.ran.every((row) => row.threw === undefined)

const running = { version: stated.version, code: stated.code, shim: stated.shim }
const verdict = await probe.startupLooksServable()
// The whole decision a press makes before it swaps anything, run against the running app: the
// startup list it would re-enter on, the page surfaces a press consults, and the other plugins'
// own saves. `ready` here means a press now would go ahead; the reload route is still never called.
const pressGate = await probe.prepareInterface().catch((error) => String(error?.message ?? error))
const pressPath = pressGate === null
  ? { ready: true }
  : { ready: false, held: pressGate === 'blocked' ? `blocked:${probe.startupHoldReason() ?? 'unknown'}` : pressGate }
// The same judgement over the same rows, asked of the running host directly. A check that always
// says ok would prove nothing, so one row is pointed at a file no plugin serves: the real answer
// has to turn that down. The smoke never presses anything either way.
const verifyWith = async (askRows) => {
  const reply = await fetch(`${HOST}/dsh-unlag/verify`, {
    method: 'POST',
    headers: { 'x-dsh-unlag': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ rows: askRows }),
  })
  return reply.ok ? await reply.json().catch(() => null) : null
}
// The host side takes the script addresses a document would request, one per row.
const addressesOf = (askRows) =>
  askRows
    .filter((row) => row.kind === 'script-src' || row.kind === 'script-preload')
    .map((row) => (String(row.src).startsWith('/') ? String(row.src) : `/${String(row.src)}`))
const soundRows = addressesOf(rows)
const firstBatchId = graph.entries.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).find((id) => typeof id === 'string') ?? 'unknown'
const brokenRows = [...soundRows, `/plugins/${firstBatchId}/no-such-file.js?rev=0000000000ff`]
const sound = await verifyWith(soundRows).catch(() => null)
const broken = await verifyWith(brokenRows).catch(() => null)
const verifyProbe = {
  sound: sound?.status ?? null,
  broken: broken?.status ?? null,
  refuses: broken !== null && broken.status !== 'ok',
  accepts: sound?.status === 'ok',
}
const verifyHeld = verifyProbe.accepts && verifyProbe.refuses

console.log(JSON.stringify({
  host: HOST,
  version: running.version,
  shimWrapped: running.shim?.wrapped === true,
  batches: graph.batches.length,
  rows: rows.length,
  verdict,
  holdReason: verdict ? null : probe.startupHoldReason(),
  pressPath,
  verify: verifyProbe,
  shim: shimBehaviour,
  rehearsal: { ok: rehearsalOk, ...rehearsal },
  asked: requests,
  contract: Object.fromEntries(contract.map(([label, got, want]) => [label, `${got}${got === want ? '' : ` (wanted ${want})`}`])),
}, null, 2))
process.exitCode = verdict === true && contractHeld && shimHeld && rehearsalOk && verifyHeld ? 0 : 1
