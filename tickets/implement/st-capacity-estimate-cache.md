description: The "how full is my storage" check reads the entire store every time it is asked, and the ring-selection logic asks repeatedly. Cache the answer for a short interval so most calls are instant.
prereq:
files: packages/db-p2p/src/storage/storage-monitor.ts, packages/db-p2p/test/storage-monitor.spec.ts, packages/db-p2p/src/storage/ring-selector.ts, docs/repository.md
difficulty: medium
----

# Cheap capacity estimate — cache the full-store byte scan with a short TTL

## Problem

`StorageMonitor.estimateUsedSpace` (`storage-monitor.ts:48`) calls the backend's
`getApproximateBytesUsed`, which is a **full-store scan** on every call: LevelDB iterates every
key+value (`leveldb-storage.ts:157`), the fs adapter stats the whole tree
(`file-storage.ts:280`), the memory driver sums every entry. `RingSelector` calls
`getCapacity` on a hot path — twice per `createArachnodeInfo` (once directly at
`ring-selector.ts:212`, once inside the `determineRing` it calls at `:213`), plus once per
`shouldTransition` tick. So the O(store) scan runs several times per ring operation.

## Resolved design: cached estimate with a TTL (not an incremental counter)

Memoize the used-bytes scan in `StorageMonitor` with a time-to-live. The first call scans; calls
within the TTL window return the cached value; after expiry the next call re-scans. This collapses
the repeated-calls-per-operation cost (2+ scans per `createArachnodeInfo`) to at most one scan per
TTL window, is backend-agnostic (the full-scan drivers stay correct as the fallback), needs no
write-path changes, no durable counter, and no read-before-write.

**Why not the incremental byte counter.** An incrementally-maintained counter (hooked at the
kernel write seam noted in `kv-raw-storage.ts:47`) is more precise and O(1) to query, but costs:
a read-before-write on every put to learn the old value's size (to subtract on overwrite), a
durable counter that must survive restart (else a full rescan to rebuild), and per-backend care.
Ring selection is already heavily damped — EWMA smoothing, a hysteresis dead-band, and a 10-minute
minimum dwell (`ring-selector.ts:12`) — so it tolerates a bounded-staleness estimate by design. The
extra precision buys nothing the consumer can use, at real write-path cost. Leave the
`kv-raw-storage.ts` seam NOTE in place, updated to say the TTL cache is the chosen mechanism and the
counter remains a future option only if TTL staleness ever proves insufficient. Do **not** implement
the counter.

## Behavior

Add to `StorageMonitorConfig`:

- `usedBytesCacheTtlMs?: number` — cache lifetime. Default **60000** (60s). `0` disables caching
  (every call scans — the current behavior, for opt-out / tests).
- `now?: () => number` — injectable clock (Unix ms), default `Date.now`. Mirror `RingSelector`'s
  injectable-clock pattern so TTL expiry is testable without sleeping on wall time.

`getCapacity` logic:

- When `usedBytes` or `availableBytes` is supplied (override path), **bypass the cache entirely** —
  no scan happens today and none should be cached.
- Otherwise consult the cache: if a cached value exists and `now() < expiresAt`, use it; else scan
  via `getApproximateBytesUsed`, store `{ value, expiresAt: now() + ttl }`, and use it.
- **Single-flight**: hold the in-flight scan Promise so concurrent `getCapacity` calls that both
  miss share one scan instead of launching several. Clear it once resolved.

## Staleness bound

The cached `used` (hence `usedPercent` and `available`) may lag reality by up to the TTL. That is
acceptable for ring selection: the move triggers are EWMA-smoothed, dead-banded, and gated by a
10-minute dwell, so a ≤60s-stale reading cannot cause a wrong or premature move — at worst it delays
one by up to the TTL, which is immaterial against a 10-minute dwell. **`RingSelector` needs no
forced-fresh read at decision boundaries.** Document this bound in `docs/repository.md` so doc and
code agree.

## Edge cases & interactions

- **Override bypass.** `usedBytes`/`availableBytes` set → never scans, never populates the cache.
- **TTL disabled (`0`).** Every call scans (current behavior) — must remain an available opt-out.
- **Clock injection.** Advancing the injected clock past `expiresAt` triggers exactly one re-scan.
- **Concurrent misses.** Two overlapping `getCapacity` calls on a cold/expired cache → the spy
  observes exactly one `getApproximateBytesUsed` (single-flight), both callers get the same value.
- **Backend without `getApproximateBytesUsed`.** `estimateUsedSpace` already coalesces to `0`;
  caching `0` is fine.
- **Scan error.** If `getApproximateBytesUsed` rejects, do not cache a bogus value and do not wedge
  the single-flight slot — clear the in-flight Promise so the next call retries.

## Key tests (write these)

- Two `getCapacity` calls within the TTL → `getApproximateBytesUsed` spy called **once**.
- Advance injected clock past TTL → next `getCapacity` scans again (spy called twice total).
- `usedBytes` override supplied → spy **never** called.
- `usedBytesCacheTtlMs: 0` → spy called once per `getCapacity`.
- Two concurrent `getCapacity` on a cold cache → spy called once (single-flight).

## TODO

- Extend `StorageMonitorConfig` with `usedBytesCacheTtlMs` (default 60000) and `now`.
- Add the memoized used-bytes cache + single-flight to `StorageMonitor`; bypass on override.
- Update the `kv-raw-storage.ts:47` seam NOTE (TTL cache chosen; counter deferred).
- Document the staleness bound + "no forced-fresh read needed" in `docs/repository.md`.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`; ensure
  storage-monitor + ring-selector specs pass.
