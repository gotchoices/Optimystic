description: When a table is opened partway through a transaction and then the transaction is cancelled, the cancelled changes to that table are never undone — they stay staged and get written into the next transaction's saved history.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` decl ~62-76; `applyActions` ~90-115; `rollback` ~505-570)
  - packages/db-core/src/collection/collection.ts (`snapshotPending` / `restorePending` ~617-645 — used as-is, no change)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (helpers `stage`/`stageMore`/`makeCoordinator`/`queuedValues`; the stale ticket reference at ~131-134 must be updated)
repro: static
difficulty: medium
----

# What is wrong

`TransactionCoordinator` undoes a transaction by restoring every collection to a
snapshot of its *staged state* (tracker transforms + queued action list). It takes
that snapshot once, on the transaction's first `applyActions` call, covering exactly
the collections present in `this.collections` at that instant
(`coordinator.ts:94-110`).

`this.collections` is a **live map the coordinator does not own** — the Quereus
adapter hands it its own registry and keeps adding to it as tables open
(`TransactionBridge.registerCollection`). A collection added after the first
`applyActions` is therefore visible to commit but missing from the snapshot, and
`rollback` — which iterates the snapshot — never visits it. Both halves of its
staged state survive the rollback, so the next commit on that collection writes the
cancelled transaction's actions into its own durable log entry, still tagged with
the cancelled transaction's id. That is the same corruption
`bug-coordinator-rollback-leaves-pending-queue-populated` (landed) fixed for a
different cause in the same method.

Not reproduced at runtime — read from the code. Reachable through SQL only in
session mode, which no host in this repo wires today (see
`backlog/debt-session-mode-bridge-coverage`); reachable now for any direct
`db-core` user of the coordinator.

# The fix, and why this shape

Two changes, both inside `coordinator.ts`. No cross-package API is added.

## 1. Reconcile the map on every `applyActions`, not just the first

Move the capture loop out of the `if (!this.stampData.has(stampId))` branch. On
**every** call, before `applyActionsRaw`, capture any collection now in
`this.collections` that this stamp has not captured yet. The first call then just
happens to capture everything, and a late-registered collection is captured on the
first call after it appears.

Why `applyActions` is the right reconcile point rather than a new
`coordinator.registerCollection(...)` the adapter calls:

- It needs nothing from the adapter, so it cannot be defeated by a future caller
  that mutates the shared map without telling the coordinator — and the adapter
  mutates that map directly today.
- It lands **before any staging**, which is the property the fix needs. In the
  Quereus path the vtab stages rows *directly* into the trees and only reaches the
  coordinator through `TransactionBridge.addStatement` →
  `TransactionSession.execute(sql, [])` → `applyActions([], stampId)`. That awaited
  empty-actions call already exists solely to make the snapshot's timing
  deterministic, and `optimystic-module.ts:2149-2157` documents the invariant that
  it must stay above every `collection.stage` in a DML. So reconciling at the top of
  `applyActions` is reconciling at an existing, documented pre-stage barrier.
- A registration-time hook would add coverage only for staging paths that never call
  `applyActions` at all — and those create no `stampData` entry, so there would be
  nothing for such a hook to top up.

Keep the capture loop synchronous and `await`-free between the snapshot and
`applyActionsRaw`, for the reason `execute()` already spells out at
`coordinator.ts:679-686`: an interleaved stage would otherwise land inside the
snapshot.

## 2. Choose "earliest" per collection, by capture sequence

Reconciling makes capture *lazy*, which breaks the assumption the current `rollback`
rests on. Today it picks ONE snapshot map — the one belonging to the lowest-`order`
stamp — and restores everything from it. That is sound only while capture is eager,
because only then does `order` (assigned at first `applyActions`) rank capture
times. With lazy capture a lower-`order` stamp can capture a collection *after* a
higher-`order` stamp already staged into it; restoring that entry would preserve the
very actions the rollback must discard.

So stamp `order` stops being the ranking for *what to restore to*. Give every
capture a monotonic sequence number and pick, **per collection**, the entry with the
smallest sequence:

```ts
private stampData = new Map<string, {
  order: number;                       // replay ordering ONLY, unchanged
  preSnapshot: Map<Collection<any>, { seq: number; snapshot: CollectionSnapshot<any> }>;
  actionBatches: CollectionActions[][];
}>();
private nextCaptureSeq = 0;
```

`rollback` then:

- merges the rolled-back stamp's and every survivor's `preSnapshot` into one
  `Map<Collection, { seq, snapshot }>`, keeping the lowest `seq` per collection;
- calls `restorePending` on each of those collections;
- replays the survivors' `actionBatches` in `order` exactly as today, rebuilding each
  survivor's `preSnapshot` from `this.collections` before its own batches (fresh
  `seq` per entry, still monotonic).

**The invariant that makes replay-all correct** (state it as a comment at the merge):
*for every collection `c`, the minimum capture seq for `c` precedes every tracked
batch that touches `c`.* It holds because a batch naming `c` requires `c` to be in
`this.collections` at that call (`applyActionsRaw` throws `Collection not found`
otherwise), so that same call's reconcile captured `c` first; the minimum across
stamps is therefore no later than any stamp's own pre-batch capture. Hence no batch
replayed after the restore was already folded into the snapshot it restored to — no
double-apply.

This reproduces today's behaviour exactly whenever capture was eager (the existing
interleaved test: seqs 0,1,2 rank the same as orders 0,1,2), and strictly improves
the multi-stamp late-registration case in both directions.

## Key `preSnapshot` by `Collection` instance, not by `CollectionId`

The map is keyed by the collection object. This removes an edge case by construction
rather than by argument: if a table re-initializes and registers a **different
`Collection` instance under the same id** (the shared map's value is replaced), an
id-keyed snapshot would restore the *old* instance's staged state onto the *new*
one. Instance keys give the new instance its own capture at the next reconcile and
leave the old entry harmlessly pointed at the detached instance. The restore loop
then calls `collection.restorePending(...)` directly instead of re-looking-up by id.
Precedent: `TransactionBridge`'s savepoint maps are already keyed by `Collection`.

# Edge cases & interactions

- **Primary repro (single stamp).** Stamp writes through collection `a`; `b` is added
  to the live map; the same stamp writes through `b`; rollback must leave
  `b.getPendingActions()` empty and `b`'s tracker carrying no transforms.
- **Two stamps, late collection dirtied by the other first.** X (order 0) captures
  `a`; `b` registers; Y (order 1) captures `b` clean and stages into it; X then
  stages into `b` and captures it dirty (a greater seq than Y's). `rollback(Y)` must
  drop Y's `b` rows and keep X's; `rollback(X)` must do the mirror. Under the old
  order-only walk `rollback(Y)` preserved Y's own rows — assert the values, not just
  the counts.
- **Existing interleaved case must not regress**: `keeps every survivor once when a
  lower-order stamp staged after a higher-order snapshot` — survivors exactly once,
  in stamp order, with their own stamp tags intact.
- **Repeat registration of the same instance** (the adapter's `registerCollection` is
  idempotent, and `reconcileMaintainedIndexes` re-registers already-open index
  trees): reconcile must NOT re-capture a collection this stamp already captured, or
  a dirty state would be recorded as "before" and rollback would preserve the actions
  it must discard. The `preSnapshot.has(collection)` guard is the whole defence —
  test it by re-adding the same instance to the map mid-transaction after staging
  into it.
- **New instance under an existing id** mid-transaction: rollback must not throw and
  must clear the new instance's pending queue; the old instance's entry is restored
  to a detached object and observed by nobody.
- **A collection created inside the transaction.** A brand-new collection's
  header/root blocks live in the tracker (uncommitted) until the first sync —
  `snapshotPending`'s doc-comment is explicit that restoring the snapshot, rather
  than resetting to empty, is what keeps it readable. Assert a read through a
  late-registered, transaction-created collection still works after rollback.
- **Untracked staging** (`Tree.stage` / direct `Collection.act`, which creates no
  `stampData` entry) into a late-registered collection between its capture and the
  rollback is discarded — the same symmetry `rollback` already documents at
  `coordinator.ts:539-546`. Extend that NOTE rather than changing the behaviour.
- **`rollback` for an untracked stamp** stays a no-op (existing test at
  `coordinator-rollback-pending.spec.ts:316`).
- **`commit` / `commitOnceLatched` / `execute`.** `commit` still deletes only its own
  `stampData` entry, leaving siblings' snapshots describing a pre-commit world — a
  distinct fault tracked in
  `backlog/bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits`, which
  this ticket neither fixes nor worsens. Its NOTE at `coordinator.ts:485-493` (and
  the sibling NOTE at ~843-854) should be re-read after the reshape and reworded if
  the entry-shape change makes them wrong. `execute`'s own `preStageSnapshots` map is
  a separate, id-keyed, single-call structure — leave it alone.
- **Cost.** The reconcile loop now runs per `applyActions` call rather than once per
  transaction; per-call work for an already-captured collection is one `Map.has`, and
  `snapshotPending` (which deep-copies transforms) still runs once per collection per
  stamp. If the registered-collection count ever grows large, park a `NOTE:` tripwire
  at the loop rather than pre-optimising.

# Tests

Extend `packages/db-core/test/coordinator-rollback-pending.spec.ts` — it already has
`makeCoordinator` / `stage` / `stageMore` / `queuedValues` / `expectNoActionsFromStamp`
and is the focused home for this behaviour (`transaction.spec.ts` is already flagged
oversized by `backlog/debt-transaction-spec-oversized`). Add a helper that creates a
collection and inserts it into the live map *after* `makeCoordinator` returns — that
is the whole repro. Expected outputs are named in the edge-case list above; assert on
`getPendingActions()` values and `transaction` tags, not on transforms alone (the
transform half was already being restored, which is exactly why the sibling defect
hid for so long).

Also update the doc comment at `coordinator-rollback-pending.spec.ts:131-134`, which
currently calls late registration "a separate, pre-existing gap" and points at this
ticket in `backlog/`.

# TODO

- Reshape `stampData.preSnapshot` to `Map<Collection<any>, { seq, snapshot }>`; add
  `nextCaptureSeq`; update the type's doc-comment and the `applyActions` comment at
  `coordinator.ts:94-101`, which asserts that eager capture is required — this change
  replaces that argument with the per-collection seq one.
- Make `applyActions` reconcile the live map on every call, before `applyActionsRaw`,
  `await`-free between capture and apply.
- Rewrite `rollback`'s earliest-snapshot walk as a per-collection minimum by `seq`;
  restore through the captured instances; keep the survivor replay and the
  per-survivor snapshot rebuild (fresh seqs).
- Write the invariant comment ("min capture seq for `c` precedes every tracked batch
  touching `c`, because …") at the merge site.
- Extend the rollback NOTE about untracked staging to cover late-registered
  collections.
- Add the tests above; update the stale ticket reference in the spec header.
- Run `yarn test` in `packages/db-core` (foreground, no redirection). Then
  `yarn build && yarn test` in `packages/quereus-plugin-optimystic` — its session-mode
  specs construct a coordinator straight from
  `plugin.txnBridge.getCollectionRegistry()`, and its specs import `../dist/`.
