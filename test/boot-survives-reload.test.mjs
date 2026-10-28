// A window reports the startup list it was frozen with once, when it starts. A press then replaces
// the plugin: the copy that received the report is disposed and a fresh copy is applied, so a report
// kept inside that copy is gone exactly when the next press needs to check what the page booted with.
// This mounts two copies against one process, the way a reload does, and requires the report to
// survive the swap.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-boot-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'boot.log')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const fakeRes = () => ({
  status: 0,
  body: '',
  writableEnded: false,
  writeHead(status) {
    this.status = status
  },
  end(body) {
    this.body += body ?? ''
    this.writableEnded = true
  },
})

const req = ({ method = 'GET', body = null } = {}) => {
  const listeners = new Map()
  return {
    method,
    headers: { 'x-dsh-unlag': '1' },
    url: '/',
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      if (event === 'end' && body !== null) {
        const chunk = Buffer.from(JSON.stringify(body))
        for (const each of listeners.get('data') ?? []) each(chunk)
        for (const each of listeners.get('end') ?? []) each()
      }
    },
  }
}

const mount = () => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') {
        return {
          collectIndexInjections: () => [],
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      if (key === 'loader') return { entries: () => [] }
      if (key === 'clientModules') {
        return {
          graph: () => ({ rev: 'live', entries: [{ id: 'dsh-unlag', rev: 'live' }] }),
          fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
        }
      }
      return undefined
    },
    on: () => {},
  }
  return { routes, ctx }
}

const stateOf = async (routes) => {
  const res = fakeRes()
  await routes.get('/dsh-unlag/state')(req(), res)
  return JSON.parse(res.body)
}

// The first copy, the one that is running when the page starts.
const first = mount()
const { apply } = await import('../index.js')
apply(first.ctx, {})
const boot = fakeRes()
await first.routes.get('/dsh-unlag/boot')(
  req({
    method: 'POST',
    body: { boot: { rev: 'page-1', entries: ['dsh-unlag'], batches: [{ url: 'plugins/??dsh-unlag/client.js&rev=live' }] } },
  }),
  boot,
)
check('the page report is accepted', boot.status === 200 && JSON.parse(boot.body).status !== 'blocked', boot.body)
const before = await stateOf(first.routes)
check('the running copy keeps the list the page booted with', before.boot?.rev === 'page-1', JSON.stringify(before.boot))

// The press: a new copy of this plugin is applied in the same process, the old one disposed.
const second = mount()
const next = await import('../index.js?copy=2')
next.apply(second.ctx, {})
await new Promise((resolve) => setTimeout(resolve, 200))
const after = await stateOf(second.routes)
check('a later copy still reads the list that page reported', after.boot?.rev === 'page-1', JSON.stringify(after.boot))
check('and the frozen scripts beside it survived too', after.bootSnapshot !== null, String(after.bootSnapshot))

console.log(out.join('\n'))
