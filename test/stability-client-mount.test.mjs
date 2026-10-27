/**
 * Mount and unmount of the refresh button.
 *
 * The button lives in a row the host rebuilds on its own schedule, so the same component can be
 * mounted twice and thrown away while its menu is open. Every case here fails if the plugin keeps
 * something across that: a second registration, a document listener, a timer, a stale tree.
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
  // A second apply of the same context is the host replaying an injection, not a new plugin: it
  // must not register the header row twice, or the person sees two buttons.
  {
    const page = await stablePage()
    const first = page.registrations.length
    page.applyAgain()
    check('the first apply registered the header row once', first === 1, String(first))
    check('a second apply registers no second button', page.registrations.length === 1,
      page.registrations.length)
    check('and the row is offered the button once', page.components.length === 1, page.components.length)
    check('and the page is not reported as freshly mounted again',
      page.reports('event=mounted') === 1, page.reports('event=mounted'))
    check('and the boot is not announced twice', page.count('/boot') === 1, page.count('/boot'))
    check('and the first button still answers a press', page.button() !== null)
  }

  // A menu left open when the row is rebuilt takes its document listeners with it.
  {
    const page = await stablePage()
    await page.rightClick()
    check('an open menu listens for the click that closes it', page.listenerCount('document') >= 1,
      page.listenerCount('document'))
    page.unmount()
    check('unmounting removes every document listener it added',
      page.listenerCount('document') === 0, page.listenerCount('document'))
    check('and leaves no unmatched listener behind', page.listenerBalance('document') === 0,
      page.listenerBalance('document'))
    check('and the button is gone from the page', page.rendered() === false)
  }

  // Opening and closing the menu is the commonest thing a person does to this button; a listener
  // per cycle would pile up in a long session.
  {
    const page = await stablePage()
    let peak = 0
    let nodesAtRest = 0
    for (let cycle = 0; cycle < 100; cycle += 1) {
      await page.rightClick()
      peak = Math.max(peak, page.listenerCount('document'), page.listenerCount('window'))
      await page.escape()
      if (cycle === 0) nodesAtRest = page.nodeCount()
    }
    check('a hundred open and close cycles add no listener', peak <= 2, peak)
    check('and none of them is left on the document', page.listenerCount('document') === 0,
      page.listenerCount('document'))
    check('and the window is left alone', page.listenerCount('window') === 0,
      page.listenerCount('window'))
    check('and every listener removal matches an addition', page.listenerBalance('document') === 0,
      page.listenerBalance('document'))
    check('and the page does not grow a node per cycle', page.nodeCount() === nodesAtRest,
      `${nodesAtRest} -> ${page.nodeCount()}`)
    check('and the menu is closed at rest', page.menu() === null)
  }

  // The row can come back after the old one is gone: the replacement mounts cleanly, once.
  {
    const page = await stablePage()
    page.unmount()
    await page.mountRegistration(0)
    check('a remount after unmount shows the button again', page.button() !== null)
    check('and there is exactly one button node', page.buttonCount() === 1, page.buttonCount())
    check('and no error reached the page', page.errors.length === 0, page.errors.length)
  }

  console.log(out.join('\n'))
  if (failed > 0) process.exitCode = 1
}
