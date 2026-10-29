/**
 * The menu behind the button, and the switch saves it starts.
 *
 * An open menu owns document listeners and a save owns a request; both have to survive a press, a
 * lost window, and a row that is rebuilt underneath them without doubling or leaking.
 */
import { pathToFileURL } from 'node:url'
import { stablePage } from './stability-client-button.test.mjs'

const out = []
let failed = 0

function check(label, ok, extra = '') {
  if (ok) out.push(`PASS  ${label}${extra === '' ? '' : `  (${extra})`}`)
  else {
    failed += 1
    out.push(`FAIL  ${label}${extra === '' ? '' : `  (${extra})`}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // A click anywhere else is the way most people close this menu, and it must not leave the key
  // listener behind with it.
  {
    const page = await stablePage()
    await page.rightClick()
    check('a right click opens the menu', page.menu() !== null)
    page.outsideClick()
    check('a click outside closes it', page.menu() === null)
    check('and its listeners go with it', page.listenerCount('document') === 0,
      page.listenerCount('document'))
    check('and every removal matches an addition', page.listenerBalance('document') === 0,
      page.listenerBalance('document'))
  }

  {
    const page = await stablePage()
    await page.rightClick()
    page.escape()
    check('escape closes the menu', page.menu() === null)
    check('and takes its listeners with it', page.listenerCount('document') === 0,
      page.listenerCount('document'))
    const other = await stablePage()
    await other.rightClick()
    other.otherKey('a')
    check('another key leaves the menu open', other.menu() !== null)
  }

  // Switching away from the window is the case the checklist names: a menu that stays open on a
  // window the person left is a menu nobody can see to close.
  {
    const page = await stablePage()
    await page.rightClick()
    page.blur()
    check('leaving the window closes the menu', page.menu() === null)
    check('and its listeners go with it', page.listenerCount('document') === 0,
      page.listenerCount('document'))
    check('and no window listener is left behind', page.listenerCount('window') === 0,
      page.listenerCount('window'))
  }

  // Pressing again on an open menu is not a second menu: the listeners are added once per open.
  {
    const page = await stablePage()
    await page.rightClick()
    const after = page.listenerCount('document')
    await page.rightClick()
    check('a second right click adds no second listener', page.listenerCount('document') === after,
      `${after} -> ${page.listenerCount('document')}`)
    check('and leaves one menu open', page.menu() !== null)
    page.escape()
    check('and one escape still closes it', page.menu() === null)
  }

  // Two flips of one switch before the first save is answered are two saves, in order: dropping the
  // second would leave the box showing a choice the app never got.
  {
    const page = await stablePage()
    await page.rightClick()
    await page.toggleTwice(0)
    const writes = page.switchesRequests()
    check('two flips of one switch both reach the app', writes.length === 2, writes.length)
    check('and the second write carries the choice the box shows',
      writes.map((entry) => JSON.parse(entry.init?.body ?? '{}').plugins).join('|') === 'false|true',
      writes.map((entry) => JSON.parse(entry.init?.body ?? '{}').plugins).join('|'))
    check('and the boxes end on that choice', page.checkboxes()[0].props.checked === true,
      page.checkboxes()[0].props.checked)
  }

  // A press during a save must not leave the menu open over a document that is being replaced, and
  // the save that was in flight must not be repeated by the press.
  {
    const page = await stablePage()
    await page.rightClick()
    const box = page.checkboxes()[0]
    const saving = box.props.onChange()
    await page.press()
    await saving
    check('a press closes the menu', page.menu() === null)
    check('and leaves no document listener behind', page.listenerCount('document') === 0,
      page.listenerCount('document'))
    check('and the save was sent once', page.switchesRequests().length === 1,
      page.switchesRequests().length)
    check('and the page is replaced once', page.navved() >= 1, page.navved())
  }

  // When the press navigates, the page that says "it stayed" is a fallback for a navigation that
  // did not happen; it must not outlive the row it would talk to.
  {
    const page = await stablePage()
    await page.press()
    check('a press that navigates leaves one timer to come back', page.timerCount() === 1,
      page.timerCount())
    page.unmount()
    check('unmounting clears that timer too', page.timerCount() === 0, page.timerCount())
    await page.advance(12000)
    check('and nothing writes to the page hours later', page.errors.length === 0, page.errors.length)
  }

  console.log(out.join('\n'))
  if (failed > 0) process.exitCode = 1
}
