import { harness } from './support/press-harness.mjs'

let reads = 0
const page = harness({
  reload: new Error('the route was replaced while it answered'),
  lateOperation: (requestId) => ({
    id: 1,
    status: ++reads < 5 ? 'applying' : 'done',
    pending: 0,
    failed: 0,
    restart: null,
    healthReadable: true,
    requestId,
  }),
})
await page.press()
if (page.navigations.length !== 1) {
  throw new Error(`slow named update did not rebuild: ${JSON.stringify(page.navigations)}`)
}
if (page.requests.some((request) => request.path.includes('event=plugin-held') && request.path.includes('gate=failed'))) {
  throw new Error('slow named update was reported as failed')
}
console.log('PASS slow named update is read through to done and rebuilds')
