description: Give the offline queue the hooks a durable journal needs — a port it writes through at each step of an entry's life, a way to put an entry back after a restart, and the collection operations that restore needs — so a later change can save queued transactions to disk without touching the drain's logic again.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#persistence
files: packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/journal.ts, packages/db-core/src/offline/entry.ts, packages/db-core/src/offline/index.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/segments.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/offline-queue.spec.ts, packages/db-core/test/collection-segments.spec.ts, docs/offline-sync.md, docs/internals.md
difficulty: hard
----

Stage 5 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), part one of three. This ticket is the `db-core` half: it adds no storage and knows nothing about tables or key-value stores. Part two (`offline-sync-journal-store`) implements the port over `IKVStore` in the Quereus plugin; part three (`offline-sync-journal-restore`) restores journaled entries after a restart. Design decisions that span the three parts are recorded here once and referenced from the other two.

## Why the port lives in db-core and the store does not

The queue (`OfflineQueue` in `packages/db-core/src/offline/queue.ts`) is the only thing that knows the moments the design's write ordering names ([§Write ordering](../../docs/offline-sync.md#write-ordering)): after sealing and before `queued` is emitted, before each send, after a partial commit, after a terminal outcome. Today it exposes one of those moments as a hook, `OfflineQueueOptions.recordAttempt`, described in the design as "the seam the journal of stage 5 fills". Four more hooks would be clutter, so this ticket replaces that one hook with one port, `IOfflineJournal`, that the queue calls at every such moment. The port speaks the queue's vocabulary: entry ids, collection ids, actions, `InFlightAttempt`s. It never sees a table name or a key-value store, so db-core keeps its no-storage rule and a `Tree`/`Diary` application without SQL can journal too.

The key-value implementation cannot live here because its records name tables (`schema.table`, to re-initialize a table on restore) and because `IKVStore` is db-p2p's interface. It lives in the plugin (part two).

## What is wanted

### The port

`packages/db-core/src/offline/journal.ts`, exported from the offline barrel:

```typescript
/** One entry as the journal records it at enqueue, written once (docs/offline-sync.md §What is journaled). */
export type JournalEntryRecord = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt?: number;
	/** One per collection the entry sealed a segment in, in sealing order: the segment's actions, verbatim. */
	readonly segments: readonly { readonly collectionId: CollectionId; readonly actions: readonly Action<unknown>[] }[];
};

/** The drive state of an entry: everything that changes between sends and must be on disk before the next one. */
export type JournalDriveState = {
	/** The action id the next submission runs under (renewed after `torn-not-saved`). */
	readonly actionId: ActionId;
	/** The attempts recorded under `actionId` and not yet resolved, per collection — the ones a later cycle resumes from. Empty right after a renewal. */
	readonly attempts: ReadonlyMap<CollectionId, InFlightAttempt>;
	/** The collections a partial commit has already committed, with who holds each. */
	readonly committed: ReadonlyMap<CollectionId, WriteDurability | undefined>;
};

export interface IOfflineJournal {
	/** Before the entry's `queued` status is emitted and before `enqueue` resolves. A throw or rejection fails the enqueue: the segments are unsealed and nothing is queued. The journal must flush before resolving. */
	queued(record: JournalEntryRecord): Promise<void>;
	/** Before each send, with the attempts about to go (replacing `recordAttempt`); again after a partial commit and after an identity renewal. Before a send, a throw aborts the cycle with nothing sent (the entry stays queued, not in doubt, re-driven after the backoff), exactly as `recordAttempt`'s throw did. After a partial commit or a renewal a throw is logged (`offline:journal-write-failed`) and the drain goes on; the next send's write repeats the state. The journal must flush before resolving. */
	driving(entryId: EntryId, state: JournalDriveState): Promise<void>;
	/** The entry's terminal status, before it is emitted. A throw is logged, never thrown into the drain: the outcome stands, and a restart resolves the stale record (part three). */
	settled(status: Extract<EntryStatus, { kind: 'committed' | 'failed' }>): Promise<void>;
}
```

`OfflineQueueOptions.journal?: IOfflineJournal` replaces `OfflineQueueOptions.recordAttempt`. The spec's uses of `recordAttempt` (`packages/db-core/test/offline-queue.spec.ts`, the harness's `recorded` list and the "write-ahead hook that throws" case) move to a journal double whose `driving` records or throws. The `RecordAttemptFailed` wrapper and the sticky in-doubt rule in `OfflineQueue.recordAttempts` are unchanged apart from calling `journal.driving`; a queue built without a journal behaves exactly as today.

### Enqueue writes before it admits

`OfflineQueue.enqueue` becomes `async`. With a journal: seal (as now), build the `JournalEntryRecord` from each sealed collection's segment (`Collection.sealedActions`, below), `await journal.queued(record)`, then register the entry, emit `queued`, publish state and start or wake the drain, in that order. On a throw: `Collection.unseal(id)` on every collection that was sealed, in reverse sealing order, then rethrow the journal's error. Nothing is registered, so no status is emitted and no listener hears of the entry. The `queued` status still arrives before `enqueue` resolves, which is what the design's "synchronously inside the commit" buys the caller (attribution to the `db.exec` under Quereus's exec lock); the doc's word "synchronously" is loosened to "before the commit resolves" in [§Following transactions](../../docs/offline-sync.md#following-transactions).

Without a journal, `enqueue` is the same code with the write skipped. Keep one path; do not keep a synchronous twin.

`Collection.unseal(entryId)`: the exact inverse of `sealPending`, list-only and latch-free by the same contract. Requires the segment to be the NEWEST sealed segment and the open segment to be empty (both true at the only call site, which has just sealed and staged nothing since); throws otherwise. Moves the segment's actions back to the open segment and bumps `SegmentList.version`. No tracker change: the transforms are already what they were. The caller (the plugin's commit) then rolls the transaction back as it does for any failed commit, which restores the pre-transaction snapshots; `restorePending` takes its replay arm because the version moved, and ends with the transaction's actions gone. Pin that end state in the spec (below).

### The drive record

`journal.driving` is called from three places in the queue, each already a method: `recordAttempts` (before the send, where `recordAttempt` was; its throw keeps today's semantics), `partiallyCommitted` (after `entry.committed` and `entry.retained` are updated, before `partially-committed` is emitted) and `renewIdentity` (after the new id is minted). The last two log a failure and continue. The state handed over is built by one function, `driveState(entry)` in `packages/db-core/src/offline/entry.ts`, from `entry.actionId`, `entry.retained` and `entry.committed`.

Why the partial-commit write cannot precede the consumption the design's rule 4 names: the committed collections' segments are consumed inside `TransactionCoordinator.commitEntry`, before `CoordinatorPartialCommitError` reaches the queue. The window between that fold and the journal write is covered by the in-doubt rule: a crash there leaves a record whose attempts name the committed collections too, and a restore resumes them under the recorded action id, where the opening refresh finds each committed collection's own entry and consumes it rather than committing it again (`Collection.completeOwnEntry`, `EntryCommit.resume`). Reword rule 4 in [§Write ordering](../../docs/offline-sync.md#write-ordering) to say so: "before the next send", with the window and what covers it.

### Settling

`journal.settled(status)` is awaited in `OfflineQueue.committed` before the `committed` status is emitted, and in `OfflineQueue.remove` before the `failed` status is emitted (`remove` is already async and runs on the removal chain). A rejection is logged as `offline:journal-write-failed entry=… step=settled` and swallowed there, never where the outcome was decided: the network has the write (or the segments are gone), and a stale record is what part three's restore resolves. Note that `committed` becomes async in consequence; its callers (`submit`, `partiallyCommitted`, and `restore` below) await it.

### Restore

`OfflineQueue.restore(init, stage)` puts an entry back from a record. It is the only way to register an entry whose segments are not sealed by `enqueue`, and it is built so the plugin's restore (part three) can stage segments between registering the entry and letting the drain see it:

```typescript
export type RestoreInit = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt?: number;
	readonly collections: readonly Collection<any>[];
	/** From the drive record, when one was written: the entry is then in doubt and resumes these. Absent: nothing was ever sent; a fresh action id is minted. */
	readonly drive?: JournalDriveState;
};
/** Per collection, what staging found: the segment is in place (possibly refused — the refusal is reported here, since the collection cannot report it to a queue that does not yet hold the entry), or the collection already holds the entry's recorded attempt as committed, so nothing was staged. */
export type RestoredSegment = { kind: 'staged'; refused?: ActionRefusedError } | { kind: 'already-committed' };
restore(init: RestoreInit, stage: (collection: Collection<any>) => Promise<RestoredSegment>): Promise<QueuedEntry | undefined>;
```

Rules:

- **The drain is held for the whole call.** `restore` waits until the loop is parked between iterations (not mid-submission, not mid-removal), holds it there, registers the entry, runs `stage` for each collection, then releases. A segment inserted ahead of the current head while a head commit of that head is on the network would fail that commit's own "head still first" assertion when it retakes the latch, and a `commitHead` that finds another segment ahead of the one it was asked for throws `SealedSegmentsError` (`not-head`), which the loop reads as a defect and stops on. Implement the hold as one deferred the loop awaits at the top of each iteration plus a "parked" signal the loop raises when it reaches it; a loop that is not running, or is parked on an empty queue, counts as parked at once. Several `restore` calls serialize on it. `discard` during a restore is refused for the entry being restored (`UnknownEntryError`, since it is not yet listed) and allowed for others; their removals run on the removal chain, which the hold also waits out before `stage` runs.
- **The entry is registered before `stage` runs**, so `onSealedRefused` reports the replay makes about OTHER entries during the insertion are attributed to a known entry, and so `stage` can read the queue (`entries()`) to find the entry's position. It is inserted by `seq` into `list` (not appended), `nextSeq` is raised past it, `waitingFor` is set as for any entry by position, and the head's `earlier-entry` flag is recomputed.
- **Identity.** With `init.drive`: `actionId`, `retained` (from `attempts`) and `committed` are taken from it, `inDoubt` is `true` when `attempts` is non-empty or `committed` is non-empty, and `attempts` (the count) is unknown and reported as `1` with a code comment saying why. Without: a fresh action id, nothing retained, not in doubt.
- **What `stage` answers decides what happens next.** Every collection `already-committed` and none staged: the entry is settled `committed` at once with a `TransactionDurability` whose every collection has an `undefined` class (the write is saved, who holds it is unknown — the same shape `Collection.commitHead` answers when a refresh established the write was saved without re-sending); `journal.settled` runs as for any commit. Some `already-committed`: those collections are recorded on `entry.committed` with `undefined` durability and the entry stays queued in doubt, as after a partial commit. Any `staged` with `refused` set: the refusal is put in `pendingRefusals` for the entry (with `causedBy` undefined), so the loop's first step fails it through the ordinary cascade. Otherwise `queued` is emitted and the loop is woken.
- **A `stage` that throws** rolls the registration back: the entry is removed from `list` and `byId`, every collection `stage` already answered `staged` for has its segment dropped (`Collection.dropSealed`), and the error is rethrown. Nothing is emitted.
- `restore` is refused after `dispose` (`QueueDisposedError`) and once the drain has stopped on a defect, like `enqueue`.

### Collection operations

Three additions to `Collection` in `packages/db-core/src/collection/collection.ts`, each small:

- `sealedActions(entryId): readonly Action<TAction>[] | undefined` — the sealed segment's actions, the array the segment holds (callers do not mutate it; the journal serializes it). Needed by `enqueue` to build the record.
- `unseal(entryId): void` — above.
- `holdsCommitted(attempt: ActionRev): boolean` — whether this collection's committed context names `attempt.actionId` at `attempt.rev`: `context !== undefined && context.rev >= attempt.rev && actionIdAt(context, attempt.rev) === attempt.actionId`. This is how a restore recognises, before re-staging a segment, that the network commit landed and the crash came after it: re-staging such a segment would run its own guards against its own committed rows (`absent` refuses on a present key) and fail the entry with `constraint`, which is the opposite of the truth. `NOTE:` at the method: `actionIdAt` reaches back to the most recent checkpoint, and no checkpoint is written today (backlog `debt-the-collection-log-never-writes-a-checkpoint`); if that changes, read the log's entry at `attempt.rev` instead.
- `restoreSealed(entryId, actions, position: { before: EntryId } | 'last'): Promise<ActionRefusedError | undefined>` — insert a sealed segment holding `actions` at the given position in the sealed list (before the named segment, or last), then rebuild the tracker with `replayActions`, which re-stages every replayable segment in order and records and reports each refusal — except this segment's own, which it RETURNS (recorded on the segment, but not reported through `onSealedRefused`, since the queue registers the entry and hears the result from `restore`'s `stage`). Takes the collection latch. Throws when the open segment is non-empty (a transaction is open; the open segment's actions were staged over state without this segment, and the only caller refuses to restore mid-transaction), when a head commit is in flight (`SealedSegmentsError`, `in-flight`), when `entryId` is already sealed, or when `before` names no segment here. A replay error that is not a refusal propagates, with the segment left in place (the same shape a refresh's replay has). `SegmentList` gains the `insert(entryId, actions, before)` it needs; `version` is bumped.

Why insertion by `seq` rather than appending: a record restored late (part three's deferred records) belongs ahead of entries queued after the restart began, both in the queue and in each collection's sealed list, or the head commit's "head is first" rule and the queue's order disagree. `replayActions` already rebuilds the tracker from the sealed list in order, so an insertion costs one replay — the quadratic cost the drain's `NOTE:` already accepts.

## Edge cases & interactions

- **Journal failure at enqueue with several collections sealed.** All are unsealed; verify the end state after the caller's rollback by test (below). By inspection: `unseal` requires the open segment empty, which holds because `enqueue`'s caller staged nothing between sealing and the throw.
- **`unseal` on a collection whose only staged content is an invented header.** `sealPending` answered `false` for it (nothing sealed), so `enqueue` never calls `unseal` on it; `unseal` of an unknown entry throws. By inspection.
- **`journal.driving` throws on the first send; the entry is discarded afterwards.** Today's semantics, pinned by the existing "write-ahead hook that throws" case once it is moved to the journal double.
- **`journal.settled` rejects.** The outcome is still emitted and the entry leaves the queue; one log line. Test: a journal double whose `settled` rejects; assert the `committed` status and that `whenDrained` resolves.
- **`restore` while a submission is in flight.** The hold waits for the submission's outcome to be applied, then runs. Test: a transactor that parks the head's commit, `restore` of an earlier-seq entry over the same collection during the park, release; assert the restored segment is first in the collection, the queue lists it first, the parked entry committed once, and the restored entry drains next.
- **`restore` of an entry whose `seq` is below an entry a cascade is removing.** The hold waits out the removal chain first. By inspection of the hold's ordering.
- **`stage` answers `already-committed` for every collection.** Settled `committed` immediately, `journal.settled` called, no `queued` status for it. Test over `TestTransactor`: commit an entry through a first queue, build a second queue and restore the entry with `drive.attempts` naming the committed attempt, `stage` using `holdsCommitted`; assert one `committed` status, nothing sent (the transactor's pend count unchanged), and the collection's sealed list empty.
- **`stage` answers `already-committed` for one of two collections.** The entry stays queued in doubt with that collection in `committed`; the next submission drives only the other. By inspection plus one assertion in the previous test's sibling, if cheap; otherwise by inspection.
- **`restoreSealed` whose own actions are refused.** Returned, not reported; the queue fails the entry through `pendingRefusals` on its first iteration, with the ordinary cascade. Test at the collection tier (`collection-segments.spec.ts`): restore a segment inserting a key the committed state holds; assert the return value, the segment listed as refused, and `onSealedRefused` not called for it.
- **`restoreSealed` whose replay newly refuses a LATER segment** (the restored segment inserts the key a later entry also inserts). The later segment's refusal is recorded and reported through `onSealedRefused` as any replay's would be; the queue fails that entry with `causedBy` from `causeOf`. Test at the collection tier for the report; the queue-level attribution is by inspection of `causeOf`, whose `removing` is undefined during a restore, so `causedBy` is undefined — acceptable and stated in the ticket's doc update.
- **`restoreSealed` with an open segment.** Throws before changing anything. Test at the collection tier.
- **`restoreSealed` on an invented collection.** The replay starts from the invented baseline, as every replay does. By inspection of `replayBaseline`.
- **`holdsCommitted` on an invented collection** (no context): `false`. By inspection.
- **Two restores racing** serialize on the hold. By inspection.
- **`dispose` during `restore`.** The hold is released, `restore` finishes its registration (the loop is stopping anyway) or, if `stage` has not started, rejects with `QueueDisposedError`. Pick one, state it in the method's doc comment, and cover it by inspection.
- **Status shape unchanged.** `EntryStatus` gains nothing here; `persisted` is the plugin's field (part two). `QueuedEntry` and `EntryStatus` for a restored entry are built by the same `entry.ts` projections as for any other.

## Tests

Only the cases named above. Reuse the harness of `packages/db-core/test/offline-queue.spec.ts` (`openQueue`, `queueEntry`, the `RecordsPends` and parking doubles) and of `packages/db-core/test/collection-segments.spec.ts`. The queue spec's existing cases must keep passing with the journal double in place of `recordAttempt`.

## Docs

- `docs/offline-sync.md`: §What is journaled — the record is split into an entry record (written once) and a drive record (rewritten per send, partial commit and renewal); show the two shapes as this ticket defines them, in the queue's terms, and say the plugin adds the table names (part two). §Write ordering — rules 2 and 4 as above. §Identity across attempts — the sentence naming `OfflineQueueOptions.recordAttempt` names `IOfflineJournal.driving` instead. §Restore after a restart — the `holdsCommitted` rule and the insertion-by-`seq` rule, in prose. §Following transactions — "synchronously" loosened as above.
- `docs/internals.md` §The offline queue: one sentence each for the journal port, `restore`, and the hold; `recordAttempts` is still the write-ahead wrapper, now over `IOfflineJournal.driving`.
- `yarn lint:docs` clean.

## TODO

- Add `packages/db-core/src/offline/journal.ts` with `JournalEntryRecord`, `JournalDriveState`, `IOfflineJournal`; export from the offline barrel.
- `Collection.sealedActions`, `Collection.unseal`, `Collection.holdsCommitted`, `Collection.restoreSealed`; `SegmentList.insert`.
- `OfflineQueueOptions.journal` replacing `recordAttempt`; `enqueue` async with write-then-admit and unseal on failure; `driving` at the three sites; `settled` before each terminal emission; `committed` async.
- `OfflineQueue.restore` with the drain hold, insertion by `seq`, identity from the drive record, the four `stage` outcomes, rollback on a throwing `stage`.
- Move the spec's `recordAttempt` uses to a journal double; add the tests named under Edge cases.
- Doc updates above; `yarn workspace @optimystic/db-core test`, `yarn lint:docs`.
