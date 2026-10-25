// A hold is only honest if the person is told the real reason. The host names a reason in its
// verdict; the page turns that name into a line. A reason with no line falls back to a generic one
// that points at the wrong thing, so every name the host can send has to have copy on both
// languages, and the two tables have to name the same set.
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`ok - ${name}`)
  } else {
    fail += 1
    console.log(`not ok - ${name}${detail === '' ? '' : `: ${detail}`}`)
  }
}

const tableKeys = (line) => {
  const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  return [...body.matchAll(/([a-z]+): '([^']*)'/gu)].map((match) => ({ key: match[1], copy: match[2] }))
}
const zhLine = client.split('\n').find((line) => line.includes("? { list: '读不到启动信息'"))
const enLine = client.split('\n').find((line) => line.includes(": { list: 'startup info is unavailable'"))
check('the copy tables are readable', Boolean(zhLine && enLine))
const zh = tableKeys(zhLine)
const en = tableKeys(enLine)
const zhKeys = zh.map((item) => item.key).sort()
const enKeys = en.map((item) => item.key).sort()
check('both languages name the same reasons', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `${zhKeys.join(',')} | ${enKeys.join(',')}`)
check('no reason has empty copy', zh.every((item) => item.copy.trim() !== '') && en.every((item) => item.copy.trim() !== ''))

// Every status the host can answer a check or a press with, minus 'ok' which is not a hold.
const hostReasons = [...new Set([...host.matchAll(/reason: '([a-z]+)'/gu)].map((match) => match[1]))].filter((reason) => reason !== 'ok').sort()
check('the host names reasons at all', hostReasons.length >= 8, String(hostReasons.length))
const missing = hostReasons.filter((reason) => !enKeys.includes(reason))
check('every reason the host sends has copy', missing.length === 0, missing.join(','))
check('and the copy is not the generic fallback for the newest ones', !['busy', 'network', 'register', 'missing', 'dependencies'].some((reason) => !enKeys.includes(reason)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
