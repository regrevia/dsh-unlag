/**
 * Where the real app lives, on any platform.
 *
 * One place resolves the three things a real-app run needs: the `dsh` CLI that ships inside the
 * desktop app (or a global npm install of the same package), the Electron desktop binary itself,
 * and a Chromium that can load a served document. Every lookup is an environment override first,
 * then the platform's own install locations, then the npm global prefix, so the same call works on
 * macOS, Windows and Linux and a machine without the app gets an empty string instead of a guess.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const isWin = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const localAppData = process.env.LOCALAPPDATA ?? (home === '' ? '' : join(home, 'AppData', 'Local'))
const appData = process.env.APPDATA ?? (home === '' ? '' : join(home, 'AppData', 'Roaming'))
const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'

const firstExisting = (candidates) => candidates.find((path) => path !== '' && existsSync(path)) ?? ''

export function resolveCli() {
  const npmGlobal = isWin
    ? [join(appData, 'npm', 'dsh.cmd')]
    : [join(home, '.npm-global', 'bin', 'dsh'), '/usr/local/bin/dsh', '/opt/homebrew/bin/dsh']
  return firstExisting([
    process.env.DSH_CONTRACT_CLI ?? '',
    ...(isMac ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'] : []),
    ...(isWin
      ? [
          join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
          join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
          join(programFilesX86, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
        ]
      : []),
    ...(!isMac && !isWin ? ['/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh'] : []),
    ...npmGlobal,
  ])
}

export function resolveApp() {
  return firstExisting([
    process.env.DSH_DESKTOP_APP ?? '',
    ...(isMac ? ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'] : []),
    ...(isWin
      ? [
          join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
          join(programFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
          join(programFilesX86, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
        ]
      : []),
    ...(!isMac && !isWin ? ['/opt/DeepSeek Harness/deepseek-harness'] : []),
  ])
}

export function resolveBrowser() {
  const playwrightCache = isMac
    ? join(home, 'Library', 'Caches', 'ms-playwright')
    : isWin
      ? join(localAppData, 'ms-playwright')
      : join(home, '.cache', 'ms-playwright')
  const playwright = []
  try {
    if (existsSync(playwrightCache)) {
      const builds = readdirSync(playwrightCache)
      for (const build of builds.filter((name) => name.startsWith('chromium-')).sort().reverse()) {
        if (isMac) {
          playwright.push(join(playwrightCache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
          playwright.push(join(playwrightCache, build, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
        } else if (isWin) {
          playwright.push(join(playwrightCache, build, 'chrome-win', 'chrome.exe'))
        } else {
          playwright.push(join(playwrightCache, build, 'chrome-linux', 'chrome'))
        }
      }
    }
  } catch {}
  return firstExisting([
    process.env.DSH_CONTRACT_CHROME ?? '',
    ...playwright,
    ...(isMac ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : []),
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
}

