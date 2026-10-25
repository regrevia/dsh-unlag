// A press waits on this check, and the page stops waiting after twelve seconds. The budget between
// rows is not enough on its own: one address that accepts the read and never answers would hold the
// whole check past the page's patience, and the page would report a timeout that names nothing.
// A read past the remaining budget is refused as slow, naming the address.
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Loading the plugin can reach its log; a test run must not write into the record a person reads.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-verify-deadline-test.log')

const { verifyStartupRows } = await import('../index.js')

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

const registered = 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} })'
const graph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }] }
const rows = ['plugins/??@local/a/client.js&rev=old']
const body = () => new Response(registered, { status: 200 })

const timed = async (work) => {
  const began = Date.now()
  const answer = await work()
  return { answer, took: Date.now() - began }
}

// A read that never settles is refused at the budget, not waited on.
const hang = await timed(() => verifyStartupRows(graph, () => new Promise(() => {}), rows, 60))
check('a read that never answers is refused as slow', hang.answer.status === 'blocked' && hang.answer.reason === 'slow', JSON.stringify(hang.answer))
check('and the refusal names the address that hung', String(hang.answer.detail).includes('@local/a/client.js'), String(hang.answer.detail))
check('and the answer comes back near the budget', hang.took < 1000, `${hang.took}ms`)

// A read that rejects is still the network reason, with the error in its own words.
const refused = await verifyStartupRows(graph, async () => { throw new Error('table gone') }, rows, 5000)
check('a read that rejects is a network refusal', refused.status === 'blocked' && refused.reason === 'network', JSON.stringify(refused))
check('and it keeps the error text', String(refused.detail).includes('table gone'), String(refused.detail))

// A read that answers in time still passes, so the bound does not cost a sound list.
const sound = await verifyStartupRows(graph, async () => body(), rows, 5000)
check('a read inside the budget still passes', sound.status === 'ok', JSON.stringify(sound).slice(0, 120))

// The abandoned read finishing later must not turn the answered refusal into a throw or a second
// answer: what happens after the page was told slow is dropped.
let release = null
const lateRead = () => new Promise((resolve) => { release = resolve })
const slow = await verifyStartupRows(graph, lateRead, rows, 60)
release(body())
check('a late answer after the refusal changes nothing', slow.status === 'blocked' && slow.reason === 'slow', JSON.stringify(slow))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
