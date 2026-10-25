import { readFileSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
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
  ['/plugins/??@local/b/client.js&rev=br2', '/* one entry */ @local/b'],
  ['/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cr2', '/* one entry */ @deepseek-ai/dsh-client-modules'],
  ['/plugins/??@local/a/client.js.map&rev=ar2', '{"version":3}'],
])

const asPath = (url) => String(url).replace(/^http:\/\/[^/]+/u, '')

function fakeRes() {
  const res = { status: 0, headers: null, body: '', writableEnded: false, destroyed: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    res.headersSent = true
  }
  res.write = (chunk) => {
    // Node writes the headers implicitly on the first write, which is exactly the leak under test.
    if (res.headersSent !== true) {
      res.status = 200
      res.headersSent = true
    }
    res.body += String(chunk)
    return true
  }
  res.end = (body) => {
    if (body !== undefined) res.body += String(body)
    res.writableEnded = true
  }
  return res
}

/** Mount the plugin over a stand-in module table and hand back the wrapped route. */
function mount({ graph = CURRENT, graphThrows = false, serve = (path) => bodies.get(path), keep = null, late = false, shape = 'handler', streams404 = false, callback404 = false, breaksMidWrite = false, hang = false, delay = 0, hmr = null } = {}) {
  const original = async (req, res) => {
    if (breaksMidWrite) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      throw new Error('table died mid-write')
    }
    const kept = keep === null ? undefined : keep(asPath(req.url))
    if (kept !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(kept)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    if (callback404) {
      await new Promise((resolve) => res.end('original', resolve))
      return
    }
    if (streams404) {
      res.write('half ')
      res.end('original')
      return
    }
    res.end('original')
  }
  // A newer app registers this route as a request-in/response-out resource instead of a handler.
  const route =
    shape === 'resource'
      ? {
          kind: 'prefix',
          path: '/plugins',
          resource: async (request) => {
            const kept = keep === null ? undefined : keep(asPath(request?.url))
            if (kept === undefined) return new Response('original', { status: 404 })
            return new Response(kept, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
          },
        }
      : { kind: 'prefix', path: '/plugins', handler: original }
  const prefixes = new Map(late ? [] : [['/plugins', route]])
  const routes = new Map()
  const handled = []
  const seen = []
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
              graph: () => {
                if (graphThrows) throw new Error('table gone')
                return graph
              },
              fetchBundle: async (asked) => {
                if (hang) return new Promise(() => {})
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
                seen.push(asked)
                const { method, url } = asked
                const path = asPath(url)
                const body = serve(path, method)
                if (body === undefined) return new Response('', { status: 404 })
                if (body === null) return new Response('', { status: 405 })
                return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
              },
            }
          : key === 'hmr'
            ? hmr
            : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handled.push({ dispose: fn })
    },
  }
  apply(ctx, {})
  return { route, original, ctx, handled, seen, prefixes, routes }
}

/** Run a body the way a document would: a loader records what it registers. */
function registeredBy(body) {
  const ids = []
  const window = { __ModuleLoader__: { load: (row) => { if (typeof row?.id === 'string') ids.push(row.id) } } }
  window.window = window
  window.globalThis = window
  runInNewContext(body, window, { timeout: 5000 })
  return ids
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

const current = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=newrev' })
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

// A document made before two plugins were grouped apart asks for a set the table never sends
// again. Each plugin is still served on its own, so the set is answered from those bodies in the
// order the document listed them: a 404 here used to end the desktop app.
const parts = (...bodies) => bodies.join('\n;\n')
const regrouped = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@deepseek-ai/dsh-client-modules/client.js&rev=g1' })
check('a set the table no longer groups is answered entry by entry', regrouped.status === 200 && regrouped.body === '/* one entry */ @local/a\n;\n/* one entry */ @deepseek-ai/dsh-client-modules', `${regrouped.status} ${regrouped.body}`)
// Two bodies joined without a separator do not parse as one script, and the document would run
// neither; the line holding `;` between them is what keeps each one a statement of its own.
check('joined bodies are separated by a statement boundary', regrouped.body === parts('/* one entry */ @local/a', '/* one entry */ @deepseek-ai/dsh-client-modules'), regrouped.body)
check('the regrouped answer is not cached', regrouped.headers?.['cache-control'] === 'no-store', JSON.stringify(regrouped.headers))

const regroupedMissing = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/gone/client.js&rev=g1' })
check(
  'a stale set with a plugin the set no longer has is answered without it',
  regroupedMissing.status === 200 && regroupedMissing.body.includes('is not part of the plugin set served now'),
  regroupedMissing.body,
)

const regroupedMap = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@deepseek-ai/dsh-client-modules/client.js.map&rev=g1' })
check('a regrouped source map is not assembled', regroupedMap.status === 404 && regroupedMap.body === 'original', regroupedMap.body)

const head = await call(first.route.handler, { method: 'HEAD', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('HEAD gets the headers and no body', head.status === 200 && head.body === '', `${head.status} ${head.body}`)

const post = await call(first.route.handler, { method: 'POST', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('a post is left to the table', post.body === 'original', post.body)

// --- everything the wrapper cannot place is answered exactly as before ------------------------
const unknownId = await call(first.route.handler, { method: 'GET', url: '/plugins/??@local/gone/client.js&rev=old' })
// A document made before that plugin was removed still lists it. The table's 404 for the one
// script ends the app, so an empty script stands in its place and the boot comes up without it.
check(
  'a stale request for a plugin the set no longer has is answered with an empty script',
  unknownId.status === 200 && unknownId.body.includes('is not part of the plugin set served now'),
  `${unknownId.status} ${unknownId.body}`,
)

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
// --- a page booting a list that names a plugin the app dropped still boots ---------------------
// This is the whole point of the stand-in answer, and only running the bytes proves it: the row for
// the dropped plugin must register nothing, and every plugin still served must register.
const dropped = mount({
  graph: {
    rev: 'newrev',
    entries: [{ id: '@local/a', url: 'plugins/??@local/a/client.js&rev=ar2', rev: 'ar2' }],
    batches: [{ phase: 'application', url: 'plugins/??@local/a/client.js,@local/b/client.js&rev=abrev', rev: 'abrev', entries: ['@local/a', '@local/b'] }],
  },
  serve: (path) => {
    if (path === '/plugins/??@local/a/client.js&rev=ar2') return 'window.__ModuleLoader__.load({ id: "@local/a", factory() {} })'
    if (path === '/plugins/??@local/a/client.js,@local/b/client.js&rev=abrev' || path === '/plugins/??@local/a/client.js&rev=ar2') return undefined
    return undefined
  },
})
const droppedAnswer = await call(dropped.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=abrev', headers: {} })
const boots = droppedAnswer.status === 200 ? registeredBy(droppedAnswer.body) : []
check('a list naming a dropped plugin boots instead of failing', droppedAnswer.status === 200, String(droppedAnswer.status))
check('a dropped plugin registers nothing', !boots.includes('@local/b'), boots.join(','))
check('every plugin still served still registers', boots.includes('@local/a'), boots.join(','))

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

// --- a table that writes its 404 in pieces ----------------------------------------------------
// Node sends the 200 headers it has not been given on the first `write`. Letting those pieces
// through would put a 200 on the wire that no fallback could replace, so they are held with the body.
const streamed = mount({ streams404: true })
const streamedStale = await call(streamed.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('a 404 written in pieces is still held back', streamedStale.status === 200 && streamedStale.body.includes('@local/a'), `${streamedStale.status} ${streamedStale.body}`)
check('and the half-written 404 never reaches the wire', streamedStale.body === '/* one entry */ @local/a', `${streamedStale.status} ${JSON.stringify(streamedStale.body)}`)

// --- a table that waits for its end callback before returning ---------------------------------
// Node answers that callback when the body is flushed. A held 404 answers it too, or a handler
// that awaits the flush would leave the fallback answer waiting behind it forever.
const waited = mount({ callback404: true })
const waitedStale = await Promise.race([
  call(waited.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' }),
  new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout', body: '' }), 3000)),
])
check('a 404 whose handler waits for the flush still answers', waitedStale.status === 200 && waitedStale.body.includes('@local/a'), `${waitedStale.status} ${JSON.stringify(waitedStale.body)}`)

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

// --- an update that hands the route to a fresh handler must not leave it unwrapped ------------
const upd = mount({ hmr: { runExclusive: (fn) => Promise.resolve(fn()), reconcileProfile: async () => ({ warnings: [] }) } })
const updForeign = (req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('foreign')
}
upd.route.handler = updForeign
const updPress = await call(upd.routes.get('/dsh-unlag/reload'), { method: 'POST', url: '/dsh-unlag/reload', headers: { 'x-dsh-unlag': '1' } })
check('a press over a re-registered route answers', updPress.status === 200, String(updPress.status))
check('an update wraps the route again', upd.route.handler !== updForeign)
const updStale = await call(upd.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('a page starting after an update still gets its stale entry', updStale.status === 200 && updStale.body === '/* one entry */ @local/a', `${updStale.status} ${updStale.body}`)

// --- a route registered as a resource, not a handler (newer app) ------------------------------
// Dispatch prefers the resource branch, so wrapping the handler of a route that has one would
// leave the guard installed but never asked: every stale script would still 404.
const resourceOnly = mount({ shape: 'resource' })
check('a resource-shaped route is wrapped too', typeof resourceOnly.route.resource === 'function' && resourceOnly.route.handler === undefined)
check('a resource-shaped route gets no handler added', 'handler' in resourceOnly.route === false)
const resourceStale = await resourceOnly.route.resource(
  new Request('http://127.0.0.1:58672/plugins/??@local/a/client.js,@local/b/client.js&rev=old'),
)
check(
  'a resource-shaped route answers a stale batch',
  resourceStale.status === 200 && (await resourceStale.text()).includes('@local/b'),
  String(resourceStale.status),
)
const resourceCurrent = await resourceOnly.route.resource(new Request('http://127.0.0.1:58672/plugins/index.js'))
check('an unplaceable resource request goes back to the table', (await resourceCurrent.text()) === 'original')
check('the table is asked with a standard request object', resourceOnly.seen[0] instanceof Request, String(resourceOnly.seen[0]?.constructor?.name))

const shapeRes = fakeRes()
resourceOnly.routes.get('/dsh-unlag/state')({ method: 'GET', url: '/dsh-unlag/state' }, shapeRes)
const shapeBody = JSON.parse(shapeRes.body)
check('the state names the route shape in use', shapeBody.shim?.kind === 'resource' && shapeBody.shim?.wrapped === true, shapeRes.body)

// --- the log tells a reader what happened -----------------------------------------------------
const log = readFileSync(process.env.DSH_UNLAG_LOG, 'utf8')
check('the log names the served plugin set', log.includes('served @local/a, @local/b at the current revision'), log.split('\n').filter((line) => line.includes('current revision')).join(' | '))
check('the log names the wrap', log.includes('older revision are answered at the current one'))

// --- the table's own old generation, when it still has one, is used untouched ----------------
// Replacing an answer the table still holds with current code would hand the page a document
// whose later chunks belong to another generation; the table's own answer is kept instead.
const kept = mount({ keep: (path) => (path.includes('rev=old') && path.includes('@local/b') ? '/* old generation */ @local/a @local/b' : undefined) })
const keptAnswer = await call(kept.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('an old-generation answer is used as it is', keptAnswer.status === 200 && keptAnswer.body.includes('old generation'), `${keptAnswer.status} ${keptAnswer.body}`)
check('an old-generation answer is not replaced', kept.seen.length === 0, String(kept.seen.length))


// --- one plugin's chunk is asked at that plugin's own revision --------------------------------
// A document and every chunk it loads later ask with the revision they booted from. The table
// serves a chunk at exactly the revision of its own entry: asking at the plugin set's revision,
// or another plugin's, answers 404 and ends a document that already runs. The plugin path alone
// decides the revision, so a chunk nobody has regrouped must never be rewritten to the set's.
const chunkAsks = []
const chunkRoute = mount({
  keep: (path) => {
    chunkAsks.push(path)
    return path.includes('client.lazy.js') && path.includes('rev=ar2') ? '/* lazy @local/a */' : undefined
  },
})
const chunkOld = await call(chunkRoute.route.handler, { method: 'GET', url: '/plugins/@local/a/client.lazy.js?rev=a-old' })
check('a chunk asked at a stale revision is answered', chunkOld.status === 200 && chunkOld.body === '/* lazy @local/a */', `${chunkOld.status} ${chunkOld.body}`)
check('the chunk is retried at the entry revision', chunkAsks.includes('/plugins/@local/a/client.lazy.js?rev=ar2'), chunkAsks.join(' '))
check('the chunk is never asked at the plugin set revision', !chunkAsks.some((path) => path.includes('rev=newrev')), chunkAsks.join(' '))

const chunkNoQuery = mount({ keep: (path) => (path === '/plugins/@local/b/client.lazy.js?rev=br2' ? '/* lazy @local/b */' : undefined) })
const chunkMissing = await call(chunkNoQuery.route.handler, { method: 'GET', url: '/plugins/@local/b/client.lazy.js' })
check('a chunk with no revision is asked at its entry revision', chunkMissing.status === 200 && chunkMissing.body === '/* lazy @local/b */', `${chunkMissing.status} ${chunkMissing.body}`)

const chunkOther = mount({ keep: (path) => (path === '/plugins/@local/b/client.lazy.js?rev=br2' ? '/* lazy @local/b */' : undefined) })
const chunkWrong = await call(chunkOther.route.handler, { method: 'GET', url: '/plugins/@local/b/client.lazy.js?rev=abrev' })
check('a chunk naming another plugin set is answered at its entry revision', chunkWrong.status === 200 && chunkWrong.body === '/* lazy @local/b */', `${chunkWrong.status} ${chunkWrong.body}`)

const resourceAsks = []
const resourceChunk = mount({
  shape: 'resource',
  keep: (path) => {
    resourceAsks.push(path)
    return path === '/plugins/@local/a/client.lazy.js?rev=ar2' ? '/* lazy resource */' : undefined
  },
})
const resourceAnswer = await resourceChunk.route.resource(new Request('http://x/plugins/@local/a/client.lazy.js?rev=a-old'))
check('a chunk asked over the resource route is answered', resourceAnswer.status === 200 && (await resourceAnswer.text()) === '/* lazy resource */', String(resourceAnswer.status))
check('the resource route asks at the entry revision', resourceAsks.includes('/plugins/@local/a/client.lazy.js?rev=ar2'), resourceAsks.join(' '))

const brokenResource = mount({ shape: 'resource', graphThrows: true })
const brokenResourceAnswer = await brokenResource.route.resource(new Request('http://127.0.0.1:58672/plugins/??@local/a/client.js&rev=old'))
check(
  'a resource-shaped route survives a table that throws',
  brokenResourceAnswer instanceof Response && brokenResourceAnswer.status === 404,
  String(brokenResourceAnswer?.status),
)

// --- a table that starts writing and then fails -------------------------------------------------
const midWrite = mount({ breaksMidWrite: true, serve: () => undefined })
const midRes = fakeRes()
await midWrite.route.handler({ method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' }, midRes)
check('a table that dies after sending its status still ends the answer', midRes.writableEnded === true && midRes.body === '', `${midRes.status}/${midRes.body}/${midRes.writableEnded}`)
check(
  'and the log says the table failed instead of the document hanging',
  readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('cannot answer a bundle request: table died mid-write'),
)

// --- a table that throws while it is being swapped --------------------------------------------
// A rejection from inside an async route handler is an unhandled one, and Node ends the process
// on that; the request is answered instead.
const broken = mount({ graphThrows: true })
const brokenAnswer = await call(broken.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' })
check('a table that throws still answers the request', brokenAnswer.status === 404 && brokenAnswer.body === 'original', `${brokenAnswer.status} ${brokenAnswer.body}`)
check(
  'the failure is in the log',
  readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('cannot read the plugin table for a bundle request: table gone'),
)

// --- a stale set that names a plugin the profile no longer has --------------------------------
// The app's own answer is 404, and a document booting from an old startup list that meets one ends
// the whole app. The plugin is genuinely gone, so the set is answered without it.
const withoutB = {
  rev: 'newrev',
  entries: CURRENT.entries.filter((row) => row.id !== '@local/b'),
  batches: CURRENT.batches.filter((row) => !row.entries.includes('@local/b')),
}
const removedMount = mount({ graph: withoutB })
const removedAsked = await call(removedMount.route.handler, {
  method: 'GET',
  url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=abrev',
})
check(
  'a stale set naming a removed plugin is answered instead of 404',
  removedAsked.status === 200,
  `${removedAsked.status}`,
)
check(
  'the plugin that remains is in the answer',
  String(removedAsked.body).includes('@local/a') && String(removedAsked.body).includes('is not part of the plugin set served now'),
  String(removedAsked.body),
)
check('and the log names what was left out', readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('left out @local/b'))

// --- how much work one address may ask for ---------------------------------------------------
// Answering a stale set reads one body per plugin it names. The address is the request's own, so
// its size must not decide how long the answer takes.
const huge = Array.from({ length: 300 }, (_, i) => `@local/p${i}`)
const capMount = mount()
const tooMany = await call(capMount.route.handler, {
  method: 'GET',
  url: `/plugins/??${huge.map((id) => `${id}/client.js`).join(',')}&rev=old`,
})
check('an address naming more plugins than a list could hold is left to the table', tooMany.status === 404 && tooMany.body === 'original', tooMany.status)

// The same plugin listed twice still names the set the table groups: the body is read once.
const repeated = await call(capMount.route.handler, {
  method: 'GET',
  url: '/plugins/??@local/a/client.js,@local/a/client.js,@local/b/client.js&rev=older',
})
check(
  'the same plugin repeated in one address is answered as one',
  repeated.status === 200 && repeated.body.includes('@local/a') && repeated.body.includes('@local/b'),
  `${repeated.status} ${repeated.body}`,
)


// One stale address can name many rows, and answering it reads one body per row. The route answers
// whatever a socket asks, so the whole answer is bounded: once the bound is reached the request goes
// back to the app's own route instead of holding the connection for as long as its rows add up.
const slowRows = mount({ delay: 60 })
const wasBudget = process.env.DSH_UNLAG_STALE_MS
process.env.DSH_UNLAG_STALE_MS = '110'
const held = await call(slowRows.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js,@deepseek-ai/dsh-client-modules/client.js&rev=g1' })
if (wasBudget === undefined) delete process.env.DSH_UNLAG_STALE_MS
else process.env.DSH_UNLAG_STALE_MS = wasBudget
check('a stale set that outlives the whole-answer bound is given back to the table', held.status === 404 && held.body === 'original', `${held.status} ${held.body}`)
check('and it stops reading rows once the bound is reached', slowRows.seen.length < 3, String(slowRows.seen.length))

// --- a table that takes the question and never answers ----------------------------------------
// The document waits on this script, so the wait is bounded; the request then gets the table's own
// answer instead of holding a connection open for as long as the table stays silent.
process.env.DSH_UNLAG_FETCH_TIMEOUT_MS = '40'
const hangMount = mount({ hang: true })
const lateAnswer = await call(hangMount.route.handler, { method: 'GET', url: '/plugins/??@local/a/client.js,@local/b/client.js&rev=old' })
check('a table that never answers does not hold the request', lateAnswer.status === 404 && lateAnswer.body === 'original', `${lateAnswer.status} ${lateAnswer.body}`)
check('and the log says the table was silent', readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('the module table did not answer in time'))
delete process.env.DSH_UNLAG_FETCH_TIMEOUT_MS

// --- a response that refuses to be held --------------------------------------------------------
// Installing the hold writes to the response object. A response that refuses must leave the table's
// own answer standing rather than reject out of an async route handler, where nobody would catch it.
const frozen = mount()
const frozenRes = fakeRes()
for (const name of ['writeHead', 'end', 'write']) {
  Object.defineProperty(frozenRes, name, { value: frozenRes[name], writable: false, configurable: true })
}
let rejected = null
try {
  await frozen.route.handler({ method: 'GET', url: '/plugins/??@local/a/client.js&rev=old' }, frozenRes)
} catch (error) {
  rejected = error
}
check('a response that cannot be held is answered, not thrown at', rejected === null, String(rejected?.message ?? ''))
check('and the table answer stands', frozenRes.status === 404 && frozenRes.body === 'original', `${frozenRes.status} ${frozenRes.body}`)
check(
  'and the log says why the 404 was not held',
  readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').includes('cannot hold a 404 for a moment'),
  'the log does not name it',
)

console.log(out.join('\n'))
if (log.includes('plugin reload did not start')) {
  console.log('FAIL  apply threw instead of starting')
  process.exitCode = 1
}
