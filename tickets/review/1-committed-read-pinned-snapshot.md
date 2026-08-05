description: A read that asks for "only already-committed data" could change its answer (or crash) halfway through, because it shared a block cache with the writer publishing new data. Such reads are now pinned to a fixed point in time; review the implementation and its tests.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/read-view-pinned.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts, packages/db-core/src/collections/tree/readme.md, docs/internals.md
difficulty: medium
----

# Review: pinned committed read view

## What was built

`Collection.createReadTracker(transforms, options?)` (`collection.ts`) no longer hands the
read view the collection's SHARED cache. It builds, in one synchronous block (freeze and
seed must describe the same instant — do not introduce an `await` between them):

- a private `TransactorSource` whose `actionContext` is a `structuredClone` FROZEN at
  view-creation time — a block first fetched after a later commit still materializes at
  the pinned revision, because the transactor honours `context.rev` on `get`;
- a private `CacheSource` nothing else references (so the live collection's
  `transformCache`/`clear` cannot reach it), seeded from the shared cache via the new
  `CacheSource.snapshotEntries()` (cloned entries + per-id revisions, LRU order) and a new
  optional `seed` constructor argument;
- by default NO read-dependency collector — see behavior change below. `ReadViewOptions
  { recordReads?: boolean }` (default false) opts back in, wiring the collection's shared
  collector (exposed via new `TransactorSource.getCollector()`).

`Tree.readView(snapshot, options?)` forwards the options; single-argument call sites are
unchanged. No plugin code changed — it inherits the fix through `readView`.

## Interleave probe: REPRODUCED a live defect (worse than a tear)

The ticket asked whether the `update()`-clears-the-cache arm is reachable today.
**It is.** `packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts`
drives, in ONE statement (`db.eval`, pulled row-by-row), a `committed.Usage` scan whose
per-row correlated subquery scans live `Usage` (each evaluation calls
`collection.update()`), while a second `Database` sharing the same storage commits
inserts and a delete between pulls. On unmodified code this did not merely tear — it
**crashed**: `Query failed: Missing block (…)` out of `queryCommitted`, because the
mid-scan cache clear + context advance made the committed walk chase a block id the
concurrent commit had reorganized away. With the fix the same spec passes (row set
exactly the pre-scan committed keys). Note `committed.<Table>` resolves in any FROM
clause, not just deferred CHECKs — the execution-mutex argument does not confine this.

## Validation

All red-first: the four mid-scan db-core tests and the plugin probe were written and run
against unmodified code first; all failed with mixed-state rows (one even lost rows), the
probe with the crash above.

- `packages/db-core`: `yarn test` — 1344 passing. New spec `read-view-pinned.spec.ts`:
  - walk unchanged by mid-scan `applyCommittedToCache` + `tracker.reset()` (session-mode
    fold), asserted row-for-row with differing rows named;
  - walk unchanged by mid-scan `update()` after an external commit (the real
    cache-clearing path, via a second Tree over the same transactor);
  - 500-entry tree at fan-out 4 (well over the 128-block LRU): evicted/never-seeded
    blocks refetch at the pinned revision while the SAME collection commits mid-scan —
    this is the case seeding alone cannot cover and the frozen context does;
  - two views at different revisions do not interfere;
  - committed view of a never-synced collection readable (and blind to later staging);
  - `recordReads` default records nothing; `{ recordReads: true }` grows the shared set;
  - `BlockUnavailableError` propagates from the pinned source (never reads as absent).
- `packages/quereus-plugin-optimystic`: build + `yarn test` — 337 passing incl. the
  existing `committed-read.spec.ts` and the new interleave probe.
- `packages/db-p2p`: `yarn test` — 1515 passing (consumer sanity; only optional params
  were added to db-core constructors).
- `yarn lint` clean at root. Env-gated integration specs (`OPTIMYSTIC_INTEGRATION=1`)
  were NOT run.

## Behavior change reviewers must weigh

**Committed views no longer feed the writer's conflict set.** Previously a committed scan
recorded read dependencies into the collection's shared collector, so a committed read
could fail the writer's commit validation. Now the default is no recording
(`recordReads: false`). Safety argument (from the ticket): deferred-CHECK protection does
not come from the read set — validator peers re-execute the transaction's recorded
statements against their own committed state (`quereus-validator.ts`), so a constraint
that no longer holds is caught at validation. No in-repo caller passes
`recordReads: true` today.

## Network-path confirmation (ticket TODO)

The pinning guarantee holds on the production path: `NetworkTransactor.get` forwards
`context` to each peer's `IRepo.get`; `StorageRepo.get` calls
`BlockStorage.getBlock(context?.rev)`, which resolves the highest committed rev ≤ the
requested one (`materializeBlock`'s descending walk); `CoordinatorRepo` forwards the same
context on its cluster consult and local refresh. One asymmetry vs `TestTransactor`: a
node holding ONLY revisions newer than the pinned one answers `unavailable`
(→ `BlockUnavailableError`) rather than "absent" for a block that did not exist at the
pinned revision. That errs loud, and a pinned walk cannot normally reach such a block
(pinned interior nodes only reference pinned-era children).

## Known gaps / notes for review

- **Legacy partial-commit sweep** (`commitDirtyTreesLegacy` mid-sweep visibility) has no
  dedicated multi-tree test. Both mutation sites it goes through (`transformCache` via
  `sync`, `clear` via `update`) are covered per-tree by the mid-scan tests, and each tree's
  view is now fully private, so cross-tree exposure has no remaining mechanism — but a
  reviewer wanting an explicit PartialCommitError-shaped test won't find one.
- **Memory tripwire** (recorded as NOTE in `createReadTracker`'s doc and the tree readme):
  each view holds up to 128 cloned blocks plus fault-ins; fine while views are per-scan —
  if long-lived committed scans appear, revisit.
- `recordReads: true` records dependencies at the PINNED revisions; the collector's
  max-wins merge keeps the higher revision if the live path also read the block.
- Seeding order preserves LRU order (`snapshotEntries` iterates oldest-first) so the
  private cache evicts in the same order the shared one would have.
- Docs updated: `packages/db-core/src/collections/tree/readme.md` (new "Committed read
  views" section), `docs/internals.md` (new "Committed reads are pinned, not shared-cache"
  subsection under the read path).
