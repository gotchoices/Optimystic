description: A change staged in memory now records which version of the block it was computed from and keeps that number until the change is committed or re-made, so the version a write later declares to storage is always the one its edits were really built on.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/base-pins.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/refresh-below-floor.spec.ts, packages/db-core/test/digest.spec.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/collection.spec.ts, docs/internals.md, packages/db-core/docs/collections.md
difficulty: hard
repro: verified
----

# A staged edit keeps the version it was computed against — complete

First of the three tickets split from `bug-a-pended-transform-does-not-carry-its-base`. No wire or storage format changed. The next ticket (`bug-a-pended-transform-does-not-carry-its-base`, in `implement/`) consumes `Tracker.stagedBaseRevs(blockIds)` from here; it returns `Record<BlockId, number>`, the shape that ticket puts on the pend.

## What was built (implement stage)

Three invariants, one site each. `docs/internals.md` § *Staged Edits Keep Their Base* is the summary; the code comments carry the reasoning.

**Invariant A — read cache (`CacheSource`).** What a read returns for a block is what the cache then describes for it. The miss path goes through one `admit` step that decides the returned content and the cache's description together. A keepable, still-wanted answer is kept and returned. Any other answer (below floor, or overtaken in flight) is returned only when the cache holds nothing for the id; when it holds something, the reader gets the held content and its revision, and the answer leaves no trace. With nothing held, the answer is handed through (returned, described by `peek` and `getCachedRevision`, not kept). The read dependency recorded is the revision actually returned. An LRU-evicted id keeps its `revisions` entry on purpose: it is the revision of the content last served, which a rev-only pin carries.

**Invariant B — tracker (`Tracker`, `BasePins`).** The base of a block's staged updates is fixed at the first update and never replaced while updates remain staged. `PinnedBase.block` is optional (a rev-only pin: read, evicted, then updated) and `PinnedBase.moved` marks a base the source no longer describes at the pinned revision. `Tracker.update` pins only on the first op for the id in this tracker; later ops re-judge the pin (`revalidatePin`): a generation change at the same revision refreshes the clone and generation, a different or absent revision marks it moved. A moved pin is never repaired by re-pinning or by falling back to the live cache. `peekMaterialized` returns nothing for a moved or rev-only pin; otherwise `baseRev` is always the pin's revision. Over a drift-aware base source an unpinned update declares nothing. New readers: `stagedBaseRevs(blockIds)`, `movedBases()`, `unretainedBases()`. `BasePins.adopt` keeps the parent's pin and marks it moved when the atomic brings the same id at a different revision. `reset(transforms)` retains moved marks for still-staged ids; `reset()` clears everything.

**Invariant C — collection (`Collection`, `TransactionCoordinator`).** A pending action is never pended over a moved base. `mustReplay` gained a third reason (pending actions and a moved base). `Collection.restageIfBasesMoved()` reads each pinned id the cache does not retain, re-judges every pin, and replays the queue if any moved, logging `collection:restage-moved-base` per block. Called at the top of every `syncAttempts` iteration and in both coordinator commit spans before the pre-commit snapshots and the log append.

Deviations from the plan text, with reasons, are recorded in the implement-stage commit (`git log --grep="ticket(implement): a-staged-edit-keeps-the-version-it-was-computed-against"`): re-validation reads only unkept ids rather than evicted ones; the coordinator calls run before the snapshots rather than before `pendPhase`; reads of a moved base still serve live content plus staged ops; `peekMaterialized` may record that a base moved.

## Review findings

**Read first:** the implement-stage diff in full (all nine source and doc files, three specs), then the handoff. Lint (eslint on every touched file), `yarn build`, `yarn typecheck`, `yarn lint:docs`, and the db-core, db-p2p and quereus-plugin suites were run after the review's own edits.

### Major findings, fixed in this pass (each was a real fork path within the ticket's own invariant B)

- **The atomic flush re-pinned a moved base at the new revision.** `Atomic.commit` adopted the atomic's pins into the parent and then replayed the atomic's ops through the parent's `update`. The parent's first op for the id went through `pinBase`, whose "keep an existing pin only if it names the cache's current revision" rule replaced the adopted pin with a fresh probe when the cache had moved between the atomic's pin and the flush (a concurrent unlatched read that reloaded the block after storage caught up). The parent then held the new revision for operations computed on the old one, `movedBases()` reported nothing, and the pend would have declared the wrong base, the one direction the storage guard cannot catch. Reproduced with a unit test before the fix (parent reported base 9 for ops built on 7). Fix: `Tracker.absorb(child)` is now the flush. It adopts the child's pins, then stages the child's ops keeping the adopted pin as the base of any update the child pinned; only an update the child did not pin is probed. `update` was split into `stageUpdate` (transforms and memo) plus the pin step, and `pinBase` lost its existing-pin rule, since the one legitimate pre-existing pin (an atomic's) never reaches it now. Regression test: "a base that moves between an atomic's pin and its flush stays the atomic's base in the parent, marked moved" in `digest.spec.ts`.
- **A restored snapshot paired old operations with the pins of a later re-stage.** `snapshotPending` did not carry pins, and the implement diff itself introduced a replay between a snapshot and its restore: in `TransactionCoordinator.execute` the new `restageIfBasesMoved` call sits after `preStageSnapshots` are taken, and the pre-existing `restorePending` NOTE named the same shape for a mid-transaction savepoint restored across a moved boundary. After such a restore the transforms were the pre-replay operations (computed on the old base) while `reset(transforms)` retained the replay's pins for those ids, so `stagedBaseRevs` named the new base for old operations and the next commit would apply them over the newer content. Reproduced at the collection level before the fix (restored operations named base revision 2 instead of 1, and the append would have committed "v1+local" over "v2-committed"). Fix at the one site that owns both symptoms: `CollectionSnapshot` carries `pins` (a `BasePins.copy()`), and `restorePending` restores them with the transforms (`BasePins.replaceWith`, in place because the store is shared with per-attempt trackers). The pre-pend re-validation then finds the restored bases moved and re-stages, so the write side of the `restorePending` NOTE's moved-boundary shape is closed; the read side (stale structure served until the pend) is unchanged and the NOTE still names it. Regression test: "a restored snapshot brings back the bases its operations were computed on, so the retry re-stages instead of forking" in `collection.spec.ts`, asserting the pinned revision after restore, `movedBases()`, and the committed value in storage.

### Minor findings, fixed in this pass

- `BasePins.adopt` traded a parent's full pin for the atomic's rev-only pin at the same revision, losing digest coverage for no reason. It now keeps the parent's clone in that case. Test: "adopting a rev-only pin at the revision the parent pins in full keeps the parent's clone" in `digest.spec.ts`.
- `Tracker.baseRevision` became unused after the `pinBase` simplification and was removed.
- Docs updated for both fixes: `docs/internals.md` § *Staged Edits Keep Their Base* and `packages/db-core/docs/collections.md` now say the pins travel with the operations (atomic flush and snapshot/restore). `yarn lint:docs` resolves.

### Checked and found sound

- **Cache invariant A on every path.** Hit, kept, handed through, held-over-unkeepable, held-over-overtaken, evicted-then-reloaded: the returned content and the recorded dependency agree with `peek` and `getCachedRevision` in each case. `handThrough`'s removed early return is covered by `admit` deciding the held case first. The case of an unkeepable answer arriving over an *unkept* entry at a higher revision is not treated as "held" (only `cache` is consulted); both are below floor, the reader gets what it fetched and the cache describes exactly that, so the invariant holds. Pre-existing behaviour, left alone.
- **`revalidatePin`.** Operator precedence in the refresh line (`block ?? pin.block ? … : …`) parses as intended; a rev-only pin at the same revision with nothing to peek stays rev-only; a moved pin is never refreshed.
- **`movedBases` and `mustReplay`.** Restricted to ids the live tracker stages as updates, so abandoned per-attempt log-block pins in the shared store never trigger a replay. A cleared id (revision undefined) is moved; a same-revision reload before anything observed the clear is a refresh, not a move (test pins both).
- **`restageIfBasesMoved` gating on `pending.length`.** Correct: a tracker holding transforms with an empty queue (an invented collection's header and root) must not be replayed to nothing.
- **Coordinator call sites.** `commitOnceLatched` restages before its snapshots, so a failed attempt restores transforms that agree with the pins. `execute` restages after its pre-stage snapshots; with the snapshot now carrying pins that ordering is safe, and reordering it is not possible (the snapshots must precede `applyActions`).
- **Abandoned per-attempt tracker pins.** With `pinBase` always probing, a stale log-block pin from an abandoned attempt is replaced on the retry's first op for that block, which `Log.addActions` has just read, so it is resident and pinned in full. The next ticket's `stagedBaseRevs` on the per-attempt tracker will therefore name the tail's current revision, not the abandoned one.
- **The rewritten existing tests.** Each expectation change follows from invariant A (a late reader gets held content) or invariant B (a folded base is moved, not re-described); none loosens an assertion.
- **Perf guards** (`tracker-read-perf`, `refresh-read-cost`, plugin `cold-apply-cost` and `index-backfill-cost`) pass unchanged in the full runs.

### Tripwires recorded

- `Collection.restageIfBasesMoved` (collection.ts): reads are not latched, so a concurrent read can still move a base between the check and the pend; the pend then declares the old revision, storage refuses, the retry re-stages. One wasted round trip, never a wrong base. `NOTE:` at the site names the closure (pend under the read latch) if the refusal ever shows up.
- `restorePending` (collection.ts): the read side of a savepoint restored across a moved boundary (stale structure until the pend) keeps its existing `NOTE:`; only the write side was closed here.
- `CacheSource.unkept` doc comment already bounds the map by unmet floors plus ids caught mid-flight; not measured, left as the existing `NOTE:`.

### Not filed, and why

- `TransactionCoordinator.execute`'s restage call still has no dedicated multi-collection test; the snapshot fix makes its bracket safe by construction and the coordinator specs that stage over stable bases pass. Conditional on `execute` ever gaining a multi-collection production caller, which its own comment says none is today; not a ticket.
- `collection.ts` is 2043 lines after this pass (measured with `wc -l`), up about 80 from the implement stage. Already claimed by `backlog/debt-collection-write-retry-logic-outgrew-its-file`; this instance is evidence for that ticket, not a new one.
- No pre-existing test failures were seen in any suite.

## What was measured (after the review's edits)

| Check | Result |
|---|---|
| `yarn workspace @optimystic/db-core test` | 1825 passing |
| `yarn workspace @optimystic/db-p2p test` (after `yarn build`) | 3023 passing, 63 pending (env-gated) |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` | 997 passing, 13 pending |
| `yarn typecheck` (root, after `yarn build`) | clean |
| `yarn lint:docs` | 46 documents, all resolve |
| eslint on every touched source and spec file | clean |
| Both major findings | reproduced failing before the fix, passing after |
