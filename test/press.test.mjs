import { readFile } from 'node:fs/promises'
import { harness, graph, rows } from './support/press-harness.mjs'

// A press is the one action this plugin exists for, and it runs in a page that can go away at any
// moment. These cases drive the real button handler in a sandbox: the press must end in exactly one
// of three ways (one navigation, one notice, or one honest hold), it must never run twice at once,
// and no answer from the app may leave the button grey.
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const count = (requests, piece) => requests.filter((request) => request.path.startsWith(piece)).length

// --- a plain press: replace the plugins, prove the next page boots, then navigate once ---------
{
  const page = harness()
  await page.press()
  check('a press asks the app to replace plugins once', count(page.requests, '/dsh-unlag/reload') === 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('a press proves the next page boots before leaving', count(page.requests, '/dsh-unlag/verify') === 1)
  check('a press navigates exactly once', page.navigations.length === 1, String(page.navigations.length))
  check('the new page keeps the address it already had', page.navigations[0]?.includes('interface=live') === true, String(page.navigations[0]))
  check('a press writes its outcome to the app log', page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('event=rebuild')))
  check(
    'that line says which page generation came up',
    page.requests.some((request) => request.path.includes('/dsh-unlag/report') && request.path.includes('&rev=live')),
  )
  check('a plain press shows nothing to fix', page.notice() === null, String(page.notice()))
}

// --- a page that holds the navigation must not leave the button waiting forever ----------------
{
  const page = harness()
  await page.press()
  const wait = page.scheduled.find((entry) => entry.ms === 6000)
  check('a rebuild arms a way back for a navigation the page holds', wait !== undefined, JSON.stringify(page.scheduled.map((entry) => entry.ms)))
  wait.fn()
  const view = page.render()
  check('a held navigation leaves the button usable', view.button.props.style.opacity === 0.75, String(view.button.props.style.opacity))
  check('a held navigation says the page did not rebuild', /page did not rebuild/.test(String(page.notice())), String(page.notice()))
  // The notice may only claim the plugins changed when this press really replaced them.
  check('a held navigation says the code went live too', /Plugin code updated/.test(String(page.notice())), String(page.notice()))
  check('a held navigation says why', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('gate=navigation')))
}

// --- a handler that answers with a message is a page that holds the navigation -----------------
// `event.returnValue = false` was the only shape checked, so a plugin that says "unsaved work" by
// returning a message was judged ready: the press navigated and the browser asked over its head.
{
  const page = harness({ answers: 'unsaved work' })
  await page.press()
  check('a handler that answers with a message keeps the page', page.navigations.length === 0, JSON.stringify(page.navigations))
  check('and the press says why it stayed', /Unsaved changes; save them, then retry/u.test(String(page.notice())), String(page.notice()))
  check('and leaves the button usable', page.render().button.props.style.opacity === 0.75, String(page.render().button.props.style.opacity))
}

// --- a page-only press that holds the navigation must not claim the code changed ----------------
{
  const page = harness({ settings: { plugins: false, page: true } })
  await page.press()
  const wait = page.scheduled.find((entry) => entry.ms === 6000)
  wait.fn()
  check('a page-only press that held says only that the page stayed', String(page.notice()) === 'The page did not rebuild; press again shortly', String(page.notice()))
  check('a page-only press that held leaves the button usable', page.render().button.props.style.opacity === 0.75)
}

// --- both switches off: the press says so instead of doing nothing -----------------------------
{
  const page = harness({ settings: { plugins: false, page: false } })
  const view = await page.press()
  check('both switches off touches nothing', count(page.requests, '/dsh-unlag/reload') === 0 && page.navigations.length === 0)
  check('both switches off says what to do', /Both switches are off/.test(String(page.notice())), String(page.notice()))
  check('both switches off leaves the button pressable', view.tree !== null)
}

// --- the plugin half alone: it says the code is live and the page stays ------------------------
{
  const page = harness({ settings: { plugins: true, page: false } })
  await page.press()
  check('plugin-only press replaces the plugins', count(page.requests, '/dsh-unlag/reload') === 1)
  check('plugin-only press does not navigate', page.navigations.length === 0)
  check('plugin-only press says the code is live', /Plugin code updated/.test(String(page.notice())), String(page.notice()))
}

// --- a press already answered a moment ago does not run twice ---------------------------------
{
  const page = harness({ stamp: String(Date.now()) })
  await page.press()
  check('a repeated press asks nothing', count(page.requests, '/dsh-unlag/state') === 0 && page.navigations.length === 0)
  check('a repeated press explains itself', /Still applying/.test(String(page.notice())), String(page.notice()))
}

// --- two presses at once: the second joins the first instead of starting another --------------
{
  const page = harness()
  page.holdReload()
  const first = page.press()
  const second = page.press()
  await new Promise((resolve) => setImmediate(resolve))
  check('the press that joined says the update is still running', /Still applying/.test(String(page.notice())), String(page.notice()))
  page.release()
  await Promise.all([first, second])
  check('two presses in one moment replace plugins once', count(page.requests, '/dsh-unlag/reload') === 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('two presses in one moment navigate once', page.navigations.length === 1, String(page.navigations.length))
}

// --- a line written while the route is being replaced ------------------------------------------
const swapped = harness({ reload: { status: 'done' }, reportAnswers: [404, 0] })
await swapped.press()
await new Promise((resolve) => setTimeout(resolve, 1500))
const reports = swapped.requests.filter((request) => request.path.includes('/dsh-unlag/report'))
check('a line written during the swap is written again until the route answers', reports.length >= 3, `${reports.length} lines`)
check('and the pressed page still rebuilt', swapped.navigations.length === 1, swapped.navigations.length)

// --- the app reports the change as still starting: no page is built on it --------------------
{
  const page = harness({ reload: { status: 'queued' } })
  await page.press()
  check('a queued update keeps the page', page.navigations.length === 0)
  check('a queued update says to press again', /queued/.test(String(page.notice())), String(page.notice()))
  check('a queued update is logged with its reason', page.requests.some((request) => request.path.includes('event=plugin-held') && request.path.includes('gate=queued')))
}

// --- the app did not answer at all: the press ends, the button comes back --------------------
{
  const page = harness({ reload: new Error('app did not answer') })
  await page.press()
  check('an unanswered replacement keeps the page', page.navigations.length === 0)
  check('an unanswered replacement says it did not finish', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('an unanswered replacement is logged', page.requests.some((request) => request.path.includes('event=plugin-held')))
}

// --- a lost answer with nothing that names the press ------------------------------------------
// A revision that moved while the answer was lost may belong to somebody else's update. Only the
// app's record of this press — found by the name the press gave it — can say it finished, so a
// moved revision alone leaves the press failed and the page where it is.
{
  const page = harness({ reload: new Error('the route was replaced while it answered'), revAfterReload: 'next' })
  await page.press()
  check('a lost answer with no record of the press keeps the page', page.navigations.length === 0, String(page.navigations.length))
  check('and the press says it did not finish', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('and nothing is logged as rebuilt', !page.requests.some((request) => request.path.includes('event=rebuild')))
}

// --- a lost answer the app does name ----------------------------------------------------------
// The same press, found in the app's own record by the name it gave: that record's `done` is what
// lets the press report a finished replacement.
{
  const page = harness({
    reload: new Error('the route was replaced while it answered'),
    lateOperation: (requestId) => ({ id: 1, status: 'done', pending: 0, failed: 0, restart: null, requestId }),
  })
  await page.press()
  check('a lost answer the app records as done rebuilds the page', page.navigations.length === 1, String(page.navigations.length))
  check('and the press is logged as a rebuild', page.requests.some((request) => request.path.includes('event=rebuild')))
  check('and the notice never says it did not finish', !/did not finish/.test(String(page.notice())), String(page.notice()))
}

// --- a lost answer the app records as failed ------------------------------------------------
// The name was found in the app's record, but that record says the update failed. The page stays
// where it is: a failed replacement is not a reason to start a new document against a broken set.
{
  const page = harness({
    reload: new Error('the route was replaced while it answered'),
    lateOperation: (requestId) => ({ id: 1, status: 'failed', pending: 1, failed: 1, restart: null, requestId }),
  })
  await page.press()
  check('a lost answer the app records as failed keeps the page', page.navigations.length === 0, String(page.navigations.length))
  check('and the press says it did not finish', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('and nothing is logged as rebuilt', !page.requests.some((request) => request.path.includes('event=rebuild')))
}

// --- a lost answer whose record never settles ------------------------------------------------
// The record still says the update is applying when every read has been spent. Running is not
// done: the page stays and the press reports that it did not finish, so a late failure cannot be
// mistaken for a press that worked.
{
  const page = harness({
    reload: new Error('the route was replaced while it answered'),
    lateOperation: (requestId) => ({ id: 1, status: 'applying', pending: 1, failed: 0, restart: null, requestId }),
  })
  await page.press()
  check('a lost answer left applying keeps the page', page.navigations.length === 0, String(page.navigations.length))
  check('and an unfinished record is not read as success', !/applied|replaced|rebuild/i.test(String(page.notice())), String(page.notice()))
}

// --- a lost answer where only the code changed ----------------------------------------------
// Replacing a plugin whose served bundles keep the same revision leaves the boot list unchanged, so
// the graph cannot show that the press worked; a code stamp cannot either, because it belongs to
// whatever update last wrote it. With no record naming this press, the press did not finish.
{
  const page = harness({ reload: new Error('the route was replaced while it answered'), codeAfterReload: 'c2', settings: { plugins: true, page: false } })
  await page.press()
  check('a lost answer with only a new code stamp is not a finished replacement', !page.requests.some((request) => request.path.includes('event=replaced')), page.requests.map((r) => r.path).join(' '))
  check('and the press says it did not finish', /did not finish/.test(String(page.notice())), String(page.notice()))
  check('and nothing navigates when only the code was asked for', page.navigations.length === 0, String(page.navigations.length))
}

// --- plugins replaced, page held: the notice says what did happen ----------------------------
{
  const page = harness({ openWindow: true })
  await page.press()
  check('an open window keeps the page', page.navigations.length === 0)
  check('an applied update says the plugins are live', /Plugins updated; the page stayed/.test(String(page.notice())), String(page.notice()))
  check('an applied hold is logged as applied', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('applied%3Adialog')))
}

// --- the switches cannot be read: the press must not claim an update it never made ------------
{
  const page = harness({ settings: null })
  await page.press()
  check('unreadable switches leave the page alone', page.navigations.length === 0, String(page.navigations.length))
  check('unreadable switches ask no replacement', count(page.requests, '/dsh-unlag/reload') === 0)
  check('unreadable switches never say the code is current', !/already up to date/.test(String(page.notice())), String(page.notice()))
  check('unreadable switches say it cannot rebuild yet', /Cannot rebuild/.test(String(page.notice())), String(page.notice()))
  check('unreadable switches are logged as such', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('gate=settings')))
}

// --- a page check throws: the rebuild is held with its real reason, no crash, no navigation ---
{
  const page = harness({ brokenSelector: true })
  const view = await page.press()
  check('a failing page check does not navigate', page.navigations.length === 0)
  // The plugins are replaced by then; what is left to say is that the page could not be read,
  // which is the truth of it, rather than a bare failure with no reason.
  check('a failing page check names the page as unreadable', /page state cannot be read/.test(String(page.notice())), String(page.notice()))
  const heldLog = page.requests.filter((request) => request.path.includes('event=held')).map((request) => request.path)
  check('a failing page check is logged as a hold', heldLog.some((path) => path.includes('screen')), JSON.stringify(heldLog))
  check('a failing page check leaves the button usable', view.button !== null && view.button.props.disabled !== true)
}

// --- a page whose surfaces throw: the rebuild is held, named, and the button stays usable -------
// The check that reads the page runs in its own guard, so an event hub or a focus field that throws
// must come back as one honest hold with the button re-enabled. A press that threw here would leave
// the button grey with nothing said, which is the complaint this plugin exists to end.
for (const [label, options] of [
  ['an event hub that throws', { dispatchThrows: true }],
  ['a focus field that cannot be read', { activeThrows: true }],
]) {
  const page = harness(options)
  const view = await page.press()
  check(`${label} does not navigate`, page.navigations.length === 0, String(page.navigations.length))
  check(`${label} names the page as unreadable`, /page state cannot be read/.test(String(page.notice())), String(page.notice()))
  const gates = page.requests.filter((request) => request.path.includes('event=held')).map((request) => request.path)
  check(`${label} is logged as a screen hold`, gates.some((path) => path.includes('screen')), JSON.stringify(gates))
  check(`${label} leaves the button usable`, view.button !== null && view.button.props.disabled !== true)
  check(`${label} records no answered press`, page.stamp() === 0, String(page.stamp()))
}

// --- one bad attempt does not cost the next one -------------------------------------------
// The complaint this plugin exists to answer is a button that greys out after a failed try. The
// pacing stamp is written only when the document is about to leave, so a press that failed has to
// leave the next click answered for real rather than turned away as if the first one had worked.
{
  const page = harness({ reload: new Error('the app refused') })
  const first = await page.press()
  check('a failed press says the update did not finish', /did not finish|没完成/.test(String(page.notice())), String(page.notice()))
  check('a failed press leaves the page alone', page.navigations.length === 0, String(page.navigations.length))
  check('a failed press records no answered press', page.stamp() === 0, String(page.stamp()))
  check('a failed press leaves the button usable', first.button !== null && first.button.props.disabled !== true)
  page.setReload({ status: 'done', warnings: [], pending: [], restartReason: null, failedEntries: [] })
  const before = count(page.requests, '/dsh-unlag/reload')
  await page.press()
  check('the press after a failure reaches the app', count(page.requests, '/dsh-unlag/reload') === before + 1, String(count(page.requests, '/dsh-unlag/reload')))
  check('and it rebuilds the page', page.navigations.length === 1, String(page.navigations.length))
  check('and only then is the press recorded', page.stamp() > 0, String(page.stamp()))
}

// The button is never switched off: every state it can be in is words and a press that answers,
// because a person facing a grey button has no way to find out what the real blocker is.
{
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  check('the button never carries a disabled state', !/disabled/u.test(text), String(/disabled/u.exec(text)?.index ?? ''))
}

// --- the same press on a Chinese page: every stopping point has words, not a missing key -------
// The person reading this is more likely to see the Chinese copy than the English one, and a key
// that only one branch lacks would show up as an empty notice exactly there.
{
  const stops = [
    ['both switches off', { language: 'zh-CN', settings: { plugins: false, page: false } }],
    ['unreadable switches', { language: 'zh-CN', settings: null }],
    ['an open window', { language: 'zh-CN', openWindow: true }],
    ['unsaved work', { language: 'zh-CN', answers: '别走' }],
    ['an unreadable page', { language: 'zh-CN', brokenSelector: true }],
    ['an update that failed', { language: 'zh-CN', reload: new Error('nope') }],
  ]
  for (const [label, options] of stops) {
    const page = harness(options)
    await page.press()
    const words = String(page.notice() ?? '')
    check(`${label} says something in Chinese`, words !== '' && !words.includes('undefined'), words)
    check(`${label} says it in Chinese characters`, /[一-鿿]/u.test(words), words)
  }
  // The one press that goes through leaves no notice at all: the document it just asked for is
  // already on its way.
  const onItsWay = harness({ language: 'zh-CN' })
  await onItsWay.press()
  check('a rebuild that goes ahead leaves no notice behind', onItsWay.notice() === null, String(onItsWay.notice()))
  check('and it navigates once in Chinese', onItsWay.navigations.length === 1, String(onItsWay.navigations.length))
}

// --- the list a booting document really gets: one inline queue script, inline global, both kinds ---
// `dsh-client-modules` emits exactly four row kinds (script, script-preload, script-src, global) and
// the shell replays them for every document. The check must read the two script addresses out of that
// shape without refusing the list over the inline rows it cannot fetch.
{
  const real = [
    { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__={};' },
    { kind: 'script-preload', src: '/plugins/??@local/a/client.js,@local/b/client.js&rev=live' },
    { kind: 'script-src', placement: 'head', src: '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=live' },
    { kind: 'style', text: ':root{--a:1}' },
    { kind: 'global', name: '__DSH_BOOT__', value: JSON.stringify(graph) },
  ]
  const page = harness({ bootRows: real })
  await page.press()
  check('a real boot list shape is not refused', page.navigations.length === 1, JSON.stringify(page.navigations))
  const sent = page.requests.find((request) => request.path.startsWith('/dsh-unlag/verify'))
  const sentBody = String(sent?.init?.body ?? '')
  check(
    'a real boot list sends both script addresses to the check',
    sentBody.includes('@local/a/client.js') && sentBody.includes('dsh-client-modules/client.js') && !sentBody.includes('__ModuleLoader__'),
    sentBody.slice(0, 160),
  )
}

// A store that cannot be read is not a reason to lose a press: the stamp only paces repeats.
{
  const denied = harness({ storageThrows: true })
  let threw = null
  try {
    await denied.press()
  } catch (error) {
    threw = error
  }
  check('a store that refuses to be read does not stop the press', threw === null && denied.navigations.length === 1, String(threw?.message ?? JSON.stringify(denied.navigations)))
  check('and the plugins were asked to replace', denied.requests.some((request) => request.path.startsWith('/dsh-unlag/reload')))
}
// A document whose address cannot be parsed still comes back as a fresh one: by then the code
// behind it has already been replaced, and leaving the old page running would show the state as
// the person never pressed.
{
  const addressless = harness({ href: '::bad address' })
  let threw = null
  try {
    await addressless.press()
  } catch (error) {
    threw = error
  }
  const rebuilt = addressless.navigations.length + addressless.reloads.length
  check('a page whose address cannot be parsed still reloads', threw === null && rebuilt >= 1, String(threw?.message ?? JSON.stringify({ navigations: addressless.navigations, reloads: addressless.reloads })))
  check('and it reloads in place rather than leaving the old page', addressless.navigations.length === 0 && addressless.reloads.length === 1)
}

// --- a press that was held changed nothing, so it must not pace the next press ------------------
// The stamp used to be written before the readiness checks ran: a press held by an open dialog or
// unsaved work left "already applying" behind and turned the next press away for three seconds.
{
  const page = harness({ openWindow: true })
  await page.press()
  check('a press held by an open window records no answered press', page.stamp() === 0, String(page.stamp()))
  check('a press held by an open window says what to do', /Close the open window/u.test(String(page.notice())), String(page.notice()))
  const next = harness()
  check('and a different page is not paced by it either', next.stamp() === 0)
}
{
  const page = harness({ answers: 'unsaved work' })
  await page.press()
  check('a press held by unsaved work records no answered press', page.stamp() === 0, String(page.stamp()))
}
{
  const page = harness({ settings: { plugins: true, page: false } })
  await page.press()
  check('a plugin-only press records no page answer', page.stamp() === 0, String(page.stamp()))
}
{
  const page = harness()
  await page.press()
  check('a press that really rebuilds records itself', page.stamp() > 0, String(page.stamp()))
}
{
  // The document stayed anyway: the press that was written down never happened, so it is taken back.
  const page = harness()
  await page.press()
  page.scheduled.find((entry) => entry.ms === 6000).fn()
  check('a rebuild the page held takes its pacing stamp back', page.stamp() === 0, String(page.stamp()))
}

// --- a picture the page still shows is not a draft -----------------------------------------
// Sent pictures keep their preview address in the transcript. Counting every such image held
// every rebuild after a picture had ever been sent, with nothing left to lose. Without the
// composer service the only markup that proves a draft is a picker that still holds files.
{
  const page = harness({ draftImages: 1 })
  await page.press()
  check('a sent picture in the transcript does not hold the rebuild', page.reloads.length + page.navigations.length >= 1, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
}
{
  const page = harness({ draftFiles: 1 })
  await page.press()
  check('a press with a picked file does not rebuild', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and it names the file too', /attach|send/iu.test(String(page.notice())), String(page.notice()))
}
{
  const page = harness()
  await page.press()
  const rebuilt = page.reloads.length + page.navigations.length
  check('a press with an empty composer still rebuilds', rebuilt >= 1, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// --- a message that is still being sent -----------------------------------------------------
// A send waiting for admission is retained by the composer with the text it carries. That text is
// in neither the transcript nor the draft field: a rebuild here would drop what the person wrote,
// so the press waits for the send to settle instead of treating it as a file.
{
  const shell = { snapshot: { attachmentIds: [], draft: '', phase: 'idle' }, detachedDrafts: new Map([['d1', { attachmentIds: [], draft: 'hello there' }]]), failedDetached: new Map(), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: () => shell } }
  const page = harness({ conversation, sessions: { list: () => [{ id: 's1' }] } })
  await page.press()
  check('a message still being sent holds the rebuild', page.reloads.length === 0 && page.navigations.length === 0, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
  check('and the notice says it is being sent', /sent|发送/u.test(String(page.notice())), String(page.notice()))
}
// An empty record is the composer's own bookkeeping, not unsent content: it must not hold anything.
{
  const shell = { snapshot: { attachmentIds: [], draft: '', phase: 'idle' }, detachedDrafts: new Map([['d1', { attachmentIds: [], draft: '' }]]), failedDetached: new Map(), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: () => shell } }
  const page = harness({ conversation, sessions: { list: () => [{ id: 's1' }] } })
  await page.press()
  check('an empty retained record does not hold the rebuild', page.reloads.length + page.navigations.length >= 1, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// A send that failed is handed back to the composer: it is unsent text the person can still send.
{
  const shell = { snapshot: { attachmentIds: [], draft: '', phase: 'idle' }, detachedDrafts: new Map(), failedDetached: new Map([['f1', { attachmentIds: [], draft: 'try again' }]]), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: () => shell } }
  const page = harness({ conversation, sessions: { list: () => [{ id: 's1' }] } })
  await page.press()
  check('a failed send still holds the rebuild', page.reloads.length === 0 && page.navigations.length === 0, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// The app publishes its sessions as one snapshot keyed by id; that is the interface a page can
// actually read, so the check must not depend on a list function that the service does not have.
{
  const shell = { snapshot: { attachmentIds: [], draft: 'typed but not sent', phase: 'idle' }, detachedDrafts: new Map(), failedDetached: new Map(), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: (id) => (id === 's1' ? shell : undefined) } }
  const sessions = { list: { getSnapshot: () => ({ byId: { s1: { id: 's1' } } }) } }
  const page = harness({ conversation, sessions })
  await page.press()
  check('a draft kept by the snapshot-addressed session holds the rebuild', page.reloads.length === 0 && page.navigations.length === 0, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// A composer between deciding and submitting owns the text until the send settles.
{
  const shell = { snapshot: { attachmentIds: [], draft: '', phase: 'adjudicating' }, detachedDrafts: new Map(), failedDetached: new Map(), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: () => shell } }
  const sessions = { list: { getSnapshot: () => ({ byId: { s1: { id: 's1' } } }) } }
  const page = harness({ conversation, sessions })
  await page.press()
  check('a composer that is mid-send holds the rebuild', page.reloads.length === 0 && page.navigations.length === 0, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
  check('and the notice names the sending message', /sent|发送/u.test(String(page.notice())), String(page.notice()))
  check('and the log names the composer state that held it', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('sending')), page.requests.map((r) => r.path).join(' '))
}
// --- a draft kept in another session ---------------------------------------------------------
// The composer keeps the draft of a session the person left. That draft is not on screen, but a
// rebuild would still drop it, so the press reads every retained session.
{
  const shell = { snapshot: { attachmentIds: ['a1'] }, detachedDrafts: new Map(), failedDetached: new Map(), attachmentFlights: new Map() }
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, input: { shell: () => shell } }
  const page = harness({ conversation, sessions: { list: () => [{ id: 's1' }] } })
  await page.press()
  check('a draft kept in another session holds the rebuild', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and the log names the state that held it', page.requests.some((request) => request.path.includes('event=held') && request.path.includes('attachments%3Acomposer')), page.requests.map((r) => r.path).join(' '))
}

// The composer takes a picked file out of the file input at once and keeps it in its own state.
// A press that only reads the markup would rebuild over a file the person can no longer see, so it
// reads the composer itself.
{
  const conversation = { draftAttachments: new Map([['a1', { id: 'a1' }]]), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, detachedDrafts: new Map(), attachmentFlights: new Map() }
  const page = harness({ conversation })
  await page.press()
  check('a file the picker already took still holds the rebuild', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and it says that file has to go first', /attach|send/iu.test(String(page.notice())), String(page.notice()))
}
{
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, detachedDrafts: new Map(), attachmentFlights: new Map() }
  const page = harness({ conversation })
  await page.press()
  check('a composer the app reports empty still rebuilds', page.reloads.length + page.navigations.length >= 1, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// A session the person left keeps its draft, attachments included, away from the page in front of
// them. The rebuild would take that draft with it, so every retained session's own composer is read
// through the app's registry rather than judging from the session on screen.
{
  const conversation = {
    draftAttachments: new Map(),
    pendingFileUploads: new Set(),
    fileUploads: { getSnapshot: () => ({}) },
    input: { shell: (id) => (id === 'elsewhere' ? { snapshot: { attachmentIds: ['kept-1'] } } : { snapshot: { attachmentIds: [] } }) },
  }
  const sessions = { list: () => [{ id: 'here' }, { id: 'elsewhere' }] }
  const page = harness({ conversation, sessions })
  await page.press()
  check('a draft kept in another session holds the rebuild', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and it says that draft has to go first', /attach|send/iu.test(String(page.notice())), String(page.notice()))
}
{
  const conversation = {
    draftAttachments: new Map(),
    pendingFileUploads: new Set(),
    fileUploads: { getSnapshot: () => ({}) },
    input: { shell: () => ({ snapshot: { attachmentIds: [] } }) },
  }
  const sessions = { list: () => [{ id: 'here' }, { id: 'elsewhere' }] }
  const page = harness({ conversation, sessions })
  await page.press()
  check('retained sessions with empty drafts still rebuild', page.reloads.length + page.navigations.length >= 1, JSON.stringify({ reloads: page.reloads, navigations: page.navigations }))
}
// The checks before the navigation take a moment; a file picked into the draft while they run is
// exactly the one a rebuild would drop, so the press looks again right before the document goes.
{
  const conversation = { draftAttachments: new Map(), pendingFileUploads: new Set(), fileUploads: { getSnapshot: () => ({}) }, detachedDrafts: new Map(), attachmentFlights: new Map() }
  const page = harness({
    conversation,
    hold: (event) => {
      if (event.type === 'dsh-unlag:before') conversation.draftAttachments.set('late', { id: 'late' })
    },
  })
  await page.press()
  check('a file picked while the press checks still holds the rebuild', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and that late file is named too', /attach|send/iu.test(String(page.notice())), String(page.notice()))
}

// --- an update that outlasted the page's wait and then failed -------------------------------
// The page stops waiting after a bounded time and is told the update is still applying. The host
// writes that update's real end as it happens, so a press that later broke a plugin must show the
// failure instead of leaving "still applying" on a button that looks busy forever.
{
  const page = harness({
    reload: { status: 'applying', operationId: 7, warnings: [], pending: [], restartReason: null },
    lateOperation: { id: 7, status: 'failed', pending: 1, failed: 1, restart: null },
  })
  await page.press()
  check('an update the page gave up waiting for is read back once', count(page.requests, '/dsh-unlag/state') >= 2, String(count(page.requests, '/dsh-unlag/state')))
  check('an update that failed after the wait says so', /did not finish|press again/i.test(String(page.notice())), String(page.notice()))
  check('and it never rebuilds the page', page.navigations.length === 0 && page.reloads.length === 0, JSON.stringify({ navigations: page.navigations, reloads: page.reloads }))
  check('and the button is usable again', page.render().button.props.style.opacity !== 0.6, String(page.render().button.props.style.opacity))
}
{
  // The same update did finish: the press has nothing to report and must not invent a failure.
  const page = harness({
    reload: { status: 'applying', operationId: 8, warnings: [], pending: [], restartReason: null },
    lateOperation: { id: 8, status: 'done', pending: 0, failed: 0, restart: null },
  })
  await page.press()
  check('an update that finished after the wait is not a failure', !/did not finish/i.test(String(page.notice())), String(page.notice()))
}

// --- the app's record claims done while its own fields say a restart is still needed --------
// A page that trusts the single `done` would navigate onto a plugin set the app has not loaded,
// which is the failure this press exists to avoid. The contradiction resolves to "not finished".
{
  const page = harness({
    reload: { status: 'applying', operationId: 9, warnings: [], pending: [], restartReason: null },
    lateOperation: (rid) => ({ id: 9, status: 'done', pending: 1, failed: 0, restart: null, requestId: rid }),
  })
  await page.press()
  check('a done record with a pending module keeps the page', page.navigations.length === 0, String(page.navigations.length))
  check('a done record with a pending module says a reopen is needed', /reopen/iu.test(String(page.notice())), String(page.notice()))
  check('a done record with a pending module leaves the button usable', page.render().button.props.style.opacity !== 0.6, String(page.render().button.props.style.opacity))
}

console.log(out.join('\n'))
console.log(out.every((line) => line.startsWith('PASS')) ? 'ok' : 'failed')
