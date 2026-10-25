// The route wrapper asks the module table for the plugin set and for a bundle; a table that throws
// or a bundle source that refuses must leave the request answered as the table left it rather than
// rejecting the handler the server is awaiting.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = join(tmpdir(), 'unlag-hostilehome')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-hostilehost.log')

const mod = await import(new URL('../index.js', import.meta.url).href)

const out = []
const check = (name, ok, detail = '') => out.push({ name, ok, detail })

const hosts = {
  'the graph throws': { graph: () => { throw new Error('graph went away') }, fetchBundle: async () => null },
  'a bundle fetch rejects': { graph: () => ({ rev: 'r2', entries: [{ id: '@local/a', rev: 'r2', chunks: ['client.js'] }] }), fetchBundle: () => Promise.reject(new Error('table went away')) },
  'a bundle fetch answers nonsense': { graph: () => ({ rev: 'r2', entries: [{ id: '@local/a', rev: 'r2', chunks: ['client.js'] }] }), fetchBundle: async () => ({ status: 200 }) },
}

function mount(shape, clientModules) {
  const route = shape === 'resource'
    ? { kind: 'prefix', path: '/plugins', resource: async () => new Response(null, { status: 404 }) }
    : { kind: 'prefix', path: '/plugins', handler: (req, res) => { res.writeHead(404, {}); res.end('original') } }
  const ctx = {
    get: (key) => (key === 'webServer'
      ? { prefixes: new Map([['/plugins', route]]), collectIndexInjections: () => [], register: () => () => {} }
      : key === 'clientModules' ? clientModules : undefined),
    on: () => {},
  }
  mod.apply(ctx, {})
  return route
}

const fakeRes = () => {
  const res = { status: 0, body: '', writableEnded: false, destroyed: false, headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    write() { return true },
    end(chunk) { if (this.writableEnded) throw new Error('end twice'); if (chunk != null) this.body += String(chunk); this.writableEnded = true } }
  return res
}

const url = '/plugins/??@local/a/client.js&rev=old'
for (const [title, host] of Object.entries(hosts)) {
  const handlerRoute = mount('handler', host)
  let threw = null
  let res = fakeRes()
  try {
    await handlerRoute.handler({ method: 'GET', url, headers: {}, on() {}, once() {}, removeListener() {} }, res)
  } catch (error) {
    threw = error
  }
  check(`handler shape: ${title} does not reject`, threw === null, String(threw?.message ?? ''))
  check(`handler shape: ${title} still answers with the table's 404`, res.writableEnded === true && res.status === 404, `${res.status} ended=${res.writableEnded}`)

  const resourceRoute = mount('resource', host)
  let resourceThrew = null
  let answer = null
  try {
    answer = await resourceRoute.resource(new Request(`http://127.0.0.1${url}`))
  } catch (error) {
    resourceThrew = error
  }
  check(`resource shape: ${title} does not reject`, resourceThrew === null, String(resourceThrew?.message ?? ''))
  check(`resource shape: ${title} still answers 404`, answer?.status === 404, String(answer?.status))
}

for (const { name, ok, detail } of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
const failed = out.filter((row) => row.ok !== true)
console.log(failed.length === 0 ? 'ok' : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
