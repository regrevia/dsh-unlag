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
// The document asks the app's own route first and only falls back to the mapping, so the check reads
// the frozen address first and the current revision second: the last read is the one the page runs.
check('the read ends at the revision that holds the set', current.asked.at(-1).includes('&rev=new'), current.asked.join(' '))

// A plugin the table no longer has is answered by the stand-in module the route serves in its
// place: it registers the row's id and applies nothing, so the loader takes the answer, the entry
// activates with no behaviour and the boot comes up without the plugin. The check reads the same
// bytes the page will run, so it approves the rebuild and reports the plugin the page loses instead
// of refusing the press the page can carry out.
const absent = table({ liveGraph: { rev: 'new', entries: [], batches: [] } })
const gone = await verifyStartup(absent, [frozenRow])
check('a startup row for a plugin the set no longer has does not refuse the press', gone.status === 'ok', JSON.stringify(gone))
check('and the answer names the plugin the page comes up without', gone.shimmed?.includes('@local/a') === true, JSON.stringify(gone))
check('and no entry is reported as lost', gone.leftOut === undefined, JSON.stringify(gone))

// A stand-in only helps when it registers: an answer that is 200 but registers nothing is still the
// boot failure this refusal exists for, so it must keep refusing instead of trusting the status.
{
  const silent = {
    graph: () => ({ rev: 'new', entries: [], batches: [] }),
    fetchBundle: async () => new Response('/* nothing here */', { status: 200 }),
  }
  const answer = await verifyStartup(silent, [frozenRow])
  check('an answer that registers nothing still refuses the press', answer.status === 'blocked' && answer.reason === 'entries', JSON.stringify(answer))
  check('and that refusal names the entry the script did not register', answer.leftOut?.includes('@local/a') === true, JSON.stringify(answer))
}



// An address the set still serves at its own revision is read from the table's own answer, not
// from a substituted body: what the next document asks for is what the check must read. A frozen
// address is the other case — the route answers it at the revision that holds the set, and the
// check reads that same answer (the case below the mix section measures it).
const bothPaths = (() => {
  const asked = []
  const fetchBundle = async (request) => {
    const url = String(request?.url ?? request)
    const path = url.replace(/^https?:\/\/[^/]+/u, '')
    asked.push(path)
    if (path.includes('&rev=old')) return new Response(registered('@local/a'), { status: 200 })
    return new Response(registered('@local/a') + '\n;', { status: 200 })
  }
  // A real table hands back the same object for one generation; a graph rebuilt per call would
  // look like a replacement to a check that looks twice.
  const stable = { rev: 'old', entries: [{ id: '@local/a', rev: 'old', url: '/plugins/??@local/a/client.js&rev=old' }], batches: [] }
  return { graph: () => stable, fetchBundle, asked }
})()
const servedFirst = await verifyStartup(bothPaths, [frozenRow])
check("a row the set still serves is read from the table's own answer", servedFirst.status === 'ok' && bothPaths.asked[0].includes('&rev=old'), bothPaths.asked.join(' '))

// A recomposition between the first body and the last leaves the check with bytes from two
// generations: no single answer describes that set, so the press is held instead of approved.
const moving = (() => {
  const graph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [] }
  const fetchBundle = async (request) => {
    const path = String(request?.url ?? request).replace(/^https?:\/\/[^/]+/u, '')
    if (!path.includes('&rev=old')) graph.rev = 'newer'
    return new Response(registered('@local/a'), { status: path.includes('&rev=old') ? 404 : 200 })
  }
  return { graph: () => graph, fetchBundle }
})()
const moved = await verifyStartup(moving, [frozenRow])
check('a set replaced while its scripts are read refuses the press', moved.status === 'blocked' && moved.reason === 'generation', JSON.stringify(moved))

// A body that does not register what its address claims is a refusal even when served.
const wrong = table({ body: registered('@local/other') })
const mismatch = await verifyStartup(wrong, [frozenRow])
check('a served body that misses its plugin still refuses', mismatch.status === 'blocked', JSON.stringify(mismatch))

// A real profile serves its whole plugin set as a few large bundles: one measured at 8.7 MB. That is
// larger than any hand-written script and must verify like any other, or the button would refuse to
// rebuild the page of the very profile it ships with.
const big = table({ body: registered('@local/a') + '\n/*' + 'x'.repeat(9 * 1024 * 1024) + '*/' })
const large = await verifyStartup(big, [frozenRow])
check('a bundle the size of a real profile still verifies', large.status === 'ok', JSON.stringify(large).slice(0, 160))

// A body far larger than any real bundle is refused instead of read and compiled in this process:
// a request must not be able to make one check hold an unbounded amount of text.
const huge = table({ body: registered('@local/a') + '\n/*' + 'x'.repeat(25 * 1024 * 1024) + '*/' })
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

// The same bound holds for a whole list: several bodies cannot add up past it either. Each body is
// below the one-script bound, so the refusal comes from the summed one.
let servedLarge = 0
const manyRows = [frozenRow, '/plugins/??@local/b/client.js&rev=old', '/plugins/??@local/c/client.js&rev=old']
const summed = await verifyStartupRows(
  { rev: 'new', entries: manyRows.map((row, at) => ({ id: `@local/${'abc'[at]}`, url: row.replace(/^\/plugins\/\?\?/, 'plugins/??') })), batches: [] },
  async () => {
    servedLarge += 1
    const body = 'abc'.split('').map((one) => registered(`@local/${one}`)).join('\n') + '\n/*' + 'x'.repeat(800) + '*/'
    return { status: 200, arrayBuffer: async () => body }
  },
  manyRows,
  9000,
  // The bounds are worked at a size a test run can afford; each body is under the one-script bound,
  // so the refusal can only come from the summed one.
  { maxScriptBytes: 3000, maxTotalBytes: 2000 },
)
check('a list of large bodies refuses once the whole list passes its bound', summed.status === 'blocked' && summed.reason === 'size', JSON.stringify(summed))
check('that refusal stops reading the list early', servedLarge === 3, String(servedLarge))
check('and the refusal counts the bytes it read', /bytes; this check reads at most/u.test(String(summed.detail)), String(summed.detail))


// An address can name a whole plugin set at once: this profile's largest measured 2.8 KB, and one
// id list of a hundred plugin names passes 4 KB. An address past the old bound was dropped from the
// check without a word, and a script the check never reads is a script nothing proved would load.
const longIds = Array.from({ length: 100 }, (_, at) => `@local/dsh-client-plugin-with-a-normal-name-${String(at)}`)
const longUrl = (rev) => `/plugins/??${longIds.map((id) => `${id}/client.js`).join(',')}&rev=${rev}`
const longTable = table({
  body: longIds.map((id) => registered(id)).join('\n'),
  liveGraph: {
    rev: 'new',
    entries: longIds.map((id) => ({ id, rev: 'new', url: `/plugins/??${id}/client.js&rev=new` })),
    batches: [{ url: longUrl('new'), entries: longIds, rev: 'new' }],
  },
})
const longRead = await verifyStartup(longTable, [longUrl('old')])
check('an address naming a whole plugin set is read, not dropped', longRead.status === 'ok' && longTable.asked.at(-1).includes('&rev=new'), JSON.stringify(longRead).slice(0, 160))
check('that address is longer than a thousand ids of slack', longUrl('old').length > 4096, String(longUrl('old').length))

// Repeating one address is not a reason to read it again: one address can be most of a profile's
// bytes, and a list of sixty-four copies of it would otherwise be sixty-four reads.
const repeated = table()
const repeatedRow = '/plugins/??@local/a/client.js&rev=new'
const repeatedRead = await verifyStartup(repeated, [repeatedRow, repeatedRow, repeatedRow])
check('a repeated address is read once', repeated.asked.length === 1, `${repeated.asked.length} reads`)
check('and the check still approves the list', repeatedRead.status === 'ok', JSON.stringify(repeatedRead).slice(0, 120))

// A row too long to read is not silently skipped while the rest of the list is approved: the
// unread address is exactly the script whose failure would end the app.
const mixed = await verifyStartup(table(), ['/plugins/??@local/a/client.js&rev=old', '/plugins/??@local/a/client.js&rev=old&pad=' + 'x'.repeat(9000)])
check('a list with one unreadably long address refuses the whole list', mixed.status === 'blocked' && mixed.reason === 'list', JSON.stringify(mixed).slice(0, 160))

// Garbage in the row is a refusal, not a throw.
const junk = await verifyStartup(table(), [''])
check('an empty address refuses instead of throwing', junk.status === 'blocked' && junk.reason === 'list', JSON.stringify(junk))

// A response that cannot answer a read is not a response this check can approve: the script it
// stands for would fail to load in the next document, and the reason has to name it rather than
// leaving the whole list unexplained.
{
  const oneRow = [frozenRow]
  const row = () => [frozenRow]
  const table = { rev: 'new', entries: [{ id: '@local/a', url: 'plugins/??@local/a/client.js&rev=new' }], batches: [] }
  const cases = [
    ['a status that cannot be read', () => ({ get status() { throw new Error('status') } })],
    ['a body that cannot be read', () => ({ status: 200, arrayBuffer: async () => { throw new Error('body') } })],
    ['a body that is not bytes', () => ({ status: 200, arrayBuffer: async () => 42 })],
    ['a body reader that is missing', () => ({ status: 200 })],
  ]
  for (const [label, make] of cases) {
    let threw = null
    let verdict = null
    try {
      verdict = await verifyStartupRows(table, async () => make(), row())
    } catch (error) {
      threw = error
    }
    check(`${label} refuses instead of throwing`, threw === null && verdict.status === 'blocked', String(threw?.message ?? JSON.stringify(verdict)))
    check(`${label} names the script it could not read`, verdict?.reason === 'missing' && String(verdict?.detail ?? '').includes('@local/a'), String(verdict?.detail))
  }
  void oneRow
}

// A plugin set that cannot be read at all leaves nothing to check a startup list against.
{
  for (const [what, graph] of [['missing', null], ['not an object', 'gone'], ['without a list', { rev: 'r1' }], ['with a list it cannot name', { rev: 'r1', entries: 'gone' }]]) {
    const answer = await verifyStartupRows(graph, async () => ({ status: 200 }), ['/plugins/a/client.js'])
    check(`verify refuses a startup list when the plugin set is ${what}`, answer.status === 'blocked', JSON.stringify(answer))
    check(`and that refusal says the list could not be read (${what})`, answer.reason === 'list', String(answer.reason))
  }
}

// A row the set still has is answered by its body, not by a stand-in, and the verdict says nothing
// about stand-ins: the two cases have to stay apart, or a press would log a plugin loss that did not
// happen.
check('a row the set still serves names no stand-in', atCurrent.standInRows === undefined, JSON.stringify(atCurrent))
check('the lost-plugin row is counted as a stand-in', gone.standInRows === 1, JSON.stringify(gone))
// The list is the running app's own object, re-composed while a swap runs: a row whose fields
// cannot be read is a list this check cannot read, and it says so rather than throwing out of the
// route that carries the press.
let entryRead = null
let entryThrew = null
try {
  entryRead = await verifyStartup({
    graph: () => ({ rev: 'new', entries: [{ get id() { throw new Error('mid-swap') } }], batches: [] }),
    fetchBundle: async () => new Response('', { status: 200 }),
  }, ['/plugins/??@local/a/client.js&rev=new'])
} catch (error) {
  entryThrew = error
}
check('a row that cannot be read is refused, not thrown', entryThrew === null && entryRead?.status === 'blocked', String(entryThrew?.message ?? entryRead?.status))
check('and the refusal names the list', entryRead?.reason === 'list', String(entryRead?.reason))

// A body past the one-script bound is refused before it is compiled, and the refusal names both
// bounds: a person reading the log learns what to change, not only that the press was held.
const oneBig = await verifyStartupRows(
  { rev: 'new', entries: [{ id: '@local/a', url: 'plugins/??@local/a/client.js&rev=old' }], batches: [] },
  async () => ({ status: 200, arrayBuffer: async () => registered('@local/a') + '\n/*' + 'x'.repeat(800) + '*/' }),
  [frozenRow],
  9000,
  { maxScriptBytes: 700, maxTotalBytes: 3000 },
)
check('a body past the one-script bound is refused as size', oneBig.status === 'blocked' && oneBig.reason === 'size', JSON.stringify(oneBig))
check('and that refusal names the per-script bound', String(oneBig.detail).includes('700'), String(oneBig.detail))

// The measure this bound is set from: this app's own profile serves 15.7 MB across three bundles,
// the largest 9.2 MB. Loosening the bound past what a profile needs is what let one check hold
// hundreds of megabytes of text in the process that owns every running turn, so the checks below
// pin both sides: the measured profile verifies, a body past the bound is refused before compile.
const measuredRows = [frozenRow, '/plugins/??@local/b/client.js&rev=old']
const measured = table({ body: registered('@local/a') + '\n/*' + 'x'.repeat(9 * 1024 * 1024) + '*/' })
const measuredBig = await verifyStartupRows(
  { rev: 'new', entries: measuredRows.map((row, at) => ({ id: `@local/${'ab'[at]}`, url: row.replace(/^\/plugins\/\?\?/, 'plugins/??') })), batches: [] },
  async () => ({ status: 200, arrayBuffer: async () => registered('@local/a') + '\n' + registered('@local/b') + '\n/*' + 'x'.repeat(9 * 1024 * 1024) + '*/' }),
  measuredRows,
)
check('a startup list the size of this app\'s own profile verifies', measuredBig.status === 'ok', JSON.stringify(measuredBig).slice(0, 160))

// Counted at the end: a check appended after a mid-file summary must still be able to fail this run.
// One startup row can carry several plugins in one bundle, and a chunk is asked of the plugin
// whose body loads it: the official loader derives `plugins/<owner>/<file>` from that module's own
// row (measured against the app's own startup bundle at 0.2.1: the four chunks one batch loads are
// answered at `plugins/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/…` and
// `plugins/@deepseek-ai/dsh-client-ui-sidebar-terminal/…`, and the bundle-spec form answers 404).
// Asking the row's bundle instead holds a boot that would have come up.
{
  const batchedRow = '/plugins/??@local/a,@local/b/client.js&rev=old'
  const batchedUrl = '/plugins/??@local/a,@local/b/client.js&rev=new'
  const batchedGraph = {
    rev: 'new',
    entries: [
      { id: '@local/a', rev: 'new', url: batchedUrl },
      { id: '@local/b', rev: 'new', url: batchedUrl },
    ],
    batches: [{ url: batchedUrl, entries: ['@local/a', '@local/b'], rev: 'new' }],
  }
  const module = (id) => `window.__ModuleLoader__.load({ id: "@local/${id}", factory() {} });`
  // The chunk call sits in the loading module's own segment of the bundle.
  const aLoads = (file) => `${module('a')} require.async("./${file}");${module('b')}`
  const bLoads = (file) => `${module('a')}${module('b')} require.async("./${file}");`
  const batchedCheck = async (body, chunkAnswers) => {
    const asked = []
    const chunkOf = async (address) => {
      asked.push(String(address))
      return chunkAnswers(String(address)) ? { status: 200 } : { status: 404 }
    }
    const result = await verifyStartupRows(
      batchedGraph,
      async () => ({ status: 200, servedRev: 'new', arrayBuffer: async () => body }),
      [batchedRow],
      9000,
      null,
      chunkOf,
    )
    return { result, asked }
  }

  const own = await batchedCheck(aLoads('chunk-1.js'), (address) => address.includes('/plugins/@local/a/chunk-1.js?rev=new'))
  check('a chunk is asked of the plugin whose body loads it', own.asked.some((path) => path === '/plugins/@local/a/chunk-1.js?rev=new') === true, own.asked.join(' '))
  check('and never from the bundle spec the startup row names', own.asked.some((path) => path.includes('??@local/a,@local/b')) === false, own.asked.join(' '))
  check('so a batched row whose own chunk answers approves the list', own.result.status === 'ok', JSON.stringify(own.result))

  // Same file name, other plugin: B's bytes must not answer A's question, and A's must not answer B's.
  const borrowed = await batchedCheck(aLoads('chunk-1.js'), (address) => address.includes('/plugins/@local/b/chunk-1.js'))
  check('another plugin own file does not answer for this plugin chunk', borrowed.result.status === 'blocked', JSON.stringify(borrowed.result))
  check('and the refusal names the address the loader asks', typeof borrowed.result.detail === 'string' && borrowed.result.detail.includes('/plugins/@local/a/chunk-1.js?rev=new') === true, String(borrowed.result.detail))

  const other = await batchedCheck(bLoads('chunk-1.js'), (address) => address.includes('/plugins/@local/b/chunk-1.js?rev=new'))
  check('the second plugin of a batch is asked at its own revision', other.asked.some((path) => path === '/plugins/@local/b/chunk-1.js?rev=new') === true, other.asked.join(' '))
  check('and its answering chunk approves the list', other.result.status === 'ok', JSON.stringify(other.result))
}

// --- one document made of two generations ----------------------------------------------------
// The page rebuilt from the shell's frozen list takes its main script at the revision that list
// names and each chunk at the revision the table serves now. `/verify` approved exactly that pair
// once, and the loader then failed inside the new page (`helper.legacyFunction is not a function`):
// an answer made of two interfaces is not a page this press can promise. The check reads which
// generation each answer came from and refuses the pair.
{
  const mixedRows = ['/plugins/??@local/a/client.js&rev=old']
  const mainBody = `require.async("./helper.js")\n${registered('@local/a')}`
  const chunkOf = async (address) => {
    if (String(address).includes('rev=new')) return { status: 200, servedRev: 'new', arrayBuffer: async () => 'export function legacyFunction() {}' }
    return { status: 404 }
  }
  const mixed = await verifyStartupRows(
    { rev: 'new', entries: [{ id: '@local/a', rev: 'new' }], batches: [] },
    // The route answered the frozen address itself: the bytes are the old generation's.
    async () => ({ status: 200, servedRev: 'old', servedFromAsked: true, arrayBuffer: async () => mainBody }),
    mixedRows,
    9000,
    null,
    chunkOf,
  )
  check('an old main body with a newer chunk is refused as mixed', mixed.status === 'blocked' && mixed.reason === 'mixed', JSON.stringify(mixed))
  check('and the refusal names both generations', /old/u.test(String(mixed.detail)) && /new/u.test(String(mixed.detail)), String(mixed.detail))

  const coherent = await verifyStartupRows(
    { rev: 'new', entries: [{ id: '@local/a', rev: 'new' }], batches: [] },
    async () => ({ status: 200, servedRev: 'new', servedFromAsked: true, arrayBuffer: async () => mainBody }),
    mixedRows,
    9000,
    null,
    chunkOf,
  )
  check('a main body at the current generation with its own chunk verifies', coherent.status === 'ok', JSON.stringify(coherent).slice(0, 160))

  const assembled = await verifyStartupRows(
    { rev: 'new', entries: [{ id: '@local/a', rev: 'new' }], batches: [] },
    async () => ({ status: 200, servedRev: 'sha256:0123456789abcdef', arrayBuffer: async () => mainBody }),
    mixedRows,
    9000,
    null,
    chunkOf,
  )
  check('a body assembled from the current set is not the stale side of a pair', assembled.status === 'ok', JSON.stringify(assembled).slice(0, 160))

  /**
   * The pair a page gets after any plugin update, and the one that held every press: the startup row
   * no longer answers, so the route serves it from the revision that does — a batch revision — while
   * the chunk is asked at the entry revision of its own plugin. Both answers are the current
   * generation; only the strings differ, because a batch revision and an entry revision are two
   * namespaces. Reading that difference as two generations refuses a rebuild that carries the page
   * forward unchanged.
   */
  const substituted = await verifyStartupRows(
    { rev: 'graph-new', entries: [{ id: '@local/a', rev: 'entry-new' }], batches: [] },
    async () => ({ status: 200, servedRev: 'batch-new', servedFromAsked: false, arrayBuffer: async () => mainBody }),
    ['/plugins/??@local/a/client.js&rev=old'],
    9000,
    null,
    async () => ({ status: 200, servedRev: 'entry-new', arrayBuffer: async () => 'export function legacyFunction() {}' }),
  )
  check('a startup row served from the current set with its own chunk verifies', substituted.status === 'ok', JSON.stringify(substituted).slice(0, 240))

  // The honest refusal is kept for the one case that is two generations: the bytes at the frozen
  // address are the old generation's, and the chunk the page loads next is the new one's.
  const staleWithoutProof = await verifyStartupRows(
    { rev: 'graph-new', entries: [{ id: '@local/a', rev: 'entry-new' }], batches: [] },
    async () => ({ status: 200, servedRev: 'old', arrayBuffer: async () => mainBody }),
    ['/plugins/??@local/a/client.js&rev=old'],
    9000,
    null,
    async () => ({ status: 200, servedRev: 'entry-new', arrayBuffer: async () => 'export function legacyFunction() {}' }),
  )
  check('a body whose source the check cannot prove is not refused as mixed', staleWithoutProof.status === 'ok', JSON.stringify(staleWithoutProof).slice(0, 240))

  /**
   * The table keeps the generation a page booted from, so a frozen address still answers 200 with
   * the old bytes. The route answers that address at the revision that holds the set now (the bundle
   * shim does exactly that), so the check must read the same answer: the next page runs one
   * generation, and a batch revision next to an entry revision is not a reason to hold the press.
   */
  const retainedGraph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [] }
  const retained = (() => {
    const asked = []
    const fetchBundle = async (request) => {
      const url = String(request?.url ?? request)
      const path = url.replace(/^https?:\/\/[^/]+/u, '')
      asked.push(path)
      if (path.includes('&rev=old')) return new Response(mainBody, { status: 200 })
      if (path.includes('&rev=new')) return new Response(registered('@local/a'), { status: 200 })
      return new Response('', { status: 404 })
    }
    return {
      graph: () => retainedGraph,
      fetchBundle,
      asked,
    }
  })()
  const readNow = await verifyStartup(retained, ['/plugins/??@local/a/client.js&rev=old'])
  check('a frozen address the table still answers is read at the set served now', readNow.status === 'ok', JSON.stringify(readNow).slice(0, 240))
  check('and the read never spends the retained generation', retained.asked.includes('/plugins/??@local/a/client.js&rev=old') === false, retained.asked.join(' '))
}

// Every check above counts: the summary is printed last, so a refused pair or a false refusal
// changes the exit code of the whole suite, not just the log.
const failed = checks.filter((row) => !row.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
