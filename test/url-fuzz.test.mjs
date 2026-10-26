// The addresses a check reads come from a page request and, before that, from a startup list the app
// froze. Neither is this plugin's own data, so the parsing path must be total: every shape, however
// malformed, has to answer a refusal or a verdict, and never throw into the route that answered a
// press. Rows are generated rather than listed so a class of shape is covered, not one example.
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Loading the plugin can reach its log; a test run must not write into the record a person reads.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-url-fuzz-test.log')

const { verifyStartup, verifyStartupRows } = await import('../index.js')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`ok - ${name}`)
  } else {
    fail += 1
    console.log(`not ok - ${name}${detail === '' ? '' : `: ${detail}`}`)
  }
}

const registered = (id) => `window.__ModuleLoader__.load({ id: "${id}", factory() {} })`
const statuses = new Set(['ok', 'blocked'])

// A small deterministic generator: the same run every time, so a failure can be repeated.
let seed = 0x5eed
const next = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = (list) => list[Math.floor(next() * list.length) % list.length]
const names = ['@local/a', '@local/b', '', '..', '%E4%B8%AD', '@local/a/client.js', '@local/a/client.js.map', 'x'.repeat(90)]
const randomAddress = () => {
  const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(names))
  const list = parts.map((one) => (next() < 0.5 ? one : `${one}/client.js`)).join(',')
  const rev = pick(['', 'old', 'new', '%00', 'x'.repeat(64)])
  const map = next() < 0.15 ? '.map' : ''
  return `/plugins/??${list}${map}${rev === '' ? '' : `&rev=${rev}`}`
}

const table = {
  rev: 'new',
  entries: [
    { id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' },
    { id: '@local/b', rev: 'new', url: '/plugins/??@local/b/client.js&rev=new' },
  ],
  batches: [],
}
// Answers differ by the address asked for, so one generated row can reach each answer the check
// has: a body that misses the plugin it must carry, an empty body, and an address that answers 404.
const serve = async (url) => {
  const text = String(url)
  if (text.includes('@local/b')) return new Response(registered('@local/a'), { status: 200 })
  if (text.includes('%00')) return new Response('', { status: 200 })
  if (text.includes('..')) return new Response('not found', { status: 404 })
  return new Response(registered('@local/a'), { status: 200 })
}

// Every generated row on its own, straight at the parser: the answer must be a verdict, never a throw.
// A fake plugin table would answer `list` before any row is read, so the rows are given to the row
// check directly; that is the code a page request reaches.
let threw = null
let bad = null
const seen = new Set()
for (let at = 0; at < 300; at += 1) {
  const row = randomAddress()
  try {
    const answer = await verifyStartupRows(table, serve, [row])
    if (answer !== null && typeof answer === 'object') seen.add(`${answer.status}/${answer.reason}`)
    if (answer === null || typeof answer !== 'object' || statuses.has(answer.status) === false) bad = { row, answer }
  } catch (error) {
    threw = { row, message: String(error?.message ?? error) }
    break
  }
}
check('no generated startup row throws out of the check', threw === null, JSON.stringify(threw))
check('every generated row answers a verdict', bad === null, JSON.stringify(bad))
// A fuzz that only ever sees one early refusal proves nothing about the parser: the generated rows
// have to reach several answers, including one that passes.
check('the generated rows reach several answers, one of them a pass', seen.size >= 3 && seen.has('ok/ok'), [...seen].join(' '))

// A hostile plugin table is the other half: the rows are sound, the description of the set is not.
const hostileGraphs = [null, 'gone', 0, [], { rev: 1 }, { rev: null, entries: null }, { entries: 'gone' }, { entries: [null, 1, 'x', { id: 3 }, { id: '@local/a' }] }, { entries: [{ id: '@local/a', url: {} }], batches: 'gone' }]
let graphThrew = null
for (const graph of hostileGraphs) {
  try {
    const answer = await verifyStartupRows(graph, serve, ['/plugins/??@local/a/client.js&rev=old'])
    if (answer === null || typeof answer !== 'object' || statuses.has(answer.status) === false) graphThrew = { graph: JSON.stringify(graph), answer }
  } catch (error) {
    graphThrew = { graph: JSON.stringify(graph), message: String(error?.message ?? error) }
    break
  }
}
check('a hostile plugin table is refused, not thrown', graphThrew === null, JSON.stringify(graphThrew))

// The list itself is a request body: shapes that are not lists cannot reach the per-row read.
let listThrew = null
for (const rows of [null, 'gone', 0, {}, [], Array.from({ length: 300 }, () => randomAddress()), [null, 1, {}, '@local/a']]) {
  try {
    const answer = await verifyStartupRows(table, serve, rows)
    if (answer === null || typeof answer !== 'object' || statuses.has(answer.status) === false) listThrew = { rows: String(rows).slice(0, 40), answer }
  } catch (error) {
    listThrew = { rows: String(rows).slice(0, 40), message: String(error?.message ?? error) }
    break
  }
}
check('a hostile startup list is refused, not thrown', listThrew === null, JSON.stringify(listThrew))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
