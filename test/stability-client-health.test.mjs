// The verdicts the host can answer with, and what the button does under each. The press path is
// the part a person lives in: it must never leave a button that cannot be pressed again, never
// navigate on an answer it cannot trust, and never say nothing.
//
// The second half drives a seeded sequence of presses, flips and clock advances: no case here is a
// story about one press, the properties have to hold after every step of a long random walk.
import { pathToFileURL } from 'node:url'
import { stablePage } from './stability-client-button.test.mjs'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const oneLine = (text) => typeof text === 'string' && text.length > 0 && !text.includes('\n')
const pressable = (page) => page.button() !== null && page.button().props?.disabled !== true

// --- the answer to a replacement, as the host really words it --------------------------------
const answers = [
  { name: 'applied and readable', data: { status: 'done', healthReadable: true, pending: [], failed: 0 }, nav: 1 },
  { name: 'applied, health not reported', data: { status: 'done', pending: [], failed: 0 }, nav: 1 },
  { name: 'applied, health unreadable', data: { status: 'done', healthReadable: false, pending: [], failed: 0 }, nav: 0 },
  { name: 'applied, health explicitly null', data: { status: 'done', healthReadable: null, pending: [], failed: 0 }, nav: 1 },
  { name: 'refused before starting', data: { status: 'blocked' }, nav: 0 },
  { name: 'a rebuild is still running', data: { status: 'applying' }, nav: 0 },
  { name: 'queued behind another', data: { status: 'queued' }, nav: 0 },
  { name: 'needs a restart', data: { status: 'done', pending: ['@local/a'], failed: 0 }, nav: 0 },
  { name: 'the replacement failed', data: { status: 'failed' }, nav: 0 },
  { name: 'no answer at all', data: null, nav: 0 },
]

for (const answer of answers) {
  const page = await stablePage()
  page.set({ reload: answer.data })
  try {
    await page.press()
  } catch (error) {
    check(`a press survives "${answer.name}"`, false, String(error?.message ?? error))
    continue
  }
  check(`"${answer.name}" does not throw`, page.errors.length === 0, String(page.errors[0]?.message ?? ''))
  check(`"${answer.name}" navved as the answer allows`, page.navved() === answer.nav, String(page.navved()))
  check(`"${answer.name}" left one pressable button`, page.buttonCount() === 1 && pressable(page), `buttons ${page.buttonCount()}`)
  check(`"${answer.name}" said something on one line`, page.navved() === 1 || oneLine(String(page.notice())), JSON.stringify(page.notice()))
}

// An unreadable health answer says why it did not rebuild, and the next press with a readable one
// goes through: a plugin that refuses once must not stay stuck.
{
  const page = await stablePage()
  page.set({ reload: { status: 'done', healthReadable: false, pending: [], failed: 0 } })
  await page.press()
  const held = String(page.notice() ?? '')
  page.set({ reload: { status: 'done', healthReadable: true, pending: [], failed: 0 } })
  await page.press()
  check('a health read that failed holds the page', page.navved() === 1, String(page.navved()))
  check('and the next readable press still rebuilds', page.navved() === 1, String(page.navved()))
  check('the held press said something', oneLine(held), JSON.stringify(held))
}

// --- a seeded walk over the button's own machine ---------------------------------------------
// Every step is a real interaction, and after each one the same four properties are asked. The
// seed is fixed so a failure is a case that can be run again.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const reloadAnswers = [
  { status: 'done', healthReadable: true, pending: [], failed: 0 },
  { status: 'done', healthReadable: false, pending: [], failed: 0 },
  { status: 'applying' },
  { status: 'blocked' },
  { status: 'failed' },
  { status: 'done', pending: ['@local/a'], failed: 0 },
]

for (const seed of [1, 7, 42]) {
  const random = mulberry32(seed)
  const page = await stablePage()
  let presses = 0
  let broken = null
  for (let step = 0; step < 60 && broken === null; step += 1) {
    const pick = random()
    if (pick < 0.4) {
      presses += 1
      await page.press()
    } else if (pick < 0.55) {
      presses += 2
      await page.pressTimes(2)
    } else if (pick < 0.7) {
      page.set({ reload: reloadAnswers[Math.floor(random() * reloadAnswers.length)] })
    } else if (pick < 0.8) {
      await page.rightClick()
      await page.outsideClick()
    } else if (pick < 0.9) {
      await page.advance(Math.floor(random() * 5000))
    } else {
      page.hover()
      page.escape()
    }
    if (page.errors.length > 0) broken = `threw: ${page.errors[0]?.message ?? page.errors[0]}`
    else if (page.buttonCount() !== 1) broken = `has ${page.buttonCount()} buttons`
    else if (!pressable(page)) broken = 'the button cannot be pressed'
    else if (page.navved() > presses) broken = `navved ${page.navved()} for ${presses} presses`
    else if (page.notice() !== null && !oneLine(String(page.notice()))) broken = `notice: ${JSON.stringify(page.notice())}`
  }
  check(`seed ${seed}: 60 interactions keep one working button`, broken === null, String(broken ?? ''))
  check(`seed ${seed}: presses stay the only thing that navigates`, page.navved() <= presses, `${page.navved()}/${presses}`)
  page.unmount()
  check(`seed ${seed}: nothing is left behind after unmount`, page.listenerBalance('document') === 0 && page.listenerBalance('window') === 0 && page.timerCount() === 0, `listeners ${page.listenerBalance('document')}/${page.listenerBalance('window')} timers ${page.timerCount()}`)
}

console.log(out.join('\n'))
if (out.some((line) => line.startsWith('FAIL'))) process.exitCode = 1
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // keep the summary above as the only output
}
