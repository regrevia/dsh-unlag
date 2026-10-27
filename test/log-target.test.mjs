import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, name, inject } from '../index.js'

/**
 * The log is the error path. A target that is a pipe, a symlink to a pipe, or a directory is a
 * misconfiguration, and the line about it must not be the reason the press never answers: the call
 * that writes it returns the same way whether or not the file can take it.
 */

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
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

function mount(extra = {}) {
  const routes = new Map()
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => (routes.set(route.path, route.handler), () => routes.delete(route.path)) }
        : key === 'hmr'
          ? { baseDir: '/tmp/unlag-log-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
          : key === 'loader'
            ? { entries: () => [{ options: { id: 'dsh-sibling' }, fiber: { state: 2 } }] }
            : key === 'clientModules'
              ? extra.clientModules
              : undefined,
    on: () => {},
  }
  apply(ctx, Config)
  return routes
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

const bootDocument = JSON.stringify({ boot: { rev: 'live', entries: 1, batches: [{ url: '/plugins/??@local/a/client.js&rev=live' }] } })

/** Answer the boot report, or say it did not answer inside the bound a person waits. */
async function answers(routes) {
  return Promise.race([
    postJson(routes.get('/dsh-unlag/boot'), bootDocument),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-unlag-log-'))
const routes = mount({
  clientModules: {
    graph: () => ({ rev: 'live', entries: [], batches: [] }),
    fetchBundle: async () => new Response('', { status: 404 }),
  },
})

// --- a pipe nobody reads: the press still answers, now and on the next call --------------------
const fifo = join(dir, 'fifo.log')
execFileSync('mkfifo', [fifo])
process.env.DSH_UNLAG_LOG = fifo
const first = await answers(routes)
check('a log that is a pipe does not hold the answer', first !== 'timeout' && first.status === 200, first === 'timeout' ? 'timeout' : `${first.status} ${first.body}`)
const second = await answers(routes)
check('and the next line does not wait either', second !== 'timeout' && second.status === 200, second === 'timeout' ? 'timeout' : `${second.status}`)

// --- a symlink to that pipe: the type must be read from the open file, not the path -------------
const link = join(dir, 'link.log')
symlinkSync(fifo, link)
process.env.DSH_UNLAG_LOG = link
const throughLink = await answers(routes)
check('a log behind a symlink to a pipe does not hold the answer', throughLink !== 'timeout' && throughLink.status === 200, throughLink === 'timeout' ? 'timeout' : `${throughLink.status}`)

// --- a directory where the log file belongs: a write that cannot happen is not a wait ----------
process.env.DSH_UNLAG_LOG = join(dir, 'a-directory')
mkdirSync(join(dir, 'a-directory'))
const blocked = await answers(routes)
check('a log that cannot be written is not a wait', blocked !== 'timeout' && blocked.status === 200, blocked === 'timeout' ? 'timeout' : `${blocked.status}`)

// --- a regular file still receives the line, so the fix did not trade evidence for speed -------
const readable = join(dir, 'good.log')
process.env.DSH_UNLAG_LOG = readable
// A target that just failed is left alone for a moment, so the retry is waited out here.
await new Promise((resolve) => setTimeout(resolve, 1100))
await answers(routes)
check('a regular file still receives its line', readFileSync(readable, 'utf8').includes('the page reported the startup list'), readFileSync(readable, 'utf8'))

rmSync(dir, { recursive: true, force: true })
console.log(out.join('\n'))
