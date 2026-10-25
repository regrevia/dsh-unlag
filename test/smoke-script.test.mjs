import { spawnSync } from 'node:child_process'

// The smoke walks the shipped page half and the shipped host half against a running app. Where no
// app listens it has to say so and pass, or the script rots into something that fails on any
// machine without this app open.
const run = spawnSync(process.execPath, ['scripts/live-smoke.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, DSH_UNLAG_HOST: 'http://127.0.0.1:1' },
  encoding: 'utf8',
  timeout: 30000,
})
const passed = run.status === 0 && /skip: no host/u.test(run.stdout)
console.log(`${passed ? 'PASS' : 'FAIL'}  without a running app the smoke says skip and passes (${JSON.stringify(run.stdout.trim())})`)
if (!passed) process.exitCode = 1
