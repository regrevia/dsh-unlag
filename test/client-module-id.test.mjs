import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))
const clientSource = read('client.js')

let registration
runInNewContext(clientSource, {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
})

// The launcher resolves the boot graph entry by name, then the client bundle has to register
// that same id. One mismatch turns into "duplicate factory registration" or "loaded without
// registering", and the whole web boot fails. Keep all three strings identical.
assert.equal(registration?.id, manifest.name, 'client factory ID must equal the package name')
console.log('PASS  client factory ID equals the package name')

const patch = read('cordis.patch.yml')
const inserted = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*\n\s*name:\s*([^\n]+)$/gmu)].map(([, id, name]) => ({
  id,
  name: name.trim().replace(/^['"]|['"]$/gu, ''),
}))
const selfEntry = inserted.find((entry) => entry.id === manifest.name)
assert.ok(selfEntry, `cordis.patch.yml must insert an entry with id ${manifest.name}`)
assert.equal(selfEntry.name, manifest.name, 'the inserted entry must resolve to this package')
console.log('PASS  boot graph entry id equals the package name')

assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'the bundle patch must ship')
assert.equal(manifest.dsh?.client?.platform, 'web', 'the client half targets the web shell')
assert.ok(!/@local\//u.test(clientSource), 'a factory must not keep the id it had before the rename')
console.log('PASS  no pre-rename id survives')
