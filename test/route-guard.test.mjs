// The floor under every route body: a handler that throws, rejects, or cannot even be read as a
// response must still cost only one status. A rejection here reaches the server's dispatch and
// takes every running turn with it.
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG = join(tmpdir(), 'unlag-routeguard.log')
rmSync(LOG, { force: true })
process.env.DSH_UNLAG_LOG = LOG

const { guardRoute } = await import(new URL('../index.js', import.meta.url).href)
const lines = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean)

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

/** A response that records what the route answered. */
const responder = () => ({
  status: 0,
  headers: {},
  body: '',
  headersSent: false,
  writableEnded: false,
  destroyed: false,
  writeHead(status, headers) {
    this.status = status
    this.headers = headers ?? {}
    this.headersSent = true
  },
  end(body) {
    if (body !== undefined) this.body = String(body)
    this.writableEnded = true
  },
})

// --- a handler that throws synchronously answers one status ---------------------------------
{
  const res = responder()
  let thrown = null
  try {
    guardRoute('/dsh-unlag/state', () => { throw new Error('the table went away') })({}, res)
  } catch (error) {
    thrown = error
  }
  check('a throwing handler does not throw to the server', thrown === null, String(thrown))
  check('a throwing handler answers 503', res.status === 503, String(res.status))
  check('a throwing handler answers the error shape', res.body === '{"status":"error"}', res.body)
  check('the throw is logged with its route', lines().some((line) => line.includes('cannot answer /dsh-unlag/state: the table went away')), JSON.stringify(lines()))
}

// --- a handler that rejects after answering nothing answers the same way --------------------
{
  const res = responder()
  let thrown = null
  try {
    guardRoute('/dsh-unlag/graph', async () => { throw new Error('the graph read failed') })({}, res)
  } catch (error) {
    thrown = error
  }
  await new Promise((resolve) => setImmediate(resolve))
  check('a rejecting handler does not throw to the server', thrown === null, String(thrown))
  check('a rejecting handler answers 503', res.status === 503, String(res.status))
  check('the rejection is logged', lines().some((line) => line.includes('cannot answer /dsh-unlag/graph: the graph read failed')), JSON.stringify(lines().slice(-2)))
}

// --- a handler that already answered is ended rather than answered twice --------------------
{
  const res = responder()
  res.writeHead(200, { 'content-type': 'application/json' })
  guardRoute('/dsh-unlag/report', async () => { throw new Error('after the status') })({}, res)
  await new Promise((resolve) => setImmediate(resolve))
  check('a late failure keeps the status already sent', res.status === 200, String(res.status))
  check('a late failure ends the body', res.writableEnded === true)
  check('a late failure writes no second status', res.status !== 503, String(res.status))
}

// --- a response whose own fields throw cannot turn the floor into a throw -------------------
{
  const hostile = {
    get headersSent() { throw new Error('no headers from you') },
    writableEnded: false,
    destroyed: false,
    writeHead() { throw new Error('no status either') },
    end() { throw new Error('no end either') },
  }
  let thrown = null
  try {
    guardRoute('/dsh-unlag/verify', () => { throw new Error('first') })({}, hostile)
  } catch (error) {
    thrown = error
  }
  check('a hostile response does not throw to the server', thrown === null, String(thrown))
  check('a hostile response is still logged', lines().some((line) => line.includes('cannot answer /dsh-unlag/verify: first')), JSON.stringify(lines().slice(-2)))
}

// --- an ordinary answer is left alone -------------------------------------------------------
{
  const res = responder()
  guardRoute('/dsh-unlag/state', (req, out) => { out.writeHead(200); out.end('{}'); return 42 })({}, res)
  check('a normal request body passes through', res.status === 200 && res.body === '{}', `${String(res.status)} ${res.body}`)
  check('a non-promise return writes nothing more', res.writableEnded === true && res.status === 200, String(res.status))
}

// --- two requests at once each get their own answer -----------------------------------------
{
  const a = responder()
  const b = responder()
  const guarded = guardRoute('/dsh-unlag/state', (req, out) => { if (req.id === 'b') throw new Error('b failed'); out.writeHead(200); out.end('a') })
  guarded({ id: 'a' }, a)
  guarded({ id: 'b' }, b)
  check('the first request keeps its own answer', a.status === 200 && a.body === 'a', `${String(a.status)} ${a.body}`)
  check('the second request gets the error, not the first answer', b.status === 503 && b.body === '{"status":"error"}', `${String(b.status)} ${b.body}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
