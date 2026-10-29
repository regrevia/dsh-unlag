// The body a document gets in a removed plugin's place has one job: it must register the row's id
// so the loader takes the answer and the entry activates with no behaviour. A body that loads
// without registering fails the whole boot (`could not load "<id>"`, then "entries did not
// activate"), which is why the stand-in is a module and not a comment.
import { runInNewContext } from 'node:vm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standInModuleBody } from '../index.js'

process.env.DSH_UNLAG_LOG = join(mkdtempSync(join(tmpdir(), 'unlag-standin-')), 'unlag.log')

const checks = []
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || detail === '' ? '' : ` — ${detail}`}`)
}

/** Run a stand-in body the way the page's loader would, and hand back what it registered. */
function register(body) {
  const registrations = []
  const window = {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
  }
  runInNewContext(String(body), { window })
  return registrations
}

const body = standInModuleBody('@local/gone')
const registrations = register(body)
check('the stand-in registers exactly one module', registrations.length === 1, JSON.stringify(registrations))
check('and it registers the id the startup row names', registrations[0]?.id === '@local/gone', JSON.stringify(registrations[0]))
const plugin = registrations[0]?.factory?.()
check('the module activates with no behaviour', typeof plugin?.apply === 'function' && plugin.apply.length === 0, JSON.stringify(plugin))
check('and it names itself as the plugin it stands in for', plugin?.name === '@local/gone', JSON.stringify(plugin))
check('the body is script the page can parse', /^\/\*[\s\S]*\*\/\nwindow\.__ModuleLoader__\.load\(/u.test(String(body)), String(body).slice(0, 120))

// The id comes from an address anyone can ask for, so it is sanitized before it is put in a body:
// a row naming `../..` must not be able to add statements to the script the document runs.
const hostileId = '@local/a");globalThis.pwned=1;("'
const expectedId = hostileId.replace(/[^a-z0-9@/._-]/giu, '')
const hostile = String(standInModuleBody(hostileId))
check('a hostile id cannot add statements to the body', !hostile.includes('pwned') || !hostile.includes('='), hostile)
const hostileRegistrations = register(hostile)
check('and the hostile stand-in still registers one module', hostileRegistrations.length === 1, JSON.stringify(hostileRegistrations))
check('with the id reduced to badges a plugin id can have', hostileRegistrations[0]?.id === expectedId, JSON.stringify(hostileRegistrations[0]))

// An id with nothing readable in it leaves nothing to register; the body says so in a comment
// instead of registering an empty id the loader could never match.
const empty = String(standInModuleBody('"""'))
check('an unreadable id registers nothing at all', register(empty).length === 0, empty)

const failures = checks.filter((entry) => !entry.pass)
console.log(`${checks.length - failures.length} PASS, ${failures.length} FAIL`)
process.exit(failures.length === 0 ? 0 : 1)
