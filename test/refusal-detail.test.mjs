/**
 * A refusal that says only "restart the app" leaves the person guessing about what is wrong with
 * their plugin. The app's own sentence is already in the answer, so the notice hands it over on
 * request: same press, one line, and the words behind it only when asked.
 */
import { harness } from './support/press-harness.mjs'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const refused = {
  status: 'blocked',
  reason: 'entries',
  leftOut: ['dsh-task-graph'],
  detail: 'the startup list names plugins this app no longer serves: dsh-task-graph',
}

{
  const page = harness({ verifyAnswer: refused })
  await page.press()
  const said = String(page.notice())
  check('the refusal still says what to do', /restart the app/u.test(said), said)
  check('the notice offers the reason', /Details/u.test(said), said)
  check('and hands over no words until asked', page.detail() === null, String(page.detail()))
  const raw = page.openDetail()
  check('asking shows the app sentence', /dsh-task-graph/u.test(String(raw)), String(raw))
  check('the sentence names the gate it came from', /entries/u.test(String(raw)), String(raw))
  check('and the notice is still there', /restart the app/u.test(String(page.notice())), String(page.notice()))
}

// A refusal whose answer carries no sentence shows the gate alone: the key is what the app said.
{
  const page = harness({ verifyAnswer: { status: 'blocked', reason: 'entries' } })
  await page.press()
  const raw = page.openDetail()
  check('a refusal without words still shows its gate', raw === 'entries', String(raw))
}

// A press that worked offers nothing to open: there is no refusal behind the line.
{
  const page = harness()
  await page.press()
  check('a press that worked offers no reason', page.notice() === null, String(page.notice()))
  check('and nothing to open', page.openDetail() === null, String(page.detail()))
}

// The notice speaks the language of the interface it sits in.
{
  const page = harness({ language: 'zh-CN', verifyAnswer: refused })
  await page.press()
  check('a Chinese page is told in Chinese', /重启应用/u.test(String(page.notice())), String(page.notice()))
  check('and asks for the reason in Chinese', /详情/u.test(String(page.notice())), String(page.notice()))
}

console.log(out.join('\n'))
