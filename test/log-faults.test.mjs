import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A log write must never be able to take a press down, and it must not be silently impossible
// either: a home directory this app has not run in yet has no log directory, and that is a normal
// first run. Each case runs the shipped module in its own process because the log is set up once.
const root = join(tmpdir(), 'unlag-log-faults')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const run = (env, body) => {
  const merged = { ...process.env, ...env }
  for (const key of Object.keys(merged)) if (merged[key] === '') delete merged[key]
  return spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: new URL('..', import.meta.url).pathname,
    env: merged,
    encoding: 'utf8',
    timeout: 30000,
  })
}

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

// A first run: nothing under $HOME yet, and no DSH_UNLAG_LOG override.
const freshHome = join(root, 'fresh-home')
const applyFirstRun = run(
  { HOME: freshHome, DSH_UNLAG_LOG: '' },
  `const { apply } = await import('./index.js')
   apply({ get: () => undefined, on: () => {} }, {})
   console.log('applied')`,
)
const freshLog = join(freshHome, '.dsh', 'unlag-reload.log')
let firstRunText = ''
try {
  firstRunText = readFileSync(freshLog, 'utf8')
} catch {}
check('a first run with no home directory still applies', /applied/u.test(applyFirstRun.stdout), applyFirstRun.stderr.slice(0, 120))
check('and the log directory is made, not lost', firstRunText !== '', firstRunText.slice(0, 60))
check('the first line is a real log line', /^\d{4}-\d{2}-\d{2}T/u.test(firstRunText), firstRunText.slice(0, 40))

// A log path that cannot be written at all (here: a directory) must stay silent and harmless.
const blocked = join(root, 'blocked.log')
mkdirSync(blocked, { recursive: true })
const applyBlocked = run(
  { HOME: join(root, 'blocked-home'), DSH_UNLAG_LOG: blocked },
  `const { apply } = await import('./index.js')
   const routes = new Map()
   const ctx = { get: (key) => key === 'webServer'
     ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
     : undefined, on: () => {} }
   apply(ctx, {})
   const res = { status: 0, body: '', writableEnded: false, writeHead(s) { this.status = s }, end(b) { this.body += b ?? ''; this.writableEnded = true } }
   await Promise.resolve(routes.get('/dsh-unlag/state')({ method: 'GET' }, res))
   console.log(JSON.stringify({ status: res.status, routes: routes.size }))`,
)
let blockedAnswer = null
try {
  blockedAnswer = JSON.parse(applyBlocked.stdout.trim().split('\n').pop())
} catch {}
check('an unwritable log does not throw', applyBlocked.status === 0, applyBlocked.stderr.slice(0, 160))
check('the plugin still mounts and answers state', blockedAnswer?.status === 200 && blockedAnswer?.routes === 5, JSON.stringify(blockedAnswer))
check('and nothing is written through the unwritable path', statSync(blocked).isDirectory())

// A log directory that exists but refuses writes: the press path answers from what it did, never
// from whether the line could be written. A press that failed only because its own record could
// not be saved would look like a refused reload with no reason.
const readOnlyDir = join(root, 'readonly')
mkdirSync(readOnlyDir, { recursive: true })
chmodSync(readOnlyDir, 0o500)
const applyReadOnly = run(
  { HOME: join(root, 'readonly-home'), DSH_UNLAG_LOG: join(readOnlyDir, 'press.log') },
  `const { apply } = await import('./index.js')
   const routes = new Map()
   const graph = { rev: 'new', entries: [{ id: '@local/a', rev: 'new', url: '/plugins/??@local/a/client.js&rev=new' }], batches: [{ url: '/plugins/??@local/a/client.js&rev=new', entries: ['@local/a'], rev: 'new' }] }
   const ctx = { get: (key) => key === 'webServer'
       ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
       : key === 'clientModules' ? { graph: () => graph, fetchBundle: async () => new Response('window.__ModuleLoader__.load({ id: "@local/a", factory() {} })', { status: 200 }) }
       : key === 'hmr' ? { baseDir: '/tmp/unlag-ro-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
       : undefined, on: () => {} }
   apply(ctx, {})
   const answer = async (url, method) => {
     const res = { status: 0, body: '', writableEnded: false, writeHead(s) { this.status = s }, end(b) { this.body += b ?? ''; this.writableEnded = true } }
     await routes.get(url.split('?')[0])({ method, url, headers: { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'http://127.0.0.1:52847' }, on() {}, destroy() {} }, res)
     return { status: res.status, verdict: JSON.parse(res.body || '{}').status, ended: res.writableEnded }
   }
   const pressed = await answer('/dsh-unlag/reload', 'POST')
   const reported = await answer('/dsh-unlag/report?event=mounted', 'POST')
   const state = await answer('/dsh-unlag/state', 'GET')
   console.log(JSON.stringify({ pressed, reported, state }))`,
)
let readOnlyAnswer = null
try {
  readOnlyAnswer = JSON.parse(applyReadOnly.stdout.trim().split('\n').pop())
} catch {}
check('an unwritable log directory does not throw on the press path', applyReadOnly.status === 0, applyReadOnly.stderr.slice(0, 700))
check('and a press there still answers from what it did', readOnlyAnswer?.pressed?.status === 200 && readOnlyAnswer?.pressed?.verdict === 'done' && readOnlyAnswer?.pressed?.ended === true, JSON.stringify(readOnlyAnswer?.pressed))
check('and the report it sends is still recorded as an answer', readOnlyAnswer?.reported?.status === 200 && readOnlyAnswer?.reported?.verdict === 'done', JSON.stringify(readOnlyAnswer?.reported))
check('and the state read is unaffected', readOnlyAnswer?.state?.status === 200 && readOnlyAnswer?.state?.ended === true, JSON.stringify(readOnlyAnswer?.state))
chmodSync(readOnlyDir, 0o700)

// A log that is capped must start over rather than grow: proven by writing past the cap first.
const capped = join(root, 'capped.log')
writeFileSync(capped, 'x'.repeat(1_100_000))
const applyCapped = run({ HOME: join(root, 'capped-home'), DSH_UNLAG_LOG: capped }, `const { apply } = await import('./index.js'); apply({ get: () => undefined, on: () => {} }, {})`)
check('a log past its cap starts over on the next write', statSync(capped).size < 4096, `size=${statSync(capped).size}`)
check('and the restart line is real', /^\d{4}-\d{2}-\d{2}T/u.test(readFileSync(capped, 'utf8')), readFileSync(capped, 'utf8').slice(0, 40))
check('the capped run applies', applyCapped.status === 0, applyCapped.stderr.slice(0, 120))

// Moving a full log aside can itself fail: the name it moves to may already be a directory, or the
// directory may be read-only. Neither may cost the plugin its mount or the press its answer, and in
// both the new line still has to land somewhere a reader can find it.
const aside = join(root, 'aside.log')
writeFileSync(aside, 'x'.repeat(1_100_000))
mkdirSync(`${aside}.1`, { recursive: true })
const applyAside = run({ HOME: join(root, 'aside-home'), DSH_UNLAG_LOG: aside }, `const { apply } = await import('./index.js'); apply({ get: () => undefined, on: () => {} }, {})`)
check('a log whose previous generation name is taken still applies', applyAside.status === 0, applyAside.stderr.slice(0, 160))
check('and the line still lands in the log itself', statSync(aside).isFile() && statSync(aside).size < 4096 && /^\d{4}-\d{2}-\d{2}T/u.test(readFileSync(aside, 'utf8')), `size=${statSync(aside).size}`)
check('and the taken name is left as it was', statSync(`${aside}.1`).isDirectory())

const asideFile = join(root, 'aside-file.log')
writeFileSync(asideFile, 'x'.repeat(1_100_000))
writeFileSync(`${asideFile}.1`, 'older generation')
const applyAsideFile = run({ HOME: join(root, 'aside-file-home'), DSH_UNLAG_LOG: asideFile }, `const { apply } = await import('./index.js'); apply({ get: () => undefined, on: () => {} }, {})`)
check('an existing previous generation is replaced by the fuller one', applyAsideFile.status === 0 && readFileSync(`${asideFile}.1`, 'utf8').length >= 1_100_000, `${applyAsideFile.status}/${readFileSync(`${asideFile}.1`, 'utf8').length}`)

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
