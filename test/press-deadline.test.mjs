// A press is a chain of answers, and a chain can outlast the person who pressed it. Two bounds are
// checked here: the page's own (a press that hears nothing ends with one sentence about the page it
// still has, and never navigates afterwards), and the host's (a press the page never reports is
// written down by the host, so the log cannot end at "plugins reloaded" and say nothing more).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { harness } from './support/press-harness.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-deadline-'))
const LOG = join(HOME, 'deadline.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
process.env.DSH_UNLAG_ANSWER_MS = '40'
process.env.DSH_UNLAG_PRESS_RECORD_MS = '60'
process.env.DSH_UNLAG_LOG_MAX_BYTES = '1000000'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '')

// --- the page: a press that never hears back still answers, once, and never navigates -----------
{
  const page = harness()
  // The app takes the press and then says nothing: the fetch it waits on is held open.
  page.holdReload()
  const running = page.press()
  const deadline = page.scheduled.find((entry) => entry.ms === 45000) // ui-copy-ignore
  check('a press arms a bound for itself', deadline !== undefined, JSON.stringify(page.scheduled.map((entry) => entry.ms)))
  deadline?.fn()
  check('a press that heard nothing says the page did not change', /No answer in time/u.test(String(page.notice())), String(page.notice()))
  check('a press that heard nothing hands the button back', page.render().button.props.style.opacity === 0.75, String(page.render().button.props.style.opacity))
  await running
  check('and once it does hear back it does not rebuild the page anyway', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('and it left no pacing stamp behind', page.stamp() === 0, String(page.stamp()))
  check(
    'and the press is written down as stalled',
    page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('event=stalled')),
    JSON.stringify(page.requests.map((request) => request.path.slice(0, 60))),
  )
}

// --- the page: a press that answered in time is not touched by its own bound -------------------
{
  const page = harness()
  await page.press()
  const deadline = page.scheduled.find((entry) => entry.ms === 45000) // ui-copy-ignore
  deadline?.fn()
  const stalled = page.requests.filter((request) => request.path.includes('event=stalled'))
  check('a bound that fires after the press answered says nothing', stalled.length === 0, String(stalled.length))
  check('and does not replace the notice with a failure', page.notice() === null, String(page.notice()))
  check('and the page still navigated once', page.navigations.length === 1, String(page.navigations.length))
}

// --- the page: an address that serves no page is not walked into -------------------------------
{
  const page = harness({ documentAnswers: false })
  await page.press()
  check('a rebuild into a page that is not there leaves the page on screen', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('and says the new page did not come up', /new page did not come up/u.test(String(page.notice())), String(page.notice()))
  check('and hands the button back', page.render().button.props.style.opacity === 0.75, String(page.render().button.props.style.opacity))
  check(
    'and writes the refusal down',
    page.requests.some(
      // A press that already replaced plugins reports this refusal under the applied gate.
      (request) => request.path.includes('event=held') && request.path.includes('document'),
    ),
    JSON.stringify(page.requests.map((request) => request.path.slice(0, 60))),
  )
}

// --- the page: a press says it is working before it has an answer -------------------------------
{
  const page = harness()
  page.holdReload()
  const running = page.press()
  check('a press says what it is doing while it waits', /Refreshing/u.test(String(page.notice())), String(page.notice()))
  page.release()
  await running
  // The document is on its way, so the progress line goes with it: nothing is left claiming work.
  check('and replaces those words with the outcome', page.notice() === null, String(page.notice()))
}

// --- the host: a press the page never reports is written down by the host ----------------------
function mount() {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') {
        return { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      }
      if (key === 'loader') return { entries: () => [{ options: { id: '@local/a' }, fiber: { state: 2 } }] }
      if (key === 'clientModules') {
        return {
          graph: () => ({ entries: [{ id: '@local/a', rev: 'old' }] }),
          fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }),
        }
      }
      if (key === 'hmr') return { baseDir: join(HOME, 'profile'), runExclusive: async (work) => work(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
}
async function askJson(routes, path, { method = 'GET' } = {}) {
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  const route = routes.get(path.split('?')[0])
  await route({ method, url: path, headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:62888', origin: 'http://127.0.0.1:62888' } }, res)
  return { status: res.status, body: JSON.parse(res.body === '' ? '{}' : res.body) }
}
{
  writeFileSync(LOG, '')
  const routes = mount()
  await askJson(routes, '/dsh-unlag/reload', { method: 'POST' })
  check('the host answered the press', lines().some((line) => /manual reload/u.test(line)), lines().slice(-3).join(' | '))
  // The next call is what settles the record: a document that went away has no way to be asked.
  await settle()
  await askJson(routes, '/dsh-unlag/reload', { method: 'POST' })
  check(
    'a press the page never reported is written down by the host',
    lines().some((line) => /never said what it did/u.test(line)),
    lines().slice(-3).join(' | '),
  )
}
{
  writeFileSync(LOG, '')
  const routes = mount()
  // The page reports at once: the press was answered where a person reads it, so no second line.
  await askJson(routes, '/dsh-unlag/reload', { method: 'POST' })
  await askJson(routes, '/dsh-unlag/report?event=navigating', { method: 'POST' })
  await settle()
  await askJson(routes, '/dsh-unlag/reload', { method: 'POST' })
  check(
    'a press the page did report is left to the page',
    lines().some((line) => /the page is going for a fresh document/u.test(line)) &&
      !lines().some((line) => /never said what it did/u.test(line)),
    lines().slice(-4).join(' | '),
  )
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
