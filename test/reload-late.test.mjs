// A press whose update outlasts the answer the page waits for is told "still applying" and keeps
// applying. What happens to that work afterwards is only ever known from the log: a line saying
// it finished, or a line saying it failed — never both, and never silence.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'unlag-late-'))
const LOG = join(HOME, 'late.log')
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = LOG
// The answer the page waits for is shortened so the test does not sit out the real bound; the
// update itself is made to outlast it on purpose.
process.env.DSH_UNLAG_ANSWER_MS = '40'

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

function mount(late) {
  const routes = new Map()
  const ctx = {
    get: (key) =>
      key === 'webServer'
        ? { collectIndexInjections: () => [], register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
        : key === 'hmr'
          ? {
              baseDir: join(HOME, 'profile'),
              runExclusive: async (op) => op(),
              reconcileProfile: async () => {
                await new Promise((resolve) => setTimeout(resolve, 200))
                if (late === 'reject') throw new Error('the swap failed after the answer')
                return { warnings: [], pending: [] }
              },
            }
          : undefined,
    on: () => {},
  }
  apply(ctx, {})
  return routes
}

const lines = () => (readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== ''))
const settle = () => new Promise((resolve) => setTimeout(resolve, 500))

for (const late of ['resolve', 'reject']) {
  writeFileSync(LOG, '')
  const routes = mount(late)
  const res = { status: 0, body: '', writableEnded: false, writeHead(status) { this.status = status }, end(body) { this.body += body ?? ''; this.writableEnded = true } }
  await routes.get('/dsh-unlag/reload')({ method: 'POST', headers: { 'x-dsh-unlag': '1' } }, res)
  check(`${late}: the page is told the update is still applying`, res.status === 200 && JSON.parse(res.body).status === 'applying', res.body)
  await settle()
  const written = lines()
  const finished = written.filter((line) => /the update finished after/u.test(line))
  const failed = written.filter((line) => /the update failed after/u.test(line))
  if (late === 'resolve') {
    check('an update that finishes late writes exactly one line', finished.length === 1, `${finished.length} finished / ${failed.length} failed`)
    check('and no failure line is invented for it', failed.length === 0, failed.join(' | '))
  } else {
    // A swap that fails is still an answer, not a rejection: the line has to say it finished and
    // name the failure, or the log cannot tell a failed press from one that never came back.
    check('an update that fails late names the failure in its one line', finished.length === 1 && /failed/u.test(finished[0]), `${finished.length} finished / ${failed.length} failed: ${finished.join(' | ').slice(0, 140)}`)
    check('and no second line repeats it', failed.length + finished.length === 1, `${finished.length + failed.length} lines`)
  }
  check(`${late}: late work leaves the log free of control characters`, written.every((line) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)))
  check(`${late}: the log does not keep the press waiting`, res.writableEnded === true)
}

rmSync(HOME, { recursive: true, force: true })
console.log(out.join('\n'))
