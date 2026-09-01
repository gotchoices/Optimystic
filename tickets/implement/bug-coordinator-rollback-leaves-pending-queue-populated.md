description: Cancelling a transaction rewinds the data in memory but forgets to throw away the list of changes it was going to write. The next transaction on the same data then records those cancelled changes in the durable history as if they had been kept.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` ~60-65, `applyActions` snapshot ~85-101, `commitOnceLatched` `preCommitSnapshots` ~352, `rollback` ~487-535)
  - packages/db-core/src/collection/collection.ts (`CollectionSnapshot` ~89-101, `snapshotPending`/`restorePending` ~616-643, `getPendingActions`/`clearPendingActions` ~705-721)
  - packages/db-core/src/transaction/session.ts (`rollback` ~178-197 — the shipped caller)
  - packages/db-core/test/transaction.spec.ts (existing rollback cases ~1500, ~1539, ~1597, ~1623, ~1651, ~3421, ~3486, ~3726)
  - packages/db-core/test/coordinator-own-action-replay.spec.ts (harness shape to copy for the new spec)
repro: verified
difficulty: medium
----

# What is broken

A `Collection` stages every change in **two** places, written together by
`Collection.actInternal`:

- the **tracker transforms** — the in-memory picture of the data, what reads see;
- the **pending queue** (`Collection.pending`) — the ordered action list a commit
  records into the collection's durable action log.

`TransactionCoordinator.rollback(stampId)` restores only the tracker half. Its
per-stamp snapshot type only *has* that half:

```ts
private stampData = new Map<string, {
    order: number;
    preSnapshot: Map<CollectionId, Transforms>;   // <- tracker half only
    actionBatches: CollectionActions[][];
}>();
```

Two runtime-verified consequences:

**A.** After a rollback the collection still carries the aborted transaction's
actions. `commitOnceLatched` builds each log entry from
`collection.getPendingActions()`, so the *next* transaction to commit on that
collection writes the aborted actions into its own durable entry — still tagged
with the rolled-back stamp id.

**B.** `rollback` replays surviving stamps' batches through `applyActionsRaw` →
`collection.act`, which pushes onto `pending` again. Since `pending` was never
rewound, the queue ends up holding the phantom action *plus* two copies of each
survivor action.

Reads right after the bad commit still look correct (the entry's *transforms* come
from the tracker, which is correctly rolled back) — which is why every existing
rollback test, all of which assert on transforms or on reads, missed this. The
corruption is in the entry's **action list**: `Collection.updateInternal` calls
`replayActions()` on a conflicting sync and re-applies everything in `this.pending`
into the tracker, where the phantom *does* become live data; and the durable action
list is what a log-replaying peer reads.

# The fix

`Collection` already models the pair as one value — `CollectionSnapshot<TAction>`
(transforms + pending + context), produced by `snapshotPending()` and put back by
`restorePending()`. The commit path already uses it correctly
(`preCommitSnapshots`, coordinator.ts:~352). Widen `stampData.preSnapshot` to hold
that same value and restore through `restorePending`, so half-restored staged state
stops being representable at all.

```ts
private stampData = new Map<string, {
    order: number;
    preSnapshot: Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>;
    actionBatches: CollectionActions[][];
}>();
```

Use the `ReturnType<...>` idiom rather than importing `CollectionSnapshot`, to match
`preCommitSnapshots` at coordinator.ts:~352 (the coordinator already imports
`Collection` as a type).

Three call sites change, all mechanical:

- **`applyActions` first-call capture** (~86-95): `snapshot.set(id, col.snapshotPending())`
  instead of `structuredClone(col.tracker.transforms)`.
- **`rollback` restore loop** (~514-521): `collection.restorePending(snapshot)`
  instead of `collection.tracker.reset(structuredClone(transforms))`.
  `restorePending` deep-copies the transforms itself (`copyTransforms`), so drop the
  now-redundant `structuredClone`.
- **`rollback` mid-replay refresh** (~525-531): `newSnapshot.set(id, col.snapshotPending())`
  instead of cloning transforms only. This one matters — a survivor replayed later in
  the loop must carry BOTH halves forward, or the next rollback re-opens the same hole.

## Why the replay then lands each survivor's action exactly once

Confirmed by reading the code, not assumed. `rollback` restores to the *earliest*
tracked snapshot — earliest by `order`, and `order` is assigned at a stamp's first
`applyActions` call, which is also when its snapshot is taken over **all** currently
registered collections. So the lowest-`order` snapshot is genuinely the earliest in
time and precedes every batch of every tracked stamp. Restoring both halves to it
rewinds each pending queue to before any survivor staged anything; the existing
replay through `collection.act` → `actInternal` then pushes each survivor batch back
exactly once. Defect B falls out of the same change — no extra dedup logic.

Do not weaken that invariant. In particular, do NOT switch to capturing a
collection's snapshot lazily on first touch: `order` would stop implying capture
time, a lower-`order` stamp's late capture could contain a higher-`order` stamp's
already-staged action, and the rolled-back action would survive the restore.

## Snapshot copy depth

`snapshotPending` deep-copies transforms (`copyTransforms`) but shallow-copies the
pending array (`[...this.pending]`), sharing `Action` objects by reference.
`restorePending` does the same. That is correct here: `applyActionsRaw` builds a
fresh tagged object per action (`{ ...action, transaction: stampId }`) and nothing
mutates a queued action in place. It is also exactly what the commit path already
relies on. No change needed; do not "fix" it into a deep clone.

# Decisions to encode as NOTEs at the sites

Both were open questions in the plan; both are settled as **accept + document**.
Write each as a `NOTE:` comment at the named site so the next reviewer sees the call
was made deliberately.

- **Latch-free rollback** — the existing `NOTE:` at the top of `rollback`
  (coordinator.ts:~488) says the method resets and replays into participant trackers
  *without* holding their instance latches, safe because a session drives abort and
  commit from one call path. That reasoning still holds after this change; the hazard
  class is unchanged, because a concurrent `act`/`sync` would already have raced
  `tracker.reset`. **Update the note's wording** to say it now overwrites both halves
  of staged state (transforms *and* the pending queue), so the claim covers what the
  method actually writes rather than being inherited silently.

- **Directly-staged actions are dropped by the restore** — actions staged outside any
  tracked stamp (the `Tree.stage` / vtab deferred-DML path, which calls
  `Collection.act` directly and creates no `stampData` entry) that landed *after* the
  earliest tracked snapshot are discarded by the pending restore. The tracker half
  already discards their transforms today, so this makes the two halves symmetric —
  and symmetric is the safer state: leaving such an action queued while its transforms
  are gone is precisely the phantom `replayActions` would resurrect. Accept, and add a
  `NOTE:` at the restore loop recording it.

# Out of scope, already filed

A collection registered *after* every tracked stamp took its snapshot is in no
`preSnapshot` map, so `rollback` skips it entirely and its pending queue keeps the
rolled-back stamp's actions. That is a pre-existing gap on the tracker half too, with
a different root cause (a stale collection set, not a half-modelled snapshot), and it
is reachable — `txn-bridge.ts:~241-248` documents trees created mid-run being
registered on an already-constructed coordinator. Filed as
`backlog/bug-coordinator-rollback-skips-late-registered-collections`. Do not widen
this ticket to cover it; the fix here must simply not make it worse.

Also noticed and deliberately left alone: `restorePending` restores `transforms` and
`pending` but not the `context` that `snapshotPending` captures. Unrelated to this
defect and unchanged by this ticket.

# Edge cases & interactions

Cover each of these; the reviewer will check for them.

- **Single rolled-back stamp, no survivors.** `getPendingActions()` is empty
  afterwards, and the collection's tracker is unchanged from today's behaviour.
- **Rolled-back stamp plus one survivor** — the reproduction that currently yields 3
  queue entries. Each survivor action must appear **exactly once**; assert the count,
  not just membership.
- **Three or more interleaved stamps**, with a lower-`order` stamp applying a batch
  *after* a higher-`order` stamp's snapshot was taken (the interleaving the
  earliest-snapshot logic exists for). Roll back the middle one; both remaining stamps
  keep their actions exactly once.
- **Multi-collection rollback** — a stamp touching two collections leaves neither
  queue holding its actions, and a survivor touching only one of them is unaffected in
  the other.
- **Rollback then commit on the same collections.** The next transaction's durable log
  entry must contain only its own actions — no action tagged with the rolled-back
  stamp id. This is the clearest single symptom; assert on what reaches the log append
  (wrap/observe `getPendingActions`, or inspect the committed entry), not just on the
  in-memory queue.
- **Untracked stamp stays a no-op.** `rollback` of a stamp that never went through
  `applyActions` (the directly-staged `Tree.stage` path) must remain a no-op — covered
  by `transaction.spec.ts:~3726`, which must stay green.
- **Partial-commit path already dropped the stamp.** `commitOnceLatched` deletes the
  `stampData` entry on a partial multi-collection commit (transaction.ts:~344-352
  documents that `rollback` is then a deliberate no-op). Confirm this change does not
  make that path start rewinding collections that durably committed.
- **Invented collection with no committed revision.** A brand-new collection's
  header/root blocks live in the tracker until first sync. Restoring a snapshot (as
  opposed to a blanket reset-to-empty) preserves them — that is why `restorePending`
  exists. A rollback on a never-synced collection must leave it readable.
- **Failed-commit restore still works.** `commitOnceLatched`'s catch block restores
  `preCommitSnapshots` via the same `restorePending`; a rollback after a failed commit
  must not double-restore into a worse state.

# Tests

New spec: `packages/db-core/test/coordinator-rollback-pending.spec.ts`. Model the
harness on `coordinator-own-action-replay.spec.ts` (its `TestTransactor` plus
`new TransactionCoordinator(transactor, new Map([...]))` setup) or on the existing
`transaction.spec.ts` rollback cases, which reach the collection with
`(tree as unknown as { collection: any }).collection`. Do not grow
`transaction.spec.ts` — it is already flagged oversized
(`backlog/debt-transaction-spec-oversized`).

Prefer **one general assertion** over three point cases, so future rollback paths
inherit the guard:

```ts
/** After any rollback, no collection's pending queue may hold an action tagged with
 *  the rolled-back stamp. Actions are tagged by applyActionsRaw as
 *  `{ ...action, transaction: stampId }`. */
function expectNoActionsFromStamp(collections: Map<string, any>, stampId: string) { /* ... */ }
```

Cases to write:

- Stage one action, `session.rollback()` — `getPendingActions()` is `[]`, and the
  general assertion holds.
- Two sessions staged, roll the first back — the queue holds the survivor's action
  and **only** that, exactly once (assert `length`, and assert the general helper).
- Roll session 1 back, then stage and commit through session 2 — the array reaching
  the log append carries only session 2's action; nothing tagged with session 1's
  stamp id reaches the durable entry.
- Multi-collection variant of the first case.
- The untracked-stamp no-op stays green (existing test; just re-run it).

Expected pre-fix behaviour, for confidence the tests actually bite: case 1 fails with
one leftover action, case 2 fails with 3 queued entries, case 3 fails with both
actions in the appended array.

# TODO

- Widen `stampData.preSnapshot` to `Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>`.
- `applyActions`: capture via `col.snapshotPending()`.
- `rollback`: restore via `collection.restorePending(snapshot)`; drop the redundant `structuredClone`.
- `rollback`: mid-replay refresh captures via `col.snapshotPending()` (both halves).
- Update the latch `NOTE:` at the top of `rollback` to name both halves.
- Add the `NOTE:` at the restore loop recording that directly-staged actions after the
  earliest tracked snapshot are dropped, symmetric with the tracker half.
- Write `packages/db-core/test/coordinator-rollback-pending.spec.ts` with the general
  helper plus the cases above.
- Run the db-core suite from `packages/db-core` in the foreground (no redirection);
  confirm the existing rollback cases and `transaction.spec.ts:~3726` stay green.
- Type-check the workspace.
