import { verifyStartup } from '../index.js'

// Before a press navigates, the host half reads the scripts the next document would run and
// compiles them. A document loads its startup list from the copy the desktop shell froze at launch,
// so those addresses name a generation the table has moved past. The route answers such an address
// at the revision that still holds it; the check must read the same answer, or it refuses a rebuild
// the button could carry out and the person pressing is told a startup script cannot be read.
//
// These cases measure that equivalence on the contract the route and the check share, not a copy of
// it: the fake table only serves the current revision, exactly like a real one after a swap.

const registered = (id) => `window.__ModuleLoader__.load({ id: "${id}", factory() {} })`

const live = {
  rev: 'new',
  entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }],
  batches: [{ url: '/plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }],
}

/**
 * A table that answers only where the current generation lives. `fetchBundle` takes either a
 * Request (newer app) or `{ method, url }` (older app), so both shapes are answered here.
 */
function table({ body = registered('@local/a'), liveGraph = live } = {}) {
  const asked = []
  const fetchBundle = async (request) => {
    const url = typeof request === 'string' ? request : String(request?.url ?? '')
    asked.push(url.replace(/^https?:\/\/[^/]+/u, ''))
    const path = url.replace(/^https?:\/\/[^/]+/u, '')
    const atCurrent = path.includes('&rev=new') || !path.includes('&rev=')
    if (!atCurrent) return new Response('', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
  }
  return { graph: () => liveGraph, fetchBundle, asked }
}

const checks = []
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || detail === '' ? '' : ` — ${detail}`}`)
}

// The document's own address, from the frozen generation.
const frozenRow = '/plugins/??@local/a/client.js&rev=old'

const current = table()
const atCurrent = await verifyStartup(current, [frozenRow])
check('a frozen startup script is read at the revision that holds it', atCurrent.status === 'ok', JSON.stringify(atCurrent))
check('the read goes to the revision that holds the set', current.asked.every((url) => url.includes('&rev=new')), current.asked.join(' '))

// The mapping must not invent an answer: a plugin the table no longer has stays a refusal.
const absent = table({ liveGraph: { rev: 'new', entries: [], batches: [] } })
const missing = await verifyStartup(absent, [frozenRow])
check('a script for a plugin the table lost still refuses', missing.status === 'blocked' && missing.reason === 'missing', JSON.stringify(missing))

// A body that does not register what its address claims is a refusal even when served.
const wrong = table({ body: registered('@local/other') })
const mismatch = await verifyStartup(wrong, [frozenRow])
check('a served body that misses its plugin still refuses', mismatch.status === 'blocked', JSON.stringify(mismatch))

// Garbage in the row is a refusal, not a throw.
const junk = await verifyStartup(table(), [''])
check('an empty address refuses instead of throwing', junk.status === 'blocked' && junk.reason === 'list', JSON.stringify(junk))

const failed = checks.filter((row) => !row.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
