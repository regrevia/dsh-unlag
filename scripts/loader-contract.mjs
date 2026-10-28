#!/usr/bin/env node
/**
 * Contract test: the startup check against the official loader, executed.
 *
 * Runs the app for real in a throwaway profile, reads the startup document the app itself renders,
 * and asks the shipped check what it thinks of that document. Then it puts the same document in
 * front of a real Chromium running the official loader, twice: once as served (the loader must come
 * up), and once with one startup bundle coerced to 404 (the loader must not). The two verdicts have
 * to agree, or the button promises a page the loader does not deliver.
 *
 * Offline by design: the instance, the browser profile and all answers are local, and the run exits
 * nonzero the moment a verdict and the loader disagree. Nothing here is part of `npm test`, which
 * has to run without the app or a browser; run it by hand after changing the startup check:
 *
 *   node scripts/loader-contract.mjs
 *
 * `DSH_CONTRACT_CHROME` names the Chromium binary; otherwise the newest Playwright download or the
 * installed Google Chrome is used.
 *
 * What this run does not cover, so a green line is not read for more than it says:
 * - It never runs in CI. It starts the app and a browser, and `npm test` has to pass on a machine
 *   with neither, so it stays a by-hand check before a release.
 * - `CLI` is the macOS desktop app's own path, written down here. On another install, a dev
 *   checkout or another OS the run fails inside `startApp` before it makes a contract claim.
 * - The instance starts with `--profile web`, so the document read here is that profile's. A plugin
 *   set that only boots on another profile is outside this check.
 * - Both the app and the browser run on a throwaway HOME/profile that must come up without a
 *   first-run setup; a fresh install that needs one fails at `startApp`/`launchChrome` too.
 *
 * The answer-selection rules and the two readings of a replaced body need neither the app nor the
 * browser, and are checked on their own:
 *
 *   node scripts/loader-contract.mjs --self-check
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const ORIGIN = 'http://127.0.0.1'

const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || detail === '' ? '' : ` — ${detail}`}`)
}

function oneLine(value, max = 300) {
  return String(value ?? '').replace(/\s+/gu, ' ').slice(0, max)
}

function chromePath() {
  if (process.env.DSH_CONTRACT_CHROME) return process.env.DSH_CONTRACT_CHROME
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      const binary = join(cache, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
      if (existsSync(binary)) return binary
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}

// --- the app, run for real in a throwaway profile ---------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'unlag-contract-'))
let instance = null
let chrome = null
let cdp = null

async function startApp() {
  const child = spawn(CLI, ['--profile', 'web', '--no-open', '--port', '0'], {
    env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const found = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app did not print its address in 120s: ${oneLine(log, 400)}`)), 120_000)
    const take = (chunk) => {
      log += String(chunk)
      const match = /dsh web: (http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?token=[\w-]+)/u.exec(log)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the app exited ${code} before printing its address: ${oneLine(log, 400)}`))
    })
  })
  return { child, url: found }
}

/** The document the app serves, with the cookie its token sets. */
async function readDocument(url) {
  const seen = await fetch(url, { redirect: 'manual' })
  const cookie = (seen.headers.getSetCookie?.() ?? []).map((one) => one.split(';')[0]).join('; ')
  const response = await fetch(new URL('/', url), { headers: cookie === '' ? {} : { cookie } })
  return { cookie, status: response.status, html: await response.text() }
}

/** The boot data the document carries, and the startup rows it names, read the way the page does. */
function readStartup(html) {
  const key = 'globalThis["__DSH_BOOT__"] = '
  const at = html.indexOf(key)
  if (at === -1) throw new Error('the document carries no boot data')
  const graph = JSON.parse(html.slice(at + key.length, html.indexOf('</script>', at)).trim().replace(/;\s*$/u, ''))
  const rows = [...html.matchAll(/<script[^>]*src="([^"]+)"/gu)].map((match) => match[1])
    .concat([...html.matchAll(/<link rel="preload" as="script" href="([^"]+)"/gu)].map((match) => match[1]))
    .map((one) => one.replaceAll('&amp;', '&'))
    .filter((one) => one.includes('plugins/??'))
  return { graph, rows }
}

// --- which answer a request gets instead of the real one --------------------------------------
/**
 * Whether `url` is the startup row `spec` names.
 *
 * A spec is a document-relative startup row (`plugins/??a/client.js&rev=1`); a request is compared
 * as path plus query, up to the first `&`, because that prefix is what the row names. Anything that
 * is not a non-empty string names no row: a call site that leaves `blocked` out used to reach
 * `spec.startsWith` as `undefined`, and that TypeError was swallowed into a `reason: 'network'`
 * refusal which read exactly like a real one.
 */
export function matchRow(url, base, spec) {
  if (typeof spec !== 'string' || spec === '') return false
  try {
    const target = new URL(url, base)
    const prefix = (spec.startsWith('/') ? spec : `/${spec}`).split('&')[0]
    return `${target.pathname}${target.search}`.startsWith(prefix)
  } catch {
    return false
  }
}

/** A substitute is only usable as bytes at a named row; anything else selects no stand-in. */
function usableReplace(replace) {
  if (replace === null || typeof replace !== 'object') return false
  if (typeof replace.spec !== 'string' || replace.spec === '') return false
  return replace.body instanceof ArrayBuffer || ArrayBuffer.isView(replace.body)
}

/**
 * The stand-in answer for one request: `'coerced'` (a 404), `'replaced'` (the substitute body), or
 * null to let the real answer through. Both parameters are optional and both are judged by their
 * type, so a call site that leaves one out selects no stand-in instead of throwing inside the read.
 */
export function chooseStandIn({ url, base, blocked = null, replace = null }) {
  if (typeof blocked === 'string' && matchRow(url, base, blocked)) return 'coerced'
  if (usableReplace(replace) && matchRow(url, base, replace.spec)) return 'replaced'
  return null
}

// --- the check, over the same answers a browser would get -------------------------------------
/**
 * Ask the shipped check about one document, with the answers a browser would get.
 *
 * `verify` and `fetchImpl` exist so the same function can be exercised without the app: the real run
 * leaves both out, the self-check below supplies a synthetic plugin table and a local answer map.
 */
export async function verdict({ base, cookie, graph, rows, blocked = null, replace = null, verify = null, fetchImpl = null }) {
  const answered = []
  const read = fetchImpl ?? globalThis.fetch
  const fetchBody = async (url) => {
    const target = new URL(url, base)
    const standIn = chooseStandIn({ url, base, blocked, replace })
    if (standIn === 'coerced') {
      answered.push({ url: String(url), status: 404, standIn })
      return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if (standIn === 'replaced') {
      answered.push({ url: String(url), status: 200, standIn })
      return { status: 200, arrayBuffer: async () => replace.body, headers: new Headers() }
    }
    const response = await read(target, { headers: { cookie } })
    answered.push({ url: String(url), status: response.status })
    return { status: response.status, arrayBuffer: async () => Buffer.from(await response.arrayBuffer()), headers: response.headers }
  }
  const fetchChunk = async (url) => {
    const response = await read(new URL(url, base), { headers: { cookie } })
    return { status: response.status, arrayBuffer: async () => Buffer.from(await response.arrayBuffer()), headers: response.headers }
  }
  const checkRows = verify ?? (await import('../index.js')).verifyStartupRows
  const result = await checkRows(graph, fetchBody, rows, 120_000, null, fetchChunk)
  return { result, answered }
}

/**
 * What this file can prove without the app or a browser: the rules that pick a stand-in answer, and
 * the two readings of a replaced startup body (its own healthy bytes are approved, another
 * generation's bytes are refused by the check itself).
 *
 * A refusal is only evidence when it has the shape of a refusal: `reason: 'network'` or a
 * `startsWith`/`Cannot read` detail is this file's own exception, which is exactly the false
 * positive that made a TypeError look like the resource check working.
 *
 *   node scripts/loader-contract.mjs --self-check
 */
export async function selfCheck() {
  const results = []
  const say = (name, pass, detail = '') => {
    results.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'} self-check ${name}${pass || detail === '' ? '' : ` — ${detail}`}`)
  }
  const attempt = async (name, body) => {
    try {
      const outcome = await body()
      say(name, outcome.pass === true, outcome.detail ?? '')
    } catch (error) {
      say(name, false, `threw ${oneLine(error?.message ?? error)}`)
    }
  }
  const base = 'http://contract.invalid'
  const rows = ['plugins/??a/client.js&rev=rev-1', 'plugins/??b/client.js&rev=rev-1']
  const graph = {
    rev: 'rev-1',
    entries: [
      { id: 'a', url: '/plugins/??a/client.js&rev=rev-1' },
      { id: 'b', url: '/plugins/??b/client.js&rev=rev-1' },
    ],
    batches: [],
  }
  const healthy = (id) => Buffer.from(`__ModuleLoader__.load({ id: "${id}", factory: function () {} });\n`)
  const served = new Map([
    ['/plugins/??a/client.js&rev=rev-1', healthy('a')],
    ['/plugins/??b/client.js&rev=rev-1', healthy('b')],
  ])
  // The app is not running here: every request is answered from this map, and one that is not in it
  // fails the check instead of silently reaching the network.
  const fetchImpl = async (url) => {
    const target = new URL(String(url))
    const body = served.get(`${target.pathname}${target.search}`)
    if (body === undefined) throw new Error(`self-check has no answer for ${target.href}`)
    return { status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from(body) }
  }
  const run = (options) => verdict({ base, cookie: '', graph, rows, fetchImpl, ...options })
  const ownRefusal = (result) => result.reason !== 'network' && /startsWith|Cannot read/u.test(String(result.detail ?? '')) === false
  const replacedRow = (answered, spec) => answered.some((row) => row.standIn === 'replaced' && matchRow(row.url, base, spec))

  await attempt('an omitted blocked selects no stand-in and does not throw', async () => {
    const { result } = await run({})
    return { pass: result.status === 'ok', detail: JSON.stringify(result).slice(0, 240) }
  })
  await attempt('a row spec that is not a string names no row', async () => ({
    pass: matchRow(rows[0], base, undefined) === false && chooseStandIn({ url: `/${rows[0]}`, base }) === null,
  }))
  await attempt('a replace without bytes selects no stand-in', async () => {
    const { result, answered } = await run({ replace: { spec: rows[1] } })
    return { pass: result.status === 'ok' && replacedRow(answered, rows[1]) === false, detail: JSON.stringify(result).slice(0, 240) }
  })
  await attempt('substituting a row with its own healthy body is approved', async () => {
    const { result, answered } = await run({ replace: { spec: rows[1], body: healthy('b') } })
    return { pass: result.status === 'ok' && replacedRow(answered, rows[1]), detail: JSON.stringify(result).slice(0, 240) }
  })
  await attempt('substituting another generation body is refused by the check itself', async () => {
    const { result, answered } = await run({ replace: { spec: rows[1], body: healthy('a') } })
    return {
      pass: result.status === 'blocked' && ownRefusal(result) && replacedRow(answered, rows[1]),
      detail: JSON.stringify(result).slice(0, 240),
    }
  })
  return results
}

// --- a browser running the official loader ----------------------------------------------------
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('the browser refused the session')), { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.next
    this.next += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  close() {
    this.socket.close()
  }
}

async function launchChrome() {
  const binary = chromePath()
  if (!existsSync(binary)) throw new Error(`no browser to run the loader in: ${binary}`)
  const profile = mkdtempSync(join(tmpdir(), 'unlag-contract-chrome-'))
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const devtools = join(profile, 'DevToolsActivePort')
  const found = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the browser did not open a debugging port in 30s')), 30_000)
    const poll = setInterval(() => {
      if (existsSync(devtools) === false) return
      const [port] = readFileSync(devtools, 'utf8').split('\n')
      if (port === undefined || port === '') return
      clearTimeout(timer)
      clearInterval(poll)
      resolve({ port: Number(port), profile })
    }, 100)
  })
  return { child, ...found }
}

/**
 * Load one page in a fresh browser page and report what the official loader did with it.
 *
 * `coerce(requestUrl)` answers with `{ status, body }` to stand in for an answer, or `null` to let
 * the real one through. Every coerced answer is counted, so a scenario that never reached the loader
 * fails instead of passing on a page that booted from a cache or a retry.
 */
async function runLoader({ url, coerce }) {
  const browserPath = readFileSync(join(chrome.profile, 'DevToolsActivePort'), 'utf8').split('\n')[1] ?? ''
  const browser = await Cdp.connect(`ws://127.0.0.1:${chrome.port}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`)
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const messages = []
    const requests = []
    const standIns = []
    browser.listeners.add((message) => {
      if (message.sessionId !== sessionId) return
      if (message.method === 'Runtime.exceptionThrown') {
        messages.push(`exception ${oneLine(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text)}`)
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        messages.push(`console ${oneLine((message.params?.args ?? []).map((arg) => arg.value ?? arg.description).join(' '))}`)
      }
      if (message.method === 'Log.entryAdded') messages.push(`log ${oneLine(message.params?.entry?.text)}`)
      if (message.method === 'Network.requestWillBeSent') requests.push(String(message.params?.request?.url))
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params
        const standIn = coerce === undefined ? null : coerce(request.url)
        if (standIn === null) {
          browser.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {})
          return
        }
        standIns.push(request.url)
        browser.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: standIn.status,
          responseHeaders: [{ name: 'content-type', value: standIn.contentType ?? 'text/javascript; charset=utf-8' }],
          body: Buffer.from(standIn.body ?? '').toString('base64'),
        }, sessionId).catch(() => {})
      }
    })
    await browser.send('Page.enable', {}, sessionId)
    await browser.send('Runtime.enable', {}, sessionId)
    await browser.send('Log.enable', {}, sessionId)
    await browser.send('Network.enable', {}, sessionId)
    // A second run of the same document must reach the network: a disk cache answer would skip the
    // coercion and make a refused bundle look bootable.
    await browser.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/?*', requestStage: 'Request' }] }, sessionId)
    await browser.send('Page.navigate', { url }, sessionId)
    // The startup bundles are local but the largest is 9 MB, and the shell mounts after all of them.
    const began = Date.now()
    let text = ''
    while (Date.now() - began < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const probe = await browser.send('Runtime.evaluate', { expression: 'document.body === null ? "" : document.body.innerText', returnByValue: true }, sessionId)
        .catch(() => ({ result: { value: '' } }))
      text = String(probe?.result?.value ?? '')
      if (text.includes('Failed to load plugins')) break
      if (text.includes('描述你想要构建的内容')) break
    }
    return {
      text,
      messages,
      requests: requests.filter((one) => one.includes('plugins/')),
      standIns,
      failedPlugins: text.includes('Failed to load plugins'),
      shell: /探索未至之境|预览版/u.test(text),
      composer: text.includes('描述你想要构建的内容'),
      loaderError: messages.some((one) => one.includes('client-modules:')),
    }
  } finally {
    browser.close()
  }
}

// --- the run ----------------------------------------------------------------------------------
const prefixOf = (row) => (row.split('&')[0].startsWith('/') ? row.split('&')[0] : `/${row.split('&')[0]}`)
const matches = (url, row) => String(url).startsWith(prefixOf(row)) || String(url).includes(prefixOf(row).replace(/^\//u, ''))

/**
 * The contract run itself: starts the app, then a browser, and compares their readings. It is only
 * reached as a command; a test reads the part that needs neither process through `--self-check`.
 */
async function runContract() {
  let failed = false
  try {
    instance = await startApp()
    const base = new URL(instance.url).origin
    const { cookie, status, html } = await readDocument(instance.url)
    check('the app serves the startup document', status === 200 && html.length > 1000, `${status} ${html.length}B`)
    const { graph, rows } = readStartup(html)
    check('the document names the startup bundles', rows.length >= 2 && Array.isArray(graph?.entries) && graph.entries.length > 10, `${rows.length} rows, ${graph?.entries?.length ?? 0} entries`)

    // The loader's own module is the startup bundle the document cannot boot without: the page's
    // inline loader refuses to start when it is not preloaded, and the app never mounts.
    const bootstrap = rows[0]
    // The middle bundle carries the plugins the shell itself is made of; the last one carries panels
    // that load later, so a body put in its place still leaves a working page.
    const appBatch = rows[Math.min(1, rows.length - 1)]
    const served = await verdict({ base, cookie, graph, rows, blocked: null })
    check('the shipped check approves the document as served', served.result.status === 'ok', JSON.stringify(served.result).slice(0, 300))
    if (served.result.status !== 'ok') throw new Error(`the served document is refused before any coercion: ${JSON.stringify(served.result)}`)

    const missing = await verdict({ base, cookie, graph, rows, blocked: bootstrap })
    check('and refuses the document with the loader bundle missing', missing.result.status === 'blocked', JSON.stringify(missing.result).slice(0, 300))
    check('the refusal names a missing answer as the reason', ['missing', 'boot'].includes(String(missing.result.reason)), String(missing.result.reason))
    check('and names the address the page would ask', String(missing.result.detail ?? '').includes('dsh-client-modules/client.js'), oneLine(missing.result.detail, 200))

    /**
     * A page loaded before the plugin set changed holds the startup list the shell froze then: the
     * addresses no longer answer at that revision, and the route maps each to the revision it serves
     * now. The rebuilt page is one generation. This is the press that follows every plugin update, so
     * the check reads those frozen addresses through the shipped reader — a real 404 at the address the
     * list named, a real answer at the mapped one — and must approve the document it composes.
     * Revision strings are not the evidence here: a batch row and another plugin's entry name one
     * generation under two namespaces, and comparing them refused every press after 1.14.6.
     */
    const { verifyStartup, startupPath } = await import('../index.js')
    const staleRev = '0000000000ff'
    const frozenRows = rows.map((row) => row.replace(/rev=[0-9a-f]+/u, `rev=${staleRev}`))
    const staleAsked = []
    const fetchBundle = async (request) => {
      const raw = typeof request === 'string' ? request : String(request?.url ?? '')
      staleAsked.push(raw)
      // The shipped reader addresses the app by path; the instance lives under its own host, so the
      // path is resolved against it rather than followed to whatever host the address named.
      const response = await fetch(new URL(startupPath(raw), base), { headers: { cookie } })
      return { status: response.status, arrayBuffer: async () => Buffer.from(await response.arrayBuffer()), headers: response.headers }
    }
    const frozen = await verifyStartup({ graph: () => graph, fetchBundle }, frozenRows)
    check('a frozen older startup list is approved after the plugin set moved on', frozen.status === 'ok', JSON.stringify(frozen).slice(0, 300))
    check(
      'because the shipped reader asked the frozen address and then the revision that holds it',
      staleAsked.some((one) => startupPath(one).includes(staleRev)) && staleAsked.some((one) => !startupPath(one).includes(staleRev)),
      staleAsked.slice(0, 4).map((one) => startupPath(one)).join(' '),
    )

    // A body that does not belong at a startup address is the generation switch seen from the page:
    // the document is the old generation, the bytes answered at its bundle address are another one.
    const bootstrapBody = await (await fetch(new URL(bootstrap, base), { headers: { cookie } })).arrayBuffer()
    const wrongBody = await verdict({ base, cookie, graph, rows, replace: { spec: appBatch, body: bootstrapBody } })
    check('and refuses a startup address answering another generation body', wrongBody.result.status === 'blocked', JSON.stringify(wrongBody.result).slice(0, 300))
    // A refusal is only evidence when the check itself answered it. A throw inside the read is caught
    // and reported as `network`, which used to make this assertion pass while proving nothing.
    check(
      'and the refusal is the check’s own answer, not a failed read',
      wrongBody.result.reason !== 'network' && !/startsWith|Cannot read/u.test(String(wrongBody.result.detail ?? '')),
      JSON.stringify(wrongBody.result).slice(0, 300),
    )
    // …and the refused body has to be the answer that was read, or the refusal happened before it.
    check(
      'because the substituted body really was the answer used',
      wrongBody.answered.some((row) => row.standIn === 'replaced' && matchRow(row.url, base, appBatch)),
      wrongBody.answered.slice(0, 4).map((row) => `${row.standIn ?? 'served'} ${row.url}`).join(' '),
    )

    // The control, without which a refused substitute proves nothing about the substitution: the same
    // address carrying its own healthy body must still be approved.
    const healthyBody = await (await fetch(new URL(appBatch, base), { headers: { cookie } })).arrayBuffer()
    const healthyReplaced = await verdict({ base, cookie, graph, rows, replace: { spec: appBatch, body: healthyBody } })
    check('and approves the same address with its own body substituted', healthyReplaced.result.status === 'ok', JSON.stringify(healthyReplaced.result).slice(0, 300))
    check(
      'because that substitution was the answer used too',
      healthyReplaced.answered.some((row) => row.standIn === 'replaced' && matchRow(row.url, base, appBatch)),
      healthyReplaced.answered.slice(0, 4).map((row) => `${row.standIn ?? 'served'} ${row.url}`).join(' '),
    )

    chrome = await launchChrome()
    check('a browser started', chrome.port > 0, String(chrome.port))

    const good = await runLoader({ url: instance.url })
    check('the official loader boots the document as served', good.failedPlugins === false && good.loaderError === false, oneLine(good.text, 200))
    check('and the app is on screen with its composer', good.shell && good.composer, oneLine(good.text, 200))
    check('the shipped check agreed with that boot', served.result.status === 'ok', String(served.result.status))

    const bad = await runLoader({
      url: instance.url,
      coerce: (requestUrl) => (requestUrl.includes(prefixOf(bootstrap).replace(/^\//u, '')) ? { status: 404, body: '' } : null),
    })
    check('the coercion reached the loader', bad.standIns.length > 0, `${bad.standIns.length} answers`)
    check('the official loader refuses a document whose loader bundle is missing', bad.failedPlugins === true, oneLine(bad.text, 240))
    check('and shows no app for it', bad.shell === false && bad.composer === false, oneLine(bad.text, 240))
    check('the shipped check agreed with that failure', missing.result.status === 'blocked', String(missing.result.reason))

    const wrong = await runLoader({
      url: instance.url,
      coerce: (requestUrl) => (matches(requestUrl, appBatch) ? { status: 200, body: bootstrapBody } : null),
    })
    check('the coercion replaced the startup body', wrong.standIns.length > 0, `${wrong.standIns.length} answers`)
    // A body from another generation does not always blank the page: the loader reports it and the
    // shell can still paint around the broken module. That is why the check may not wait for pixels —
    // it refuses the document before the boot, and the browser evidence is the loader's own rejection.
    check('the loader rejects the other generation body', wrong.loaderError === true || wrong.failedPlugins === true, oneLine(wrong.messages.filter((one) => one.includes('client-modules:')).join(' | '), 240))
    check('the shipped check agreed with that refusal', wrongBody.result.status === 'blocked', String(wrongBody.result.reason))
    check('and reported the mismatch the loader hit', wrong.failedPlugins === true || wrong.loaderError === true, oneLine(wrong.messages.filter((one) => one.includes('client-modules:')).join(' | ') || wrong.text, 240))

    const revision = typeof graph?.rev === 'string' ? graph.rev : ''
    console.log(`\nrevision ${revision.slice(0, 12)} · ${rows.length} startup bundles · ${graph.entries.length} entries`)
    console.log(`served:   ${served.result.status} · loader ${good.failedPlugins ? 'failed' : 'booted'} · composer ${good.composer}`)
    console.log(`missing:  ${missing.result.status}/${missing.result.reason} · loader ${bad.failedPlugins ? 'failed' : 'booted'}`)
    console.log(`replaced: ${wrongBody.result.status}/${wrongBody.result.reason} · loader ${wrong.failedPlugins ? 'failed' : 'booted'}`)
    const missed = checks.filter((row) => row.pass === false)
    failed = missed.length > 0
    console.log(`\n${checks.length - missed.length}/${checks.length} passed`)
  } catch (error) {
    failed = true
    console.log(`FAIL contract run — ${oneLine(error?.message ?? error, 400)}`)
  } finally {
    try { cdp?.close() } catch {}
    try { if (chrome?.child !== undefined) chrome.child.kill('SIGTERM') } catch {}
    try { if (chrome?.profile !== undefined) rmSync(chrome.profile, { recursive: true, force: true }) } catch {}
    try { if (instance?.child !== undefined) instance.child.kill('SIGTERM') } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  return failed
}

async function main() {
  if (process.argv.includes('--self-check')) {
    const results = await selfCheck()
    const missed = results.filter((row) => row.pass === false)
    console.log(`\n${results.length - missed.length}/${results.length} self-checks passed`)
    process.exitCode = missed.length > 0 ? 1 : 0
    return
  }
  // Only a direct `node scripts/loader-contract.mjs` runs the contract; an import (tests included)
  // must not start the app and a browser.
  const runAsCommand = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  if (!runAsCommand) return
  process.exitCode = (await runContract()) ? 1 : 0
}
await main()
