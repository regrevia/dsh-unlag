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
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// --- the check, over the same answers a browser would get -------------------------------------
async function verdict({ base, cookie, graph, rows, blocked, replace }) {
  const answered = []
  const asks = (url, spec) => {
    const target = new URL(url, base)
    const prefix = spec.startsWith('/') ? spec : `/${spec}`
    return (target.pathname + target.search).startsWith(prefix.split('&')[0])
  }
  const fetchBody = async (url) => {
    const target = new URL(url, base)
    if (blocked !== null && asks(url, blocked)) {
      answered.push({ url: String(url), status: 404, standIn: 'coerced' })
      return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if (replace !== undefined && asks(url, replace.spec)) {
      answered.push({ url: String(url), status: 200, standIn: 'replaced' })
      return { status: 200, arrayBuffer: async () => replace.body, headers: new Headers() }
    }
    const response = await fetch(target, { headers: { cookie } })
    answered.push({ url: String(url), status: response.status })
    return { status: response.status, arrayBuffer: async () => Buffer.from(await response.arrayBuffer()), headers: response.headers }
  }
  const fetchChunk = async (url) => {
    const response = await fetch(new URL(url, base), { headers: { cookie } })
    return { status: response.status, arrayBuffer: async () => Buffer.from(await response.arrayBuffer()), headers: response.headers }
  }
  const { verifyStartupRows } = await import('../index.js')
  const result = await verifyStartupRows(graph, fetchBody, rows, 120_000, null, fetchChunk)
  return { result, answered }
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

  // A body that does not belong at a startup address is the generation switch seen from the page:
  // the document is the old generation, the bytes answered at its bundle address are another one.
  const bootstrapBody = await (await fetch(new URL(bootstrap, base), { headers: { cookie } })).arrayBuffer()
  const wrongBody = await verdict({ base, cookie, graph, rows, replace: { spec: appBatch, body: bootstrapBody } })
  check('and refuses a startup address answering another generation body', wrongBody.result.status === 'blocked', JSON.stringify(wrongBody.result).slice(0, 300))

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
process.exitCode = failed ? 1 : 0
