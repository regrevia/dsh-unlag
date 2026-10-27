/**
 * Soak: a seeded stream of hostile operations, with the thresholds that make the run a check
 * instead of a log line. The budget comes from `DSH_UNLAG_SOAK_MS`, capped here so this file can
 * always live inside the suite's time limit; the long form is `node scripts/soak.mjs`.
 *
 * Run: node test/soak-long.test.mjs
 *      DSH_UNLAG_SOAK_MS=20000 DSH_UNLAG_SOAK_SEEDS=1,2 node test/soak-long.test.mjs
 */

import { formatMetrics, removeChaosHome, runSoak } from '../scripts/soak.mjs'

const CAP_MS = 8000
const requested = Number(process.env.DSH_UNLAG_SOAK_MS ?? '')
const budget = Number.isFinite(requested) && requested > 0 ? Math.min(requested, CAP_MS) : 3000
const previous = process.env.DSH_UNLAG_SOAK_MS
process.env.DSH_UNLAG_SOAK_MS = String(budget)

const seeds = (process.env.DSH_UNLAG_SOAK_SEEDS ?? '1,2')
  .split(',')
  .map((text) => Number(text.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
  .slice(0, 4)

let failures = 0

function check(label, ok, extra = '') {
  if (ok) {
    console.log(`PASS ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${extra === '' ? '' : ` -- ${extra}`}`)
}

const started = process.hrtime.bigint()
const result = await runSoak({
  seeds: seeds.length > 0 ? seeds : [1],
  opsPerSeed: 400,
  answerMs: 20,
  timeoutMs: 30,
  heapGrowthMb: 48,
  rssGrowthMb: 320,
  p99Ms: 2000,
  maxTimers: 512,
})
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

if (previous === undefined) delete process.env.DSH_UNLAG_SOAK_MS
else process.env.DSH_UNLAG_SOAK_MS = previous

for (const run of result.runs) console.log(formatMetrics(run))
console.log(`\n${result.runs.length} seed(s), ${result.ops} ops, ${result.presses} presses in ${elapsedMs.toFixed(0)}ms`)

check('the soak made a stream, not a single press', result.ops > 0 && result.presses > 0, `${result.ops} ops / ${result.presses} presses`)
check('presses actually reached the swap', result.applies > 0, `${result.applies} updates`)
check('every seed held every invariant', result.violations.length === 0, result.violations.slice(0, 8).join(' | '))
check('the route answered inside its p99 threshold', result.p99 <= 2000, `p99 ${result.p99.toFixed(1)}ms`)
check('the whole run fits in the suite budget', elapsedMs < 90_000, `${elapsedMs.toFixed(0)}ms`)

for (const run of result.runs) {
  check(`seed ${run.seed}: heap stayed flat`, run.heapGrowthMb <= 48, `${run.heapGrowthMb.toFixed(1)}MB`)
  check(`seed ${run.seed}: rss stayed flat`, run.rssGrowthMb <= 320, `${run.rssGrowthMb.toFixed(1)}MB`)
  check(`seed ${run.seed}: no timer pile-up`, run.timersMax <= 512, `${run.timersMax} timers`)
  check(`seed ${run.seed}: press memory stayed bounded`, run.pressesHeld <= 32, `${run.pressesHeld} rows`)
  check(`seed ${run.seed}: live press rows stayed bounded`, run.liveHeld <= 128, `${run.liveHeld} rows`)
  check(`seed ${run.seed}: globalThis stayed bounded`, run.globals <= 10, `${run.globals} entries`)
  check(`seed ${run.seed}: no update ran next to another`, run.maxConcurrent <= 1, `${run.maxConcurrent} at once`)
  check(`seed ${run.seed}: every answer carried a status`, run.statusCounts !== undefined && Object.keys(run.statusCounts).length > 0)
}

removeChaosHome()

if (failures > 0) {
  console.log(`failed: ${failures} check(s)`)
  process.exitCode = 1
} else {
  console.log('ok')
}
