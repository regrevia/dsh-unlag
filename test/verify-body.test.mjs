// The check route reads a startup list out of the request body. Anything the connection does to
// that body — refusing listeners, erroring, ending twice, sending more than the bound, sending
// pieces that are not buffers — must still produce one answer: the page waits on this request.
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = join(tmpdir(), 'unlag-verifybody')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-verifybody.log')

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const routes = new Map()
const graph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [{ url: '/plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }] }
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
        : key === 'clientModules'
          ? { graph: () => graph, fetchBundle: async () => new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', { status: 200 }) }
          : undefined,
    on: () => {},
  },
  {},
)

const answer = async (req) => {
  const res = { status: 0, body: '', writableEnded: false, writeHeads: 0, ends: 0 }
  res.writeHead = (status) => { res.writeHeads += 1; res.status = status }
  res.end = (body) => { res.ends += 1; res.body += body ?? ''; res.writableEnded = true }
  let threw = null
  try {
    await routes.get('/dsh-unlag/verify')(req, res)
  } catch (error) {
    threw = error
  }
  let body = null
  try { body = JSON.parse(res.body) } catch {}
  return { threw, res, body, one: res.writeHeads === 1 && res.ends === 1 }
}

const req = (method = 'POST') => Object.assign(new EventEmitter(), { method, url: '/dsh-unlag/verify', headers: { 'x-dsh-unlag': '1' }, destroy() { this.destroyed = true } })

// 1. A connection that refuses listeners: no body can be read, and the answer must not wait on one.
{
  const r = req()
  r.on = () => { throw new Error('listeners refused') }
  const a = await answer(r)
  check('a body whose listeners refuse is answered once', a.threw === null && a.one && a.body?.status === 'blocked', `${a.threw?.message ?? ''} ${a.res.writeHeads}/${a.res.ends} ${a.body?.reason}`)
}

// 2. A body that errors instead of ending.
{
  const r = req()
  setImmediate(() => r.emit('error', new Error('reset')))
  const a = await answer(r)
  check('a body that errors is answered once', a.threw === null && a.one && a.body?.status === 'blocked', `${a.res.writeHeads}/${a.res.ends} ${a.body?.reason}`)
}

// 3. A body that ends twice: the second end must not answer again.
{
  const r = req()
  setImmediate(() => {
    r.emit('data', Buffer.from('{"rows":["/plugins/??@local/a/client.js&rev=old"]}'))
    r.emit('end')
    r.emit('end')
  })
  const a = await answer(r)
  check('a body that ends twice is answered once', a.threw === null && a.one && a.body?.status === 'ok', `${a.res.writeHeads}/${a.res.ends} ${a.body?.status}`)
}

// 4. A body past the bound, and one that keeps sending after the refusal.
{
  const r = req()
  const huge = Buffer.alloc(1024 * 1024 + 64, 0x20)
  setImmediate(() => {
    r.emit('data', huge)
    r.emit('data', huge)
    r.emit('end')
  })
  const a = await answer(r)
  check('a body past the bound is refused once, in the list size words', a.threw === null && a.one && a.body?.status === 'blocked' && a.body?.reason === 'size', `${a.res.writeHeads}/${a.res.ends} ${a.body?.reason}`)
}

// 5. A body that aborts mid-way.
{
  const r = req()
  setImmediate(() => { r.emit('data', Buffer.from('{"rows"'))
    r.emit('aborted') })
  const a = await answer(r)
  check('an aborted body is answered once', a.threw === null && a.one && a.body?.status === 'blocked', `${a.res.writeHeads}/${a.res.ends} ${a.body?.reason}`)
}

// 6. Pieces that are not buffers: the join fails, which is a body that cannot be read, not a throw.
{
  const r = req()
  setImmediate(() => { r.emit('data', { not: 'a buffer', length: 4 })
    r.emit('end') })
  const a = await answer(r)
  check('a body of pieces that cannot be joined is answered once', a.threw === null && a.one && a.body?.status === 'blocked', `${a.res.writeHeads}/${a.res.ends} ${a.body?.reason}`)
}

// 7. A piece whose length cannot be read at all.
{
  const r = req()
  const odd = { length: undefined }
  setImmediate(() => { r.emit('data', odd)
    r.emit('end') })
  const a = await answer(r)
  check('a piece with no readable length is answered once', a.threw === null && a.one && a.body?.status === 'blocked', `${a.res.writeHeads}/${a.res.ends} ${a.body?.status}`)
}

console.log(out.join('\n'))
