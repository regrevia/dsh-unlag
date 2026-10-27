// The switches route is what the button's menu writes and what a press reads. It lives in the
// app's own home directory, so this run gives it a home of its own and never writes the real one.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-unlag-switches-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'reload.log')
const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const SWITCH_FILE = join(HOME, '.dsh', 'unlag-switches.json')
const HEADERS = { 'x-dsh-unlag': '1' }

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

const body = (res) => {
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}

function mount(config) {
  const routes = new Map()
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
          ? { baseDir: '/tmp/unlag-probe-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
          : undefined,
    on: () => {},
  }
  apply(ctx, config)
  return routes
}

// The route reads a body through the stream events, the same way the real server hands it over.
const request = (path, { method = 'POST', headers = HEADERS, payload } = {}) => {
  let dataListener = null
  return {
    method,
    url: path,
    headers,
    on(event, fn) {
      if (event === 'data') dataListener = fn
      if (event === 'end') {
        setImmediate(() => {
          if (payload !== undefined) dataListener?.(Buffer.from(payload))
          fn()
        })
      }
      return this
    },
    destroy() {},
  }
}

const state = async (routes) => {
  const res = fakeRes()
  routes.get('/dsh-unlag/state')({ method: 'GET', headers: {} }, res)
  return body(res)
}

// --- a write is kept and the next press reads it ------------------------------------------------
{
  const routes = mount({})
  const write = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: false, page: true }) }), write)
  const answer = body(write)
  check('the write is accepted', answer?.status === 'done' && answer.plugins === false && answer.page === true, write.body)
  check('the write says it was kept', answer?.saved === true, write.body)
  const saved = JSON.parse(readFileSync(SWITCH_FILE, 'utf8'))
  check('the file holds both switches', saved.plugins === false && saved.page === true, JSON.stringify(saved))
  check('and the settings row it was made against', /^[0-9a-f]{16}$/u.test(String(saved.fingerprint ?? '')), String(saved.fingerprint))
  const now = await state(routes)
  check('the state route reports the saved switches', now?.plugins === false && now?.page === true && now?.saved === true, JSON.stringify(now))
}

// --- a refused write changes nothing -----------------------------------------------------------
{
  const routes = mount({})
  const before = await state(routes)
  const write = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: '{not json' }), write)
  check('a write that is not a body is refused', write.status === 400, `${write.status} ${write.body}`)
  const after = await state(routes)
  check('and the switches are unchanged', before.plugins === after.plugins && before.page === after.page)
}

// --- the route is not a read, and not open to another site -------------------------------------
{
  const routes = mount({})
  const read = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { method: 'GET' }), read)
  check('a read is told the method is wrong', read.status === 405, `${read.status}`)
  const foreign = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { headers: { 'x-dsh-unlag': '1', host: 'evil.example:54601', origin: 'http://evil.example:54601' }, payload: JSON.stringify({ plugins: true, page: true }) }), foreign)
  check('another site is refused', foreign.status === 403, `${foreign.status}`)
  const noHeader = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { headers: {}, payload: JSON.stringify({ plugins: true, page: true }) }), noHeader)
  check('a write without the page header is refused', noHeader.status === 403, `${noHeader.status}`)
}

// --- a newer settings row wins over an older saved choice --------------------------------------
{
  const routes = mount({ reloadPlugins: true, reloadInterface: true })
  const write = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: false, page: false }) }), write)
  check('the choice is saved first', (await state(routes)).plugins === false)
  // Editing the settings row restarts the plugin with different config. The saved choice was made
  // against the old row, so it must not silently override the person's newer decision.
  const later = mount({ reloadPlugins: true, reloadInterface: false })
  const after = await state(later)
  check('a settings row that changed wins', after?.plugins === true && after?.page === false, JSON.stringify(after))
  check('and the stale choice is not reported as saved', after?.saved === false, JSON.stringify(after))
}

// --- the automatic row is not one of the two press switches ------------------------------------
{
  const routes = mount({ autoReload: true, reloadPlugins: true, reloadInterface: true })
  const write = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: false, page: true, autoReload: false }) }), write)
  const answer = body(write)
  check('the write cannot change automatic reloading', answer?.plugins === false && answer?.page === true, write.body)
  const now = await state(routes)
  check('and the state keeps the automatic row out of its answer', now?.autoReload === undefined, JSON.stringify(now))
}

// --- the agent switch is optional in the write and named in every answer ----------------------
{
  const routes = mount({})
  const fresh = await state(routes)
  check('the state names the agent switch as off by default', fresh?.agentRefresh === false, JSON.stringify(fresh))
  // An older page writes only the two press switches. That write must still be accepted, and the
  // agent switch keeps the value the settings row gave it.
  const older = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: true, page: true }) }), older)
  check('a write without the agent switch is still accepted', body(older)?.status === 'done' && body(older)?.agentRefresh === false, older.body)
  const on = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: true, page: true, agentRefresh: true }) }), on)
  check('the agent switch can be turned on', body(on)?.agentRefresh === true, on.body)
  check('and the file keeps it', JSON.parse(readFileSync(SWITCH_FILE, 'utf8')).agent === true)
  check('and the state reports it on', (await state(routes))?.agentRefresh === true)
  const wrong = fakeRes()
  await routes.get('/dsh-unlag/switches')(request('/dsh-unlag/switches', { payload: JSON.stringify({ plugins: true, page: true, agentRefresh: 'yes' }) }), wrong)
  check('a value that is not a boolean is refused', wrong.status === 400, `${wrong.status} ${wrong.body}`)
}

// --- a settings file that would never finish being read ------------------------------------------
// The file lives in the app's home, so a pipe (or a device) can be there. Reading it happens on the
// way to an answer and on the way to a page's first paint: a read with no end is the app not
// starting, so a path that is not a small regular file is answered as "nothing saved".
{
  rmSync(SWITCH_FILE, { recursive: true, force: true })
  // POSIX can put a FIFO here and prove the read never blocks. Windows has no FIFO,
  // so the nearest thing that is not a small regular file is a directory; both must
  // be answered as "nothing saved" instead of holding the answer.
  if (process.platform === 'win32') mkdirSync(SWITCH_FILE, { recursive: true })
  else execFileSync('mkfifo', [SWITCH_FILE])
  const routes = mount({})
  const answered = await Promise.race([
    state(routes),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
  check('a settings path that never reads does not hold the answer', answered !== 'timeout', String(answered))
  check('and it answers the settings row instead', answered?.saved === false && typeof answered?.plugins === 'boolean', JSON.stringify(answered))
  rmSync(SWITCH_FILE, { recursive: true, force: true })
}

console.log(out.join('\n'))
if (process.exitCode === 1) console.log('\nFAIL')
else console.log('\nall checks passed')
