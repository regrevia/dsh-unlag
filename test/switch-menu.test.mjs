// The button's own menu: right-click opens the two switches a press reads, and a change is saved
// through the same route the returns. A menu that showed a stale switch, or accepted a change the
// app refused, would be worse than no menu at all.
import { harness } from './support/press-harness.mjs'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const labels = (view) => {
  const found = []
  ;(function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'label') found.push(String([].concat(node.children).filter((child) => typeof child === 'string').join('')))
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  })(view.tree)
  return found.join('|')
}

const boxes = (view) => {
  const found = []
  ;(function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'input') found.push(node.props.checked === true)
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  })(view.tree)
  return found
}

// --- the menu shows what the app says, and opening it changes nothing ---------------------------
{
  const h = harness({ settings: { plugins: true, page: false } })
  // The page reports itself once when it mounts; the menu is what this block is about.
  const before = h.requests.length
  const view = await h.openMenu()
  const opened = h.requests.slice(before)
  check('the menu names the three switches', labels(view) === 'Replace plugin code|Rebuild page|Agents may refresh on their own', labels(view))
  check('and shows the switches the app answered', boxes(view).join('|') === 'true|false|false', boxes(view).join('|'))
  check('opening the menu only reads the switches', opened.every((request) => request.path.startsWith('/dsh-unlag/state')), opened.map((request) => request.path).join(','))
  check('and does not start an update', !opened.some((request) => request.path.startsWith('/dsh-unlag/reload')))
}

// --- a checkbox writes the switch, and the press that follows reads the new one ------------------
{
  const h = harness({ settings: { plugins: true, page: true } })
  await h.openMenu()
  const view = await h.toggle(0)
  const sent = h.requests.find((request) => request.path.startsWith('/dsh-unlag/switches'))
  check('the switch write names both switches', JSON.parse(sent?.init?.body ?? '{}').plugins === false && JSON.parse(sent?.init?.body ?? '{}').page === true, sent?.init?.body)
  check('the checkbox takes the answer', boxes(view).join('|') === 'false|true|false', boxes(view).join('|'))
  await h.press()
  check('the next press replaces no plugins', !h.requests.some((request) => request.path.startsWith('/dsh-unlag/reload')), h.requests.map((request) => request.path).join(','))
}

// --- a refused write puts the switch back and says so ------------------------------------------
{
  const h = harness({ settings: { plugins: true, page: true }, switchAnswer: 'error' })
  await h.openMenu()
  const view = await h.toggle(1)
  check('a refused write leaves the switch as it was', boxes(view).join('|') === 'true|true|false', boxes(view).join('|'))
  check('and the page says it did not change', h.notice() === 'Settings not changed; try again later', String(h.notice()))
}

// --- a write the app keeps for this run only says that too --------------------------------------
{
  const h = harness({ settings: { plugins: true, page: true }, switchAnswer: 'unsaved' })
  await h.openMenu()
  await h.toggle(1)
  check('a write that cannot be kept says it lasts this run', h.notice() === 'Settings apply to this run only', String(h.notice()))
}

// --- the menu is in the page's own language ----------------------------------------------------
{
  const h = harness({ settings: { plugins: false, page: true }, language: 'zh-CN' })
  const view = await h.openMenu()
  check('the Chinese menu names the switches in Chinese', labels(view) === '换掉插件代码|重建页面|Agent 可以自己刷新', labels(view))
}

// --- a page that cannot read its switches keeps the menu closed --------------------------------
{
  const h = harness({ settings: null })
  const view = await h.openMenu()
  check('an unreadable app shows no menu', boxes(view).length === 0, JSON.stringify(boxes(view)))
  check('and explains why the press is held', String(h.notice()).includes('Cannot rebuild'), String(h.notice()))
}

// --- two clicks in one tick both land, and the newest answer is the one shown ---------------
{
  const h = harness({ settings: { plugins: true, page: true }, switchDelay: 60 })
  await h.openMenu()
  const first = h.flip(0)
  const second = h.flip(1)
  await Promise.all([first, second])
  const writes = h.requests.filter((request) => request.path.startsWith('/dsh-unlag/switches')).length
  check('two clicks in one tick send two writes instead of dropping one', writes === 2, String(writes))
  check('and both choices are on screen', boxes(h.render()).join('|') === 'false|false|false', boxes(h.render()).join('|'))
}

// --- a press started while a switch is saving judges the setting the person chose --------------
{
  const h = harness({ settings: { plugins: true, page: true }, switchDelay: 120 })
  await h.openMenu()
  const first = h.flip(0)
  const second = h.flip(1)
  const pressed = h.press()
  await Promise.all([first, second, pressed])
  // Only the page half can rebuild on its own here; with both switches off a press has nothing to
  // do, which is the answer that proves it read the saves rather than the switches from before.
  const log = h.switchLog.map((entry) => entry.what)
  check('a press waits for the save in flight before reading the switches',
    log.lastIndexOf('switches-end') < log.lastIndexOf('state'), log.join('|'))
  check('and does nothing when the switches it raced left it nothing to do',
    !h.requests.some((request) => request.path.startsWith('/dsh-unlag/reload')),
    h.requests.map((request) => request.path).join(','))
}

console.log(out.join('\n'))
if (process.exitCode === 1) console.log('\nFAIL')
else console.log('\nall checks passed')
