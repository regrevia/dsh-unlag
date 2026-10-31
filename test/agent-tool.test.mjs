// The refresh button as a tool: offered only when the settings row allows it, and otherwise
// refusing in one line instead of pressing. The press it makes goes through the same path as the
// button, so the process is never restarted and a failed swap is reported as one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-agent-'))
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(HOME, 'agent.log')
process.env.DSH_UNLAG_ANSWER_MS = '2000'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

function mount(config = {}, options = {}) {
  const routes = new Map()
  const tools = []
  let applies = 0
  let state = (options.before ?? [{ id: '@local/a', state: 2 }]).map((entry) => ({ ...entry }))
  const clientModules = {
    graph: () => ({ entries: state.map((entry) => ({ id: entry.id, rev: 'old' })) }),
    fetchBundle: async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('module').buffer }),
  }
  const ctx = {
    get: (key) => {
      if (key === 'webServer') {
        return { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      }
      if (key === 'loader') return { entries: () => state.map((entry) => ({ options: { id: entry.id }, fiber: { state: entry.state } })) }
      if (key === 'clientModules') return clientModules
      if (key === 'agents' && options.agents) {
        const registry = { list: () => options.agents.map((entry) => entry.agent) }
        if (options.noRoots !== true) registry.roots = () => options.agents.filter((entry) => entry.root).map((entry) => entry.agent)
        return registry
      }
      if (key === 'hmr') {
        return {
          baseDir: join(HOME, 'profile'),
          runExclusive: async (work) => work(),
          reconcileProfile: async () => {
            applies += 1
            if (options.applyDelayMs) await new Promise((resolve) => setTimeout(resolve, options.applyDelayMs))
            state = (options.after ?? state).map((entry) => ({ ...entry }))
            if (options.fail === true) throw new Error('the swap failed')
            return { warnings: [], pending: [] }
          },
        }
      }
      return undefined
    },
    on: () => {},
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    effect: (factory) => { factory(); return () => {} },
  }
  apply(ctx, config)
  return { routes, tools, applies: () => applies }
}

// --- the switch decides whether the tool presses at all ---------------------------------------
{
  const { tools, applies } = mount({})
  check('one refresh tool is offered to the model', tools.length === 1 && tools[0].name === 'unlag_refresh', JSON.stringify(tools.map((tool) => tool.name)))
  const description = String(tools[0]?.description ?? '')
  check('its description is one line', description !== '' && !description.includes('\n'), description)
  const blocked = await tools[0].execute({})
  check('with the switch off the call is refused', blocked.status === 'blocked', JSON.stringify(blocked))
  check('and the refusal names where to turn it on', typeof blocked.reason === 'string' && blocked.reason.includes('右键菜单'), JSON.stringify(blocked))
  check('and nothing was reloaded', applies() === 0, String(applies()))
  const text = tools[0].output.render({}, blocked)[0]?.text ?? ''
  check('the page is shown one line for that refusal', typeof text === 'string' && !text.includes('\n'), text)
}

// --- with the switch on it makes the same press the button makes ------------------------------
{
  const { tools, applies } = mount({ agentRefresh: true })
  const pressed = await tools[0].execute({ requestId: 'agent-1' })
  check('with the switch on the call ends done', pressed.status === 'done', JSON.stringify(pressed))
  check('and the plugin set was composed once', applies() === 1, String(applies()))
  check('and the rebuild is called safe', pressed.rebuild === 'safe', JSON.stringify(pressed))
  check('and the reason is one sentence', typeof pressed.reason === 'string' && !pressed.reason.includes('\n'), JSON.stringify(pressed))
  const again = await tools[0].execute({ requestId: 'agent-1' })
  check('the same request id is answered from its own record', again.status === 'done' && applies() === 1, JSON.stringify({ again, applies: applies() }))
}

// --- the press switch still gates it, and a failed swap is reported as one -------------------
{
  const { tools, applies } = mount({ agentRefresh: true, reloadPlugins: false })
  const blocked = await tools[0].execute({})
  check('with the press switch off the call is refused', blocked.status === 'blocked', JSON.stringify(blocked))
  check('and nothing was reloaded', applies() === 0, String(applies()))
}
{
  const { tools } = mount({ agentRefresh: true }, { fail: true })
  const failed = await tools[0].execute({})
  check('a swap that fails is reported as failed', failed.status === 'failed', JSON.stringify(failed))
  check('and the rebuild is not called safe', failed.rebuild !== 'safe', JSON.stringify(failed))
}

// --- a running subagent would be cancelled by the swap, so an agent press waits for it ---------
{
  const parent = { root: true, agent: { id: 'session-parent', status: 'running' } }
  const child = { root: false, agent: { id: 'child-1', status: 'running' } }
  const { tools, applies } = mount({ agentRefresh: true }, { agents: [parent, child] })
  const blocked = await tools[0].execute({ requestId: 'busy-child' })
  check('with a subagent turn running the call is refused', blocked.status === 'blocked', JSON.stringify(blocked))
  check('and nothing was reloaded', applies() === 0, String(applies()))
  check('and the refusal names the running subagent', typeof blocked.reason === 'string' && blocked.reason.includes('child-1'), JSON.stringify(blocked))
  check('and the refusal is one line', typeof blocked.reason === 'string' && !blocked.reason.includes('\n'), JSON.stringify(blocked))
  // Once the child is done, the same press goes through.
  child.agent.status = 'idle'
  const after = await tools[0].execute({ requestId: 'busy-child-after' })
  check('a press after the subagent finishes runs', after.status === 'done' && applies() === 1, JSON.stringify({ after, applies: applies() }))
}
{
  // A forked session names a parent in its header but is a root: it is not torn down with a plugin.
  const fork = { root: true, agent: { id: 'session-fork', status: 'running', session: { header: { parentSession: 'session-origin' } } } }
  const idleChild = { root: false, agent: { id: 'child-2', status: 'idle' } }
  const { tools, applies } = mount({ agentRefresh: true }, { agents: [fork, idleChild] })
  const pressed = await tools[0].execute({ requestId: 'idle-child' })
  check('running top-level turns (forks included) and idle subagents do not hold the press', pressed.status === 'done' && applies() === 1, JSON.stringify({ pressed, applies: applies() }))
}
{
  const child = { root: false, agent: { id: 'child-3', status: 'running' } }
  const { tools, applies } = mount({ agentRefresh: true }, { agents: [child], noRoots: true })
  const pressed = await tools[0].execute({ requestId: 'no-roots' })
  check('a host without roots() is not held', pressed.status === 'done' && applies() === 1, JSON.stringify({ pressed, applies: applies() }))
}

// --- a stopped turn leaves the set alone ------------------------------------------------------
{
  const { tools, applies } = mount({ agentRefresh: true })
  const controller = new AbortController()
  controller.abort()
  const stopped = await tools[0].execute({ requestId: 'stopped-1' }, { signal: controller.signal })
  check('a press stopped before it started is answered as cancelled', stopped.status === 'cancelled', JSON.stringify(stopped))
  check('and it did not compose the plugin set', applies() === 0, String(applies()))
  check('and the reason says nothing was replaced', typeof stopped.reason === 'string' && stopped.reason.includes('取消'), JSON.stringify(stopped))
  check('and it is not called safe to rebuild', stopped.rebuild !== 'safe', JSON.stringify(stopped))
}
{
  const { tools, applies, routes } = mount({ agentRefresh: true, minIntervalMs: 800 })
  const first = await tools[0].execute({ requestId: 'pace-1' })
  check('a first press still runs under the pace limit', first.status === 'done' && applies() === 1, JSON.stringify({ first, applies: applies() }))
  const controller = new AbortController()
  const waiting = tools[0].execute({ requestId: 'pace-2' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  const stopped = await waiting
  check('a press stopped while it waits is answered as cancelled', stopped.status === 'cancelled', JSON.stringify(stopped))
  check('and the waited press applied nothing', applies() === 1, String(applies()))
  const stateRes = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  routes.get('/dsh-unlag/state')({ method: 'GET' }, stateRes)
  const stateText = String(stateRes.body)
  check('and it left no operation record behind', !/"operation":\{\"status\":\"cancelled/.test(stateText), stateText.slice(0, 160))
  // A stopped press does not burn the pace limit for the next one.
  const after = await tools[0].execute({ requestId: 'pace-3' })
  check('a press after a stopped one still runs', after.status === 'done' && applies() === 2, JSON.stringify({ after, applies: applies() }))
}

// --- every request id reads its own end, not a word from while it waited ----------------------
{
  const { tools, applies } = mount({ agentRefresh: true }, { applyDelayMs: 120 })
  const controllerA = new AbortController()
  const first = tools[0].execute({ requestId: 'slow-a' }, { signal: controllerA.signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const joined = await tools[0].execute({ requestId: 'joined-b' })
  check('a press made during another update joins it', joined.status === 'applying', JSON.stringify(joined))
  const end = await first
  check('and the update it joined ends done', end.status === 'done', JSON.stringify(end))
  const retry = await tools[0].execute({ requestId: 'joined-b' })
  check('a retry of the joined press reads that end', retry.status === 'done', JSON.stringify(retry))
  check('and a retry never composes the set a second time', applies() === 1, String(applies()))
}

{
  const { tools, applies } = mount({ agentRefresh: true }, { applyDelayMs: 120, fail: true })
  const first = tools[0].execute({ requestId: 'slow-fail' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const joined = await tools[0].execute({ requestId: 'joined-fail' })
  check('a press can join an update that will fail', joined.status === 'applying', JSON.stringify(joined))
  const end = await first
  check('that update ends failed', end.status === 'failed', JSON.stringify(end))
  const retry = await tools[0].execute({ requestId: 'joined-fail' })
  check('a retry of a press that joined a failed update reads failed', retry.status === 'failed', JSON.stringify(retry))
  check('and it reports the joined update as failed to rebuild on', retry.rebuild === 'unsafe', JSON.stringify(retry))
  // The failed update is asked once more before the press tells the person, so the set is
  // composed twice and never a third time: the extra ask is the one a person would make.
  check('and the retry composed nothing beyond the one more ask', applies() === 2, String(applies()))
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
