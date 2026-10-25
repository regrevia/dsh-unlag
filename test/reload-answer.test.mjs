/**
 * The press route asks the update for an answer and hands whatever comes back to the page. The
 * update runs inside the same process as every other plugin, so its answer is not a shape this
 * code can trust: it may be missing, late, unawaitable, or reject twice over. Each of those still
 * has to leave the page with one status, because a route that throws here takes the app with it and
 * the person sees a press that did nothing at all.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This file asks the press route's answer helper directly; the helper says its own things in the
// log. Point that log at a temporary file so a test run never writes into the record a person reads
// after a real press.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-reload-answer.log')

import { answerReload } from '../index.js'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const done = { status: 'done', warnings: [], pending: [], restartReason: null, failedEntries: [] }
const slow = Symbol('slow') // ui-copy-ignore
const isAnswer = (value) => value !== null && typeof value === 'object' && typeof value.status === 'string'

const cases = [
  ['an answer that is a plain result', () => done, 'done'],
  ['an answer that resolves to a result', () => Promise.resolve(done), 'done'],
  ['an answer that returns nothing', () => undefined, 'failed'],
  ['an answer that resolves to nothing', () => Promise.resolve(null), 'failed'],
  ['an answer that is not an object', () => Promise.resolve('done'), 'failed'],
  ['an answer whose status cannot be read', () => Promise.resolve({ get status() { throw new Error('status') } }), 'failed'],
  ['an answer that throws before answering', () => { throw new Error('sync') }, 'failed'],
  ['an answer that rejects', () => Promise.reject(new Error('rejected')), 'failed'],
  ['an answer that cannot be awaited', () => ({ then() { throw new Error('then') } }), 'failed'],
  ['an answer that never comes', () => new Promise((resolve) => { void resolve }), 'applying'],
]

for (const [label, reloadNow, expected] of cases) {
  let threw = null
  let answer = null
  try {
    answer = await answerReload({ reloadNow }, 150)
  } catch (error) {
    threw = error
  }
  check(`${label} is answered`, threw === null && isAnswer(answer?.outcome), String(threw?.message ?? JSON.stringify(answer?.outcome)))
  check(`${label} is answered as ${expected}`, answer?.outcome?.status === expected, String(answer?.outcome?.status))
  if (expected === 'applying') {
    check(`${label} is marked as running out of time`, answer?.timeRanOut === true, String(answer?.timeRanOut))
  }
}

// A slow answer is told "still applying" and its own later answer is kept for the log; that late
// answer must not reach a response that was already written.
{
  let release
  const late = new Promise((resolve) => { release = resolve })
  const answer = await answerReload({ reloadNow: () => late }, 120)
  check('a slow answer is told it is still applying', answer.outcome.status === 'applying' && answer.timeRanOut === true)
  release(done)
  check('the late answer stays available without being sent', (await answer.work).status === 'done')
}
// An update that says "applying" itself is a press that joined another one, not one that ran out of
// time: the two read the same to the page but mean opposite things in the log.
{
  const answer = await answerReload({ reloadNow: () => Promise.resolve({ status: 'applying', warnings: [], pending: [], restartReason: null, failedEntries: [] }) }, 5000)
  check('an update already applying is not called slow', answer.outcome.status === 'applying' && answer.timeRanOut === false)
}
// A rejecting answer must not surface as an unhandled rejection once the race has been decided.
{
  const rejecting = answerReload({ reloadNow: () => Promise.reject(new Error('late rejection')) }, 5000)
  const answer = await rejecting
  check('a rejecting answer is answered as failed', answer.outcome.status === 'failed')
  await new Promise((resolve) => setImmediate(resolve))
  check('a rejecting answer leaves no unhandled rejection', true)
}

console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
