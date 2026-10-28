// The four gates a press must keep, on the one press harness the suite shares:
// - A1 a save window with an edit landing in it is not a page the rebuild may walk away from;
// - A2 a failed send whose words are not back is held on the words, whatever files it carried;
// - A3 a press that outlived the page's patience is read from the update's own end, not re-said;
// - A4 a picked file is discarded only when it is the same file the person was told about.
// The client source is a parameter so this file can be pointed at a shipped copy and prove the
// gates were missing there.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const out = []
function check(label, ok, extra = '') {
  out.push(`${ok ? 'PASS' : 'FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`)
  if (!ok) process.exitCode = 1
}

const clientPath = process.env.DSH_UNLAG_CLIENT ?? fileURLToPath(new URL('../client.js', import.meta.url))
const sourceText = readFileSync(clientPath, 'utf8')

// Two branches of the shared harness stand between a test and the gates themselves, and neither is
// about the button: its file picker answers with a stub whose `files` cannot be walked (so a picked
// file has no content identity at all), and its /state only carries an operation once a reload has
// finished (so a press stalled inside a reload cannot be asked about). The harness source is shared
// read-only; this copy teaches those two branches and leaves every other line as it is.
const harnessFile = join(tmpdir(), `client-gates-harness-${process.pid}.mjs`)
const pickerStub = 'return Array.from({ length: draftFiles }, () => ({ files: { length: 1 } }))'
const operationGate = 'replaced && lateOperation !== null'
const harnessSource = readFileSync(new URL('./support/press-harness.mjs', import.meta.url), 'utf8')
if (!harnessSource.includes(pickerStub) || !harnessSource.includes(operationGate)) {
  throw new Error('press-harness changed under client-gates: update the two branches this file teaches')
}
const taught = harnessSource
  .replace(pickerStub, 'return Array.isArray(draftFiles) ? (draftFiles.length === 0 ? [] : [{ files: draftFiles }]) : Array.from({ length: draftFiles }, () => ({ files: { length: 1 } }))')
  .replace(operationGate, 'lateOperation !== null')
writeFileSync(harnessFile, taught)
const { harnessForSource, harnessWithComposer, composerShell } = await import(pathToFileURL(harnessFile).href)

try {
  // A1: the word the person is writing when the save runs.
  {
    const shell = composerShell()
    let saves = 0
    let addressedBeforeSave = false
    let page = null
    page = harnessWithComposer(shell, {
      sourceText,
      hold: (event) => {
        if (event.type !== 'dsh-unlag:before') return
        saves += 1
        if (saves === 1) {
          // The next page was already confirmed when the plugins were first asked to save.
          addressedBeforeSave = page.requests.some((entry) => entry.path.includes('interface='))
          // A keystroke lands while the plugins are saving: it is newer than every save so far.
          shell.type('half-written sentence')
        } else if (String(shell.snapshot.draft) !== '') {
          // The plugin refuses to save while the person is writing, as the shipped one does.
          event.preventDefault()
        }
      },
    })
    await page.press()
    check('A1 the next page is confirmed before the plugins are asked to save', addressedBeforeSave === true, `addressed=${String(addressedBeforeSave)} saves=${saves}`)
    check('A1 the plugin holds the page for the edit that landed during the save', page.navigations.length === 0 && saves >= 2, `navigations=${page.navigations.length} saves=${saves}`)
    check('A1 the person is told the page stayed because of unsaved work', /Unsaved changes/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
  }

  // A2: a failed send from an app whose record keeps words and files, with newer words in the field.
  {
    const shell = composerShell().type('newer words').fail('f1', { draft: 'try again', attachmentIds: ['a1'] })
    const page = harnessWithComposer(shell, { sourceText })
    await page.press()
    check('A2 words no restore accounts for hold the page, even with a file in the record', page.navigations.length === 0 && /failed message is not back in the input/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
  }
  {
    // The same record with no words is only a file question: it still goes to the discard sentence.
    const shell = composerShell().fail('f1', { draft: '', attachmentIds: ['a1'] })
    const page = harnessWithComposer(shell, { sourceText })
    await page.press()
    check('A2 a record that restores its words keeps its file question', page.navigations.length === 0 && /Files are attached but not sent/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
  }

  // A3: the app's own patience runs out before the update does.
  {
    const page = harnessForSource(sourceText, {
      reload: { status: 'applying' },
      lateOperation: (requestId) => ({ requestId, status: finished ? 'done' : 'applying' }),
    })
    let finished = false
    const running = page.press()
    // The update has been written down and the page is now waiting on it: this is the window that
    // outlives the press's own deadline on a slow app.
    const stateReads = () => page.requests.filter((entry) => entry.path.startsWith('/dsh-unlag/state')).length
    for (let tick = 0; tick < 400 && stateReads() < 2; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (stateReads() < 2) throw new Error('the press never asked the app how its update was doing')
    const deadline = page.scheduled.find((entry) => entry.ms === 45000)
    if (deadline === undefined) throw new Error('the press never armed its deadline')
    deadline.fn()
    check('A3 the deadline ends the wait and says the page stayed', /No answer in time/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
    const askedBefore = page.requests.filter((entry) => entry.path.startsWith('/dsh-unlag/state')).length
    finished = true
    await page.press()
    const askedAfter = page.requests.filter((entry) => entry.path.startsWith('/dsh-unlag/state')).length
    check('A3 the next press asks the update how it ended', askedAfter > askedBefore, `state reads ${askedBefore} -> ${askedAfter}`)
    check('A3 the answer is the update\'s end, not "still applying"', /Plugin code updated/u.test(page.notice() ?? '') && !/Still applying this update/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
    await running
    check('A3 the update that passed its deadline never rebuilds the page behind the notice', page.navigations.length === 0, `navigations=${page.navigations.length}`)
  }

  // A4: two files with one name and one size are still two files.
  {
    const files = [new File(['aaaa'], 'report.pdf')]
    const page = harnessForSource(sourceText, { draftFiles: files })
    await page.press()
    check('A4 the first press asks about the picked file', /Files are attached but not sent/u.test(page.notice() ?? ''), `notice=${String(page.notice())}`)
    files[0] = new File(['bbbb'], 'report.pdf')
    await page.press()
    check('A4 a different file with the same name and size is asked about again', page.navigations.length === 0 && /Files are attached but not sent/u.test(page.notice() ?? ''), `navigations=${page.navigations.length} notice=${String(page.notice())}`)
    await page.press()
    check('A4 the same file, pressed again, is the one the person agreed to give up', page.navigations.length === 1, `navigations=${page.navigations.length}`)
  }
} finally {
  rmSync(harnessFile, { force: true })
}

console.log(out.join('\n'))
