// The bundle route is wrapped in an async handler, so anything that throws before the first guard
// becomes a rejection nobody catches: a request whose address cannot be read is answered as if it
// had none instead of taking the app down.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = join(tmpdir(), 'unlag-requestshape-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-requestshape.log')

const mod = await import(new URL('../index.js', import.meta.url).href)

const graph = () => ({ entries: [{ id: '@local/a', revision: 'r1', chunks: ['client.js'] }], applications: [], bootstraps: [] })

function mount(shape) {
  const original = shape === 'resource'
    ? async () => new Response(null, { status: 404 })
    : (req, res) => { res.writeHead(404, {}); res.end('original') }
  const route = shape === 'resource' ? { kind: 'prefix', path: '/plugins', resource: original } : { kind: 'prefix', path: '/plugins', handler: original }
  const ctx = {
    get: (key) => (key === 'webServer'
      ? { prefixes: new Map([['/plugins', route]]), collectIndexInjections: () => [], register: () => () => {} }
      : key === 'clientModules' ? { graph, fetchBundle: async () => null } : undefined),
    on: () => {},
  }
  mod.apply(ctx, {})
  return route
}

const out = []
const check = (name, ok, detail = '') => out.push({ name, ok, detail })

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    write() { return true },
    end(chunk) { if (this.writableEnded) throw new Error('end twice'); if (chunk != null) this.body += String(chunk); this.writableEnded = true },
  }
  return res
}

const handlerReq = () => {
  const req = { method: 'GET', headers: {}, on() {}, once() {}, removeListener() {} }
  Object.defineProperty(req, 'url', { get() { throw new Error('no address') } })
  return req
}

const handler = mount('handler')
let threw = null
let answer = null
try {
  answer = fakeRes()
  await handler.handler(handlerReq(), answer)
} catch (error) {
  threw = error
}
check('a handler request whose address throws does not reject', threw === null, String(threw?.message ?? ''))
check('and the caller still gets an answer', answer.writableEnded === true && answer.status === 404, `${answer.status} ended=${answer.writableEnded}`)

const resource = mount('resource')
let resourceThrew = null
let resourceAnswer = null
try {
  const req = new Request('http://127.0.0.1/plugins/@local/a/client.js?rev=old')
  Object.defineProperty(req, 'url', { get() { throw new Error('no address') } })
  resourceAnswer = await resource.resource(req)
} catch (error) {
  resourceThrew = error
}
check('a resource request whose address throws does not reject', resourceThrew === null, String(resourceThrew?.message ?? ''))
check('and it is answered rather than ignored', resourceAnswer !== null && resourceAnswer !== undefined, String(resourceAnswer?.status))

for (const { name, ok, detail } of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
const failed = out.filter((row) => row.ok !== true)
console.log(failed.length === 0 ? 'ok' : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
