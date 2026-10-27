// A window is frozen with one startup list. When that list names a script the app can no longer
// serve, the document renders without that plugin and says nothing at all: the person sees a page
// missing a feature they have no reason to press for. The only honest way to surface that is a
// check that runs without a press, speaks once, names the remedy, and stays quiet when it cannot
// tell. These assertions pin exactly that shape.
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`ok - ${name}`)
  } else {
    fail += 1
    console.log(`not ok - ${name}${detail === '' ? '' : `: ${detail}`}`)
  }
}

const line = (text) => client.split('\n').find((row) => row.includes(text)) ?? ''

// The host has to keep the answer status, otherwise a page cannot tell a script that is gone from
// a list that could not be read whole, and it would send someone to restart the app for nothing.
check('the boot capture keeps the status a script answered with', /unreadable: true, code: Number\(response\?\.status/u.test(host))
check('a missing script is written into the log', /one startup script this page asked for is not served now/u.test(host))

const zhLine = line('这一页有插件没加载')
const enLine = line('plugin code is missing from this page')
check('the notice exists in both languages', zhLine !== '' && enLine !== '')
check('the notice names the remedy', /重启应用/u.test(zhLine) && /reopen the app/u.test(enLine))
check('the notice is one short sentence', zhLine.length < 200 && enLine.length < 200, `${zhLine.length}/${enLine.length}`)

// Only an error answer means missing code. A row recorded while the list overflowed, or one that
// failed to read, must not turn into "reopen the app".
const reader = client.slice(client.indexOf('async function startupLostPlugins'), client.indexOf('function reportBoot'))
check('the reader only counts an error answer', /unreadable === true && typeof row\?\.code === 'number' && row\.code !== 0/u.test(reader))
check('the reader does not use the capture completeness flag', reader.includes('complete') === false)
check('the reader gives up quietly', /attempt >= 2\) return false/u.test(reader) && /catch/u.test(reader))

// The check must run without a press and must not be re-run by every render of the button.
const effect = client.slice(client.indexOf('void startupLostPlugins()'), client.indexOf('void startupLostPlugins()') + 400)
check('the check runs from a page-level effect', /\}, \[\]\);/u.test(effect))
check('the check waits for the capture instead of racing it', /setTimeout/u.test(client.slice(client.indexOf('One page, one check'), client.indexOf('One page, one check') + 700)))

// A page short a plugin stays short until it is reopened: its notice must not be cleared by the
// timer that ends an ordinary press outcome.
check('the page notice is exempt from the auto-clear timer', /if \(sticky\) return undefined;/u.test(client))
check('a press outcome clears the page notice', /setSticky\(false\);/u.test(client))
check('the notice is not prefixed with an update result', /插件已更新，页面未重开：/u.test(client) && /BOOT_GAP_NOTICE/u.test(client))

// Reachable from the harness the tests drive, like every other page check.
check('the reader is exposed to the probe', /startupLostPlugins,/u.test(client))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
