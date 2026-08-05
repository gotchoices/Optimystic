description: A read of already-committed data now answers promptly and correctly even while a write to the same table is stuck waiting on the network, and the database engine has been told it is safe to run such reads at the same time as writes.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/read-view-pinned.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/commit-gate.ts, packages/quereus-plugin-optimystic/test/committed-read-stall.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-conformance.spec.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, docs/transactions.md, docs/internals.md, packages/db-core/src/collections/tree/readme.md
----

# Completed: `readCommittedSnapshot` declared, with the stall-overlap guarantee proven

`OptimysticModule` declares `readCommittedSnapshot = true` alongside
`concurrencyMode = 'reentrant-reads'`, so Quereus 4.8 routes eligible
`readConcurrency: 'committed'` statements off the execution mutex. A committed
read of a table now answers promptly and from one coherent boundary while
another statement's commit is parked against an unresponsive cohort.

## What shipped

**The snapshot-boundary pin (db-core).** `CollectionSnapshot` records the
committed boundary (`context`) it was captured on; `Tree.readView` pins the view
to the snapshot's own boundary instead of the collection's current one, and
`Collection.createReadTracker` drops cache-seed entries newer than that pin (they
refetch at the pinned revision, which `BlockStorage.getBlock(rev)` honours). This
is what keeps a committed read coherent while the legacy tree-by-tree commit
sweep is mid-publish — main table flushed and its revision advanced, index still
parked. A hand-built snapshot with no recorded boundary keeps the old behaviour.

**First-touch provisional initialization (plugin).**
`OptimysticVirtualTable.initializeForCommittedRead()`: when a writer transaction
is open, a cold table's first committed touch runs `doInitialize(readOnly: true)`
— no transaction state joined, no schema write, no `registerCollections()`, no
change subscription, and the table is not memoized as initialized so the next
quiescent or live touch upgrades it. When the bridge is quiescent it runs the
ordinary full initialization. `instantiateTable` no longer initializes its cached
arm; callers own initialization through the entry point their path requires.

**Proofs.** `test/committed-read-stall.spec.ts` (9 tests) drives a delegating
transactor (`test/commit-gate.ts`) that parks `pend`/`commit` behind a
test-controlled gate while `get` passes through, so a stall can be placed
mid-publish. Promptness is asserted with bounded `settleMacrotasks` turns, never
wall-clock — which doubles as proof the engine took the mutex-free path.
`test/committed-read-conformance.spec.ts` runs the engine-shipped harness in both
commit modes with `observedCommitOverlap` asserted true.

## Review findings

### Checked

Read the implement diff first, before the handoff summary. Verified against the
upstream obligation text (`@quereus/quereus` `vtab/module.d.ts` — flag name and
promise wording), the transactor's revision-scoped read path
(`TransactorSource.tryGet` → `StorageRepo.get` → `BlockStorage.getBlock(rev)`,
which is what makes the pin's refetch real rather than nominal), the
transaction-scoped collection cache (`CollectionFactory.getCachedCollection` —
confirms a provisional open shares nothing with the writer's transaction), every
`initialize()` / `ensureConnectionRegistered()` call site in the module, the
bridge's collection registry and dirty-tree snapshot accessors, and every doc the
change touched plus the ones it should have.

### Fixed in this pass (minor)

- **Stale-check race in `initializeForCommittedRead` (real, off-mutex).** When a
  provisional pass was in flight and the bridge happened to read as quiescent,
  the method delegated to `initialize()`, which awaits that provisional pass and
  only *then* samples `getCurrentTransaction()` — by which time a writer may have
  begun. A committed read could therefore drive exactly the transaction-joining
  full initialization the method exists to prevent (registering collections into
  the live registry, and persisting schema on a shape mismatch, mid-transaction
  and off the mutex). Fixed by giving an in-flight provisional pass precedence
  over the quiescence check: a committed read joins it and the upgrade happens on
  the next touch. The remaining quiescent branch is safe without a re-check —
  with no provisional pass to await, `initialize()` reaches
  `getCurrentTransaction()` in the same microtask as the check; that reasoning is
  now recorded at both checks.
- **`isProvisionallyInitialized` was never cleared** after a full upgrade, leaving
  both init flags true forever. Cleared alongside `isInitialized = true`.
- **Three stale comments the change invalidated**: `committedTreeView`'s header
  still said the view "pins to the committed revision current at this call" (the
  precise thing this ticket changed); `OptimysticCommittedTable.disconnect()`
  pointed at `resolveConnectedTable`'s `registerConnection` flag, renamed to
  `committed`; `docs/internals.md` still described the pinned `TransactorSource`
  context as frozen "at view-creation time" and the committed connect path as
  plainly "initializes" the table on first touch. All corrected.
- **Undocumented user-visible semantic.** The handoff flagged the shift honestly
  but the docs described only the mechanism. Added a paragraph to
  `docs/transactions.md` § "Committed reads run concurrently with a stalled
  commit" stating it plainly: `committed.<Table>` inside a deferred CHECK now
  describes the boundary the transaction first touched that table on, so it no
  longer observes an external commit landing mid-transaction on a table this
  transaction has already written to — and why that is safe (validator peers
  re-execute against their own committed state).
- **Dead local** in the conformance spec's `close()` test (`sawError` assigned,
  then only `void`ed).

### Added test coverage

- The MID-SWEEP stall test now also drives a **primary-key point lookup**
  (`plan=2`) during the stall and asserts it agrees with the full scan's row for
  the same key, with the writer still provably parked. The implementer's proof
  covered full scans and index scans; the point lookup descends the
  already-flushed main tree by key rather than walking it in order, which is the
  access shape most likely to surface a post-commit block if the pin slipped. It
  also asserts the post-release point lookup sees the new value, so the pin is not
  permanent.

### Found and left as-is, with reasons

- **The conformance harness's index-driven leg is skipped in both modes.** Real,
  and honestly reported by the harness (the skip reason is printed, not
  swallowed): the planner does not choose a seek for a range predicate on the
  integer primary key, because this module's `executeRangeQuery` is a documented
  full-scan fallback. Already tracked by `debt-optimystic-pk-range-seek` (gated on
  `debt-optimystic-true-key-ordering`); no new ticket. Index/full-scan agreement
  under stall is proven directly by the stall spec's forced index scans.
- **Session-mode "stalled then PARTIAL commit" is not driven end-to-end.** Making
  consensus half-land needs per-collection failure injection inside the
  coordinator's fan-out. Already tracked by
  `debt-bridge-partial-commit-branch-test`, which names the same
  `CoordinatorPartialCommitError` catch branch; no new ticket. The legacy partial
  arm *is* driven end-to-end.
- **The provisional schema-mismatch arm (`storedSchema = mergedCandidate`, no
  write) has no dedicated test.** Read it closely instead: it resolves to exactly
  the same in-memory shape the full pass persists, so the provisional and full
  passes decode identically — a missing test, not a divergence. A compound of
  three rare conditions; not worth a ticket at this size.
- **The `close()` test does not force the abort arm.** Correct as written — both
  arms are legal and the test pins the only illegal outcome (close hanging).

### Tripwires recorded (index only — analysis lives at the sites)

- `NOTE` at the full-initialization completion in `doInitialize`: this is the one
  path on which `doInitialize` runs twice for a table (the upgrade after a
  provisional pass), so it is the only one that replaces `rowCodec` /
  `indexManager` while a committed scan started off the provisional state may
  still be iterating — scans re-read both fields per row. Harmless while both
  passes resolve the same schema; the remedy (capture both as scan locals) is
  stated there. **New in this review.**
- `NOTE` at `committedTreeView`: an index created inside the in-flight transaction
  has no committed entries at the pinned boundary, so a committed read routed
  through it disagrees with a full scan. From the implement pass; re-read and kept
  — it is the one arm of the upstream obligation ("across concurrent DDL on that
  table") the declaration does not fully hold, and the remedy is stated at the
  site.
- `NOTE` at `TransactionBridge.degradedReason`: the declaration deliberately scopes
  its promise to concurrent tearing and does not treat a cleared latch as at-rest
  coherence. From the implement pass; verified against the declaration site and
  `docs/transactions.md`'s residual-limit paragraph.
- `NOTE` at `createReadTracker`: rev-0 cache-seed entries pass the pin filter.
  Verified against `CacheSource.snapshotEntries` (`revisions.get(id) ?? 0`) — the
  claim is accurate.

### Not found

No correctness defect in the pin itself, in the per-scan view construction, or in
the provisional pass's isolation from the writer's transaction: the
transaction-scoped collection cache, the bridge registry, and the engine's
connection registry are all genuinely untouched, and the stall spec asserts each.

## Validation

- `packages/db-core`: `yarn test` — **1345 passing**.
- `packages/quereus-plugin-optimystic`: `yarn build` + `yarn test` — **358
  passing, 11 pending, 0 failing**, + `smoke ok quereus@4.8.0`.
- Root `yarn build` and `yarn lint` clean.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- Env-gated integration specs (`OPTIMYSTIC_INTEGRATION=1`) not run, as in the
  implement pass.
- `packages/db-p2p` not re-run in this pass — db-core was unchanged by the review
  edits (they touch the plugin and docs only), and the implement pass recorded
  1515 passing / 44 pending against the same db-core state.
