// Long-running app: the plugin half is applied and disposed many times over a session, and every
// press lands on whatever instance owns the routes at that moment. What is checked here is the
// property the person pressing depends on: the routes always belong to exactly one instance, a
// stale dispose cannot take the live ones down, and answering under load does not leave a route
// without a reply.
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

// Keep the live log readable: this run writes its own.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-stress.log')

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

/** One apply on a server stand-in that tracks what the instance leaves behind. */
function mount() {
  const routes = new Map()
  const live = new Set()
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? {
            collectIndexInjections: () => [],
            register: (route) => {
              routes.set(route.path, route.handler)
              live.add(route.path)
              return () => {
                live.delete(route.path)
                // A stale dispose must not remove a path the newer instance re-registered, so the
                // map is only cleared when the path still belongs to this instance.
                if (routes.get(route.path) === route.handler) routes.delete(route.path)
              }
            },
          }
        : key === 'hmr'
          ? { baseDir: '/tmp/unlag-stress-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
          : undefined,
    on: (event, fn) => {
      if (event === 'dispose') ctx.dispose = fn
    },
  }
  apply(ctx, {})
  return { routes, live, dispose: () => ctx.dispose?.() }
}

const cycles = []
const atApply = []
for (let index = 0; index < 20; index += 1) {
  const cycle = mount()
  cycles.push(cycle)
  // Read in the same step the instance registered them: a later apply is expected to take the
  // previous instance's routes down, so the count is only meaningful right after this apply.
  const res = fakeRes()
  cycle.routes.get('/dsh-unlag/state')({ method: 'GET' }, res)
  atApply.push(`${cycle.routes.size}/${res.status}`)
}
check('every apply leaves five routes and answers a state request', atApply.every((entry) => entry === '5/200'), atApply.join(','))
check('only the newest instance owns routes after twenty applies', cycles[cycles.length - 1].routes.size === 5 && cycles.slice(0, -1).every((cycle) => cycle.routes.size === 0), cycles.map((cycle) => cycle.routes.size).join(','))

// The app can dispose an instance it replaced minutes ago; the newest one must keep serving.
const newest = cycles[cycles.length - 1]
for (const cycle of cycles.slice(0, -1)) cycle.dispose()
check('a stale dispose leaves the live routes alone', newest.routes.size === 5, String(newest.routes.size))
const afterStale = fakeRes()
newest.routes.get('/dsh-unlag/state')({ method: 'GET' }, afterStale)
check('and the live instance still answers', afterStale.status === 200, String(afterStale.status))

// A press and the page's reads can overlap; every answer must settle, none may throw.
const answers = await Promise.allSettled(
  Array.from({ length: 120 }, (_unused, index) => {
    const res = fakeRes()
    const route = index % 3 === 0 ? '/dsh-unlag/graph' : '/dsh-unlag/state'
    return Promise.resolve(newest.routes.get(route)({ method: 'GET' }, res)).then(() => res)
  }),
)
const settled = answers.filter((answer) => answer.status === 'fulfilled').map((answer) => answer.value)
check('overlapping reads all settle', settled.length === 120, String(settled.length))
check('every overlapping read answers 200', settled.every((res) => res.status === 200), settled.filter((res) => res.status !== 200).length + ' did not')

newest.dispose()
check('the last dispose takes the routes down', newest.routes.size === 0, String(newest.routes.size))

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
