description: A table opened partway through a transaction used to keep its changes when that transaction was cancelled — the changes leaked into the next transaction's saved history. Fixed, reviewed, and shipped.
files:
  - packages/db-core/src/transaction/coordinator.ts (`CollectionCapture` type ~50; `applyActions` ~105-120; `captureUncaptured` ~122-160; `rollback` ~560-640)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (helpers `registerLate` / `insertKeys`; `collections registered mid-transaction` describe block, 7 cases)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (comment corrections at `doInitialize`, `registerCollections`, `update`, `declareIndex`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`addStatement` doc correction)
----

# What shipped

`TransactionCoordinator` undoes a transaction by restoring every collection to a
snapshot of its staged state (tracker transforms + queued action list). It used to take
that snapshot once, on the transaction's first `applyActions`, covering only the
collections present in the live `this.collections` map at that instant. That map is
owned by the caller (the Quereus adapter's registry) and grows as tables open, so a
collection registered later was visible to commit but missing from every snapshot —
`rollback` never visited it, and its cancelled staged state survived into the next
transaction's durable log entry, still tagged with the cancelled stamp.

Three coupled changes, all inside `coordinator.ts`; no cross-package API added.

**Capture is reconciled on every `applyActions`, not just the first.** Each call, before
`applyActionsRaw`, captures any collection now in the live map that this stamp has not
captured yet. An already-captured guard keeps idempotent re-registration from recording
a *dirty* state as "before" (which would make rollback preserve the actions it must
discard). The loop is synchronous and `await`-free through to `applyActionsRaw`.

**Per-collection earliest capture, ranked by a monotonic `seq`.** Lazy capture broke the
old `rollback`, which picked ONE snapshot map (the lowest-`order` stamp's) and restored
everything from it — sound only while capture was eager. `preSnapshot` is now
`Map<Collection, CollectionCapture>` with a coordinator-global `nextCaptureSeq`;
`rollback` merges the rolled-back stamp's and every survivor's maps keeping the lowest
`seq` per collection. Stamp `order` now orders survivor *replay* and nothing else.

**Keyed by `Collection` instance, not `CollectionId`.** If a table re-initializes and the
map's value under an id is replaced with a different `Collection` object, an id-keyed
snapshot would restore the old instance's staged state onto the new one. Instance keys
make that unrepresentable.

The correctness argument is a comment at the merge site in `rollback`: *for every
collection `c`, the minimum capture seq for `c` precedes every tracked batch that touches
`c`* — because a batch naming `c` requires `c` to be in the live map at that
`applyActions` call (`applyActionsRaw` throws `Collection not found` otherwise), so that
call's reconcile captured `c` first. Hence no replayed batch was already folded into the
snapshot it replays onto.

Not touched, deliberately: `execute`'s `preStageSnapshots` and `commitOnceLatched`'s
`preCommitSnapshots` are separate, id-keyed, single-call structures.

# Validation

- `packages/db-core`: `npx tsc --noEmit` clean; **1591 passing, 0 failing** (1590 from
  implement + 1 added in review).
- `packages/quereus-plugin-optimystic`: `yarn build` then `yarn test` — **692 passing,
  13 pending, 0 failing**; `test:smoke` ok.
- Repo root: `yarn lint` clean; `yarn lint:docs` — 45 documents, 71 anchored citations,
  572 file mentions, 307 links, all resolve.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- Both the implement stage and this review mutation-checked the fix: neutering any one
  leg (reconcile-on-first-call-only, single lowest-`order` map, dropped re-capture guard,
  dropped snapshot rebuild) fails the focused spec.

# Review findings

## Correctness — nothing found

Walked every stamp/collection interleaving by hand against the merge logic (late
collection captured clean by the survivor first; captured clean by the rolled-back stamp
first; the mirror rollback of each; a second rollback after the first rebuilt the
survivors' snapshots). The per-collection minimum-`seq` merge is sound in all of them,
and the invariant comment's argument holds: `applyActionsRaw` throwing
`Collection not found` is what structurally guarantees a batch's collection was captured
by that same call's reconcile.

**Answered the handoff's first "please probe" item — the seam does hold in the real
driver.** `registerCollections()` runs at the end of `doInitialize`, and
`OptimysticTable.update()` awaits `this.initialize()` *before* it awaits
`txnBridge.addStatement(...)`, which is the call that reaches
`coordinator.applyActions([], stampId)`. So a table opened inside a DML statement has its
main and index collections registered before that statement's barrier, and every stage in
that method sits below the barrier. Registration precedes capture precedes staging, as
the model in the tests assumes.

**Checked the second registration site too.** `reconcileMaintainedIndexes`
(`optimystic-module.ts`) registers freshly opened index trees, and `backfillIndexTrees`
then stages into them with no barrier in between — the shape that would leave a first
capture dirty. Not a leak: that helper ends in `flushDirtyTrees(targets)`, so backfilled
entries are made durable there rather than left staged for the enclosing transaction's
commit. Recorded in the corrected comment at that site rather than as a separate note.

## Major findings — none

No finding rose to a new ticket. Everything found was either a hygiene fix applicable in
this pass, a doc correction, or a test gap — all resolved inline below. Stating that
explicitly: this is not "looks good", it is that the three defect candidates chased
(the adapter's registration/staging ordering, the index-backfill site, and the survivor
snapshot rebuild) each resolved to "already correct" or "one added test".

## Minor findings — fixed in this pass

- **DRY.** The capture entry's shape, `{ seq: number; snapshot: CollectionSnapshot<any> }`,
  was written out inline at four sites. Extracted `type CollectionCapture`.
- **Comment-over-composition.** The reconcile loop was four lines of code under
  twenty-five lines of comment inside `applyActions`, and `rollback`'s replay loop
  duplicated the same capture logic under a different comment. Extracted
  `private captureUncaptured(into)`, called from both; the rationale now lives in that
  method's doc and `applyActions` is back to a short body. Capturing into an empty map is
  exactly the rebuild the replay loop wanted, so the duplication was removable rather than
  merely deduplicable.
- **Doc drift in the Quereus adapter — four comments still described first-call-only
  capture as the rule.** The implement stage updated `coordinator.ts` and the spec but not
  the package that depends on this behaviour. Corrected: `declareIndex`'s parenthetical
  that an index created mid-transaction "would miss that transaction's already-taken
  snapshot — a known, documented edge" (now false, and replaced with the real residual
  rule plus why backfill is exempt); `registerCollections`' claim that `markDirtyTrees` is
  "too late to seed that snapshot"; `doInitialize`'s "the coordinator's per-transaction
  snapshot includes them"; `update()`'s NOTE naming "the first addStatement per
  transaction"; and `TransactionBridge.addStatement`'s "creates the coordinator's
  per-transaction rollback snapshot on its first call".
  `TransactionBridge.registerCollection`'s own doc carries the same drift but was left
  untouched — `implement/2-bug-savepoint-rollback-skips-late-registered-collections`
  rewrites that exact function, so the correction was appended there as an arm instead of
  racing it.
- **Docs.** Read `docs/transactions.md` against the change: it describes rollback's
  contract but never states when captures are taken, so nothing there went stale. No doc
  edit needed, and `yarn lint:docs` confirms every citation still resolves.

## Test gap — fixed in this pass

`rollback`'s replay loop rebuilds each survivor's `preSnapshot` from the live map, and
that line is new, instance-keyed, fresh-`seq` code with **zero coverage**: no test in the
suite rolled back twice. Added
`rewinds the late collection on a SECOND rollback, from the snapshot the first one
rebuilt` — two stamps over a late-registered collection, roll back the survivor, then roll
back the other. Mutation-checked by dropping the rebuild assignment: the test fails with
`['y-b']`, i.e. the second rollback resurrects a row belonging to the stamp the first
rollback already discarded. Load-bearing.

## Tripwires — one, already parked at its site

The per-call reconcile's cost (one `Map.has` per registered collection per `applyActions`;
`snapshotPending`'s deep copy still at most once per collection per stamp) is reasoned
about but unmeasured. The implement stage's `NOTE:` at the loop was carried into
`captureUncaptured`'s doc, with "Unmeasured." made explicit and the escape hatch named
(track a per-stamp map size rather than dropping the reconcile). No new tripwire recorded.

## Considered and declined

- **A runtime assertion of the capture-precedes-batch invariant** (the handoff's "argued,
  not enforced" gap). Declined: the invariant is already enforced structurally — the only
  way a batch can name a collection is through `applyActionsRaw`, which throws
  `Collection not found` for anything outside the live map, and the reconcile in the same
  call runs first. An assertion in `rollback` would have to re-derive per-collection batch
  membership solely to re-check what that throw guarantees. Not filed.
- **`nextCaptureSeq` being unbounded.** Agreeing with the implement stage: not worth a
  note. 2^53 captures is unreachable, and the sibling `nextStampOrder` counter has the same
  shape with no note — adding one here would just make the pair inconsistent.
- **"Multi-stamp cases are synthetic."** Accurate but not actionable: the adapter drives
  one stamp per coordinator, so there is no non-synthetic multi-stamp test to write. The
  synthetic specs are the only coverage that branch can have today.
- **No end-to-end SQL repro.** Inherent to session mode being unwired by any host in this
  repo; already tracked by `backlog/debt-session-mode-bridge-coverage`. Not re-filed.
- **Untracked staging** (`Tree.stage` / direct `Collection.act`) into a late-registered
  collection between its capture and the rollback is still discarded — and, in the
  multi-stamp case, such staging on a late collection now gets discarded where before the
  collection was skipped entirely. The pre-existing symmetry argument holds (leaving an
  action queued while its transforms are gone is the phantom a conflicting sync's
  `replayActions` would resurrect as live data), the `NOTE:` at the restore loop states it,
  and the multi-stamp half is unreachable today. Left as is.
- **`commit` deleting only its own `stampData` entry**, staling a sibling stamp's
  snapshots. Out of scope and already tracked in
  `backlog/bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits`. Re-read both
  `NOTE:`s about it; the one reworded in `execute`'s partial-commit branch reads correctly
  against the new per-collection earliest-capture walk. This change neither fixes nor
  worsens it.
