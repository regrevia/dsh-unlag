import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A press sends the startup list the next document would run. The list can be long on a profile
// with many bundles, and the request that carries it has a bound of its own: a request past it is
// refused in its own words, never reported as an empty list a person would then look for in vain.
// These cases drive the real route, so the bound is measured where a press meets it.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-verify-route-test.log')

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const registered = (id) => `window.__ModuleLoader__.load({ id: "${id}", factory() {} })`
const graph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [{ url: '/plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }] }

function mount(overrides = {}) {
  const routes = new Map()
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
        : key === 'clientModules'
          ? {
              graph: () => overrides.graph ?? graph,
              fetchBundle: overrides.fetchBundle ?? (async () => new Response(registered('@local/a'), { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })),
            }
          : key === 'hmr'
            ? { baseDir: '/tmp/unlag-verify-route-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
            : undefined,
    on: (event, fn) => { if (event === 'dispose') ctx.dispose = fn },
  }
  apply(ctx, {})
  return routes
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '', writableEnded: false }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body += body ?? ''; res.writableEnded = true }
  return res
}

/** A request that carries `text` as its body, in the chunks the server would receive it in. */
function request(text) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/dsh-unlag/verify'
  req.headers = { 'x-dsh-unlag': '1', 'content-type': 'application/json' }
  req.destroy = () => { req.destroyed = true }
  const bytes = Buffer.from(text)
  queueMicrotask(() => {
    for (let at = 0; at < bytes.length; at += 64 * 1024) req.emit('data', bytes.subarray(at, at + 64 * 1024))
    req.emit('end')
  })
  return req
}

const routes = mount()
const post = async (text) => {
  const res = fakeRes()
  await routes.get('/dsh-unlag/verify')(request(text), res)
  return { status: res.status, body: JSON.parse(res.body) }
}

// A startup list from a profile with many bundles is longer than the old 64 KiB request bound:
// that list has to be read, not refused.
const padded = (n) => `/plugins/??@local/a/client.js&rev=old&pad=${'x'.repeat(7000)}&n=${n}`
const longList = JSON.stringify({ rows: Array.from({ length: 40 }, (_unused, n) => padded(n)) })
check('the request carrying a long but sound list is larger than the old bound', Buffer.byteLength(longList) > 64 * 1024, `${Buffer.byteLength(longList)} bytes`)
const longAnswer = await post(longList)
check('a long sound list is read and approved', longAnswer.body.status === 'ok', JSON.stringify(longAnswer.body).slice(0, 140))

// Past the bound the answer names the list, not an empty one: the person pressing would otherwise
// be told their startup list names nothing, which is false and points at the wrong thing.
const huge = JSON.stringify({ rows: [`/plugins/??@local/a/client.js&rev=old&pad=${'x'.repeat(1024 * 1024 + 64)}`] })
const hugeAnswer = await post(huge)
check('a request past the bound is refused as size', hugeAnswer.status === 200 && hugeAnswer.body.status === 'blocked' && hugeAnswer.body.reason === 'size', JSON.stringify(hugeAnswer.body))
check('and the refusal says the list is longer than the check reads', /longer than this check reads/u.test(String(hugeAnswer.body.detail)), String(hugeAnswer.body.detail))

const broken = await post('{"rows": [')
check('a body that is not JSON stays a refused list', broken.body.status === 'blocked' && broken.body.reason === 'list', JSON.stringify(broken.body))

// A profile that loses a plugin still boots an older document from a stand-in script, and the pass
// that says so must leave a line naming how the row was answered: a later look at the log has to
// tell a plugin loss from a normal pass without re-running the press.
{
  const lostRoutes = mount({ graph: { rev: 'new', entries: [], batches: [] }, fetchBundle: async () => new Response('', { status: 404 }) })
  const answer = await (async () => {
    const res = fakeRes()
    await lostRoutes.get('/dsh-unlag/verify')(request(JSON.stringify({ rows: ['/plugins/??@local/a/client.js&rev=old'] })), res)
    return { status: res.status, body: JSON.parse(res.body) }
  })()
  check('a list whose plugin is gone still passes on the stand-in', answer.body.status === 'ok', JSON.stringify(answer.body).slice(0, 160))
  check('and the pass counts the stand-in row', answer.body.standInRows === 1, JSON.stringify(answer.body))
  const logText = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8')
  check('and the log says a stand-in answered the row', /answered by a stand-in script/u.test(logText), logText.split('\n').slice(-3).join(' | '))
}

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
