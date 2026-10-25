import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

// Keep the live log readable: this run writes its own.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-coalesce-test.log')

const HOME = '/tmp/unlag-coalesce-home'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh', 'plugins', 'demo'), { recursive: true })
process.env.HOME = HOME

const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)))

const mod = await import(new URL('../index.js', import.meta.url).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let reloads = 0
const hmr = {
  baseDir: HOME,
  runExclusive: (fn) => fn(),
  reconcileProfile: async () => {
    reloads += 1
    return { warnings: [], pending: [] }
  },
}
const disposers = []
const ctx = {
  get: (key) => (key === 'hmr' ? hmr : undefined),
  on: (event, fn) => {
    if (event === 'dispose') disposers.push(fn)
  },
}

const cases = []
const check = (name, ok, detail = '') => cases.push({ name, ok, detail })

mod.apply(ctx, { debounce: 20, minIntervalMs: 50 })
await sleep(300)
const root = join(HOME, '.dsh', 'plugins', 'demo')

// A save that arrives as several writes is one apply, not one per write.
writeFileSync(join(root, 'burst.js'), 'export const a = 1\n')
await sleep(40)
writeFileSync(join(root, 'burst.js'), 'export const a = 2\n')
await sleep(40)
writeFileSync(join(root, 'burst.js'), 'export const a = 3\n')
await sleep(400)
check('a burst of writes is one apply', reloads === 1, `applies=${reloads}`)

// An event that edits no source file leaves the set as it is, so nothing is restarted.
const beforeQuiet = reloads
mkdirSync(join(root, 'assets.js'), { recursive: true })
await sleep(400)
check('an event with no source change applies nothing', reloads === beforeQuiet, `applies=${reloads - beforeQuiet}`)

// A test edit does not change what the plugin does, so it restarts nothing.
const beforeTest = reloads
writeFileSync(join(root, 'demo.test.mjs'), 'export const t = 1\n')
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'test', 'unit.mjs'), 'export const u = 1\n')
await sleep(400)
check('a test edit applies nothing', reloads === beforeTest, `applies=${reloads - beforeTest}`)

// The same file edited for real is applied again.
writeFileSync(join(root, 'burst.js'), 'export const a = 4\n')
await sleep(400)
check('a real edit is applied', reloads === beforeQuiet + 1, `applies=${reloads - beforeQuiet}`)

for (const dispose of disposers) dispose()

check('no unhandled rejection', unhandled.length === 0, unhandled.join(' | '))

const failed = cases.filter((item) => item.ok === false)
for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail === '' ? '' : `  (${item.detail})`}`)
if (failed.length > 0) {
  console.error(`${failed.length} FAILED`)
  process.exitCode = 1
}
