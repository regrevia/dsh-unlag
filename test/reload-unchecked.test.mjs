import { harness } from './support/press-harness.mjs'

// A press must not be turned away by a check that never got an answer. Two kinds of "the address
// did not answer" are kept apart: a page that says it has no page here keeps the document, because
// entering it would leave nothing to read; a check that could not read the page at all is said out
// loud, and the next press inside the minute goes ahead with it.
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const held = (page, gate) => page.requests.some((request) => request.path.includes('event=held') && request.path.includes(`gate=${encodeURIComponent(gate)}`))

// --- a page that never answers: the press says so, keeps the document, and can be pressed again --
{
  const page = harness({ documentAnswers: 'silent', href: 'http://127.0.0.1:62542/' })
  const view = await page.press()
  check('a page that never answered does not replace the document', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('a page that never answered is named as unchecked', /could not be confirmed/.test(String(page.notice())), String(page.notice()))
  check('a page that never answered keeps the button usable', view.button.props.style.opacity === 0.75, String(view.button.props.style.opacity))
  check('the log says the check did not answer', held(page, 'applied:document:noanswer'), JSON.stringify(page.requests.filter((request) => request.path.includes('event=held')).map((request) => request.path)))
  await page.press()
  check('the second press goes ahead with the same address', page.navigations.length === 1, String(page.navigations.length))
  check('the second press leaves no notice behind', page.notice() === null, String(page.notice()))
}

// --- a page that says there is no page here: the document stays, no matter how often one presses -
{
  const page = harness({ documentAnswers: false, href: 'http://127.0.0.1:62542/' })
  await page.press()
  await page.press()
  check('a page that answers 404 is never entered', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('a page that answers 404 says the new page did not come up', /new page did not come up/.test(String(page.notice())), String(page.notice()))
  check('the log names the answer that refused', held(page, 'applied:document:http:404'), JSON.stringify(page.requests.filter((request) => request.path.includes('event=held')).map((request) => request.path)))
}

// --- a document that just came out of a rebuild does not rebuild itself again on the next press --
{
  const page = harness({ rebuiltMark: { rev: 'live', at: Date.now() - 1000 } })
  const view = await page.press()
  check('a fresh rebuild is not replaced again', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('a fresh rebuild says so', /Just rebuilt/.test(String(page.notice())), String(page.notice()))
  check('a fresh rebuild touches no plugin code', page.requests.filter((request) => request.path.startsWith('/dsh-unlag/reload')).length === 0)
  check('a fresh rebuild leaves the button usable', view.button.props.style.opacity === 0.75)
}

// --- a mark that belongs to another page generation does not hold anything back -----------------
{
  const page = harness({ rebuiltMark: { rev: 'older', at: Date.now() - 1000 } })
  await page.press()
  check('a mark from another generation does not stop a press', page.navigations.length === 1, String(page.navigations.length))
}

// --- an old mark does not hold a press either ---------------------------------------------------
{
  const page = harness({ rebuiltMark: { rev: 'live', at: Date.now() - 120000 } })
  await page.press()
  check('an expired mark does not stop a press', page.navigations.length === 1, String(page.navigations.length))
}


// --- a check the app refuses for every address says nothing about the page it asked for ---------
{
  const page = harness({ documentAnswers: 'refused', href: 'http://127.0.0.1:62542/' })
  await page.press()
  check('a check the app refuses does not hold the press', page.navigations.length === 1, JSON.stringify(page.navigations))
  check('a check the app refuses shows nothing to fix', page.notice() === null, String(page.notice()))
  check('the log says the check was refused, not the page', page.requests.some((request) => request.path.includes('event=rebuild') && request.path.includes(encodeURIComponent('refused:http:401'))), JSON.stringify(page.requests.filter((request) => request.path.includes('event=rebuild')).map((request) => request.path)))
}

console.log(out.join('\n'))
