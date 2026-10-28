import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { chooseStandIn, matchRow } from '../scripts/loader-contract.mjs'

/**
 * The contract script is a command, not a library: importing it must not start the app or a browser,
 * which is why the checks that need neither run through `--self-check` in a child process. These
 * tests exist because the regression they guard against was the script's own exception being read as
 * a real refusal — a TypeError swallowed into `reason: 'network'` passed an assertion that claimed
 * another generation's body had been rejected.
 */
const script = fileURLToPath(new URL('../scripts/loader-contract.mjs', import.meta.url))
const base = 'http://contract.invalid'
const row = 'plugins/??b/client.js&rev=rev-1'

test('an omitted blocked parameter names no row and does not throw', () => {
  assert.equal(matchRow(`/${row}`, base, undefined), false)
  assert.equal(matchRow(`/${row}`, base, null), false)
  assert.equal(chooseStandIn({ url: `/${row}`, base }), null)
})

test('the blocked row is coerced only when its spec is a real row', () => {
  assert.equal(chooseStandIn({ url: `/${row}`, base, blocked: row }), 'coerced')
  assert.equal(chooseStandIn({ url: `/${row}`, base, blocked: 'plugins/??a/client.js&rev=rev-1' }), null)
})

test('a replace selects a stand-in only with bytes at a named row', () => {
  const body = new TextEncoder().encode('__ModuleLoader__.load({ id: "b" });')
  assert.equal(chooseStandIn({ url: `/${row}`, base, replace: { spec: row, body } }), 'replaced')
  assert.equal(chooseStandIn({ url: `/${row}`, base, replace: { spec: row } }), null)
  assert.equal(chooseStandIn({ url: `/${row}`, base, replace: { spec: undefined, body } }), null)
})

test('--self-check passes with no app and no browser', () => {
  const run = spawnSync(process.execPath, [script, '--self-check'], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.doesNotMatch(run.stdout, /^FAIL /mu)
  assert.match(run.stdout, /5\/5 self-checks passed/u)
  // The refusal that used to be the script's own TypeError has to be a real one now, and the
  // healthy control has to be approved beside it.
  assert.match(run.stdout, /^PASS self-check substituting another generation body is refused by the check itself$/mu)
  assert.match(run.stdout, /^PASS self-check substituting a row with its own healthy body is approved$/mu)
  assert.match(run.stdout, /^PASS self-check an omitted blocked selects no stand-in and does not throw$/mu)
})
