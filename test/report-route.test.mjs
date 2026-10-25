// The report route is how a page tells the log what its press did. Its query comes from outside:
// a forged or malformed one must still land as exactly one clean line and exactly one answer, or
// the log stops being evidence and the page waits on a request that never ends.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = join(tmpdir(), 'unlag-reportroute')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, '.dsh'), { recursive: true })
process.env.HOME = HOME
process.env.DSH_UNLAG_LOG = join(tmpdir(), 'unlag-reportroute.log')
writeFileSync(process.env.DSH_UNLAG_LOG, '')

const { apply } = await import('../index.js')

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const routes = new Map()
const server = {
  prefixes: new Map(),
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
  collectIndexInjections: () => [],
}
apply({ get: (key) => (key === 'webServer' ? server : undefined), on: () => {} }, {})
// Only the reports below may write: the startup lines are not part of this count.
writeFileSync(process.env.DSH_UNLAG_LOG, '')

const res = () => {
  const answer = { status: 0, body: '', writableEnded: false, writeHeads: 0, ends: 0 }
  answer.writeHead = (status) => {
    answer.writeHeads += 1
    answer.status = status
  }
  answer.end = (body) => {
    answer.ends += 1
    if (body !== undefined) answer.body += String(body)
    answer.writableEnded = true
  }
  return answer
}

const post = async (query) => {
  const answer = res()
  await routes.get('/dsh-unlag/report')({ method: 'POST', url: `/dsh-unlag/report?${query}`, headers: { 'x-dsh-unlag': '1' } }, answer)
  return answer
}

const lines = () => readFileSync(process.env.DSH_UNLAG_LOG, 'utf8').split('\n').filter((line) => line !== '')

// Every shape a page (or anything else on the machine) can put in that query. The one that matters
// most is the newline: a value that kept it would forge a second line, and the log would say an
// outcome happened that never did.
const hostile = [
  'event=held&gate=list',
  'event=mounted&rev=abc',
  'event=%0A%0Dforged%20line&gate=%0A%0D',
  'event=%F0%9F%92%A5&gate=a%3Ab%3Ac',
  'event=' + 'x'.repeat(4000) + '&gate=' + 'y'.repeat(4000) + '&rev=' + '9'.repeat(4000),
  'event=&gate=&rev=',
  'event=<script>alert(1)</script>&gate=%00%00&rev=%00',
  'event=decodeError&gate=plugin-held:row',
  'gate=list&rev=old',
  'event=%C3%A9%20%C3%A9',
]

const answers = []
for (const query of hostile) answers.push({ query, answer: await post(query) })

check('every hostile report is answered once', answers.every(({ answer }) => answer.writeHeads === 1 && answer.ends === 1 && answer.status === 200), answers.map(({ answer }) => `${answer.status}:${answer.writeHeads}/${answer.ends}`).join(' '))

const written = lines()
check('every hostile report leaves exactly one line', written.length === hostile.length, `${written.length} lines for ${hostile.length} reports`)
check('no line was forged by a value that carried a break', written.every((line) => line.includes('press') || line.includes('rebuild') || line.includes('interface')), written.slice(0, 4).join(' | ').slice(0, 200))
check('no line carries control characters', written.every((line) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)), JSON.stringify(written.find((line) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)) ?? '').slice(0, 120))
check('a line stays bounded in length', written.every((line) => line.length <= 2000), String(Math.max(...written.map((line) => line.length))))
check('a gate is written as words, never as the raw separator', !written.some((line) => line.includes('a:b:c')), written.filter((line) => line.includes('a')).slice(0, 2).join(' | ').slice(0, 160))
check('a page revision is written only as its safe form', written.some((line) => /\(page 9+\)/u.test(line)), written.find((line) => line.includes('page')) ?? 'none')
check('a forged event never becomes a second line', !written.some((line) => /forged line/u.test(line)), written.filter((line) => /forged/u.test(line)).join(' | '))

console.log(out.join('\n'))
