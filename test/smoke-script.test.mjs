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

// The same script against a host that answers: the verdict and the route contract it prints are
// what makes a live smoke worth running, and a skipping-only check would not notice their loss.
// The host runs as its own process: this one has to keep answering while the smoke runs.
const { spawn } = await import('node:child_process')
const HOST_PORT = 53991
const hostScript = `
const { createServer } = require('node:http')
const graph = { graph: { rev: 'rev1', entries: [], batches: [{ rev: 'r1', url: 'plugins/??@local/a/client.js&rev=r1', entries: ['@local/a'] }] } }
createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url === '/dsh-unlag/state') return req.method === 'GET' ? send(200, { version: 'x', code: 'c', shim: { wrapped: true } }) : send(405, { status: 'method' })
  if (req.url === '/dsh-unlag/graph') return req.method === 'GET' ? send(200, graph) : send(405, { status: 'method' })
  if (req.url === '/dsh-unlag/verify') return req.headers['x-dsh-unlag'] ? send(200, { status: 'blocked', reason: 'list' }) : send(403, { status: 'forbidden' })
  send(403, { status: 'forbidden' })
}).listen(${HOST_PORT}, '127.0.0.1')
`
const host = spawn(process.execPath, ['--input-type=commonjs', '-e', hostScript], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 500))
const live = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/live-smoke.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DSH_UNLAG_HOST: `http://127.0.0.1:${HOST_PORT}` },
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.on('exit', (status) => resolve({ status, stdout }))
})
host.kill()
const printed = (() => {
  try {
    return JSON.parse(live.stdout.slice(live.stdout.indexOf('{')))
  } catch {
    return null
  }
})()
const contract = printed?.contract ?? {}
const checked =
  run.status === 0 &&
  contract['state GET'] === '200' &&
  contract['state DELETE'] === '405' &&
  contract['graph PUT'] === '405' &&
  contract['reload without header'] === '403' &&
  contract['verify without header'] === '403'
console.log(`${checked ? 'PASS' : 'FAIL'}  against a host the smoke prints the route contract and passes (${JSON.stringify(printed?.contract ?? null)} ${live.status})`)
if (!checked) process.exitCode = 1

// The smoke also runs the decision a press would make before it swaps anything, so a reader learns
// whether the button would go ahead right now instead of only whether the app answers.
const pressPath = printed?.pressPath ?? null
const pressPathRight = pressPath?.ready === false && pressPath?.held === 'blocked:list'
console.log(`${pressPathRight ? 'PASS' : 'FAIL'}  the smoke prints what a press would decide (${JSON.stringify(pressPath)})`)
if (!pressPathRight) process.exitCode = 1

// The README tells a reader to run this script, so the published package has to contain it: a
// files list that forgot it is a broken instruction the repo tests would not otherwise notice.
const { readFileSync } = await import('node:fs')
const shipped = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).files
const shippedScript = shipped.includes('scripts/live-smoke.mjs')
console.log(`${shippedScript ? 'PASS' : 'FAIL'}  the package publishes the smoke the README tells a reader to run (${JSON.stringify(shipped)})`)
if (!shippedScript) process.exitCode = 1
