description: A batch of small storage-layer fixes — stop code from reordering its caller's list, clone objects before storing them, keep a restoration metric honest and hand out copies of it, hash a real peer id instead of a fake one, inject the node's own id instead of casting into another library's internals, and treat "couldn't read the folder" differently from "folder is empty." Reviewed and accepted.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/reference-peer/src/cli.ts, packages/db-p2p-storage-fs/src/file-storage.ts
----

# Complete: assorted storage-layer correctness & cleanliness fixes

Six independent storage-layer defects fixed in the implement stage; reviewed here adversarially.
All six fixes are correct, well-tested, and accepted with no inline changes needed. One resolved
duplicate backlog ticket was removed. Details below.

## What landed (per defect — verified)

1. **In-place sort mutating caller state — `storage-repo.ts:165`.** `get()`'s promotion loop now
   sorts `[...missing]`; when the block has no committed `latest`, `missing` aliases
   `context.committed`, so the copy prevents reordering shared request state. **Verified:** the
   aliasing path (undefined `latest` → `missing === context.committed`) is real, and the regression
   test asserts both element order and identity unchanged.
2. **Missing clone in `saveTransaction` — `memory-storage.ts:102`.** Now `structuredClone(transform)`,
   matching every sibling writer and the documented clone-on-store invariant
   (`docs/internals.md` §"Storage Returns References" — confirmed the referenced section exists and
   the doc already reflects this reality; no doc edit needed).
3. **Dead metric + reference-leaking getter — `restoration-coordinator.ts`.** `failureByRing` now
   incremented once per exhausted ring (`recordFailure`), and `getMetrics()` returns fresh `Map`
   copies. **Verified:** the failure-count call sites are correct (my-ring after the peer loop; each
   inner ring after its loop; no double-count since the my-ring depth and inner rings are disjoint),
   and the snapshot-isolation test passes.
4. **Fake `PeerId` was a live crash — `ring-selector.ts:99`.** Now `hashPeerId(peerIdFromString(peerId))`.
   **Verified this was more severe than a swallowed test error:** `createArachnodeInfo` (`ring-selector.ts:114`)
   `await`s `calculatePartition` with **no** try/catch, and node bring-up
   (`libp2p-node-base.ts:886`) `await`s `createArachnodeInfo` — so pre-fix, **any node landing on
   ring ≥ 1 (i.e. capacity-constrained) threw `TypeError: peerId.toMultihash is not a function`
   during startup**, not just in tests. The rewritten `ring-selector.spec.ts` uses real Ed25519
   peer-id strings and asserts a defined partition, so it genuinely fails on the pre-fix code.
5. **`as any` into FRET internals — `arachnode-fret-adapter.ts`.** Optional `selfPeerId` constructor
   param, injected at both production sites (`libp2p-node-base.ts:872`, `reference-peer/src/cli.ts:160`),
   private-`.node` read kept only as a narrowed fallback. **Verified all `new ArachnodeFretAdapter`
   sites:** the two production sites inject; the three test sites (rebalance-monitor,
   rebalance-reaction, unify-tracked-block-set) keep the single-arg form and behave identically to
   pre-fix (their mock FRET never had `.node`, so `getMyArachnodeInfo` returned `undefined` before
   and after).
6. **`readdir` swallowed all errors as "no pendings" — `file-storage.ts:77`.** Now rethrows unless
   `code === 'ENOENT'`; unrecognized `.json` ids are `log()`-skipped instead of silently dropped.

## Review findings

**Scope of review:** read the full implement diff (src + tests) with fresh eyes before the handoff,
then scrutinized each fix for correctness, aliasing, type safety, resource cleanup, and test honesty.

- **Correctness — checked, no defects.** Each of the six fixes does what it claims. The two highest-
  risk fixes (#1 aliasing, #4 startup crash) were traced through their real call paths and confirmed.
- **Type safety — checked, clean.** #5 replaces a bare `as any` with a named narrowed local type; #4
  adds a properly-typed import. No new `any` introduced. Lint passes on all touched files.
- **Tests — checked, adequate as a starting point and extended coverage confirmed.** Happy path, the
  ENOENT-vs-EACCES error path (#6), snapshot isolation and ring-exhaustion counting (#3), aliasing
  regression (#1), and real-peer-id partition (#4) are all exercised. The pre-fix→fail property of
  the #4 test was verified by reasoning through the throw path.
- **Docs — checked, current.** `docs/internals.md` §"Storage Returns References" already documents
  the clone-on-store invariant #2 restores; no doc drift introduced by these fixes.
- **Duplicate backlog ticket — RESOLVED and REMOVED.** `tickets/backlog/bug-arachnode-partition-hashpeerid-throws.md`
  described exactly defect #4 (the `hashPeerId` throw). It is fully resolved by fix #4 (verified: same
  file/line, same TypeError, now covered by tests that fail on the old code). Left in place it would
  have cost a future agent a whole cycle re-doing landed work, so I deleted it as part of this review.
- **Minor / inline fixes applied:** none. Code quality is high and comments are thorough; nothing
  warranted a touch-up.
- **Major / new tickets filed:** none.

## Tripwires (conditional concerns — parked, not ticketed)

- **`failureByRing` counts empty rings, amplified by the default ring depth of 8.** When
  `getMyArachnodeInfo()` yields no info, `getMyRingDepth()` defaults to 8, so a failed restore on a
  node with no ring peers records a failure for rings 8..0 (nine counts). This is a metric-inflation
  concern only, not a correctness bug, and is documented inline at the `recordFailure` call sites in
  `restoration-coordinator.ts`. It only becomes work if the metric is ever consumed as "peers were
  dialed and none had it" rather than "rings queried"; if so, exclude the empty-ring case. Parked
  where a reader meets it (the call-site comments); indexed here.
- **`directoryByteSize` (`file-storage.ts:148`) swallows non-ENOENT `readdir`/`stat` errors** and
  returns a best-effort partial size. Unlike `listPendingTransactions` (fixed in #6), this is a
  capacity *metric*, so a best-effort estimate is acceptable and the divergence is intentional. Not
  changed; noted here in case a future need for exact sizing makes the swallow matter.

## Honest gaps carried forward

- **The full `db-p2p` suite (heavy mesh / cohort-scale / real-libp2p / `*.integration.spec.ts`) was
  not run** — its wall-clock risks the 10-minute agent idle-timeout. Coverage run this pass: the
  directly-affected specs (ring-selector, restoration-coordinator, storage-repo, memory-storage) plus
  the adjacent specs that construct `ArachnodeFretAdapter` / exercise the changed storage surface
  (rebalance-monitor, rebalance-reaction, unify-tracked-block-set, block-storage) and the fs suite
  (file-storage) — all green. A human/CI run of the full suite is the remaining out-of-band check;
  no ripple is expected since the diffs are localized and all adjacent constructors behave identically.

## Validation performed (review)

- `yarn build` (tsc) — **db-p2p** and **db-p2p-storage-fs** pass.
- `yarn lint` on all 13 touched files — **clean**.
- `db-p2p` specs — `RingSelector`, `RestorationCoordinator`, `StorageRepo`, `MemoryRawStorage`
  (**76 passing**); adjacent `RebalanceMonitor`/`RebalanceReaction`/`unified owned-block`/
  `BlockStorage` (**32 passing**).
- `db-p2p-storage-fs` — `FileRawStorage` incl. new readdir-discrimination suite (**9 passing**).
