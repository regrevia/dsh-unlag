#!/usr/bin/env node
/**
 * Desktop acceptance probe: can this machine run the real app for a button check?
 *
 * Reports what the machine has, and never fails because something is missing:
 *
 *   node scripts/desktop-e2e.mjs --probe
 *
 * It answers three questions before any real-app run is attempted:
 *   cli     — the `dsh` CLI shipped inside the desktop app (real Host, real boot document)
 *   app     — the Electron desktop binary (dsh-app:// window, IPC boot injections)
 *   browser — a Chromium that can load the served document for the loader verdict
 *
 * Every path is discovered per platform or taken from an environment override, so the same
 * command runs on macOS, Windows and Linux. A missing piece is reported as `missing`, which is
 * the answer for a machine that has no desktop install; it is not a failing test.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const localAppData = process.env.LOCALAPPDATA ?? (home === '' ? '' : join(home, 'AppData', 'Local'))
const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'

const firstExisting = (candidates) => candidates.find((path) => path !== '' && existsSync(path)) ?? ''

const cli = firstExisting([
  process.env.DSH_DESKTOP_CLI ?? '',
  ...(isMac
    ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']
    : []),
  ...(isWin
    ? [
        join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        join(programFilesX86, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      ]
    : []),
  ...(!isMac && !isWin ? ['/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh'] : []),
])

const app = firstExisting([
  process.env.DSH_DESKTOP_APP ?? '',
  ...(isMac
    ? ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness']
    : []),
  ...(isWin
    ? [
        join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
        join(programFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
        join(programFilesX86, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      ]
    : []),
  ...(!isMac && !isWin ? ['/opt/DeepSeek Harness/deepseek-harness'] : []),
])

const browser = firstExisting([
  process.env.DSH_CONTRACT_CHROME ?? '',
  ...(isMac
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []),
  ...(isWin
    ? [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : []),
  ...(!isMac && !isWin ? ['/usr/bin/google-chrome', '/usr/bin/chromium'] : []),
])

const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cli: cli === '' ? 'missing' : cli,
  app: app === '' ? 'missing' : app,
  browser: browser === '' ? 'missing' : browser,
}

if (!process.argv.includes('--json')) {
  for (const [key, value] of Object.entries(report)) console.log(`${key}: ${value}`)
} else {
  console.log(JSON.stringify(report))
}

process.exitCode = 0
