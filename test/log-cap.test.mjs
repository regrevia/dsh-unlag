// The log is the only place a failed update leaves evidence, so it must not grow without a cap:
// every 200th line checks the size once and a file past the cap starts over.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs'

const HOME = join(tmpdir(), 'unlag-logcap-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh', 'plugins'), { recursive: true })
process.env.HOME = HOME

const LOG = join(tmpdir(), 'unlag-logcap.log')
process.env.DSH_UNLAG_LOG = LOG
const CAP = 1_000_000
writeFileSync(LOG, 'x'.repeat(CAP + 100_000))

const mod = await import(new URL('../index.js', import.meta.url).href)

const ctx = {
  get: () => undefined,
  on: () => {},
}
const out = []
const check = (name, ok, detail = '') => out.push({ name, ok, detail })

try {
  mod.apply(ctx, {})
  check('a plugin entry applies with a log already past the cap', true)
} catch (error) {
  check('a plugin entry applies with a log already past the cap', false, String(error))
}

const size = (() => {
  try {
    return statSync(LOG).size
  } catch {
    return -1
  }
})()
check('the oversized log starts over instead of growing', size >= 0 && size < 4096, `size=${size}`)

if (size > 0) {
  const text = readFileSync(LOG, 'utf8')
  check('the first line after the restart is a real one', /^\d{4}-\d{2}-\d{2}T/u.test(text), text.slice(0, 60))
}

for (const { name, ok, detail } of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
const failed = out.filter((row) => row.ok !== true)
console.log(failed.length === 0 ? 'ok' : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
