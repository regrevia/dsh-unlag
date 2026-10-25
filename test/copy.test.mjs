// The press explains itself with one short sentence chosen from two tables: the gates the checks
// use, and the words the person reads. A gate added to one table and not the other has already
// produced a sentence about the wrong thing once, so the two tables are held against each other.
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const block = (marker) => {
  const at = source.indexOf(marker)
  if (at < 0) return ''
  const open = source.indexOf('{', at)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return ''
}

const keysOf = (text) => [...text.matchAll(/(?:^|[,{\s])([a-z]+):\s*(?:'|`|"|\n)/gu)].map((match) => match[1])

const gateText = block('const VERIFY_GATES =')
const reasonAt = source.indexOf('const REASONS = zh')
const reasonBody = source.slice(reasonAt, source.indexOf(';', source.indexOf('}', source.indexOf(':', source.indexOf('? {', reasonAt)))))
const zhText = reasonBody.slice(0, reasonBody.indexOf('}'))
const enText = reasonBody.slice(reasonBody.indexOf('{', reasonBody.indexOf(':')) + 1, reasonBody.lastIndexOf('}'))

const gates = new Map(
  [...gateText.matchAll(/([a-z]+):\s*'([a-z]+)'/gu)].map((match) => [match[1], match[2]]),
)
const zh = new Map([...zhText.matchAll(/([a-z]+):\s*'([^']*)'/gu)].map((match) => [match[1], match[2]]))
const en = new Map([...enText.matchAll(/([a-z]+):\s*'([^']*)'/gu)].map((match) => [match[1], match[2]]))

check('the gate table is not empty', gates.size >= 8, String(gates.size))
check('the words table is not empty', zh.size >= 10, String(zh.size))
check('every refusal the checks raise has words', [...gates.values()].every((key) => zh.has(key)), [...gates.values()].filter((key) => !zh.has(key)).join(',') || 'all')
check('and the two languages name the same refusals', zh.size === en.size && [...zh.keys()].every((key) => en.has(key)), `${zh.size}/${en.size}`)
check('no refusal is left without words', [...zh.keys()].every((key) => en.get(key) !== undefined && en.get(key) !== ''), '')
check('the words differ between languages', [...zh.keys()].every((key) => zh.get(key) !== en.get(key)), '')
const gateKeys = keysOf(gateText)
check('the gate keys are read from the source they name', gateKeys.length === gates.size, `${gateKeys.length}/${gates.size}`)
check('the slow answer keeps its own words', gates.get('slow') === 'slow' && zh.get('slow') !== zh.get('script'), `${gates.get('slow')}:${zh.get('slow')}`)

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
