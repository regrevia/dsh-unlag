// Only a page this machine opened may ask for a plugin swap. The header check is the first gate;
// the address check covers the case that bypasses a preflight, where a public name resolves to this
// machine and the page becomes same-origin. Nothing else in the suite asks the mounted route what
// it does with a hostile `host`/`origin` pair, so a refactor could quietly open that door.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { apply } from '../index.js'

const logPath = join(tmpdir(), 'unlag-origin.log')
rmSync(logPath, { force: true })
writeFileSync(logPath, '')
process.env.DSH_UNLAG_LOG = logPath

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}
const lines = () => readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '')

function fakeRes() {
  const res = { status: 0, headers: null, body: '', writableEnded: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.body += body ?? ''
    res.writableEnded = true
  }
  return res
}

const routes = new Map()
const ctx = {
  get: (key) =>
    key === 'webServer'
      ? {
          collectIndexInjections: () => [],
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      : key === 'hmr'
        ? { baseDir: '/tmp/unlag-origin-profile', runExclusive: async (op) => op(), reconcileProfile: async () => ({ warnings: [], pending: [] }) }
        : undefined,
  on: () => {},
}
apply(ctx, {})
const press = routes.get('/dsh-unlag/reload')
const report = routes.get('/dsh-unlag/report')

const ask = async (handler, headers, url = '/dsh-unlag/reload') => {
  const res = fakeRes()
  await handler({ method: 'POST', url, headers }, res)
  return res
}

// --- a page on this machine gets through -----------------------------------------------
const sameOrigin = await ask(press, { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'http://127.0.0.1:52847' })
check('a page on this machine may ask for a swap', sameOrigin.status === 200, `${sameOrigin.status} ${sameOrigin.body}`)
const privateNetwork = await ask(press, { 'x-dsh-unlag': '1', host: '192.168.1.5:52847', origin: 'http://192.168.1.5:52847' })
check('a page on the local network may ask too', privateNetwork.status === 200, `${privateNetwork.status}`)
const upperCase = await ask(press, { 'x-dsh-unlag': '1', host: 'LOCALHOST:52847', origin: 'http://LocalHost:52847' })
check('the address is compared without case', upperCase.status === 200, `${upperCase.status}`)
const noAddress = await ask(press, { 'x-dsh-unlag': '1' })
check('a request with no address is judged by the header alone', noAddress.status === 200, `${noAddress.status}`)

// --- a name the person listed: the gate widens by that name and nothing else --------------
// Reached through a reverse proxy, this page's address is not loopback, private or `.local`, so
// every press is refused. The list is the way out that keeps the rebinding check: it names which
// addresses count as this machine.
const listPath = join(tmpdir(), 'unlag-trusted-hosts.txt')
rmSync(listPath, { force: true })
process.env.DSH_UNLAG_TRUSTED_HOSTS = listPath
const beforeList = await ask(press, { 'x-dsh-unlag': '1', host: 'dsh.lan:3080', origin: 'http://dsh.lan:3080' })
check('a name nobody listed is still refused', beforeList.status === 403, `${beforeList.status}`)

writeFileSync(listPath, ['# reverse proxy', 'dsh.lan', '*.ts.net', 'proxy.lan:8443', '', '*', 'bad name!'].join('\n'))

const listed = await ask(press, { 'x-dsh-unlag': '1', host: 'dsh.lan:3080', origin: 'http://dsh.lan:3080' })
check('a listed name may press', listed.status === 200, `${listed.status}`)
const listedAnyPort = await ask(press, { 'x-dsh-unlag': '1', host: 'dsh.lan:5050', origin: 'http://dsh.lan:5050' })
check('a listed name covers any port when the list named none', listedAnyPort.status === 200, `${listedAnyPort.status}`)
const wildcard = await ask(press, { 'x-dsh-unlag': '1', host: 'box.tail1.ts.net', origin: 'http://box.tail1.ts.net' })
check('a listed suffix covers the names under it', wildcard.status === 200, `${wildcard.status}`)
const deeper = await ask(press, { 'x-dsh-unlag': '1', host: 'a.b.tail1.ts.net', origin: 'http://a.b.tail1.ts.net' })
check('and the ones further down', deeper.status === 200, `${deeper.status}`)
const listedPort = await ask(press, { 'x-dsh-unlag': '1', host: 'proxy.lan:8443', origin: 'http://proxy.lan:8443' })
check('a listed name may press on the port it named', listedPort.status === 200, `${listedPort.status}`)
const otherPort = await ask(press, { 'x-dsh-unlag': '1', host: 'proxy.lan:9000', origin: 'http://proxy.lan:9000' })
check('but not on a port it did not name', otherPort.status === 403, `${otherPort.status}`)
// The listing says which addresses are this machine. It does not say which page may act: a page on
// a listed name that answers from somewhere else is the case the origin check exists for.
const listedButForeign = await ask(press, { 'x-dsh-unlag': '1', host: 'dsh.lan:3080', origin: 'https://evil.example' })
check('a listed name does not make a foreign page same-origin', listedButForeign.status === 403, `${listedButForeign.status}`)
check('the listing is recorded once the page it allows presses', lines().some((line) => line.includes('is allowed by')), JSON.stringify(lines().slice(-3)))
const unusableLines = lines().filter((line) => line.includes('ignored') && line.includes(listPath))
check('lines the list cannot use are recorded', unusableLines.some((line) => line.includes('ignored 2 line(s)')), JSON.stringify(unusableLines))
check('a bare star is not a listing', unusableLines.some((line) => line.includes('*')), JSON.stringify(unusableLines))

// --- every other page is refused, and the log names it ---------------------------------
const cases = [
  ['another site', { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'https://evil.example' }, 'https://evil.example'],
  ['a public name that resolves here', { 'x-dsh-unlag': '1', host: 'evil.example:52847', origin: 'http://evil.example:52847' }, 'evil.example:52847'],
  ['an opaque origin', { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'null' }, 'opaque origin'],
  ['an origin that is not an address', { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'not a url' }, 'not an address'],
]
for (const [label, headers, named] of cases) {
  const before = lines().length
  const res = await ask(press, headers)
  check(`${label} cannot swap plugins`, res.status === 403, `${res.status}`)
  check(`${label} gets an answer, not a hang`, res.writableEnded === true)
  const added = lines().slice(before)
  check(`${label} is recorded`, added.some((line) => line.includes('refused a press')), JSON.stringify(added))
  if (named !== null) check(`${label} is named in the record`, added.some((line) => line.includes(named)), JSON.stringify(added))
}

// Removing the list closes the gate back down to the addresses it started with, so the file is the
// whole surface: nothing was remembered from when it was there.
rmSync(listPath, { force: true })
const afterList = await ask(press, { 'x-dsh-unlag': '1', host: 'dsh.lan:3080', origin: 'http://dsh.lan:3080' })
check('removing the listing refuses that name again', afterList.status === 403, `${afterList.status}`)
const stillHere = await ask(press, { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'http://127.0.0.1:52847' })
check('and the addresses this machine always had still press', stillHere.status === 200, `${stillHere.status}`)

// The report route is the same gate with a quieter answer: a page that cannot press still must
// not be able to write lines into the plugin's own record.
const quiet = await ask(report, { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'https://evil.example' }, '/dsh-unlag/report?event=held&gate=unsaved')
check('a refused page cannot write a line', quiet.status === 403, `${quiet.status}`)
const quietRight = await ask(report, { 'x-dsh-unlag': '1', host: '127.0.0.1:52847', origin: 'http://127.0.0.1:52847' }, '/dsh-unlag/report?event=held&gate=unsaved')
check('the page that may press may report', quietRight.status === 200, `${quietRight.status}`)

// A header object that throws is a check this code cannot complete. Refusing is right; a silent
// refusal would hide the reason, so the log has to carry it.
const exploding = {}
Object.defineProperty(exploding, 'host', {
  get() {
    throw new Error('headers went away')
  },
})
const broken = await ask(press, { 'x-dsh-unlag': '1', ...{} })
exploding['x-dsh-unlag'] = '1'
const brokenRes = fakeRes()
await press({ method: 'POST', url: '/dsh-unlag/reload', headers: exploding }, brokenRes)
check('an unreadable header is refused', brokenRes.status === 403, `${brokenRes.status}`)
check('and the reason is recorded', lines().some((line) => line.includes('cannot check where a press came from')), JSON.stringify(lines().slice(-2)))
check('the readable-header request still answered', broken.status === 200, `${broken.status}`)

console.log(out.join('\n'))
