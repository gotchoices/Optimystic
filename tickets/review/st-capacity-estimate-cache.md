description: The "how full is my storage" check used to re-scan the entire store on every call, and ring selection asked several times per operation; it now caches the answer for 60 seconds so most calls are instant.
prereq:
files: packages/db-p2p/src/storage/storage-monitor.ts, packages/db-p2p/test/storage-monitor.spec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, docs/repository.md
difficulty: medium
----

# Review: cache the used-bytes scan with a short TTL

## What changed

`StorageMonitor` now memoizes its used-bytes scan behind a time-to-live instead of calling the
backend's full-store `getApproximateBytesUsed` on every `getCapacity`. This collapses the
repeated-scan cost (2+ scans per `RingSelector.createArachnodeInfo`, one per `shouldTransition`
tick) to at most one scan per TTL window.

**`storage-monitor.ts`**
- `StorageMonitorConfig` gains two optional fields:
  - `usedBytesCacheTtlMs?: number` — cache lifetime, default **60000** (60s). `0` disables caching
    (every call scans — the pre-cache behavior, kept as an opt-out).
  - `now?: () => number` — injectable clock (Unix ms), default `Date.now`; mirrors `RingSelector`'s
    clock so TTL expiry is testable without wall-time sleeps.
- New private `getCachedUsedBytes()`:
  - TTL `<= 0` → scan every call (no cache, no single-flight — matches prior behavior exactly).
  - Cache hit within window → return cached value.
  - Miss → single-flight: hold the in-flight scan Promise so concurrent misses share one scan;
    on resolve, memoize `{ value, expiresAt: now() + ttl }`; clear the in-flight slot in `finally`
    (so a rejected scan is neither cached nor left wedged — next call retries).
- `getCapacity` override path unchanged in spirit: when `usedBytes`/`availableBytes` is supplied the
  `??` short-circuit means the scan (and therefore the cache) is never touched.

**`kv-raw-storage.ts`** — updated the write-path seam NOTE (line ~47): the TTL cache is the chosen
mechanism; the incremental byte counter stays deferred as a future option only if TTL staleness
proves insufficient. Counter still NOT implemented.

**`docs/repository.md`** — new "Capacity estimation and staleness" subsection under Implementation
Notes: documents the ≤TTL staleness bound and that `RingSelector` needs no forced-fresh read at
decision boundaries (its EWMA + dead-band + 10-min dwell absorb the staleness).

## Design decision (already resolved in the plan — do not relitigate)

TTL cache, **not** an incremental byte counter. The counter would need read-before-write on every
put (to subtract old size on overwrite), a durable counter surviving restart, and per-backend care —
buying precision the damped consumer cannot use. The seam NOTE preserves the counter as a future
escape hatch.

## Validation performed

- `yarn workspace @optimystic/db-p2p test` → **1298 passing, 36 pending, 0 failing** (54s).
- `storage-monitor.spec.ts` alone → **12 passing** (6 pre-existing + 6 new).
- `yarn workspace @optimystic/db-p2p build` (tsc) → exit 0, no type errors.

New tests (all from the ticket's "Key tests" list):
- Two `getCapacity` within TTL → scan spy called **once**.
- Advance injected clock past TTL → next call re-scans (spy twice total).
- `usedBytes` override → spy **never** called.
- `usedBytesCacheTtlMs: 0` → spy called once per `getCapacity` (twice for two calls).
- Two concurrent `getCapacity` on cold cache (`Promise.all`) → spy **once** (single-flight).
- Scan error → not cached, slot not wedged; next call retries and succeeds.

## Use cases to exercise / validate

- **Ring hot path**: a real `RingSelector.createArachnodeInfo` call should now trigger at most one
  backend scan instead of two. Not asserted end-to-end here — the cache is unit-tested on
  `StorageMonitor` in isolation. A reviewer wanting integration confidence could spy the driver's
  `approximateBytesUsed` through a live `RingSelector` and count calls per operation.
- **Backend without `getApproximateBytesUsed`**: `estimateUsedSpace` coalesces to `0`; caching `0`
  is fine and covered by the existing "treats backends ... as zero used" test (now runs under the
  default 60s TTL).

## Known gaps / honest flags (reviewer: treat tests as a floor)

- **Concurrency test determinism**: the single-flight test relies on both `getCapacity` calls
  reaching `getCachedUsedBytes` before the async spy resolves. It is deterministic given current
  microtask ordering (the spy increments its counter synchronously on invocation, and the second
  caller sees `inFlightScan` already set), but it is not a stress test — it does not cover 3+
  simultaneous callers or interleaved expiry-during-flight. Low risk; flagged for completeness.
- **Override + cache interaction is per-instance only**: `config` is fixed for a monitor's lifetime,
  so an instance either always uses overrides or never does; there is no "switch mid-life" path to
  test. If a future consumer mutates config, the bypass reasoning would need revisiting.
- **No cross-backend test** that a genuinely expensive scan (LevelDB/fs) is actually skipped — tests
  use a spy stub. The saving is structural (one call vs many), verified by call count, not wall-clock.
- **Staleness bound is asserted only in prose** (`docs/repository.md`) and by the plan's damping
  argument; there is no test proving a ≤60s-stale reading cannot cause a wrong ring move. That claim
  rests on `RingSelector`'s existing 10-min dwell, which is out of this ticket's diff.

## Tripwire recorded (not a ticket)

The incremental byte counter remains a deferred alternative. Parked as an updated `NOTE:` at the
write-path seam in `kv-raw-storage.ts` (~line 47) — the counter is only worth building if TTL
staleness ever proves insufficient for ring selection. No action now.
