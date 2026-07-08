description: The "how full is my storage" check used to re-scan the entire store on every call; it now caches the answer for 60 seconds so most calls are instant. Reviewed and shipped.
prereq:
files: packages/db-p2p/src/storage/storage-monitor.ts, packages/db-p2p/test/storage-monitor.spec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/repository.md
difficulty: medium
----

# Complete: cache the used-bytes scan with a short TTL

## What shipped

`StorageMonitor.getCapacity` no longer runs the backend's full-store `getApproximateBytesUsed`
scan on every call. The scan is memoized behind a time-to-live (`usedBytesCacheTtlMs`, default
60000ms; `0` disables). Within the window callers share the cached value; concurrent cold-cache
misses share one in-flight scan (single-flight); a supplied `usedBytes`/`availableBytes` override
bypasses the scan and the cache entirely. Clock is injectable (`now?`) for testable TTL expiry.

Collapses the repeated-scan cost (≥2 scans per `RingSelector.createArachnodeInfo`, one per
`shouldTransition` tick) to at most one scan per TTL window.

## Review findings

Adversarial pass over commit `3ee9d7b`. Read the full source, test, and docs diff before the
implementer's handoff.

**Checked — clean, no action:**
- **Correctness of the cache state machine** — TTL disabled (`ttl <= 0` → scan every call, no
  single-flight), hit (`now() < expiresAt`), miss with single-flight, and re-arm on expiry all
  trace correctly. `.then` memoizes before `.finally` clears the slot (chain order guarantees it).
- **Error handling / resource cleanup** — rejected scan is neither cached (`.then` skipped) nor left
  wedged (`.finally` clears `inFlightScan` on both resolve and reject); rejection propagates through
  `getCapacity` to the caller, matching pre-cache behavior. Covered by the "does not cache or wedge"
  test.
- **Override interaction** — `??` short-circuit means an explicit `usedBytes`/`availableBytes`
  bypasses `getCachedUsedBytes` entirely; config is `readonly` per instance so no mid-life switch
  path exists. Tested (spy never called).
- **Consumer blast radius** — the only real-`StorageMonitor` construction is
  `libp2p-node-base.ts:936` (production now gets 60s default caching — intended). `RingSelector`
  tests use a `MockStorageMonitor`, so no test depends on fresh-read-per-call semantics. No breakage.
- **Type safety / DRY / SPP** — single seam, well-documented, no duplication.
- **Lint** (`eslint` on the 3 touched files) → clean.
- **Tests** (`yarn workspace @optimystic/db-p2p test`) → **1298 passing, 36 pending, 0 failing**
  (52s). Includes the 6 new cache tests. Build reported exit 0 by implementer.

**Found — tripwire (recorded, not a ticket):**
- **Default TTL (60s) equals the ring monitor tick interval** (`setInterval(..., 60_000)` in
  `libp2p-node-base.ts:1104`). At the default this is fine — each `shouldTransition` tick folds a
  roughly-fresh sample into its EWMA. *If* `usedBytesCacheTtlMs` is later raised above the tick
  interval (or the tick shortened below the TTL), consecutive ticks fold the *same* stale sample
  into the EWMA, biasing the smoothed ring depth toward stale. Conditional, absorbed by the existing
  dead-band + 10-min dwell → not a defect. Parked as a `NOTE (tripwire)` bullet in the
  "Capacity estimation and staleness" section of `docs/repository.md`.

**Found — minor (fixed in this pass):**
- None beyond the tripwire. The docs bullet above is the only edit this review made.

**Not filed as tickets (out of scope / already handled):**
- Incremental byte counter — a *deferred alternative*, already parked as a `NOTE:` at the write-path
  seam in `kv-raw-storage.ts` (~line 47). Only worth building if TTL staleness ever proves
  insufficient. Carried over from the implement stage; no change.

**Test coverage assessment (implementer's tests treated as a floor):**
- Floor is solid: happy path (hit within TTL), expiry (re-scan past TTL), override (never scans),
  disabled (`ttl:0` scans each call), single-flight (concurrent cold misses → one scan), error path
  (no cache, no wedge, retry succeeds). Edge cases left uncovered are low-risk and flagged by the
  implementer (3+ simultaneous callers, interleaved expiry-during-flight, exact `expiresAt`
  boundary). No new tests were required to reach adequate confidence; the structural saving
  (one call vs many) is verified by call-count spies rather than wall-clock, which is appropriate.

## Design decision (settled in plan — not relitigated)

TTL cache, not an incremental byte counter. The counter would need read-before-write on every put,
a durable restart-surviving counter, and per-backend care — precision the damped consumer cannot
use. Seam NOTE preserves it as a future escape hatch.
