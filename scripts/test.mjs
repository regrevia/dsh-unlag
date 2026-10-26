import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Every test file is its own process: one file's globals cannot leak into the next, and a file that
// hangs is a file this runner can name. Kept in Node so the same command works on Windows, where a
// shell loop over `test/*.test.mjs` is not a thing the default shell runs.
const dir = fileURLToPath(new URL('../test/', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `${dir}${name}`)

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.error) {
    console.error(`${file}: ${result.error.message}`)
    failed += 1
    continue
  }
  if (result.status !== 0) failed += 1
}
if (failed > 0) {
  console.error(`${failed} test file(s) failed`)
  process.exit(1)
}
console.log(`${files.length} test file(s) passed`)
