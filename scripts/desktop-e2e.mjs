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
import { resolveApp, resolveBrowser, resolveCli } from './lib/desktop-paths.mjs'

const cli = resolveCli()
const app = resolveApp()
const browser = resolveBrowser()

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
