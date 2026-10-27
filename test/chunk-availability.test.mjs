import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { Config, apply, name, inject } from '../index.js'

process.env.DSH_UNLAG_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-unlag-chunk-')), 'reload.log')

/**
 * The files a startup body loads after boot are asked for at that entry's own revision. A check that
 * approves the list because the main scripts still read, while one of those files answers 404, hands
 * the press a document whose plugin stops half way: the turns the press was meant to protect are
 * already gone by then. So the check reads the chunks too, at the address the next document asks.
 */

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const verdict = (body) => {
  try {
    return JSON.parse(body).status
  } catch {
    return 'unparseable'
  }
}
const reason = (body) => {
  try {
    return JSON.parse(body).reason
  } catch {
    return 'unparseable'
  }
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writableEnded = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body += body ?? ''
    res.writableEnded = true
  }
  return res
}

function mount(config, extra = {}) {
  const routes = new Map()
  const handlers = {}
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? {
            collectIndexInjections: () => [],
            register: (route) => {
              routes.set(route.path, route.handler)
              return () => routes.delete(route.path)
            },
          }
        : key === 'hmr'
          ? {
              baseDir: '/tmp/unlag-chunk-profile',
              runExclusive: async (op) => op(),
              reconcileProfile: async () => ({ warnings: [], pending: [] }),
            }
          : key === 'loader'
            ? { entries: () => [{ options: { id: 'dsh-sibling' }, fiber: { state: 2 } }] }
            : key === 'clientModules'
              ? extra.clientModules
              : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handlers.dispose = fn
    },
  }
  apply(ctx, config)
  return { routes, handlers }
}

async function postJson(route, document) {
  const res = fakeRes()
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { 'x-dsh-unlag': '1' },
    on: (event, fn) => {
      ;(listeners[event] ??= []).push(fn)
    },
    destroy: () => {},
  }
  setImmediate(() => {
    for (const fn of listeners.data ?? []) fn(Buffer.from(document))
    for (const fn of listeners.end ?? []) fn()
  })
  await route(req, res)
  return res
}

const bootJson = (urls, rev = 'old') => JSON.stringify({ boot: { rev, entries: urls.length, batches: urls.map((url) => ({ url })) } })

async function settledBoot(routes) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const res = fakeRes()
    routes.get('/dsh-unlag/state')({ method: 'GET' }, res)
    const body = JSON.parse(res.body)
    if (body.bootSnapshot !== undefined && body.bootSnapshot !== null && body.bootSnapshot.pending !== true) return body.bootSnapshot
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return null
}

const urlA = '/plugins/??@local/a/client.js&rev=old'
const urlB = '/plugins/??@local/b/client.js&rev=old'
const bodyOf = (id, chunk) =>
  `window.__ModuleLoader__.load({ id: "@local/${id}", factory() {} });${chunk === null ? '' : ` require.async("./${chunk}")`}`
const served = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })

/** One app whose chunk answers are switched per test, and whose graph moves with them. */
function app(state) {
  const graph = {
    rev: 'old',
    entries: [
      { id: '@local/a', rev: 'old', url: urlA },
      { id: '@local/b', rev: 'old', url: urlB },
    ],
    batches: [
      { url: urlA, entries: ['@local/a'], rev: 'old' },
      { url: urlB, entries: ['@local/b'], rev: 'old' },
    ],
  }
  return mount(
    {},
    {
      clientModules: {
        graph: () => graph,
        fetchBundle: async (request) => {
          const url = String(request?.url ?? request)
          // A chunk is a real path with a real query: its own entry's revision and nowhere else.
          if (url.includes('client.lazy.js') || url.includes('client.moved.js')) {
            const [owner] = url.match(/@local\/[a-z]+/u) ?? []
            return state.chunks[owner] === true && url.includes(state.chunkUrl(owner)) ? served('/* chunk */') : new Response('', { status: 404 })
          }
          if (url.includes(urlA)) return served(state.bodyA)
          if (url.includes(urlB)) return served(state.bodyB)
          return new Response('', { status: 404 })
        },
      },
    },
  )
}

// --- an old main script whose chunk is gone holds the press before it can navigate ------------
let state = null
state = {
  bodyA: bodyOf('a', 'client.lazy.js'),
  bodyB: bodyOf('b', null),
  chunks: { '@local/a': false },
  chunkUrl: (owner) => `/plugins/${owner}/client.lazy.js?rev=old`,
}
const gone = app(state)
await postJson(gone.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(gone.routes)
const goneRes = await postJson(gone.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('a chunk the old copy asks for that answers 404 holds the press', verdict(goneRes.body) === 'blocked', goneRes.body)
check('and the reason names the chunk instead of the boot', reason(goneRes.body) === 'boot' && goneRes.body.includes('client.lazy.js'), goneRes.body)

// --- an unchanged plugin next to an updated one is not held back ------------------------------
// Only B moved: the press boots a document whose A is byte for byte the page's own copy and whose
// chunks still answer. Nothing about A may be read as a conflict just because B changed.
state = {
  bodyA: bodyOf('a', 'client.lazy.js'),
  bodyB: bodyOf('b', null),
  chunks: { '@local/a': true },
  chunkUrl: (owner) => `/plugins/${owner}/client.lazy.js?rev=old`,
}
const sideBySide = app(state)
await postJson(sideBySide.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(sideBySide.routes)
const allowed = await postJson(sideBySide.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('a plugin that did not change next to one that did is approved', verdict(allowed.body) === 'ok', allowed.body)
{
  // The answer must say which later files the check read, not only that it approved: the client
  // rebuild and the next press use that list, and a row that silently drops it is judged incomplete.
  const answer = JSON.parse(allowed.body)
  const rowA = (answer.scripts ?? []).find((script) => String(script.url).includes('@local/a'))
  check('an approved row carries the later files the page will ask for', Array.isArray(rowA?.lazy) && rowA.lazy.includes('client.lazy.js'), JSON.stringify(rowA))
}

// --- a renamed chunk of a body that also changed is still held --------------------------------
// The main body changed and the chunk it used to ask for no longer answers: the newer generation is
// not the one this page's copy asks for, and the press would boot a document whose later file 404s.
state = {
  bodyA: bodyOf('a', 'client.lazy.js'),
  bodyB: bodyOf('b', null),
  chunks: { '@local/a': true },
  chunkUrl: (owner) => `/plugins/${owner}/client.moved.js?rev=old`,
}
const renamed = app(state)
await postJson(renamed.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(renamed.routes)
const renamedRes = await postJson(renamed.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('a body whose chunk stopped answering is held', verdict(renamedRes.body) === 'blocked', renamedRes.body)

// --- a byte-identical main script is no exemption for its later files --------------------------
// The page that reports this row booted exactly these bytes, so the main script and its chunk list
// are the same ones. The chunk still answers only under a newer revision, which the running page
// never asks for: approving on "the main digest did not move" would hand it a document whose later
// file 404s.
state = {
  bodyA: bodyOf('a', 'client.lazy.js'),
  bodyB: bodyOf('b', null),
  chunks: { '@local/a': true },
  chunkUrl: (owner) => `/plugins/${owner}/client.lazy.js?rev=new`,
}
const sameMain = app(state)
await postJson(sameMain.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(sameMain.routes)
const sameRes = await postJson(sameMain.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('an unchanged main script whose chunk moved revisions is held', verdict(sameRes.body) === 'blocked', sameRes.body)
check('and the refusal names the file that answers at the wrong revision', reason(sameRes.body) === 'boot' && sameRes.body.includes('client.lazy.js'), sameRes.body)

// --- a chunk that moved with its plugin is answered where the next page asks it ----------------
// The app is one release ahead: the table serves revision `new`, and the file the page's old copy
// asks for is still there under the same name at that revision. The route answers that address, so a
// rebuilt document gets its later file instead of ending the app on a 404. Only a file the release
// no longer has stays a refusal.
function movedApp(chunkAnswers) {
  const graphNew = {
    rev: 'new',
    entries: [
      { id: '@local/a', rev: 'new', url: urlA },
      { id: '@local/b', rev: 'new', url: urlB },
    ],
    batches: [
      { url: urlA, entries: ['@local/a'], rev: 'new' },
      { url: urlB, entries: ['@local/b'], rev: 'new' },
    ],
  }
  return mount(
    {},
    {
      clientModules: {
        graph: () => graphNew,
        fetchBundle: async (request) => {
          const url = String(request?.url ?? request)
          if (url.includes('client.lazy.js')) {
            return chunkAnswers === true && url.includes('/plugins/@local/a/client.lazy.js?rev=new') ? served('/* chunk */') : new Response('', { status: 404 })
          }
          if (url.includes('&rev=new')) return served(url.includes('@local/a') ? bodyOf('a', 'client.lazy.js') : bodyOf('b', null))
          return new Response('', { status: 404 })
        },
      },
    },
  )
}
const moved = movedApp(true)
await postJson(moved.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(moved.routes)
const movedRes = await postJson(moved.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('a chunk the release still has is approved at the revision it answers', verdict(movedRes.body) === 'ok', movedRes.body)
{
  const answer = JSON.parse(movedRes.body)
  const rowA = (answer.scripts ?? []).find((script) => String(script.url).includes('@local/a'))
  check('and the approved row still names the later file', Array.isArray(rowA?.lazy) && rowA.lazy.includes('client.lazy.js'), JSON.stringify(rowA))
}

const lost = movedApp(false)
await postJson(lost.routes.get('/dsh-unlag/boot'), bootJson([urlA, urlB], 'old'))
await settledBoot(lost.routes)
const lostRes = await postJson(lost.routes.get('/dsh-unlag/verify'), JSON.stringify({ rows: [urlA, urlB] }))
check('a chunk the release no longer has still holds the press', verdict(lostRes.body) === 'blocked', lostRes.body)
check('and that refusal keeps naming the file', reason(lostRes.body) === 'boot' && lostRes.body.includes('client.lazy.js'), lostRes.body)

console.log(out.join('\n'))
