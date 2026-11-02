import { harness } from './support/press-harness.mjs'

// The plugin now also runs in a browser tab: `dsh web` serves the same interface to a page with no
// desktop bridge. That page must get the button and must come back on its own address, while the
// desktop build keeps the address its frozen startup list makes it ask for. These cases drive the
// real handler with the two environments the same code has to tell apart.
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const count = (requests, piece) => requests.filter((request) => request.path.startsWith(piece)).length
const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'

// --- a browser tab: the button is there and a press comes back where it already is -------------
{
  const page = harness({ userAgent: chrome, desktopBridge: false, href: 'http://127.0.0.1:3080/' })
  check('a browser tab gets the button', page.render().button !== null, String(page.render().button))
  await page.press()
  check('a browser-tab press asks for the plugin swap once', count(page.requests, '/dsh-unlag/reload') === 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('a browser-tab press proves the next page boots', count(page.requests, '/dsh-unlag/verify') === 1)
  check('a browser-tab press navigates once', page.navigations.length === 1, String(page.navigations.length))
  check('a browser tab comes back on its own address', page.navigations[0] === 'http://127.0.0.1:3080/', String(page.navigations[0]))
  check('a browser tab never asks for an old interface generation', String(page.navigations[0]).includes('interface=') === false, String(page.navigations[0]))
  check('a browser-tab press shows nothing to fix', page.notice() === null, String(page.notice()))
}

// --- the stamp an earlier press left is not carried into the next address ----------------------
{
  const page = harness({ userAgent: chrome, desktopBridge: false, href: 'http://127.0.0.1:3080/?interface=old' })
  await page.press()
  check('a stamped browser address comes back unstamped', page.navigations[0] === 'http://127.0.0.1:3080/', String(page.navigations[0]))
}

// --- the outcome is written down where the desktop build writes it ----------------------------
{
  const page = harness({ userAgent: chrome, desktopBridge: false, href: 'http://127.0.0.1:3080/' })
  await page.press()
  check(
    'a browser-tab press writes its outcome to the app log',
    page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('event=rebuild')),
  )
  check(
    'and that line names the page generation that came up',
    page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('&rev=live')),
  )
}

// --- the desktop build keeps its own address, frozen startup list and all ---------------------
{
  const page = harness()
  await page.press()
  check('the desktop build still enters the frozen address', page.navigations[0] === 'http://127.0.0.1:62542/?interface=live', String(page.navigations[0]))
}

// --- a shell whose bridge has not answered yet is still the desktop build ---------------------
{
  const page = harness({ desktopBridge: false, href: 'http://127.0.0.1:3080/' })
  await page.press()
  check('an Electron page without a bridge stays on the desktop path', page.navigations[0] === 'http://127.0.0.1:3080/?interface=live', String(page.navigations[0]))
}

console.log(out.join('\n'))
