import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// A log that is capped must start over rather than grow: proven by writing past the cap first.
const capped = join(root, 'capped.log')
writeFileSync(capped, 'x'.repeat(1_100_000))
const applyCapped = run({ HOME: join(root, 'capped-home'), DSH_UNLAG_LOG: capped }, `const { apply } = await import('./index.js'); apply({ get: () => undefined, on: () => {} }, {})`)
check('a log past its cap starts over on the next write', statSync(capped).size < 4096, `size=${statSync(capped).size}`)
check('and the restart line is real', /^\d{4}-\d{2}-\d{2}T/u.test(readFileSync(capped, 'utf8')), readFileSync(capped, 'utf8').slice(0, 40))
check('the capped run applies', applyCapped.status === 0, applyCapped.stderr.slice(0, 120))

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
