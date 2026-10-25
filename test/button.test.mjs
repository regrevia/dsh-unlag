import { Config, apply, name, inject } from '../index.js'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

// --- Config: validation never throws and defaults both switches on -----------------------------
check('name/inject', name === 'dsh-unlag' && Array.isArray(inject.optional))
const v = (value) => Config['~standard'].validate(value)
check('validate {} -> both on', JSON.stringify(v({}).value) === '{"reloadPlugins":true,"reloadInterface":true}')
check('validate omitted -> both on', v(undefined).value.reloadPlugins === true)
check('validate null -> both on', v(null).value.reloadInterface === true)
check('validate false sticks', v({ reloadPlugins: false }).value.reloadPlugins === false)
check('validate keeps foreign keys', v({ roots: ['/x'], reloadInterface: false }).value.roots?.[0] === '/x')
check('validate survives a string config', v('nope').value.reloadPlugins === true)
const json = JSON.parse(JSON.stringify(Config.toJSON()))
check('toJSON is a plain document', json.refs?.[6]?.dict?.reloadPlugins === 2)
check('form nodes are objects', Config.dict.reloadPlugins.type === 'boolean' && Config.dict.reloadPlugins.meta.default === true)

// --- routes: registered, answer, and honour the switches --------------------------------------
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

function mount(config) {
  const routes = new Map()
  const disposed = []
  const handlers = {}
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? {
            register: (route) => {
              routes.set(route.path, route.handler)
              const dispose = () => routes.delete(route.path)
              disposed.push(dispose)
              return dispose
            },
          }
        : key === 'hmr'
          ? {
              baseDir: '/tmp/unlag-probe-profile',
              runExclusive: async (op) => op(),
              reconcileProfile: async () => {
                handlers.reloads = (handlers.reloads ?? 0) + 1
                return { warnings: [], pending: [] }
              },
            }
          : undefined,
    on: (event, fn) => {
      if (event === 'dispose') handlers.dispose = fn
    },
  }
  apply(ctx, config)
  return { routes, disposed, handlers }
}

const both = mount({})
check('two routes registered', both.routes.size === 2, [...both.routes.keys()].join(','))

const stateRes = fakeRes()
both.routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
check('state GET 200', stateRes.status === 200)
check('state says both on', stateRes.body === '{"plugins":true,"page":true}', stateRes.body)

const viaGet = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'GET', headers: {} }, viaGet)
check('reload rejects GET', viaGet.status === 405)

const noHeader = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: {} }, noHeader)
check('reload rejects a cross-site post', noHeader.status === 403)

const ok = fakeRes()
await both.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, ok)
check('reload runs and reports done', ok.body === '{"status":"done"}', ok.body)
check('the hmr service really ran', both.handlers.reloads === 1, String(both.handlers.reloads))

// --- switches --------------------------------------------------------------------------------
const onlyPage = mount({ reloadPlugins: false })
const offRes = fakeRes()
await onlyPage.routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, offRes)
check('switch off -> host does not reload', offRes.body === '{"status":"off"}' && onlyPage.handlers.reloads === undefined)
const onlyPageState = fakeRes()
onlyPage.routes.get('/dsh-unlag/state')({}, onlyPageState)
check('switch off is announced', onlyPageState.body === '{"plugins":false,"page":true}', onlyPageState.body)

const onlyPlugins = mount({ reloadInterface: false })
const onlyPluginsState = fakeRes()
onlyPlugins.routes.get('/dsh-unlag/state')({}, onlyPluginsState)
check('page off is announced', onlyPluginsState.body === '{"plugins":true,"page":false}', onlyPluginsState.body)

// --- a turn in progress ----------------------------------------------------------------------
const busyMount = (() => {
  const routes = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'webServer') return { register: (r) => (routes.set(r.path, r.handler), () => routes.delete(r.path)) }
      if (key === 'hmr')
        return { baseDir: '/tmp/x', runExclusive: async (op) => op(), reconcileProfile: async () => { throw new Error('must not run') } }
      if (key === 'agents') return { list: () => [{ status: 'working' }] }
      return undefined
    },
    on: () => {},
  }
  apply(ctx, {})
  return routes
})()
const busyRes = fakeRes()
await busyMount.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, busyRes)
check('a running turn is reported, not replaced', busyRes.body === '{"status":"busy"}', busyRes.body)

// --- hostile surroundings --------------------------------------------------------------------
let survived = true
try {
  const ctx = { get: () => undefined, on: () => {} }
  apply(ctx, {})
} catch {
  survived = false
}
check('no web server and no hmr is not fatal', survived)

// --- replacing the module twice must not stack routes ----------------------------------------
const first = mount({})
const second = mount({})
check('remount leaves one route set', first.routes.size === 0 && second.routes.size === 2, `${first.routes.size}/${second.routes.size}`)

console.log(out.join('\n'))
console.log(process.exitCode === 1 ? 'FAILURES' : 'ALL PASS')
process.exit(process.exitCode ?? 0)

