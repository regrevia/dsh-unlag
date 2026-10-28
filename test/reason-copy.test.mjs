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

// A frozen startup list cannot be changed by pressing again, so the line for it must not send the
// person back to the button. It says what actually changes: reopening the app.
const bootZh = zh.find((item) => item.key === 'boot')?.copy ?? ''
const bootEn = en.find((item) => item.key === 'boot')?.copy ?? ''
check('the frozen-list line does not ask for another press', !/再按|再刷新|再试/u.test(bootZh) && !/press again|try again/iu.test(bootEn), `${bootZh} | ${bootEn}`)
check('and it names what puts the new code in the page', /重开应用|重启应用/u.test(bootZh) && /reopen the app/iu.test(bootEn), `${bootZh} | ${bootEn}`)
check('the transient swap line still allows another press', /再按一次/u.test(zh.find((item) => item.key === 'generation')?.copy ?? '') && /press again/iu.test(en.find((item) => item.key === 'generation')?.copy ?? ''))

// The detail behind a notice is read inside the notice: the card grows downwards and the detail is
// in flow. A second absolutely placed box beside it was outside the card and under the page.
const style = (name) => {
  const at = client.indexOf(`const ${name} = {`)
  return at === -1 ? '' : client.slice(at, client.indexOf('};', at))
}
const pillStyle = style('PILL_STYLE')
const rawStyle = style('RAW_STYLE')
// A short sentence gets a short card: the box hugs its words and only wraps when they reach the
// reading width, so the frame matches the line instead of standing 340px wide around six characters.
check('the notice card may wrap its line', pillStyle !== '' && pillStyle.includes("whiteSpace: 'normal'"), pillStyle.slice(0, 160))
check('and its width follows the words up to the reading width', pillStyle.includes("maxWidth: 'min(340px, 82vw)'") && !/\n\s+width:/u.test(pillStyle), pillStyle.slice(0, 200))
check('the detail is laid out inside the card, not absolutely beside it', rawStyle !== '' && !rawStyle.includes("position: 'absolute'"), rawStyle.slice(0, 120))
check('an opened detail keeps the notice on screen', /if \(showRaw\) return undefined/u.test(client))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
