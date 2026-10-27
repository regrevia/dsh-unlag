import { fileURLToPath } from 'node:url'
// A test run must not write into the record a person reads after a real press. Every file that
// loads the plugin's own code can reach the log, so each one has to point it somewhere temporary.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('.', import.meta.url))
const loadsPlugin = (source) => /from '\.\.\/index\.js'|import\('\.\.\/index\.js'\)/u.test(source)

const offenders = []
for (const name of readdirSync(dir).filter((file) => file.endsWith('.test.mjs') && file !== 'log-isolation.test.mjs')) {
  const source = readFileSync(join(dir, name), 'utf8')
  if (loadsPlugin(source) === false) continue
  if (source.includes('DSH_UNLAG_LOG') === false && source.includes('DSH_UNLAG_HOME') === false) offenders.push(name)
}

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
check('every test that loads the plugin points its log somewhere temporary', offenders.length === 0, offenders.join(', '))
console.log(out.join('\n'))
