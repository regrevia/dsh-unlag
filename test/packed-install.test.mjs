// The repository is not what a host sees. A host sees the package npm installs: the manifest it
// reads and the files the tarball actually ships. This packs the working tree the way publishing
// does, installs that tarball into a throwaway profile, and asks the two questions the host asks:
// can the manifest be resolved by name, and are the entry points the manifest maps to really there.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'unlag-packed-'))
const out = []
const check = (label, ok, extra = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) process.exitCode = 1
}

/**
 * npm is reached through the JS entry point npm itself sets in `npm_execpath`, run by this node.
 * On Windows that avoids going through a shell at all: `shell: true` needs a usable cmd.exe, and a
 * sandboxed test run is exactly where that is not guaranteed (spawnSync cmd.exe ENOENT).
 */
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmCli = process.env.npm_execpath
const run = (args, cwd) => {
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  if (typeof npmCli === 'string' && npmCli.endsWith('.js') === true) return execFileSync(process.execPath, [npmCli, ...args], { ...options, env })
  return execFileSync(npm, args, { ...options, env, shell: process.platform === 'win32' })
}

// npm pack writes the tarball under the name npm would publish; that name is what a profile installs.
const packed = run(['pack', '--json', '--pack-destination', work], root)
const info = JSON.parse(packed.slice(packed.indexOf('[')))
const tarball = join(work, info[0].filename)
check('packing the tree produces a tarball', existsSync(tarball), tarball)
check('the tarball ships the manifest and both halves', info[0].files.map((one) => one.path).includes('package.json') && info[0].files.map((one) => one.path).includes('client.js') && info[0].files.map((one) => one.path).includes('index.js'), info[0].files.map((one) => one.path).join(','))
check('and never ships the tests', info[0].files.every((one) => !one.path.startsWith('test/') && !one.path.startsWith('scripts/test')), info[0].files.length + ' files')

// A profile is just a directory with a node_modules: that is where the host's fallback resolver
// starts, and installing the tarball there is what a market install leaves behind.
writeFileSync(join(work, 'package.json'), '{"name":"probe","private":true}\n')
run(['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--install-strategy=hoisted'], work)
const installed = join(work, 'node_modules', 'dsh-unlag')
check('the installed package has a manifest on disk', existsSync(join(installed, 'package.json')), installed)

const resolveFrom = createRequire(join(work, 'package.json'))
const manifestPath = resolveFrom.resolve('dsh-unlag/package.json')
check('the manifest resolves by package name', realpathSync(manifestPath) === realpathSync(join(installed, 'package.json')), manifestPath)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('the manifest names a client half for the web platform', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh))
check('the entry points are exported by name', manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js', JSON.stringify(manifest.exports))
check('every export target the manifest maps is installed', Object.entries(manifest.exports).every(([key, target]) => key.includes('*') || existsSync(join(installed, target))), JSON.stringify(manifest.exports))
check('and the client half is the real script, not a stand-in', readFileSync(join(installed, manifest.exports['./client']), 'utf8').length > 60000, String(readFileSync(join(installed, manifest.exports['./client']), 'utf8').length))

// The exact failure a 0.2.1-rc.2 host hit: the fallback resolver asks for the manifest by name, the
// package's export map does not list it, and the host then drops the row with no line of its own.
const honest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...honest, exports: { '.': './index.js', './client': './client.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' } }, null, 2))
// A child process: Node caches a package's map per filename inside one process, so the resolver
// that already read the honest manifest would keep answering from that copy. The question is what a
// host that starts now sees.
const askedNow = execFileSync(
  process.execPath,
  ['-e', "const { createRequire } = require('node:module'); try { console.log(createRequire(process.cwd() + '/package.json').resolve('dsh-unlag/package.json')) } catch (error) { console.log('ERR:' + error.code) }"],
  { cwd: work, encoding: 'utf8' },
).trim()
check('without the export that host would fail by name', askedNow === 'ERR:ERR_PACKAGE_PATH_NOT_EXPORTED', askedNow)
check('and the client entry still resolves in that map, which is why the host looked for the manifest instead', String(resolveFrom.resolve('dsh-unlag/client')).endsWith('client.js'), String(resolveFrom.resolve('dsh-unlag/client')))

// The row the host emits names this bundle; a file that is not served under the name the row uses
// is a row the page asks for and gets nothing back from.
const bundleUrl = `plugins/??dsh-unlag/client.js&rev=live`
check('the row a host emits names the script that is installed', bundleUrl.includes('dsh-unlag/client.js') && existsSync(join(installed, 'client.js')), bundleUrl)

console.log(out.join('\n'))
