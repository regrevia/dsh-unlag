/**
 * Chaos core: the invariants a press must hold while the host lies to it.
 *
 * Each case injects one fault -- the swap throws, the loader cannot be read, the swap wants a
 * restart, the swap never returns -- and then reads the same three places the page reads: the
 * answer, `/state.operation`, and the record left under the request id. Nothing here sleeps for a
 * guessed duration: the plugin's press spacing is measured on `Date.now`, so the lab advances its
 * own clock between presses (see `scripts/soak.mjs`) and the real timeouts stay real.
 *
 * Run: node test/chaos-core.test.mjs
 */

import {
  activeTimers,
  advanceClock,
  auditOperation,
  createChaosModel,
  globalEntries,
  removeChaosHome,
} from '../scripts/soak.mjs'

let failures = 0

function check(label, ok, extra = '') {
  if (ok) {
    console.log(`PASS ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${extra === '' ? '' : ` -- ${extra}`}`)
}

const rejections = []
const exceptions = []
process.on('unhandledRejection', (reason) => rejections.push(reason))
process.on('uncaughtException', (error) => exceptions.push(error))

const QUIET = {
  hmr: 'ok',
  health: 'active',
  delay: 0,
  warnings: false,
  restartReason: null,
  pending: null,
  stopId: null,
  nestedLeft: 0,
  dropAnswer: false,
}

const model = await createChaosModel({ seed: 7, answerMs: 25, timeoutMs: 40 })

/** Put the world back to a healthy set, then let a press find it. */
function reset() {
  model.setFault(QUIET)
  for (const entry of model.world.entries) entry.state = 2
  advanceClock(1600)
}

/** One press, as a person makes it: later than the last one by more than the button's own gap. */
async function press(requestId) {
  advanceClock(1600)
  return model.press(requestId)
}

const TERMINAL = new Set(['done', 'failed', 'blocked', 'restart', 'unavailable'])
const answersSeen = new Map()

function record(requestId, answer) {
  answersSeen.set(requestId, answer)
}

// ------------------------------------------------------------------------------------------------
// A healthy press ends done and safe, and leaves a record a reloaded page can read.
// ------------------------------------------------------------------------------------------------
reset()
const appliesBefore = model.counters.applies
const happy = await press('c-happy')
record('c-happy', happy)
check('a healthy press answers 200', happy.status === 200, `HTTP ${happy.status}`)
check('a healthy press ends done', happy.body?.status === 'done', String(happy.body?.status))
check('a done press carries a safe rebuild', happy.body?.rebuild === 'safe', String(happy.body?.rebuild))
check('a healthy press started exactly one update', model.counters.applies - appliesBefore === 1, `${model.counters.applies - appliesBefore} updates`)

let state = await model.state()
check('/state shows the same terminal record', state?.operation?.status === 'done', String(state?.operation?.status))
check('/state record keeps the request id', state?.operation?.requestId === 'c-happy', String(state?.operation?.requestId))

// ------------------------------------------------------------------------------------------------
// The same press twice: the second one is answered from the record and starts nothing.
// ------------------------------------------------------------------------------------------------
const appliesBeforeRetry = model.counters.applies
advanceClock(1600)
const again = await model.press('c-happy')
check('a repeated press answers the same status', again.body?.status === 'done', String(again.body?.status))
check('a repeated press answers the same rebuild', again.body?.rebuild === 'safe', String(again.body?.rebuild))
check('a repeated press starts no update', model.counters.applies === appliesBeforeRetry, `${model.counters.applies - appliesBeforeRetry} updates`)

// ------------------------------------------------------------------------------------------------
// The swap throws: failed, unsafe, and never "done".
// ------------------------------------------------------------------------------------------------
reset()
model.setFault({ hmr: 'throw' })
const thrown = await press('c-throw')
record('c-throw', thrown)
check('a throwing swap answers 200, not an error page', thrown.status === 200, `HTTP ${thrown.status}`)
check('a throwing swap ends failed', thrown.body?.status === 'failed', String(thrown.body?.status))
check('a failed press is unsafe to reload into', thrown.body?.rebuild === 'unsafe', String(thrown.body?.rebuild))
check('a failed press reports no pending work', Array.isArray(thrown.body?.pending) && thrown.body.pending.length === 0)

// ------------------------------------------------------------------------------------------------
// The loader cannot be read: the answer must say it does not know, not that it is safe.
// ------------------------------------------------------------------------------------------------
reset()
model.setFault({ health: 'unreadable' })
const blind = await press('c-blind')
record('c-blind', blind)
check('an unreadable loader still answers', blind.status === 200, `HTTP ${blind.status}`)
check('an unreadable loader never claims a safe rebuild', blind.body?.rebuild !== 'safe', String(blind.body?.rebuild))
check('an unreadable loader answers unknown', blind.body?.rebuild === 'unknown', String(blind.body?.rebuild))
check('an unreadable loader says so', blind.body?.healthReadable === false, String(blind.body?.healthReadable))

// ------------------------------------------------------------------------------------------------
// The swap wants a new process: restart, pending, actionable -- and the process keeps running.
// ------------------------------------------------------------------------------------------------
reset()
model.setFault({ hmr: 'restart' })
const pidBefore = process.pid
const servicesBefore = model.counters.applies
const restarted = await press('c-restart')
record('c-restart', restarted)
check('a restart press answers restart', restarted.body?.status === 'restart', String(restarted.body?.status))
check('a restart press is pending, not safe', restarted.body?.rebuild === 'pending', String(restarted.body?.rebuild))
check('a restart press names the reason it cannot finish', typeof restarted.body?.restartReason === 'string' && restarted.body.restartReason.length > 0, String(restarted.body?.restartReason))
check('a restart press did not restart the process', process.pid === pidBefore)
check('a restart press still ran through the swap once', model.counters.applies - servicesBefore === 1, `${model.counters.applies - servicesBefore} updates`)

// ------------------------------------------------------------------------------------------------
// Half the swap landed: the answer has to keep the unfinished entry in front of the page.
// ------------------------------------------------------------------------------------------------
reset()
model.setFault({ hmr: 'pending' })
const half = await press('c-pending')
record('c-pending', half)
check('a partially applied swap answers restart', half.body?.status === 'restart', String(half.body?.status))
check('a partially applied swap is pending', half.body?.rebuild === 'pending', String(half.body?.rebuild))
check('a partially applied swap names what is still pending', Array.isArray(half.body?.pending) && half.body.pending.length > 0, JSON.stringify(half.body?.pending))

// ------------------------------------------------------------------------------------------------
// The swap never returns: the answer is bounded, and the work still has to leave a record.
// ------------------------------------------------------------------------------------------------
reset()
model.setFault({ hmr: 'hang' })
const hangStarted = process.hrtime.bigint()
const hung = await press('c-hang')
const hangMs = Number(process.hrtime.bigint() - hangStarted) / 1e6
check('a hung swap is answered instead of held', hangMs < 1000, `${hangMs.toFixed(1)}ms`)
check('a hung swap answers applying', hung.body?.status === 'applying', String(hung.body?.status))
check('an applying press is pending, not safe', hung.body?.rebuild === 'pending', String(hung.body?.rebuild))
await model.drain(300)
state = await model.state()
const late = state?.operation ?? null
check('a late update still writes a terminal record', late !== null && TERMINAL.has(late.status), String(late?.status))
check('the late record keeps the request id of the press that started it', late?.requestId === 'c-hang', String(late?.requestId))
const hungRow = model.presses()?.get('c-hang') ?? null
check('the late update leaves a record under the request id', hungRow !== null)

// ------------------------------------------------------------------------------------------------
// Nothing the page deliberately keeps may be without a reason, and nothing may be unbounded.
// ------------------------------------------------------------------------------------------------
const found = []
auditOperation(model.operation(), 'chaos/operation', found)
check('every operation record has a status and a rebuild', found.length === 0, found.join('; '))

const rows = model.presses()
check('press memory stays bounded', (rows?.size ?? 0) <= 32, `${rows?.size ?? 0} rows`)
const live = model.runningPresses()
check('live press rows stay bounded', (live?.size ?? 0) <= 128, `${live?.size ?? 0} rows`)

const globals = globalEntries().filter((row) => row.name.startsWith('dsh-unlag'))
check('globalThis keeps only the plugin state it needs', globals.length <= 10, globals.map((row) => row.name).join(', '))

check('the plugin registered its seven routes and no more', model.routes.size === 7, `${model.routes.size} routes`)
check('no update ever ran next to another', model.counters.maxConcurrent <= 1, `${model.counters.maxConcurrent} at once`)

const timers = activeTimers()
check('no wait is left behind', timers <= 8, `${timers} timers`)

for (const requestId of ['c-happy', 'c-throw', 'c-blind', 'c-restart', 'c-pending']) {
  const answer = answersSeen.get(requestId) ?? null
  check(`press ${requestId} was answered with status and rebuild`, answer !== null && typeof answer.body?.status === 'string' && typeof answer.body?.rebuild === 'string')
}

check('no press rejected without a handler', rejections.length === 0, rejections.map((reason) => String(reason?.message ?? reason)).join('; '))
check('no press threw out of the event loop', exceptions.length === 0, exceptions.map((error) => String(error?.message ?? error)).join('; '))

await model.finish()
removeChaosHome()

if (failures > 0) {
  console.log(`failed: ${failures} check(s)`)
  process.exitCode = 1
} else {
  console.log('ok')
}
