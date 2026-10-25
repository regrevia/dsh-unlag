/**
 * The two read routes answer with what the running app says about itself. The services behind them
 * belong to the app, not to this plugin: the plugin table can be mid-swap, its entries can be a
 * shape nobody expected, and the route table itself can be replaced while a read is in flight. A
 * read that throws has to end as one answer with a line in the log, because the page turns an empty
 * answer into a hold and the log is the only place the reason survives.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'unlag-services-'))
process.env.DSH_UNLAG_LOG = join(dir, 'log')
const { apply } = await import('../index.js')

const checks = []
const check = (label, ok, extra = '') => {
  checks.push({ label, pass: ok })
  if (!ok) process.exitCode = 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
}

const thrower = (what) => () => { throw new Error(what) }
const mount = (services) => {
  const routes = new Map()
  const server = { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } }
  if (services.prefixes !== undefined) {
    // An app that swaps its route table mid-read: asking for the table itself throws.
    Object.defineProperty(server, 'prefixes', { get: services.prefixes, configurable: true })
  }
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return server
      if (key === 'clientModules') return services.clientModules
      return services[key]
    },
    on: () => {},
  }
  apply(ctx, { reloadPlugins: true, reloadInterface: true, autoReload: true })
  return routes
}

const ask = async (handler, path) => {
  let body = ''
  let ended = 0
  const res = { statusCode: 0, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, setHeader() {}, end(chunk) { ended += 1; if (chunk) body += String(chunk) }, write(chunk) { body += String(chunk); return true } }
  const req = { method: 'GET', url: path, headers: { host: '127.0.0.1:52847' }, on() {} }
  try {
    await Promise.race([handler(req, res), new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 4000))])
  } catch (error) {
    return { ended, body, threw: String(error?.message ?? error) }
  }
  return { ended, body, threw: null }
}

const table = (graph) => ({ clientModules: { graph: () => graph, fetchBundle: async () => null } })
const shapes = [
  ['a list that answers nothing', null],
  ['a list that answers text', 'nope'],
  ['a list with no entries', { rev: 'r1' }],
  ['a list whose entries cannot be read', Object.defineProperty({ rev: 'r1' }, 'entries', { get: thrower('entries'), enumerable: true })],
  ['a list whose reader throws', () => { throw new Error('graph') }],
  ['a list whose revision cannot be read', Object.defineProperty({ entries: [] }, 'rev', { get: thrower('rev'), enumerable: true })],
]
for (const [label, graph] of shapes) {
  const routes = mount(table(typeof graph === 'function' ? graph : () => graph))
  const handler = routes.get('/dsh-unlag/graph')
  const answer = typeof handler === 'function' ? await ask(handler, '/dsh-unlag/graph') : { ended: 0, body: '', threw: 'no route' }
  let parsed = null
  try { parsed = JSON.parse(answer.body) } catch {}
  check(`${label} is answered once`, answer.ended === 1 && answer.threw === null, answer.threw ?? `ended ${answer.ended}`)
  check(`${label} answers a list or nothing`, parsed !== null && 'graph' in parsed, answer.body.slice(0, 60))
}

// The route table is a live object too: reading it can throw while the app swaps it.
{
  const routes = mount({ clientModules: { graph: () => ({ rev: 'r1', entries: [], batches: [] }), fetchBundle: async () => null }, prefixes: thrower('prefixes') })
  const state = await ask(routes.get('/dsh-unlag/state'), '/dsh-unlag/state')
  check('a status read whose route table throws is answered once', state.ended === 1 && state.threw === null, state.threw ?? `ended ${state.ended}`)
  check('and it answers a readable object either way', (() => { try { const parsed = JSON.parse(state.body); return typeof parsed.version === 'string' || typeof parsed.status === 'string' } catch { return false } })(), state.body.slice(0, 60))
}

// Evidence: a list that cannot be read leaves a line naming the failure, so a press that held
// because the list was unreadable can be explained afterwards. One line, no break, no throw.
{
  const routes = mount({ clientModules: { graph: () => { throw new Error('mid-swap') }, fetchBundle: async () => null } })
  const graph = await ask(routes.get('/dsh-unlag/graph'), '/dsh-unlag/graph')
  check('a list that cannot be read is answered with no list', graph.ended === 1 && graph.body === '{"graph":null}', graph.body.slice(0, 60))
  await new Promise((resolve) => setImmediate(resolve))
  const lines = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter((line) => line.includes('startup list'))
  check('a list that cannot be read leaves a line', lines.some((line) => line.includes('mid-swap')), lines.slice(0, 2).join(' | '))
  check('and the line is one line', lines.every((line) => line.length < 400))
}

// The route table itself can be replaced while a read is in flight: the shim cannot be checked,
// so the read refuses, says so, and the answer still names an error rather than nothing.
{
  const routes = mount({ clientModules: { graph: () => ({ rev: 'r1', entries: [], batches: [] }), fetchBundle: async () => null }, prefixes: thrower('swapping') })
  const graph = await ask(routes.get('/dsh-unlag/graph'), '/dsh-unlag/graph')
  check('a route table mid-swap is answered once', graph.ended === 1 && graph.threw === null, graph.threw ?? `ended ${graph.ended}`)
  check('a route table mid-swap answers an error', (() => { try { return JSON.parse(graph.body).status === 'error' } catch { return false } })(), graph.body.slice(0, 60))
  await new Promise((resolve) => setImmediate(resolve))
  const lines = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter((line) => line.includes('plugin list'))
  check('a route table mid-swap leaves a line naming it', lines.some((line) => line.includes('swapping')), lines.slice(0, 2).join(' | '))
}

const failed = checks.filter((row) => !row.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
