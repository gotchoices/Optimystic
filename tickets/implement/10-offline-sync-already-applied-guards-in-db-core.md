description: Give the tree three guard variants that accept a row another machine already changed the same way (already deleted, already equal to what we write) instead of refusing, and let the offline queue report whether a committed entry still changed anything.
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/action.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/segments.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/status.ts, packages/db-core/test/tree-guard.spec.ts, packages/db-core/test/offline-queue.spec.ts, docs/internals.md
difficulty: hard
----

Stage 10 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), the db-core half. The plugin half (staging the variants from SQL, the `effect` on the plugin's status, the outlook, the design doc) is `offline-sync-already-applied-writes-in-the-plugin`, which depends on this ticket. Read [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured) and the guard paragraphs of [docs/internals.md §Conflict replay re-makes the uniqueness decision](../../docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards) first.

## The problem

Every guard today refuses when the row is not as the statement found it, including when the rival made exactly the change this writer makes. Two machines marking the same task done offline: the second entry's `unchanged` guard finds the row changed and the entry fails `concurrent-modification`. Two machines deleting the same row: the second finds it absent and fails the same way. Both final states are what both writers intended. The guard kinds live in db-core and are enforced only by the tree `replace` handler, so the acceptance has to be a new guard kind there, and the fact that an entry committed without changing anything has to travel from that handler up to the queue's `committed` status, since the plugin reports it as `effect: 'already-applied'`.

## Design

### Three guard kinds beside the four in `TreeEntryGuard`

Add to `TreeEntryGuard` in `packages/db-core/src/collections/tree/struct.ts`, each a plain serialisable object like the existing kinds:

| Kind | Element | Accepts and writes when | Accepts as already applied (skips the element) when | Refuses with |
|---|---|---|---|---|
| `absentOrEqual` | upsert | the key is absent | the present entry is structurally equal to the element's own `entry` | `TreeKeyTakenError`, as `absent` does |
| `unchangedOrEqual` (`expected: TEntry`) | upsert | the present entry equals `expected` | the present entry equals the element's own `entry` (checked second, so a write whose `expected` equals its `entry` writes and counts as applied) | `TreeEntryChangedError` on absent or any other entry |
| `unchangedOrAbsent` (`expected: TEntry`) | delete | the present entry equals `expected` | the key is absent | `TreeEntryChangedError` on any other entry |

The post-image an `unchangedOrEqual` compares against is the element's own `entry`, not a second copy on the guard: the element already carries it, and the guard stays the size `unchanged` is. "Equal" is `structuralEquals` in `packages/db-core/src/utility/structural-equals.ts`, the comparison `unchanged` uses, with the same JSON caveats its doc comment states.

Kinds and elements: `unchangedOrAbsent` is meaningful only on a delete (on an upsert it would mean "resurrect the row"), `absentOrEqual` and `unchangedOrEqual` only on an upsert (on a delete an equal-then-skip has nothing to compare, and the delete would be a no-op by construction). The handler narrows both ways at runtime, as `deleteGuardExpected` does today: a delete carrying any kind but `unchanged` or `unchangedOrAbsent`, and an upsert carrying `unchangedOrAbsent`, is a malformed action, thrown outside the `TreeGuardRefusedError` hierarchy like `TreeDeleteGuardKindError`, never ignored. `TreeDeleteElement.guard` becomes `TreeUnchangedGuard | TreeUnchangedOrAbsentGuard`; `TreeUpsertElement.guard` excludes the delete-only kind.

The `TreeUnchangedGuard` doc comment that says "If tolerating absence on deletes is ever genuinely wanted, add a separate `unchangedOrAbsent` kind rather than weakening this one's contract" is the design of record; this ticket does exactly that, and the comment is rewritten to point at the new kind. `unchanged` keeps its contract: absent still counts as changed.

### The handler reports what it accepted as already applied

`ActionHandler` in `packages/db-core/src/collection/action.ts` already has a `TResult` parameter. The `replace` handler in `buildInit` (`packages/db-core/src/collections/tree/tree.ts`) returns an `AlreadyAppliedTally`, `{ alreadyApplied: number; applied: number }`, counting ONLY the elements whose guard is one of the three new kinds: `alreadyApplied` for each skipped, `applied` for each written or deleted. Elements with no guard or with one of the four existing kinds are not counted (a `keepExisting` skip is not an already-applied acceptance: it says nothing about equality). `CollectionInitOptions.modules` is typed to allow `AlreadyAppliedTally | void`, and a handler that returns nothing counts as the zero tally, so `Diary` and every other collection type are unchanged.

`Collection.stageInto` sums the tallies of the actions it stages and returns the sum. Two callers record it on the sealed segment they staged, as `SealedSegment.applied` in `packages/db-core/src/collection/segments.ts` (set directly, no version bump: it is not a change to the sealed list): `replayActions`, for each sealed segment it re-stages, and `buildHeadTracker`, for the head segment. Both stage over the committed state the collection reads at, so at the moment a head commit folds, the recorded tally is from a staging over the state the write committed over (a reader's refresh that adopted a rival after the head tracker was built makes the attempt stale, and the refusal rebuilds it). The open segment's tallies are discarded.

### The tally reaches the queue through a hook, not a return type

`HeadCommitOptions` (`packages/db-core/src/collection/struct.ts`) gets `onCommittedHead?: (applied: AlreadyAppliedTally) => void`, and `EntryCommit` (`packages/db-core/src/transaction/entry-commit.ts`) the per-collection form `onCommittedHead?: (collectionId: CollectionId, applied: AlreadyAppliedTally) => void`, mirroring how `recordAttempt` exists on both; `EntryParticipants.open` threads it into each handle the way it threads `resume`. The collection calls it, under its latch, at the two places a head segment is made durable and dropped: `HeadCommitHandle.fold` (the attempt committed) and `Collection.consumeHead` (the refresh finished the entry's own log entry), with the dropped segment's recorded tally. A segment with no recorded tally is answered with the zero tally and logged as a defect, not thrown; no reachable path produces one, since a sealed segment is staged by `buildHeadTracker` before its first send and by `restoreSealed`'s replay when put back, and the resume path that sends a recorded attempt verbatim runs after one of those. A hook was chosen over widening the return types of `commitHead` and `commitEntry` because the partial-commit path reports the committed half through `CoordinatorPartialCommitError`, which would otherwise have to carry tallies too, and the refresh-consumed path reports through `RefreshReport`; the hook reaches all three with one shape. A throw out of the hook is logged, never raised: the commit is already durable.

### The queue folds the tallies into `effect`

`OfflineQueue` keeps `entry.applied: Map<CollectionId, AlreadyAppliedTally>`, filled by the hooks it passes to `commitHead` and `commitEntry` (the committed half of a partial commit is recorded by the same hook before the error reaches the queue, so a later submission's tallies accumulate beside it). `EntryStatus`'s `committed` arm (`packages/db-core/src/offline/status.ts`) gains `effect: 'applied' | 'already-applied'`: `'already-applied'` exactly when the sums over every collection have `alreadyApplied > 0` and `applied === 0`, meaning every element that could have been already applied was, and at least one was; `'applied'` otherwise, including for an entry with no such element (plain inserts only) and for one the restore found already committed (`RestoredSegment` of kind `already-committed`, which records no tally). The `JournalSettledStatus` the journal hears carries it too.

The rule is "all, not any" on purpose: an entry of two updates where one row was already done and the other not did change a row, and a host reading `already-applied` as "nothing of mine landed" must be right.

## Edge cases & interactions

- **An `unchangedOrEqual` whose `expected` equals its `entry`** (a no-op update) writes and counts `applied`. Test over a raw tree.
- **Two writes of one key in one entry** (insert `absentOrEqual`, then update `unchangedOrEqual`): a rival inserted the equal row; the insert skips, the update finds `expected` (the insert's image) and writes, tally `{1, 1}`, effect `applied`. A rival inserted and made the same update; the insert skips, the update finds its own `entry` and skips, tally `{2, 0}`, effect `already-applied`. Test over a raw tree.
- **A rival deleted the row an `unchangedOrEqual` updates**: absent, refused with `TreeEntryChangedError`. Absent is still changed for every upsert kind. Test.
- **A rival changed the row an `unchangedOrAbsent` deletes** without deleting it: refused. Test.
- **Delete-only and upsert-only kinds on the wrong element** are malformed actions, outside the refusal hierarchy; the replayed-from-JSON shape (`[key, null, guard]`) must reach the same check. Test, beside the existing `TreeDeleteGuardKindError` case.
- **JSON round trip**: a guard with `expected` round-trips as `unchanged` does; `absentOrEqual` has no payload. One assertion over the new kinds in the existing round-trip test's pattern.
- **`classifyCommitFailure`, `mapCommitRefusal`, `refusalReason`** see the same two error classes as today; nothing changes there. By inspection.
- **A refused replay records no tally** for the segment (the staging threw before `stageInto` returned); a refused segment is never committed, so nothing reads it. By inspection.
- **`restorePending`'s replay arm and `unstage`'s replay** go through `replayActions` and so record tallies; the verbatim arm restores transforms and leaves the segments' recorded tallies as they are. By inspection.
- **The hook runs under the collection latch**, like `onSealedRefused`; the queue's closure only records into a map, exactly as the refusal callback only records and wakes. Stated in the hook's doc comment.
- **A collection that `holdsCommitted` the attempt at restore** restores no segment and reports nothing, so the queue's effect for that entry is `applied`. Named in the status doc comment.
- **Mixed versions**: a guard is evaluated only by the writer's own replay (`TreeEntryGuard`'s MIXED VERSIONS note still holds); a node on an older build never interprets one. No gate needed.
- **Collections other than trees** (`Diary`) return no tally and take the zero default. By type.

## Tests

Follow *Tests must pay for themselves*: the new behaviour is branching logic pinned by the specification's table above, so each row gets one raw-tree case in `packages/db-core/test/tree-guard.spec.ts` (accept-and-write, accept-and-skip, refuse, for each of the three kinds), plus the two multi-element cases above and the malformed-kind cases. In `packages/db-core/test/offline-queue.spec.ts`, one case per effect rule: an entry over two collections where every variant element was accepted reports `already-applied`; one where one was accepted and one applied reports `applied`; and the hook fires on the refresh-consumed path (an entry whose attempt landed and whose re-drive finds its own entry, the `resume` shape the spec already builds) with the effect still correct.

## Documentation

Update [docs/internals.md §Conflict replay re-makes the uniqueness decision](../../docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards): the kind list ("the four in `TreeEntryGuard`" becomes seven), the "ABSENT COUNTS AS CHANGED" paragraph (true of `unchanged`; the variants that accept absence or equality are named beside it), and a short paragraph on the tally and the `onCommittedHead` hooks under *The offline queue*. The plugin ticket updates docs/offline-sync.md.

## TODO

- Add `AlreadyAppliedTally` and the three guard kinds (`absentOrEqual`, `unchangedOrEqual`, `unchangedOrAbsent`) to `packages/db-core/src/collections/tree/struct.ts`; narrow `TreeUpsertElement.guard` and `TreeDeleteElement.guard`; add the upsert-side malformed-kind error beside `TreeDeleteGuardKindError`; rewrite the `TreeUnchangedGuard` note to point at `unchangedOrAbsent`.
- Enforce the three kinds in `enforceUpsertGuard` and the delete branch of the `replace` handler in `packages/db-core/src/collections/tree/tree.ts`; make the handler return the tally; export the new types and errors from the package index.
- Type `CollectionInitOptions.modules` handlers as returning `AlreadyAppliedTally | void`; sum in `Collection.stageInto`; record on `SealedSegment.applied` from `replayActions` and `buildHeadTracker`.
- Add `onCommittedHead` to `HeadCommitOptions` and `EntryCommit`; call it from `HeadCommitHandle.fold` and `Collection.consumeHead` with the dropped segment's tally; thread the per-collection form through `EntryParticipants.open`.
- Add `effect` to `EntryStatus`'s `committed` arm; keep `entry.applied` in `OfflineQueue`, pass the hooks in `send`, fold in `committed`.
- Tests in `packages/db-core/test/tree-guard.spec.ts` and `packages/db-core/test/offline-queue.spec.ts` as listed.
- Update docs/internals.md as listed; run `yarn lint:docs`.
- `yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-core test`, then `yarn build && yarn typecheck` from the root, since the plugin's status types extend the queue's and must still compile.
