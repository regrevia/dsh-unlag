import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

// Keep the live log readable: this run writes its own.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-shim-test.log')
writeFileSync(process.env.DSH_UNLAG_LOG, '')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

// --- a bundle table that serves only the current revision --------------------------------------
// The startup list handed to a document names the revision that was current when it was made. A
// plugin swapped afterwards leaves that revision gone, and the module table answers it with 404;
// this half then has to answer the same plugin set at the current revision instead.
const CURRENT = {
  rev: 'newrev',
  entries: [
    { id: '@local/a', url: 'plugins/??@local/a/client.js&rev=ar2', rev: 'ar2' },
    { id: '@local/b', url: 'plugins/??@local/b/client.js&rev=br2', rev: 'br2' },
    { id: '@deepseek-ai/dsh-client-modules', url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cr2', rev: 'cr2' },
  ],
  batches: [
    { phase: 'bootstrap', url: 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=brev', rev: 'brev', entries: ['@deepseek-ai/dsh-client-modules'] },
    { phase: 'application', url: 'plugins/??@local/a/client.js,@local/b/client.js&rev=abrev', rev: 'abrev', entries: ['@local/a', '@local/b'] },
  ],
}

const bodies = new Map([
  ['/plugins/??@local/a/client.js,@local/b/client.js&rev=abrev', '/* application */ @local/a @local/b'],
  ['/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=brev', '/* bootstrap */ @deepseek-ai/dsh-client-modules'],
  ['/plugins/??@local/a/client.js&rev=ar2', '/* one entry */ @local/a'],
  ['/plugins/??@local/a/client.js.map&rev=ar2', '{"version":3}'],
])

const asPath = (url) => String(url).replace(/^http:\/\/[^/]+/u, '')

function fakeRes() {
  const res = { status: 0, headers: null, body: '', writableEnded: false, destroyed: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    if (body !== undefined) res.body += String(body)
    res.writableEnded = true
  }
  return res
}

/** Mount the plugin over a stand-in module table and hand back the wrapped route. */
function mount({ graph = CURRENT, serve = (path) => bodies.get(path), late = false } = {}) {
  const original = (req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('original')
  }
  const route = { kind: 'prefix', path: '/plugins', handler: original }
  const prefixes = new Map(late ? [] : [['/plugins', route]])
  const routes = new Map()
  const handled = []
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? {
            prefixes,
            collectIndexInjections: () => [],
            register: ({ path, handler }) => {
              routes.set(path, handler)
              return () => {}
            },
          }
        : key === 'clientModules'
          ? {
              graph: () => graph,
              fetchBundle: async ({ method, url }) => {
                const path = asPath(url)
                const body = serve(path, method)
                if (body === undefined) return new Response('', { status: 404 })
                if (body === null) return new Response('', { status: 405 })
                return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
              },
            }
          : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handled.push({ dispose: fn })
    },
  }
  apply(ctx, {})
  return { route, original, ctx, handled, prefixes, routes }
}

const call = (handler, req) => {
  const res = fakeRes()
  return Promise.resolve(handler(req, res)).then(() => res)
}

// --- the wrapper lands on the route the module table owns --------------------------------------
const first = mount()
check('the bundle route is wrapped in place', first.route.handler !== first.original)
check('the wrapped route keeps its path', first.route.path === '/plugins')
check('wrapping does not answer for the table', first.prefixes.get('/plugins') === first.route)

const current = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=abrev' })
check('a current revision is left to the table', current.status === 404 && current.body === 'original', `${current.status} ${current.body}`)

// --- a stale revision of the same plugin set is answered at the current one --------------------
const stale = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('a stale batch is answered here', stale.status === 200 && stale.body.includes('@local/a') && stale.body.includes('@local/b'), `${stale.status} ${stale.body}`)
check('the answer is not cached', stale.headers?.['cache-control'] === 'no-store', JSON.stringify(stale.headers))
check('the answer names its length', stale.headers?.['content-length'] === String(Buffer.byteLength(stale.body)))

const staleOne = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('a stale single entry is answered here', staleOne.status === 200 && staleOne.body === '/* one entry */ @local/a', staleOne.body)

const staleMap = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js.map&rev=old' })
check('a stale source map is answered here', staleMap.status === 200 && staleMap.body === '{"version":3}', `${staleMap.status} ${staleMap.body}`)

const head = await call(first.route.handler, { method: 'HEAD', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('HEAD gets the headers and no body', head.status === 200 && head.body === '', `${head.status} ${head.body}`)

const post = await call(first.route.handler, { method: 'POST', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('a post is left to the table', post.body === 'original', post.body)

// --- everything the wrapper cannot place is answered exactly as before ------------------------
const unknownId = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/gone/client.js&rev=old' })
check('an unknown plugin still 404s', unknownId.status === 404 && unknownId.body === 'original', unknownId.body)

const chunk = await call(first.route.handler, { method: 'GET', url: '/plugins/@local/a/chunk-1.js?rev=old' })
check('a package-local chunk is left alone', chunk.body === 'original', chunk.body)

const notBundle = await call(first.route.handler, { method: 'GET', url: '/plugins/index.js' })
check('a plain path under the route is left alone', notBundle.body === 'original', notBundle.body)

// A table that answers the current set with a body missing the plugin it claims must not be
// handed to a document: the boot would refuse it, and that refusal ends the desktop app.
const lying = mount({ serve: (path) => (path.includes('@local/b') ? '/* only a */ @local/a' : undefined) })
const missing = await call(lying.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('a body missing a listed plugin falls through', missing.status === 404 && missing.body === 'original', missing.body)

// --- dispose puts the route back, and a reload wraps it again ---------------------------------
const dispose = first.handled[0]?.dispose
check('an apply leaves a dispose hook', typeof dispose === 'function')
dispose?.()
check('dispose restores the table handler', first.route.handler === first.original)
check('dispose leaves no mark on the route', Object.getOwnPropertySymbols(first.route).length === 0, String(Object.getOwnPropertySymbols(first.route).length))

const again = mount()
check('a second apply wraps the route again', again.route.handler !== again.original)

// --- the route can appear after this plugin starts, and can be replaced afterwards ------------
const late = mount({ late: true })
check('a route that is not there yet leaves nothing wrapped', late.route.handler === late.original)
late.prefixes.set('/plugins', late.route)
const graphAsk = await call(late.routes.get('/dsh-unlag/graph'), { method: 'GET', url: '/dsh-unlag/graph' })
check('a page asking for the startup list wraps the route that appeared', late.route.handler !== late.original, String(graphAsk.status))
const lateStale = await call(late.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('the late route answers a stale entry', lateStale.status === 200 && lateStale.body === '/* one entry */ @local/a', `${lateStale.status} ${lateStale.body}`)

const replaced = mount()
const foreign = (req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('foreign')
}
replaced.route.handler = foreign
await call(replaced.routes.get('/dsh-unlag/graph'), { method: 'GET', url: '/dsh-unlag/graph' })
check('a route replaced since the wrap is wrapped again', replaced.route.handler !== foreign)
const replacedStale = await call(replaced.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('the wrapped route answers a stale entry again', replacedStale.status === 200 && replacedStale.body === '/* one entry */ @local/a', `${replacedStale.status} ${replacedStale.body}`)

// --- the log tells a reader what happened -----------------------------------------------------
const log = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8')
check('the log names the served plugin set', log.includes('served @local/a, @local/b at the current revision'), log.split('\n').filter((line) => line.includes('current revision')).join(' | '))
check('the log names the wrap', log.includes('older revision are answered at the current one'))

console.log(out.join('\n'))
if (log.includes('plugin reload did not start')) {
  console.log('FAIL  apply threw instead of starting')
  process.exitCode = 1
}
