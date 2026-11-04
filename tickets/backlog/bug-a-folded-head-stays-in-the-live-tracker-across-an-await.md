description: While a queued transaction's committed changes are being moved from the staged view into the committed view, there is a short gap in which a concurrent read can see those changes applied twice, so a row might appear duplicated or an entry land at the wrong position for the length of one network round trip.
architecture: docs/internals.md#staged-actions-are-segments
files: packages/db-core/src/collection/collection.ts (`Collection.subtractCommittedHead`, `Collection.applyCommittedToCache`, `Collection.foldOwnCommit`), packages/db-core/src/transaction/entry-commit.ts (the success path that folds every participant and then awaits each `replay`), packages/db-core/src/collection/head-commit.ts (`HeadCommitHandle.fold`, `HeadCommitHandle.replay`)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The wrong view lasts one round trip and corrects itself on the next read, nothing durable is affected, and the clean fix moves a read into a step that is deliberately await-free, so a maintainer may prefer to wait until a reader is seen to hit it.
----
# What is wrong

A head commit lands in two steps under the collection latch. `fold` puts the attempt's transforms into the read cache and adopts the revision; `replay` then takes the committed head out of the live tracker, either by subtracting it (`Collection.subtractCommittedHead`) or by replaying what remains. Between the two, the cache holds the head's operations AND the live tracker still holds the same operations, so a read of a touched block made in that gap applies them twice: a leaf insert splices the same entry in again, a delete removes the neighbour. Reads are not latched, so nothing stops a reader from landing there.

The doc on `Collection.applyCommittedToCache` already states the invariant the sync path keeps: the fold and the tracker reset must be one synchronous step, with no `await` between them. Two sites break it:

- **`Collection.subtractCommittedHead`.** Before it re-folds the touched blocks it reads through the cache each touched block that a remaining segment updates and the cache no longer retains, because the fold applies the head's operations into a resident block only, and a block evicted from the cache (128 entries, least recently used) would otherwise be pinned at the revision last served, which the remaining operations were not computed on. Each such read is an `await` with the head folded and still staged. Only when a touched block was evicted under a later segment's update, so a large tree drained by a long queue is where it would show.
- **`TransactionCoordinator.commitEntry`'s success path** (`packages/db-core/src/transaction/entry-commit.ts`). It folds every participant in one await-free pass, which the committed subset's atomicity needs, and then awaits each participant's `replay` in turn. While the first participant's replay is awaiting its re-staging reads, every later participant is folded and not yet reset. A table and its index are separate participants of one entry, so a read of the index during the table's replay sees the index's head twice. This arm predates `subtractCommittedHead`; the subtraction only makes the first participant's own replay shorter.

The one-collection driver (`driveHeadCommit`) calls `fold` and then `replay` with no await between, so with nothing evicted the single-collection drain keeps the invariant.

# What would confirm it

A two-collection entry commit through `TransactionCoordinator.commitEntry` with the first participant's replay parked on a read, and a read of the second collection's touched leaf made while it is parked, asserting the leaf reads with one copy of the head's entry. For the subtraction arm, the same with a read cache small enough to evict the touched leaf before the head commits.

# What a fix looks like

Either make the step that takes the head out of the live tracker need no read, or move the read ahead of the fold.

- The fold could advance an evicted id's revision entry when the committed transforms update it (`CacheSource.transformCache` leaves it, since the entry is documented as the revision of the content last served); then the re-fold would pin the committed revision with no read, and the subtraction would be synchronous after the fold. This changes what `getCachedRevision` means for an evicted id, which every rev-only pin reads.
- Or a step between `retake` and `fold` on `HeadCommitHandle` could read the blocks the subtraction will need, so both drivers fold and re-fold synchronously. For the coordinator arm the replay of a participant is itself an await, so that arm needs the subtraction (every participant's head taken out synchronously right after its fold) rather than a replay, and a fallback to replay would reopen the gap for the participants after the first.

The `NOTE:` at the read loop in `Collection.subtractCommittedHead` points here.
