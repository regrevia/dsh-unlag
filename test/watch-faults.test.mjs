// Automatic reloading is an extra; the press is the feature. A watch that cannot be set up must
// leave the plugin loaded and the button working, and a service event that arrives mid-watch must
// not throw back into the app that dispatched it.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { apply } from '../index.js'

const logPath = join(tmpdir(), 'unlag-watch.log')
rmSync(logPath, { force: true })
writeFileSync(logPath, '')
process.env.DSH_UNLAG_LOG = logPath

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const lines = () => readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '')

function fakeRes() {
  const res = { status: 0, headers: null, body: '', writableEnded: false }
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

/** Mount the plugin with an hmr service whose watching cannot start. */
function mount({ baseDirThrows = false, roots = [] } = {}) {
  const routes = new Map()
  const listeners = []
  const hmr = {
    runExclusive: async (op) => op(),
    reconcileProfile: async () => ({ warnings: [], pending: [] }),
  }
  // The controller reads the profile directory before it installs a watch; a read that throws is
  // the one fault the per-root try/catch inside startWatching does not cover.
  Object.defineProperty(hmr, 'baseDir', {
    get() {
      if (baseDirThrows) throw new Error('the profile directory went away')
      return '/tmp/unlag-watch-profile'
    },
  })
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
          ? hmr
          : undefined,
    on: (event, fn) => {
      if (event === 'internal/service') listeners.push(fn)
      if (event === 'dispose') ctx.dispose = fn
    },
  }
  apply(ctx, { autoReload: true, roots })
  const dispatch = (service) => {
    for (const fn of listeners) fn(service)
  }
  return { routes, dispatch }
}

// --- a watch that throws leaves the press working ---------------------------------------
const broke = mount({ baseDirThrows: true })
check('six routes are still registered', broke.routes.size === 6, String(broke.routes.size))
check('the reason is one line', lines().some((line) => line.includes('cannot watch for saved plugin changes: the profile directory went away')), JSON.stringify(lines().slice(-4)))
check('and it says the press still works', lines().some((line) => line.includes('a press still works')))
const state = fakeRes()
broke.routes.get('/dsh-unlag/state')({ method: 'GET' }, state)
check('the button can still read its switches', state.status === 200 && JSON.parse(state.body).plugins === true, state.body)
const press = fakeRes()
await broke.routes.get('/dsh-unlag/reload')({ method: 'POST', url: '/dsh-unlag/reload', headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:52847' } }, press)
check('the button can still apply a change', press.status === 200 && press.body.includes('"status"'), `${press.status} ${press.body}`)

// --- a failing service event does not escape -------------------------------------------
let thrown = null
try {
  broke.dispatch('hmr')
} catch (error) {
  thrown = error
}
check('a watch that fails on a service event does not throw', thrown === null, String(thrown))
check('the second attempt is recorded too', lines().filter((line) => line.includes('cannot watch for saved plugin changes')).length === 2, String(lines().filter((line) => line.includes('cannot watch for saved plugin changes')).length))

// A service name that is not a string would have been concatenated raw into a log line.
let odd = null
try {
  broke.dispatch({ toString: () => 'x\nsecond line' })
} catch (error) {
  odd = error
}
check('a service event with an odd name does not throw', odd === null, String(odd))
check('and its name is kept on one line', lines().every((line) => !line.includes('second line')), JSON.stringify(lines().slice(-2)))

// --- a watch that works is installed once ----------------------------------------------
const fine = mount({ roots: [join(tmpdir(), 'unlag-watch-root')] })
fine.dispatch('hmr')
fine.dispatch('hmr')
check('a watch that can start is installed once', lines().filter((line) => line.includes('watching ')).length === 1, String(lines().filter((line) => line.includes('watching ')).length))
check('the working case says what is watched', lines().some((line) => line.includes('auto reload is on')), JSON.stringify(lines().slice(-3)))
if (typeof fine.dispose === 'function') fine.dispose()

console.log(out.join('\n'))
// A real watcher holds file handles; the run is done once every line is printed.
process.exit(process.exitCode ?? 0)
