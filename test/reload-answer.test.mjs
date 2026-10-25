import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The log is the evidence a press leaves. Two presses that end in "still applying" are not the same
// event: one is slow, the other arrived while an update was already running. A reader of the log
// must be able to tell them apart.
const LOG = join(tmpdir(), 'unlag-reload-answer.log')
rmSync(LOG, { force: true })
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '150'

const { apply } = await import('../index.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

let running = 0
const hmr = {
  baseDir: '/tmp/unlag-reload-answer-profile',
  runExclusive: (fn) => fn(),
  reconcileProfile: async () => {
    running += 1
    await sleep(400)
    running -= 1
    return { warnings: [], pending: [] }
  },
}

const routes = new Map()
const ctx = {
  get: (key) => (key === 'webServer'
    ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
    : key === 'hmr'
      ? hmr
      : key === 'agents'
        ? { list: () => [] }
        : undefined),
  on: () => {},
}
apply(ctx, { reloadPlugins: true, rebuildPage: true })

function fakeRes() {
  const res = { status: 0, body: '', writableEnded: false }
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body += body ?? ''; res.writableEnded = true }
  return res
}
const req = { method: 'POST', headers: { 'x-dsh-unlag': '1' }, url: '/dsh-unlag/reload', destroy: () => {} }

const press = async () => {
  const res = fakeRes()
  await routes.get('/dsh-unlag/reload')(req, res)
  return JSON.parse(res.body)
}

const slow = await press()
check('a slow update answers that it is still applying', slow.status === 'applying', JSON.stringify(slow).slice(0, 80))

// A second press lands while the first update is still running: it must be answered at once, and
// the log must say it arrived during an update rather than that it outlasted the page's wait.
const second = await press()
check('a second press during an update answers immediately', second.status === 'applying', JSON.stringify(second).slice(0, 80))
await sleep(600)

const text = readFileSync(LOG, 'utf8')
check('the slow press is logged as outlasting the page', /the update outlasted the answer the page waits for/u.test(text))
check('the second press is logged as arriving during an update', /a press arrived while an update is already applying/u.test(text), text.split('\n').filter((line) => /applying/u.test(line)).join(' | ').slice(0, 200))
check('the first update finished afterwards and is not lost', running === 0)

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
