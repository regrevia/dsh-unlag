import { verifyStartup } from '../index.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep this run's evidence in its own file: the fallback below must leave a line there.
const LOG = join(tmpdir(), 'dsh-unlag-host-verify-test.log')
process.env.DSH_UNLAG_LOG = LOG
writeFileSync(LOG, '')

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

// A plugin the table no longer has is answered by the stand-in script the route serves in its
// place, so the boot comes up without it and the check says so instead of refusing the rebuild.
const absent = table({ liveGraph: { rev: 'new', entries: [], batches: [] } })
const gone = await verifyStartup(absent, [frozenRow])
check('a startup row for a plugin the set no longer has is readable', gone.status === 'ok', JSON.stringify(gone))
check('the verdict names the plugin the page comes up without', gone.leftOut?.includes('@local/a') === true, JSON.stringify(gone))


// A body that does not register what its address claims is a refusal even when served.
const wrong = table({ body: registered('@local/other') })
const mismatch = await verifyStartup(wrong, [frozenRow])
check('a served body that misses its plugin still refuses', mismatch.status === 'blocked', JSON.stringify(mismatch))

// A body far larger than any real bundle is refused instead of read and compiled in this process:
// a request must not be able to make one check hold an unbounded amount of text.
const huge = table({ body: registered('@local/a') + '\n' + '/*' + 'x'.repeat(8 * 1024 * 1024) + '*/' })
const tooBig = await verifyStartup(huge, [frozenRow])
check('an oversized startup script refuses instead of being compiled', tooBig.status === 'blocked' && tooBig.reason === 'size', JSON.stringify(tooBig))
check('the refusal says how much it read', /bytes/.test(String(tooBig.detail)), String(tooBig.detail))

// The fast path can fail on its own (a table that throws while answering the mapped address); the
// check must fall back to the app's own route rather than refuse, and the failure must be evidence.
let graphCalls = 0
const flip = table()
const flaky = {
  graph: () => {
    graphCalls += 1
    if (graphCalls > 1) throw new Error('table gone\nsecond line')
    return live
  },
  fetchBundle: flip.fetchBundle,
}
const recovered = await verifyStartup(flaky, [frozenRow])
check('a check whose fast path fails answers from the app\'s own route', recovered.status === 'blocked' && recovered.reason === 'missing', JSON.stringify(recovered))
const fallbackLog = readFileSync(LOG, 'utf8')
check('the failure is in the log', fallbackLog.includes("asking the app's own route"), fallbackLog.trim().slice(0, 160))
check('and it is one line', fallbackLog.trim().split('\n').filter((line) => line.includes('asking the app')).length === 1)

// A list whose addresses each answer slowly is bounded as a whole: a press must not wait past the
// moment the page stops waiting for the verdict.
const { verifyStartupRows } = await import('../index.js')
let slowReads = 0
const slowGraph = { rev: 'new', entries: [{ id: '@local/a', url: 'plugins/??@local/a/client.js&rev=new' }, { id: '@local/b', url: 'plugins/??@local/b/client.js&rev=new' }], batches: [] }
const slow = await verifyStartupRows(
  slowGraph,
  async () => {
    slowReads += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { status: 200, arrayBuffer: async () => registered('@local/a') }
  },
  [frozenRow, '/plugins/??@local/b/client.js&rev=old'],
  30,
)
check('a list read slower than the page waits refuses instead of hanging', slow.status === 'blocked' && slow.reason === 'slow', JSON.stringify(slow))
check('and the slow list stops being read once its time is up', slowReads === 1, String(slowReads))

// The same bound holds for a whole list: several large bodies cannot add up past it either.
let servedLarge = 0
const manyRows = [frozenRow, '/plugins/??@local/b/client.js&rev=old', '/plugins/??@local/c/client.js&rev=old', '/plugins/??@local/d/client.js&rev=old', '/plugins/??@local/e/client.js&rev=old']
const summed = await verifyStartupRows(
  { rev: 'new', entries: manyRows.map((row, at) => ({ id: `@local/${'abcde'[at]}`, url: row.replace(/^\/plugins\/\?\?/, 'plugins/??') })), batches: [] },
  async () => {
    servedLarge += 1
    const body = 'abcde'.split('').map((one) => registered(`@local/${one}`)).join('\n') + '\n/*' + 'x'.repeat(7 * 1024 * 1024) + '*/'
    return { status: 200, arrayBuffer: async () => body }
  },
  manyRows,
)
check('a list of large bodies refuses once the whole list passes its bound', summed.status === 'blocked' && summed.reason === 'size', JSON.stringify(summed))
check('that refusal stops reading the list early', servedLarge === 5, String(servedLarge))


// Garbage in the row is a refusal, not a throw.
const junk = await verifyStartup(table(), [''])
check('an empty address refuses instead of throwing', junk.status === 'blocked' && junk.reason === 'list', JSON.stringify(junk))

const failed = checks.filter((row) => !row.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
