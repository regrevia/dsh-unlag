// The host finds a plugin's client half through the package itself: with the Loader's own resolver
// unavailable it resolves `dsh-unlag/package.json` and reads the manifest. An exports map that does
// not open that subpath makes the lookup throw ERR_PACKAGE_PATH_NOT_EXPORTED before any manifest is
// read, and the entry then never reaches the plugin set the page is served. These checks run the
// real Node resolver against what npm would publish, not against the repository directory, and they
// pin the old map's failure so the reason this export exists cannot be removed by accident.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// A published package is its manifest plus the paths in `files`; copying exactly those is what npm
// would install, without a tarball and without a package manager in the test.
const install = (root, exported, name) => {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  const published = { ...manifest, exports: exported }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      // A glob stands for the files it matches; copying every sibling would ship more than npm does.
      const folder = join(ROOT, entry.slice(0, entry.indexOf('*')).replace(/\/$/, ''))
      const target = join(dir, folder.slice(ROOT.length))
      if (!existsSync(folder)) continue
      mkdirSync(target, { recursive: true })
      for (const file of readdirSync(folder)) cpSync(join(folder, file), join(target, file))
      continue
    }
    if (!existsSync(join(ROOT, entry))) continue
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  }
  return dir
}

const base = mkdtempSync(join(tmpdir(), 'unlag-discovery-'))
const dir = install(base, manifest.exports, 'dsh-unlag')
const req = createRequire(join(base, 'host.js'))

// 1. The host's fallback lookup: resolve the manifest as a package subpath and read it.
let found = null
let failure = null
try {
  found = JSON.parse(readFileSync(req.resolve('dsh-unlag/package.json'), 'utf8'))
} catch (error) {
  failure = error
}
check(
  'the published map lets the host read this package\'s manifest',
  found !== null,
  failure === null ? 'dsh-unlag/package.json resolved' : `${failure?.code ?? ''} ${failure?.message ?? failure}`,
)
check(
  'and the manifest it reads declares the client half',
  found?.dsh?.client?.platform === 'web',
  `platform=${String(found?.dsh?.client?.platform)}`,
)

// 2. The old map must still fail the same lookup: a passing test on the new map is only evidence if
// the failing shape is reproducible beside it.
const oldMap = { ...manifest.exports }
delete oldMap['./package.json']
const oldRoot = mkdtempSync(join(tmpdir(), 'unlag-discovery-old-'))
install(oldRoot, oldMap, 'dsh-unlag')
let oldCode = null
try {
  createRequire(join(oldRoot, 'host.js')).resolve('dsh-unlag/package.json')
} catch (error) {
  oldCode = error?.code ?? 'unknown'
}
check('without the export the same lookup throws', oldCode === 'ERR_PACKAGE_PATH_NOT_EXPORTED', String(oldCode))

// 3. Every target the map publishes has to exist in the installed copy: a map that points at a file
// the package does not ship is the same silence one step later.
const missing = Object.entries(found?.exports ?? {})
  .filter(([key]) => key.startsWith('./') && !key.includes('*'))
  .map(([, target]) => target)
  .filter((target) => typeof target === 'string' && !existsSync(join(dir, target)))
check('every file the map publishes was installed', missing.length === 0, missing.join(', ') || 'all present')

// 4. The client half is what the page loads, and it is opened through its own subpath.
let clientPath = null
try {
  clientPath = req.resolve('dsh-unlag/client')
} catch {}
check('the client half resolves from the same package', typeof clientPath === 'string' && clientPath.endsWith('client.js'), String(clientPath))

console.log(out.join('\n'))
