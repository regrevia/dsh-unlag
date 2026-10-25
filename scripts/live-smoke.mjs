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

const running = { version: stated.version, code: stated.code, shim: stated.shim }
const verdict = await probe.startupLooksServable()
console.log(JSON.stringify({
  host: HOST,
  version: running.version,
  shimWrapped: running.shim?.wrapped === true,
  batches: graph.batches.length,
  rows: rows.length,
  verdict,
  holdReason: verdict ? null : probe.startupHoldReason(),
  asked: requests,
}, null, 2))
process.exitCode = verdict === true ? 0 : 1
