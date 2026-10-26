// What the shipped files promise has to be what the code does. These checks read the files a user
// or an agent acts on (README, package scripts, the composition patch) and the two routes added for
// the frozen startup list, so a claim cannot drift away from the build again.
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const host = read('index.js')
const client = read('client.js')

// --- what a press keeps ------------------------------------------------------------------------
// An unsent attachment lives only in the page that is about to be replaced, so the docs and the
// page must both say so: the docs explain it, and the press itself is held.
check('the readme no longer says attachments survive a rebuild', !/草稿、附件/u.test(readme))
check('and that such a press is held', /附件/u.test(readme) && /没发出去/u.test(readme) && /按钮会停住|先发出去/u.test(readme))
check('the readme no longer says attachments survive a rebuild', !/草稿、附件/u.test(readme))
check('it says an unsent attachment holds the press', /附件/u.test(readme) && /没发出去/u.test(readme) && /按钮会停住|先发出去/u.test(readme))
check('it tells the reader to send first', /先发/u.test(readme))
check('it does not claim drafts are lost either', /文字草稿/u.test(readme))

// --- who may replace plugin code ---------------------------------------------------------------
check('it keeps the promise that the plugin never replaces code itself', /永远不会去换代码/u.test(readme))
check('it says the app own hot update can still apply a change', /宿主自带|宿主自带/u.test(readme) && /热更新/u.test(readme))
check('the host half never calls its own reload route', !/fetch\([^)]*\/reload/u.test(host))

// --- the same command on every shell ------------------------------------------------------------
check('the test script is not a shell loop', !/\bfor\b.*\bdo\b/u.test(pkg.scripts.test), pkg.scripts.test)
check('the test script runs through node', /^node /u.test(pkg.scripts.test), pkg.scripts.test)
check('test files are listed and each runs in its own process', read('scripts/test.mjs').includes('spawnSync'))

// --- the working directory on a machine whose paths are not unix --------------------------------
check('the composition does not hand a bare path to a url parser', !/base: !!js 'process\.cwd\(\)'/u.test(patch))
check('it builds a file url instead', /file:\/\//u.test(patch))

// --- the page's own startup list -----------------------------------------------------------------
check('the page reports the list it booted with', client.includes('/boot') && client.includes('__DSH_BOOT__'))
check('the host keeps that report', host.includes("`${BASE_PATH}/boot`") && host.includes('liveBoot'))
check('the state route carries it', /boot: liveBoot\.current/u.test(host))


check('the page holds a press while a draft attachment is there', /function draftHasAttachments/.test(client) && /if \(draftHasAttachments\(\)\) return 'attachments'/.test(client))
check('and it checks both previews and picked files', /img\[src\^="blob:"\]/.test(client) && /input\[type="file"\]/.test(client))

console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')

