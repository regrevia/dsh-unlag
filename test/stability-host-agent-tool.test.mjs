// Start-up must finish even when one step cannot. Cordis refuses a plain property read of a
// service this plugin did not declare ("cannot get property \"tools\" without inject"), and v1.11.0
// let exactly that refusal end apply() half-way: no dispose hook, no instance, no bundle shim, no
// tool. This file mounts the plugin on a context that behaves like that and checks, for each
// failing step, that everything else still got installed.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-tool-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'tool.log')

const { apply } = await import('../index.js')

const K = (name) => Symbol.for(`dsh-unlag.${name}`)
const out = []
const rejections = []
process.on('unhandledRejection', (error) => rejections.push(error))
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const logged = () => {
  try {
    return readFileSync(join(HOME, 'tool.log'), 'utf8')
  } catch {
    return ''
  }
}

/** The tools a host would offer: register() returns the undo a real Cordis effect would keep. */
function fakeTools() {
  const registered = new Map()
  let registers = 0
  return {
    registered,
    registers: () => registers, // ui-copy-ignore
    service: {
      register: (definition) => {
        registers += 1
        registered.set(definition.name, definition) // ui-copy-ignore
        return () => registered.delete(definition.name) // ui-copy-ignore
      },
    },
  }
}

/**
 * A context with the one behaviour that matters here: reading a service this plugin did not
 * inject throws, exactly as the shipped Cordis context does. inject() runs the callback once the
 * dependency is present, and can be replayed the way a re-registered service replays it.
 */
function mount({ services = {}, config = {}, throwOn = {}, injectRejects = false, strictProps = false } = {}) {
  const routes = new Map()
  const disposers = []
  const effects = []
  const injectCalls = []
  const injected = new Set()
  const bundleRoute = { handler: async () => ({ kind: 'json', body: { rev: 'r1' } }) }
  const base = {
    webServer: {
      prefixes: { get: () => bundleRoute },
      collectIndexInjections: () => [],
      register: (route) => {
        if (throwOn.register === true) throw new Error('the route registry refused the route')
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    loader: { entries: () => [{ options: { id: '@local/a' }, fiber: { state: 2 } }] },
    hmr: { baseDir: join(HOME, 'profile'), runExclusive: async (work) => work(), reconcileProfile: async () => ({ warnings: [], pending: [] }) },
    clientModules: { graph: () => ({ rev: 'r1', entries: [] }), fetchBundle: async () => null },
    ...services,
  }
  const ctx = {
    get: (name) => {
      if (throwOn.get === name) throw new Error(`the ${name} service could not be read`)
      return base[name]
    },
    on: (event, fn) => {
      if (event === 'dispose') disposers.push(fn)
    },
  }
  const impl = {
    effect: (work, label) => {
      const undo = work()
      const row = { label, undo, disposed: false }
      effects.push(row)
      return () => {
        if (row.disposed === true) return
        row.disposed = true
        if (typeof row.undo === 'function') row.undo()
      }
    },
    inject: (deps, callback) => {
      injectCalls.push({ deps, callback })
      if (injectRejects === true) {
        // A Cordis inject scope is a thenable that rejects when the service it waits on goes away.
        return { then: (_resolve, reject) => reject(new Error('the tools scope went away')) }
      }
      if (deps.every((dep) => base[dep] !== undefined)) {
        for (const dep of deps) injected.add(dep)
        callback(ctx)
      }
      return () => {}
    },
    reflect: { get: () => undefined },
  }
  // A strict context throws on every property this plugin did not declare — including inject,
  // effect and reflect, because `typeof ctx.inject` is itself a read that Cordis refuses.
  for (const name of ['inject', 'effect', 'reflect']) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        if (strictProps === true) throw new Error(`cannot get property "${name}" without inject`)
        return impl[name]
      },
    })
  }
  for (const name of ['webServer', 'hmr', 'loader', 'clientModules', 'tools', 'agents']) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        if (strictProps === true || injected.has(name) === false) throw new Error(`cannot get property "${name}" without inject`)
        return base[name]
      },
    })
  }
  let accessThrew = false
  try {
    void ctx.tools
  } catch {
    accessThrew = true
  }
  let threw = null
  try {
    apply(ctx, config)
  } catch (error) {
    threw = error
  }
  const dispose = () => {
    for (const fn of [...disposers].reverse()) {
      try {
        fn()
      } catch {}
    }
    for (const row of effects.reverse()) {
      if (row.disposed === true) continue
      row.disposed = true
      try {
        if (typeof row.undo === 'function') row.undo()
      } catch {}
    }
  }
  return { ctx, threw, accessThrew, routes, disposers, effects, injectCalls, base, bundleRoute, dispose, replay: () => injectCalls.forEach((call) => call.callback(ctx)) }
}

const CONFIG = { reloadPlugins: true, reloadInterface: true, autoReload: false, agentRefresh: false }

// --- (a) a host with no tools service at all ---------------------------------------------------
{
  const host = mount({ config: CONFIG })
  check('apply does not throw when the host has no tools service', host.threw === null, String(host.threw))
  check('the button routes are mounted', host.routes.has('/dsh-unlag/state') && host.routes.has('/dsh-unlag/reload'), [...host.routes.keys()].length.toString())
  check('the routes slot is recorded for the next copy', globalThis[K('routes')] !== null && globalThis[K('routes')] !== undefined, String(globalThis[K('routes')]))
  check('the instance is recorded even without a tool', globalThis[K('instance')] !== null && globalThis[K('instance')] !== undefined, String(globalThis[K('instance')]))
  check('the bundle shim is installed', globalThis[K('shim')] !== null && globalThis[K('shim')] !== undefined, String(globalThis[K('shim')]))
  check('a dispose hook was registered', host.disposers.length === 1, String(host.disposers.length))
  check('the log says the tool was not offered', /no tools service/.test(logged()), logged().split('\n').filter((line) => /tools/.test(line)).join(' | ').slice(0, 120))
  host.dispose()
  check('dispose clears the instance and the routes', globalThis[K('instance')] === null && globalThis[K('routes')] === null, `${globalThis[K('instance')]}/${globalThis[K('routes')]}`)
}

// --- (b) the host has a tools service: the tool is registered exactly once --------------------
{
  const tools = fakeTools()
  const host = mount({ services: { tools: tools.service }, config: CONFIG })
  check('apply does not throw with a tools service', host.threw === null, String(host.threw))
  check('the tools service is asked for through a dynamic inject scope', host.injectCalls.length === 1 && host.injectCalls[0].deps[0] === 'tools', JSON.stringify(host.injectCalls.map((call) => call.deps)))
  check('the refresh tool is registered once', tools.registered.size === 1 && tools.registers() === 1, `${tools.registered.size}/${tools.registers()}`)
  const tool = tools.registered.get('unlag_refresh')
  check('the tool is named unlag_refresh', tool !== undefined, [...tools.registered.keys()].join(','))
  const blocked = await tool.execute({ requestId: 'agent-1' })
  check('with the agent switch off the tool answers blocked', blocked?.status === 'blocked', JSON.stringify(blocked))
  check('the blocked answer says why and how the page is doing', typeof blocked?.reason === 'string' && blocked.reason.length > 0 && blocked.rebuild === 'unknown', JSON.stringify(blocked))
  // The inject scope replays when the service is registered again; one tool, not two.
  host.replay()
  check('a replayed inject scope does not register a second tool', tools.registered.size === 1 && tools.registers() === 1, `${tools.registered.size}/${tools.registers()}`)
  host.dispose()
  check('dispose takes the tool back', tools.registered.size === 0, [...tools.registered.keys()].join(','))
}

// --- (c) the tools service is missing at first and appears later ------------------------------
{
  const tools = fakeTools()
  const host = mount({ config: CONFIG })
  check('a missing tools service is said in the log', /no tools service/.test(logged()), '')
  host.base.tools = tools.service
  host.replay()
  check('a service that appears later still gets the tool', tools.registered.size === 1, String(tools.registered.size))
  host.dispose()
  check('that tool is taken back on dispose', tools.registered.size === 0, String(tools.registered.size))
}

// --- (d) a property read that throws is not a start-up failure --------------------------------
{
  const tools = fakeTools()
  const host = mount({ services: { tools: tools.service }, config: CONFIG })
  check('reading ctx.tools without inject throws in this fixture', host.accessThrew === true, 'fixture')
  check('the tool is still registered despite that throw', tools.registered.size === 1, String(tools.registered.size))
  host.dispose()
}

// --- (e) any one failing start-up step still leaves the bookkeeping installed ------------------
for (const [what, options] of [
  ['the route registry throws', { throwOn: { register: true } }],
  ['the web server cannot even be read', { throwOn: { get: 'webServer' } }],
]) {
  const host = mount({ ...options, config: CONFIG })
  check(`apply survives when ${what}`, host.threw === null, String(host.threw))
  check(`the instance is recorded when ${what}`, globalThis[K('instance')] !== null && globalThis[K('instance')] !== undefined, String(globalThis[K('instance')]))
  check(`a dispose hook exists when ${what}`, host.disposers.length === 1, String(host.disposers.length))
  host.dispose()
  check(`dispose still clears the instance when ${what}`, globalThis[K('instance')] === null, String(globalThis[K('instance')]))
}

// --- (f) an inject scope that rejects after apply returned is not an unhandled rejection --------
{
  const tools = fakeTools()
  const host = mount({ services: { tools: tools.service }, config: CONFIG, injectRejects: true })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('a rejecting inject scope does not throw out of apply', host.threw === null, String(host.threw))
  check('a rejecting inject scope is said in the log', /cannot offer the refresh tool/.test(logged()), '')
  check('a rejecting inject scope leaves no unhandled rejection', rejections.length === 0, rejections.map((error) => error?.message).join(','))
  check('the instance survives a rejecting inject scope', globalThis[K('instance')] !== null && globalThis[K('instance')] !== undefined, String(globalThis[K('instance')]))
  host.dispose()
  check('dispose still clears the instance after a rejecting inject scope', globalThis[K('instance')] === null, String(globalThis[K('instance')]))
}

// --- (g) a context that throws on every undeclared read, inject and effect included -----------
{
  const logBefore = logged().length
  const host = mount({ config: CONFIG, strictProps: true })
  const said = logged().slice(logBefore)
  check('a context that refuses inject does not end the start-up', host.threw === null, String(host.threw))
  check('nothing says the plugin reload did not start', /did not start/.test(said) === false, said.split('\n').filter((line) => /did not start/.test(line)).join(' | '))
  check('the instance is recorded on a context that refuses inject', globalThis[K('instance')] !== null && globalThis[K('instance')] !== undefined, String(globalThis[K('instance')]))
  check('a dispose hook is registered on a context that refuses inject', host.disposers.length === 1, String(host.disposers.length))
  check('the button routes are still mounted on that context', host.routes.has('/dsh-unlag/state'), [...host.routes.keys()].length.toString())
  host.dispose()
  check('dispose still clears the instance on that context', globalThis[K('instance')] === null, String(globalThis[K('instance')]))
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
