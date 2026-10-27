import { readdirSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test file is its own process: one file's globals cannot leak into the next, and a file that
// hangs is a file this runner can name. Kept in Node so the same command works on Windows, where a
// shell loop over `test/*.test.mjs` is not a thing the default shell runs.
const dir = fileURLToPath(new URL('../test/', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `${dir}${name}`)

let failed = 0
// The plugin reads its switches and writes its log under the home directory, so a run must not see
// the developer's own ~/.dsh: on a machine where the switch is off, every file that expects it on
// would fail. One sandbox per run, handed to every file; HOME and USERPROFILE both point at it
// because homedir() reads the latter on Windows.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-unlag-home-'))
for (const file of files) {
  const result = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: { ...process.env, DSH_UNLAG_SOURCE: 'test', HOME: sandboxHome, USERPROFILE: sandboxHome },
  })
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
