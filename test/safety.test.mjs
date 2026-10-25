import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

// Keep the live log readable: this run writes its own.
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'dsh-unlag-test.log')

const HOME = '/tmp/unlag-test-home'
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

function makeCtx({ hmrValue = hmr, status = 'idle' } = {}) {
  const disposers = []
  return {
    get(key) {
      if (key === 'hmr') return hmrValue
      if (key === 'agents') return { list: () => [{ id: 'a', status }] }
      return undefined
    },
    on(event, fn) {
      if (event === 'dispose') disposers.push(fn)
    },
    disposeAll: () => disposers.forEach((fn) => fn()),
  }
}

const cases = []
const check = (name, ok, detail = '') => cases.push({ name, ok, detail })

// 1. No hmr service at all: must not throw, must not watch.
try {
  mod.apply(makeCtx({ hmrValue: undefined }), {})
  check('no hmr service', true)
} catch (error) {
  check('no hmr service', false, String(error))
}

// 2. Hostile config values: must not throw.
for (const cfg of [undefined, null, { roots: 'nope' }, { roots: [42, '/does/not/exist'] }, { debounce: 'x' }, { plugins: 'off' }]) {
  try {
    mod.apply(makeCtx(), cfg)
    check(`config ${JSON.stringify(cfg)}`, true)
  } catch (error) {
    check(`config ${JSON.stringify(cfg)}`, false, String(error))
  }
}

// 3. hmr that throws on use: must not throw out of apply, must not become an unhandled rejection.
const hostile = {
  baseDir: HOME,
  runExclusive: () => {
    throw new Error('reconcile exploded')
  },
  reconcileProfile: async () => ({ warnings: [], pending: [] }),
}
const hostileCtx = makeCtx({ hmrValue: hostile })
mod.apply(hostileCtx, { debounce: 10 })
await sleep(50)

// 4. A real watcher: .js fires a reload, .txt and node_modules do not.
const ctx = makeCtx()
mod.apply(ctx, { debounce: 10 })
await sleep(200)
const root = join(HOME, '.dsh', 'plugins', 'demo')
writeFileSync(join(root, 'ignore.txt'), 'x')
await sleep(120)
const afterTxt = reloads
writeFileSync(join(root, 'node_modules.js'), 'x')
await sleep(120)
const afterNoModules = reloads
mkdirSync(join(root, 'node_modules'), { recursive: true })
writeFileSync(join(root, 'node_modules', 'dep.js'), 'x')
await sleep(120)
const afterNested = reloads
writeFileSync(join(root, 'real.js'), 'export const a = 1\n')
await sleep(300)
const afterJs = reloads
check('txt ignored', afterTxt === 0, `reloads=${afterTxt}`)
check('node_modules file name ignored', afterNoModules === 0, `reloads=${afterNoModules}`)
check('node_modules dir ignored', afterNested === 0, `reloads=${afterNested}`)
check('js triggers one reload', afterJs === 1, `reloads=${afterJs}`)

// 4b. A profile link usually points outside the profile; watch it as given, not glued to baseDir.
const profile = join(HOME, 'profile')
const devRoot = join(HOME, 'dev', 'dsh-demo')
mkdirSync(profile, { recursive: true })
mkdirSync(devRoot, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-demo': `link:${devRoot}` } }))
const beforeLinked = reloads
mod.apply(makeCtx({ hmrValue: { ...hmr, baseDir: profile } }), { debounce: 10 })
await sleep(250)
writeFileSync(join(devRoot, 'change.js'), 'export const c = 1\n')
await sleep(300)
check('an absolute link target is watched', reloads === beforeLinked + 1, `reloads=${reloads - beforeLinked}`)

// 5. A busy agent does not hold a save back: swapping code never interrupts a turn.
const busyCtx = makeCtx({ status: 'running' })
mod.apply(busyCtx, { debounce: 10 })
await sleep(200)
const beforeBusy = reloads
writeFileSync(join(root, 'busy.js'), 'export const b = 1\n')
await sleep(300)
check('a busy agent still swaps', reloads === beforeBusy + 1, `reloads=${reloads - beforeBusy}`)

// 5b. The opt-in quiet mode waits instead.
const quietCtx = makeCtx({ status: 'running' })
mod.apply(quietCtx, { debounce: 10, idleOnly: true })
await sleep(200)
const beforeQuiet = reloads
writeFileSync(join(root, 'quiet.js'), 'export const q = 1\n')
await sleep(400)
check('opt-in quiet mode waits', reloads === beforeQuiet, `reloads=${reloads - beforeQuiet}`)

// 6. A reload while another is in flight does not re-enter.
let concurrent = 0
let peak = 0
const slow = {
  baseDir: HOME,
  runExclusive: async (fn) => {
    concurrent += 1
    peak = Math.max(peak, concurrent)
    await sleep(150)
    const value = await fn()
    concurrent -= 1
    return value
  },
  reconcileProfile: async () => ({ warnings: [], pending: [] }),
}
mod.apply(makeCtx({ hmrValue: slow }), { debounce: 10 })
await sleep(200)
writeFileSync(join(root, 'a.js'), 'export const c = 1\n')
writeFileSync(join(root, 'b.js'), 'export const d = 1\n')
writeFileSync(join(root, 'c.js'), 'export const e = 1\n')
await sleep(600)
check('no re-entrant reload', peak === 1, `peak=${peak}`)

// 7. Disposing closes the watchers and leaves no handle behind.
for (const c of [ctx, busyCtx, hostileCtx]) c.disposeAll()
await sleep(150)
const beforeDispose = reloads
writeFileSync(join(root, 'after-dispose.js'), 'export const f = 1\n')
await sleep(300)
check('dispose stops reloads', reloads === beforeDispose, `reloads=${reloads - beforeDispose}`)
check('no unhandled rejection', unhandled.length === 0, unhandled.join('; '))

for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
const failed = cases.filter((c) => !c.ok).length
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
const started = Date.now()
const timer = setTimeout(() => {
  console.log('event loop still held open after dispose')
  process.exit(1)
}, 1500)
timer.unref()
process.on('beforeExit', () => {
  clearTimeout(timer)
  process.exit(failed === 0 ? 0 : 1)
})
