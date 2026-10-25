// A burst of lines can land between two periodic size checks, so the cap has to hold for every
// write: the log is read before a line is appended, and a line that would not fit starts the file
// over instead of pushing it past the cap.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'

const HOME = join(tmpdir(), 'unlag-logburst-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME

const LOG = join(tmpdir(), 'unlag-logburst.log')
process.env.DSH_UNLAG_LOG = LOG
const CAP = 1_000_000

const mod = await import(new URL('../index.js', import.meta.url).href)

const routes = new Map()
const ctx = {
  get: (key) => (key === 'webServer' ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => {} } } : undefined),
  on: () => {},
}
mod.apply(ctx, {})

const out = []
const check = (name, ok, detail = '') => out.push({ name, ok, detail })

function report(event) {
  const res = { status: 0, body: '', writableEnded: false }
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body += body ?? ''; res.writableEnded = true }
  return routes.get('/dsh-unlag/report')({ method: 'POST', url: `/dsh-unlag/report?event=${event}`, headers: { 'x-dsh-unlag': '1' } }, res)
}
const size = () => statSync(LOG).size

// One write with a file under the cap: no restart, the line lands.
report('mounted')
check('a line under the cap is appended', size() > 0 && size() < 4096, `size=${size()}`)

// The cap is hit between two periodic checks: the next line must restart the file, never pass it.
writeFileSync(LOG, 'x'.repeat(CAP - 1))
report('held')
check('a line that would pass the cap restarts the file', size() < CAP, `size=${size()}`)

// And it holds for a burst, not just one line: many lines in a row with the file near the cap.
for (let index = 0; index < 20; index += 1) {
  writeFileSync(LOG, 'x'.repeat(CAP - 80))
  report('held')
  if (size() >= CAP) break
}
check('a burst of lines never leaves the file past the cap', size() < CAP, `size=${size()}`)

for (const { name, ok, detail } of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
const failed = out.filter((row) => row.ok !== true)
console.log(failed.length === 0 ? 'ok' : `${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
