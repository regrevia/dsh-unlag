/**
 * The startup check reads the ids a script registers through `__ModuleLoader__.load`. A plugin may
 * ship its own prebuilt bundle and hand the loader a name instead of an inline string — DSH's
 * loader reads the value at run time, so the literal the body already gave that name is the id.
 * Reading only literal ids refused such a bundle forever (`does not register …`) and the page was
 * never rebuilt, while the very same bundle loads fine in the app.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_UNLAG_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-unlag-reg-shape-')), 'host.log')

const { verifyStartupRows } = await import('../index.js')

const graphFor = (...ids) => ({ rev: 'test', entries: ids.map((id) => ({ id, rev: 'test' })), batches: [] })
const answerWith = (body) => async () => ({ status: 200, arrayBuffer: async () => Buffer.from(body) })
const rowFor = (id) => `/plugins/??${id}/client.js&rev=test`

{
  const body = 'var clientModuleId = "dsh-x";\nwindow.__ModuleLoader__.load({ id: clientModuleId, factory: () => ({}) });'
  const verdict = await verifyStartupRows(graphFor('dsh-x'), answerWith(body), [rowFor('dsh-x')])
  assert.equal(verdict.status, 'ok', JSON.stringify(verdict))
  console.log('PASS  a name the body declares before the call is the id it registers')
}
{
  const body = 'let picked = "dsh-x";\nconst other = "dsh-y";\nwindow.__ModuleLoader__.load({ id: picked, factory: () => ({}) });'
  const verdict = await verifyStartupRows(graphFor('dsh-x'), answerWith(body), [rowFor('dsh-x')])
  assert.equal(verdict.status, 'ok', JSON.stringify(verdict))
  console.log('PASS  the declaration that matches the name is the one read')
}
{
  const body = 'var clientModuleId = "dsh-x";\nwindow.__ModuleLoader__.load({ id: clientModuleId, factory: () => ({}) });'
  const verdict = await verifyStartupRows(graphFor('dsh-y'), answerWith(body), [rowFor('dsh-y')])
  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict))
  assert.equal(verdict.reason, 'register')
  console.log('PASS  a name that holds another id does not register the row')
}
{
  const body = 'window.__ModuleLoader__.load({ id: late, factory: () => ({}) });\nvar late = "dsh-late";'
  const verdict = await verifyStartupRows(graphFor('dsh-late'), answerWith(body), [rowFor('dsh-late')])
  assert.equal(verdict.status, 'blocked', JSON.stringify(verdict))
  assert.equal(verdict.reason, 'register')
  assert.match(verdict.detail, /读不出值/u)
  console.log('PASS  a name given a value after the call registers nothing, and the refusal says why')
}
{
  const body = 'window.__ModuleLoader__.load({ id: ' + '`dsh-tpl`' + ', factory: () => ({}) });'
  const verdict = await verifyStartupRows(graphFor('dsh-tpl'), answerWith(body), [rowFor('dsh-tpl')])
  assert.equal(verdict.status, 'ok', JSON.stringify(verdict))
  console.log('PASS  a template literal id is still read')
}
{
  // The prebuilt bundle the issue named: a name declared ~1.1 KB before the call, in a big file.
  const filler = '/* ' + 'x'.repeat(1100) + ' */'
  const body = `${filler}\nvar clientModuleId = "ds-harness-remote";\nwindow.__ModuleLoader__.load({ id: clientModuleId, factory: () => ({}), requires: [] });`
  const verdict = await verifyStartupRows(graphFor('ds-harness-remote'), answerWith(body), [rowFor('ds-harness-remote')])
  assert.equal(verdict.status, 'ok', JSON.stringify(verdict))
  console.log('PASS  a prebuilt bundle that names its id no longer reads as "does not register"')
}
