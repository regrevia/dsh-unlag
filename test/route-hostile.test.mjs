// The five routes a page or another local process can call must answer even when the request or
// the response cannot be read the ordinary way: a rejection here reaches the server's dispatch and
// takes every running turn with it.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = join(tmpdir(), 'unlag-routehostile')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-routehostile.log')

const mod = await import(new URL('../index.js', import.meta.url).href)

const routes = new Map()
const server = {
  prefixes: new Map(),
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
  collectIndexInjections: () => [],
}
const clientModules = {
  graph: () => ({ rev: 'r2', entries: [{ id: '@local/a', rev: 'r2', chunks: ['client.js'] }] }),
  fetchBundle: async () => null,
}
mod.apply({ get: (key) => (key === 'webServer' ? server : key === 'clientModules' ? clientModules : undefined), on: () => {} }, {})

const out = []
const check = (name, ok, detail = '') => out.push({ name, ok, detail })

const response = (kind) => {
  const res = {
    status: 0, body: '', writableEnded: false, destroyed: false, headersSent: false,
    writeHead(status) {
      if (kind === 'writeHead throws') throw new Error('writeHead')
      this.status = status
      this.headersSent = true
    },
    write() { return true },
    end(chunk) { this.writableEnded = true; if (chunk != null) this.body += String(chunk) },
  }
  return kind === 'frozen response' ? Object.freeze(res) : res
}

const streamer = (body) => ({
  on(event, fn) {
    setImmediate(() => {
      try {
        if (event === 'data') fn(Buffer.from(body))
        if (event === 'end') fn()
      } catch {}
    })
  },
  once(event, fn) { this.on(event, fn) },
  removeListener() {},
})

const request = (method, fault) => {
  const req = { method, url: '/dsh-unlag/report?event=mounted', headers: { 'x-dsh-unlag': '1' }, ...streamer('{"rows":[]}') }
  if (fault !== null) {
    delete req[fault]
    Object.defineProperty(req, fault, { get() { throw new Error(fault) } })
  }
  return req
}

const faults = ['method', 'headers', 'url']
for (const path of ['/dsh-unlag/state', '/dsh-unlag/graph', '/dsh-unlag/verify', '/dsh-unlag/report', '/dsh-unlag/reload']) {
  const handler = routes.get(path)
  check(`${path} is mounted`, typeof handler === 'function', typeof handler)
  for (const kind of ['plain response', 'writeHead throws', 'frozen response']) {
    let threw = null
    const res = response(kind)
    try {
      await handler(request('POST', null), res)
    } catch (error) {
      threw = error
    }
    check(`${path}: ${kind} does not reject`, threw === null, String(threw?.message ?? ''))
  }
}
for (const fault of faults) {
  let threw = null
  try {
    await routes.get('/dsh-unlag/report')(request('POST', fault), response('plain response'))
  } catch (error) {
    threw = error
  }
  check(`a request whose ${fault} cannot be read does not reject`, threw === null, String(threw?.message ?? ''))
}
for (const path of ['/dsh-unlag/state', '/dsh-unlag/graph']) {
  let threw = null
  const res = response('plain response')
  try {
    await routes.get(path)(request('DELETE', null), res)
  } catch (error) {
    threw = error
  }
  check(`${path}: an unserved method answers rather than rejects`, threw === null && res.writableEnded === true, String(threw?.message ?? `${res.status}`))
}

for (const { name, ok, detail } of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
const failed = out.filter((row) => row.ok !== true)
console.log(failed.length === 0 ? 'ok' : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
