import { composerShell, harnessWithComposer } from './support/press-harness.mjs'

// The one promise this plugin must never break: a rebuild never drops a message the person already
// wrote and that the app has not put back into the input. `press.test.mjs` covers the everyday half
// of that (one failed record, restored or not, with and without a draft beside it). This file walks
// the rest of the matrix: several records at once, a restore the app no longer accounts for, a
// composer whose snapshot is half filled, and a failure book that cannot be read at all.
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const went = (page) => page.reloads.length + page.navigations.length >= 1
const stayed = (page) => page.reloads.length === 0 && page.navigations.length === 0
const said = (page) => String(page.notice())
const holdReport = (page) => JSON.stringify({ navigations: page.navigations, reloads: page.reloads, notice: page.notice() })

// --- no failed message at all: the plain composer is not held for looking like one -------------
{
  const page = harnessWithComposer(composerShell())
  await page.press()
  check('a composer with no failed send lets the rebuild through', went(page), holdReport(page))
  check('and it is a real navigation, not a reload in place', page.navigations.length === 1, String(page.navigations.length))
}

// --- several failed sends at once --------------------------------------------------------------
// One record the app restored says nothing about the next: every waiting record is walked, and any
// single one the app did not take back holds the press.
{
  const shell = composerShell()
  shell.type('words being written')
  shell.fail('f1', { draft: 'first' })
  shell.fail('f2', { draft: 'second' })
  shell.fail('f3', { draft: 'third' })
  const page = harnessWithComposer(shell)
  await page.press()
  check('three failed sends the app never restored hold the rebuild', stayed(page), holdReport(page))
  check('and the notice says a message is not back in the input', /not back in the input|没回到输入框/u.test(said(page)), said(page))
}
// All of them restored into an empty composer: the draft store carries every one of them, so the
// next document reads them back and the rebuild does not take anything away.
{
  const shell = composerShell()
  shell.fail('f1', { draft: 'first' })
  shell.fail('f2', { draft: 'second' })
  shell.fail('f3', { draft: 'third' })
  const page = harnessWithComposer(shell)
  await page.press()
  check('three failed sends the app restored and saved do not hold the rebuild', went(page), holdReport(page))
}

// --- a restore the app no longer accounts for -------------------------------------------------
// The restore is recorded against the revision it wrote. A draft that moved on afterwards is the
// app's own signal that what the composer holds is not that restoration, so the record is still
// waiting and the press must stop even though the text looks restored.
{
  const shell = composerShell().fail('f1', { draft: 'try again' })
  shell.snapshot.draftRev = shell.snapshot.draftRev + 1
  const page = harnessWithComposer(shell)
  await page.press()
  check('a failed send the draft store no longer matches holds the rebuild', stayed(page), holdReport(page))
  check('and the notice names the failed message', /not back in the input|没回到输入框/u.test(said(page)), said(page))
}
// The restore revision is recorded but the draft revision is not a number at all: a half-filled
// snapshot is not evidence that the words were saved.
for (const [label, snapshot] of [
  ['no draft revision', { draft: 'try again', draftRev: undefined, attachmentIds: [], phase: 'idle' }],
  ['a null draft revision', { draft: 'try again', draftRev: null, attachmentIds: [], phase: 'idle' }],
  ['a draft revision as text', { draft: 'try again', draftRev: '3', attachmentIds: [], phase: 'idle' }],
]) {
  const shell = composerShell()
  shell.snapshot = snapshot
  shell.failedDetached.set('f1', { draft: 'try again', attachmentIds: [] })
  shell.failedRestoreRev = 1
  const page = harnessWithComposer(shell)
  await page.press()
  check(`a failed send with ${label} holds the rebuild`, stayed(page), holdReport(page))
}
// A composer shell with no snapshot at all: nothing claims the failure was restored, so it is held
// rather than read as an empty book.
{
  const shell = composerShell()
  shell.snapshot = null
  shell.failedDetached.set('f1', { draft: 'try again', attachmentIds: [] })
  const page = harnessWithComposer(shell)
  await page.press()
  check('a failed send under an unreadable snapshot holds the rebuild', stayed(page), holdReport(page))
}

// --- attachments travel with the failure ------------------------------------------------------
// A restored failure whose files came back to the rail is held on the files: those live in this
// document only, whatever the words do.
{
  const shell = composerShell().fail('f1', { draft: 'try again', attachmentIds: ['a1'] })
  const page = harnessWithComposer(shell)
  await page.press()
  check('a restored failure that brought files back holds the rebuild', stayed(page), holdReport(page))
  check('and the notice is about the files, not the message', /attached|附件/u.test(said(page)), said(page))
}
// The same failure with the files already sent: the record carries nothing else, so it is ordinary.
{
  const shell = composerShell().fail('f1', { draft: 'try again', attachmentIds: [] })
  const page = harnessWithComposer(shell)
  await page.press()
  check('a restored failure with no files does not hold the rebuild', went(page), holdReport(page))
}
// A restored failure on a snapshot that never had an attachment list: the revision pairing is the
// app's own proof that the words are saved, and a missing file list cannot make it a file hold.
{
  const shell = composerShell()
  shell.snapshot = { draft: 'try again', draftRev: 1, attachmentIds: undefined, phase: 'idle' }
  shell.failedDetached.set('f1', { draft: 'try again', attachmentIds: [] })
  shell.failedRestoreRev = 1
  const page = harnessWithComposer(shell)
  await page.press()
  check('a restored failure on a snapshot without a file list does not hold the rebuild', went(page), holdReport(page))
}

// --- a failure book that cannot be read -------------------------------------------------------
// A composer that answers with a book which throws is not a composer with no failures. The press
// cannot prove the message is gone, so it stays where it is and says so — the same rule the plugin
// applies to a page it cannot read.
{
  const shell = composerShell()
  shell.failedDetached = {
    values() {
      throw new Error('the failure book cannot be read')
    },
  }
  const page = harnessWithComposer(shell)
  await page.press()
  check('a failure book that throws holds the rebuild', stayed(page), holdReport(page))
  check('and the notice says a message is not back in the input', /not back in the input|没回到输入框/u.test(said(page)), said(page))
}
// The book is present but answers with garbage instead of throwing: records that are not records
// still say "something failed", and an unreadable entry is never read as an empty one.
{
  const shell = composerShell()
  shell.failedDetached = new Map([
    ['f1', null],
    ['f2', { draft: 42, attachmentIds: undefined }],
  ])
  const page = harnessWithComposer(shell)
  await page.press()
  check('a failed record with unreadable fields holds the rebuild', stayed(page), holdReport(page))
}

// --- a failure the person cleared away --------------------------------------------------------
// Several records, then the composer emptied: the app has no later path that restores a failure, so
// the records are still waiting and the draft being empty proves nothing.
{
  const shell = composerShell()
  shell.type('words being written')
  shell.fail('f1', { draft: 'first' })
  shell.fail('f2', { draft: 'second' })
  shell.clear()
  const page = harnessWithComposer(shell)
  await page.press()
  check('several failed sends hold the rebuild after the composer is emptied', stayed(page), holdReport(page))
}

// --- a held press leaves nothing behind -------------------------------------------------------
// A press that stops must not spend the pacing stamp: the person fixes the message and presses
// again in the same second, and that second press is the one that has to work.
{
  const shell = composerShell()
  shell.type('words being written')
  shell.fail('f1', { draft: 'first' })
  const page = harnessWithComposer(shell)
  await page.press()
  check('a held press writes no pacing stamp', page.stamp() === 0, String(page.stamp()))
  check('a held press leaves the button usable', page.render().button.props.style.opacity === 0.75, String(page.render().button.props.style.opacity))
  // The message comes back into the input the way the app does it, and the same page presses again.
  shell.type('')
  shell.failedDetached.clear()
  shell.failedRestoreRev = undefined
  shell.snapshot.draft = ''
  await page.press()
  check('the next press after the message came back rebuilds', page.navigations.length === 1, holdReport(page))
  check('the button was never disabled along the way', page.render().button.props.disabled !== true, String(page.render().button.props.disabled))
}

console.log(out.join('\n'))
process.exit(process.exitCode ?? 0)
