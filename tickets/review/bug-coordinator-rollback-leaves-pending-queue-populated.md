description: Cancelling a transaction used to rewind the data in memory but forget to throw away the list of changes it was going to write, so the next transaction recorded the cancelled changes in the durable history. The rollback now rewinds both halves together.
files:
  - packages/db-core/src/transaction/coordinator.ts (changed — `stampData` type ~59-71, `applyActions` capture ~92-105, `rollback` doc + latch NOTE ~490-508, restore loop ~528-548, mid-replay refresh ~551-560)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (new — 9 cases)
  - packages/db-core/src/collection/collection.ts (unchanged — `CollectionSnapshot` ~89-101, `snapshotPending`/`restorePending` ~616-643)
repro: verified
----

# What changed

`TransactionCoordinator` kept a per-stamp rollback snapshot that only held one half of a
collection's staged state — the tracker transforms. A collection stages every change in
**two** places, written together by `Collection.actInternal`: the tracker transforms (the
in-memory picture reads see) and the **pending queue** (the ordered action list a commit
records into the collection's durable action log). Restoring only the transforms left the
aborted transaction's actions sitting in the queue, where the next transaction to commit on
that collection wrote them into *its* durable log entry, still tagged with the rolled-back
stamp id.

The fix widens the snapshot to the pair the collection already models as one value —
`Collection.snapshotPending()` / `restorePending()`, which the commit path
(`preCommitSnapshots`) was already using correctly. Four sites in `coordinator.ts`:

- `stampData.preSnapshot` is now `Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>`.
- `applyActions` first-call capture uses `col.snapshotPending()` instead of `structuredClone(col.tracker.transforms)`.
- `rollback`'s restore loop calls `collection.restorePending(snapshot)` (which deep-copies
  the transforms itself, so the old `structuredClone` is gone).
- `rollback`'s mid-replay refresh captures both halves, so a survivor replayed later in the
  loop carries its queue forward and the *next* rollback does not re-open the hole.

Half-restored staged state is no longer representable in this map, which is the point — the
class of bug is closed by the type, not by a guard.

Net: 43 insertions, 17 deletions in `coordinator.ts`; one new spec file. No production
behaviour outside `rollback`/`applyActions` was touched.

Three `NOTE:` comments were added or reworded, all recording decisions the plan settled as
accept-and-document (see "Tripwires and accepted tradeoffs" below).

# How to convince yourself it works

## The tests bite

The new spec was run against a deliberately reverted coordinator (restore loop put back to
`tracker.reset(structuredClone(snapshot.transforms))`, everything else as shipped). Result:
**6 of 9 cases failed**, and the 3 that stayed green are exactly the ones that should
(the two no-op cases and — before it was added — nothing else). The survivor case failed with
the leftover the ticket predicted:

```
survivor queued exactly once
+ expected - actual
 [
-  "aborted"
    "survivor"
```

That reverted edit was undone; `grep BITE-CHECK` over the tree is clean and `git status`
shows only the two intended paths.

## Commands

From `packages/db-core`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min
npx tsc --noEmit -p tsconfig.json
```

Result: **1584 passing, 0 failing**; typecheck clean. From the repo root, `yarn typecheck`
(all workspaces) and `yarn lint:docs` both pass, and `npx eslint` on the two changed paths is
clean. No pre-existing failures were seen, so no `.pre-existing-error.md` was written.

## Cases in `coordinator-rollback-pending.spec.ts`

The general guard every case also asserts — provenance, not values, so future rollback paths
inherit it:

```ts
/** After ANY rollback, no collection's pending queue may hold an action tagged with the
 *  rolled-back stamp. applyActionsRaw tags each action `{ ...action, transaction: stampId }`. */
function expectNoActionsFromStamp(collections, stampId, label)
```

- **Solo rollback** — one stamp, no survivors; queue empties.
- **One survivor** — the reproduction. Asserts the exact array `['survivor']`, so both the
  phantom (pre-fix leftover) and the double-replay (pre-fix duplicate) fail it. Pre-fix this
  queue held 3 entries.
- **Three interleaved stamps**, with the lowest-`order` stamp staging a second batch *after*
  the other two snapshotted. Rolls back the middle one; asserts `['a1','a2','c1']` and that
  each survivor action still carries its **own** stamp tag after the replay re-tagged it.
- **Multi-collection** — a stamp touching two collections leaves neither queue holding its
  actions, and a survivor touching only one is unaffected in the other.
- **Rollback then commit** — the clearest symptom. Wraps the collection's `getPendingActions`
  to capture the exact array reaching the log append, asserts it carries only the committing
  stamp's action, and then asserts the **durable** log via `selectLog()`. Doubles as the
  invented-collection case: the collection had no committed revision when the rollback ran, so
  its header/root blocks lived in the tracker; the commit only resolves because a *snapshot*
  was restored rather than a blanket reset-to-empty.
- **Prior committed state** — commit, then stage-and-roll-back, then commit again. Covers the
  path where the log tail lives in storage rather than the tracker; the durable log ends at
  `['durable','next']`.
- **Untracked stamp** — an action staged straight into the collection (the `Tree.stage` /
  deferred-DML path, which creates no `stampData` entry) survives a rollback of its stamp.
  This is the local mirror of `transaction.spec.ts:~3726`, which also stays green.
- **Partial landing** — a local `PartialLossTransactor` produces a
  `CoordinatorPartialCommitError`; the subsequent `rollback` must not rewind the collection
  that durably committed. Asserts the winner's log is byte-identical before and after.
- **After a failed commit** — a hard pend rejection makes `commitOnceLatched`'s catch restore
  its own `preCommitSnapshots` through the same `restorePending`; a rollback on top of that
  still empties the queue rather than double-restoring into a worse state.

# Tripwires and accepted tradeoffs recorded in code

None of these are open work; each is a decision written at its site so the next reader meets it.

- `coordinator.ts` `rollback` latch `NOTE:` (~500) — **reworded**, not added. The method still
  resets and replays into participant trackers without holding their instance latches; the note
  now says it overwrites **both** halves rather than leaving that inherited silently, and states
  why the hazard class is unchanged (a concurrent `act`/`sync` would already have raced
  `tracker.reset`).
- `coordinator.ts` restore loop `NOTE:` (~532) — **new**. Actions staged outside any tracked
  stamp that landed after the earliest tracked snapshot are discarded by the restore. Accepted:
  the tracker half already discards their transforms, and symmetric is the safer state — an
  action left queued while its transforms are gone is exactly the phantom a conflicting sync's
  `replayActions` would resurrect as live data.
- `coordinator.ts` `applyActions` capture `NOTE:` (~95) — **new**. Records why the snapshot is
  taken eagerly over every registered collection rather than lazily on first touch: `order` is
  assigned at that call, so it only implies capture time while capture happens there. A lazy
  capture could take a lower-`order` stamp's snapshot after a higher-`order` stamp had already
  staged, and the rolled-back action would survive the restore.

# Known gaps — please probe these

Written as a floor, not a finish line.

- **Late-registered collections are still skipped.** A collection registered *after* every
  tracked stamp snapshotted is in no `preSnapshot` map, so `rollback` skips it and its queue
  keeps the rolled-back stamp's actions. Pre-existing on the tracker half too, different root
  cause, and out of scope here — filed as
  `backlog/bug-coordinator-rollback-skips-late-registered-collections`. This change does not
  make it worse (the skip is unchanged; both halves are skipped now as both were before), but
  that claim is by reading the restore loop, **not** by a test. Worth an adversarial look.
- **`restorePending` does not restore `context`.** `snapshotPending` captures the collection's
  action context; `restorePending` puts back `transforms` and `pending` only. Noticed, unrelated
  to this defect, deliberately unchanged — flagging it because this change makes the coordinator
  a second consumer of that asymmetry.
- **No new test drives `TransactionSession.rollback`.** The new spec calls
  `coordinator.rollback(stampId)` directly, since the session method is a thin delegate to it.
  The existing session-driven rollback cases in `transaction.spec.ts` (~1500, ~1539, ~1597,
  ~1623, ~1651, ~3421, ~3486, ~3726) stay green, but none of them assert on the pending queue —
  they assert transforms and reads, which is precisely why they missed the original defect.
- **The commit-observation spy is white-box.** The rollback-then-commit case monkey-patches
  `getPendingActions` on the collection instance. If the commit path ever stops reading the
  queue through that method, the spy silently observes nothing — guarded by asserting the spy
  fired at least once, and backed up by the independent `selectLog()` assertion, but it is a
  coupling worth knowing about.
- **Concurrency is untested and unchanged.** Everything here assumes the documented
  single-call-path invariant (a session drives abort and commit from one path). No test exercises
  a rollback racing a commit on shared collection instances, and the latch `NOTE:` is the only
  thing standing between that assumption and a future caller who breaks it.
- **Snapshot copy depth was left alone deliberately.** `snapshotPending` deep-copies transforms
  but shallow-copies the pending array, sharing `Action` objects by reference. Correct here —
  `applyActionsRaw` builds a fresh tagged object per action and nothing mutates a queued action
  in place — and it is what the commit path already relies on. If a reviewer wants to "fix" this
  into a deep clone, that is a behaviour change to the commit path too, not a local cleanup.
