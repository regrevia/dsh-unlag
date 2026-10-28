// A report of "there is no refresh button" needs a cause that can be checked, not just a line in a
// log file nobody can read on that machine. `/state` answers with the same reading the log is written
// from: whether this entry is in the set the app hands the page, how many rows that set has, and
// whether the reading itself failed.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-served-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'served.log')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const fakeRes = () => ({
  status: 0,
  body: '',
  writableEnded: false,
  writeHead(status) {
    this.status = status
  },
  end(body) {
    this.body += body ?? ''
    this.writableEnded = true
  },
})

const req = () => ({ method: 'GET', headers: { 'x-dsh-unlag': '1' }, url: '/' })

// `graph` is replaced per case: the set the app serves can be present, missing this entry, empty, or
// unreadable, and each has a different cause behind "no button".
const mount = (graph) => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') {
        return {
          collectIndexInjections: () => [],
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      if (key === 'loader') return { entries: () => [] }
      if (key === 'clientModules') return { graph, fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }) }
      return undefined
    },
    on: () => {},
  }
  return { routes, ctx }
}

const stateOf = async (routes) => {
  const res = fakeRes()
  await routes.get('/dsh-unlag/state')(req(), res)
  return JSON.parse(res.body)
}

const { apply } = await import('../index.js')

const served = mount(() => ({ rev: 'live', entries: [{ id: 'dsh-unlag', rev: 'live' }] }))
apply(served.ctx, {})
const yes = await stateOf(served.routes)
check('a served entry answers as served', yes.served?.status === 'served', JSON.stringify(yes.served))
check('and the set size is on the answer', yes.served?.entries === 1, JSON.stringify(yes.served))
check('the id it checked is named, so a report can quote it', yes.served?.id === 'dsh-unlag', JSON.stringify(yes.served))

const missing = mount(() => ({ rev: 'live', entries: [{ id: 'other-plugin', rev: 'live' }, { id: 'dsh-unlag2', rev: 'live' }] }))
apply(missing.ctx, {})
const no = await stateOf(missing.routes)
check('an entry the set left out answers as missing', no.served?.status === 'missing', JSON.stringify(no.served))
check('with the size of the set it was missing from', no.served?.entries === 2, JSON.stringify(no.served))

const second = await stateOf(missing.routes)
check('asking again answers the same way', second.served?.status === 'missing', JSON.stringify(second.served))
const log = existsSync(process.env.DSH_UNLAG_LOG) ? readFileSync(process.env.DSH_UNLAG_LOG, 'utf8') : ''
const said = (log.match(/out of the plugin set it serves now/gu) ?? []).length
check('the cause reaches the log once, however often the page asks', said === 1, `said=${said}`)

const empty = mount(() => ({ rev: 'live', entries: [] }))
apply(empty.ctx, {})
const blank = await stateOf(empty.routes)
check('an empty set is unreadable rather than a missing entry', blank.served?.status === 'unknown' && blank.served?.entries === 0, JSON.stringify(blank.served))

const broken = mount(() => {
  throw new Error('graph is not ready')
})
apply(broken.ctx, {})
const failed = await stateOf(broken.routes)
check('a reading that throws is unknown, not missing', failed.served?.status === 'unknown', JSON.stringify(failed.served))
check('and the reason travels with it', String(failed.served?.error ?? '').includes('graph is not ready'), JSON.stringify(failed.served))
check('the route still answers 200', failed.version !== undefined, String(failed.version))

console.log(out.join('\n'))
