// A person updates the plugin while a page is already open: the button in that page is the code
// from the version the page booted with, while the app answers from whatever version was applied
// last. That pairing is the normal case here, and it is the one no single-version test can cover:
// every shipped version's button is driven over one fake app, and each must still end in exactly
// one rebuild.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { harnessForSource } from './support/press-harness.mjs'

const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const git = (args) => execFileSync('git', args, { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

let tags = []
try {
  tags = git(['tag', '--list', 'v1.9.*'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
} catch {
  tags = []
}

if (existsSync(new URL('../.git', import.meta.url)) === false || tags.length === 0) {
  console.log('PASS  shipped-version buttons are checked where the history exists (no git history here)')
  process.exit(0)
}

// A spread across the shipped line, newest included: consecutive versions rarely change the button,
// while these are far enough apart that a change in its shape shows up.
const want = 12
const step = Math.max(1, Math.floor(tags.length / want))
const sample = [...new Set([tags[0], ...tags.filter((_, at) => at % step === 0), tags[tags.length - 1]])]

const pages = []
for (const tag of sample) {
  let source = ''
  try {
    source = git(['show', `${tag}:client.js`])
  } catch {
    continue
  }
  let page = null
  let failed = null
  try {
    page = harnessForSource(source)
    await page.press()
  } catch (error) {
    failed = String(error?.message ?? error)
  }
  const rebuilt = page === null ? 0 : page.navigations.length + page.reloads.length
  const asked = page === null ? 0 : page.requests.filter((request) => request.path.startsWith('/dsh-unlag/reload')).length
  pages.push({ tag, rebuilt, asked, failed, notice: page?.notice() ?? null })
}
check('the shipped versions are represented', pages.length >= 8, String(pages.length))
check('no shipped version throws while pressing', pages.every((page) => page.failed === null), pages.filter((page) => page.failed !== null).map((page) => `${page.tag}: ${page.failed}`).join('; '))
check('every shipped version asks for one rebuild', pages.every((page) => page.asked === 1), pages.map((page) => `${page.tag}:${page.asked}`).join(' '))
check('every shipped version ends in exactly one rebuild', pages.every((page) => page.rebuilt === 1), pages.map((page) => `${page.tag}:${page.rebuilt}`).join(' '))
check('none of them leaves a notice about a failed press', pages.every((page) => page.notice === null), pages.filter((page) => page.notice !== null).map((page) => `${page.tag}: ${page.notice}`).join('; '))

console.log(out.join('\n'))
process.exitCode = process.exitCode ?? 0
