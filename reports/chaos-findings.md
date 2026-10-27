# Chaos / soak findings

Scope: `dsh-unlag` refresh button (written against v1.11.0; re-checked on 1.12.0, where F1 is still at `index.js:1044`), read-only probing of `index.js` / `client.js`.
Everything below was produced by the lab files added with this report; nothing in the plugin was changed.

| file | what it is |
| --- | --- |
| `scripts/soak.mjs` | the lab: fake host, seeded operation stream, invariant audits, metrics |
| `test/chaos-core.test.mjs` | one fault per case, deterministic, asserts answer ⇄ `/state.operation` ⇄ press record agreement |
| `test/soak-long.test.mjs` | the same stream as a test, with thresholds (heap, rss, timers, p99, bounds) |

```bash
node test/chaos-core.test.mjs
node test/soak-long.test.mjs
DSH_UNLAG_SOAK_MS=20000 DSH_UNLAG_SOAK_SEEDS=1,2 node scripts/soak.mjs   # long form
```

## Faults covered

`hmr`: `ok`, `throw`, `nested` (a listener throwing inside the swap), `hang`, `slow`, `partial`, `restart`, `pending`, `stop` (an entry left inactive).
`health`: `active`, `pending`, `unreadable` (loader throws), `table-hang`, `table-throw`.
`answer`: dropped (the page times out its own request), late, and duplicated request ids.
`bundle`: current document, stale generation, chunk, unknown entry, hung table.
`timing`: presses closer than the press gap, presses during an in-flight update, generation bumped under a press, retry of an old request id, a press whose answer outlives `DSH_UNLAG_ANSWER_MS`.

## Invariants asserted

1. Every press is answered: HTTP 200 with `{status, rebuild}`, or an error the page can render. No silent path, no unhandled rejection, no throw out of the event loop.
2. `done` ⇔ `rebuild: safe`, unless health could not be read, where the only honest answer is `unknown` and never `safe`.
3. `applying` / `queued` / `restart` ⇒ `rebuild: pending`, and `restart` names either a reason or the unfinished entries.
4. A restart never restarts the process; a press that needs one says so.
5. At most one update runs at a time (`maxConcurrent <= 1`), including when a generation is swapped mid-press.
6. The same request id answers from the record and starts nothing; a request id older than the press memory is a new press, not a resurrection.
7. `/state.operation` eventually carries the terminal record with the `requestId` of the press that started it.
8. Bounded memory: `presses <= 32`, live press rows `<= 128`, plugin `globalThis` entries `<= 10`, seven routes and no more.
9. Bundle documents are never answered `404` while the entry is current, never with an empty body while claimed current, and a hung table is bounded by the lab, not by the page.

## Findings

### F1 — the press gap is hard-wired and ignores the config (P2)

`index.js:1044`

```js
const wait = lastRun + MIN_INTERVAL_MS - Date.now()   // MIN_INTERVAL_MS = 1500 (line 170)
```

`minIntervalMs` is read from config at `index.js:467` and applied only on the watcher path (`index.js:856`). The press path uses the module constant, so `apply(ctx, { minIntervalMs: 0 })` still parks every press after the first for up to 1.5 s inside `runPress`. With the short answer deadline the page sees `{status: 'applying', rebuild: 'pending'}` for a press that has not started any work, so the button looks busy while nothing is rebuilding.

Minimal repro (`seed 1`, lab): `apply(ctx, { minIntervalMs: 0 })`, two presses 30 ms apart with `DSH_UNLAG_ANSWER_MS=20`; the second is answered `applying` and its update starts ~1.47 s later, i.e. the spacing, not the work, decided the answer. Fix (not applied): read the configured value on the press path too, or pass the answer deadline into the wait so the answer stops claiming pending work that has not begun.

### F2（1.12.2 已修） — a hung module table parks the wrapped bundle route with no deadline (P2)

`index.js:2207-2240` (`ensureBundleShim`): the wrapper `await`s the previously registered handler. If the module table stops answering, `/plugins/<id>` never resolves — the browser's script request hangs forever, the page never gets a `404`, a `503`, or a retry. The lab bounds such requests at 400 ms and observes `{hung: true}`; the plugin has no own bound.

Fix (not applied): give the passthrough the same deadline discipline as `guardRoute`, answering the held 404 and logging when the table does not answer.

### F3 — `applying` is one word for two different situations (P3, design)

A press that finds the single update slot occupied and a press whose own update outlasted `DSH_UNLAG_ANSWER_MS` both answer `{status: 'applying', rebuild: 'pending'}`. The page cannot tell "wait for someone else's rebuild" from "your press is only parked by the 1.5 s spacing", and neither answer carries a hint about which. Fix (not applied): carry a `waitMs` / `retryAfter`, or split the status.

## Limits of this run

- The soak attributes more than one update inside a single press window to a queued tick of an earlier press (printed as `queue overlap`), so the strict per-press claim is the weaker one: one press never runs an update next to another, and a busy press starts nothing — the latter is asserted deterministically in `chaos-core`.
- Not covered: two tabs pressing at once (needs two page instances), a real `HMR` service, a restart that actually replaces the process.
- Longest run attempted here: 20 s per seed, 2 seeds. `DSH_UNLAG_SOAK_MS` allows longer; the metrics and thresholds scale with it.
