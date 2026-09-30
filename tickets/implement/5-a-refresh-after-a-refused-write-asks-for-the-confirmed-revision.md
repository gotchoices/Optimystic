description: When a write is refused because a newer version already exists, the client re-reads to catch up, but that re-read can be answered by an out-of-date machine and the client learns nothing, so the write can never succeed. The re-read now says which version it already knows exists, tries another machine when the answer is older, and passes that minimum on to the machine it asks.
prereq:
files: packages/db-core/src/collection/collection.ts (syncAttempts, updateInternal, readLogEnds, readLogTail, refreshInFlight), packages/db-core/src/transactor/network-transactor.ts (get: both processBatches calls), packages/db-core/src/network/struct.ts (BlockGets.floors doc), packages/db-core/test/network-transactor.spec.ts ("never reaches a repo"), packages/db-core/test/refresh-below-floor.spec.ts (the TwoReplicaTransactor double to build on), packages/db-core/test/own-entry-completes-the-action.spec.ts (a harness that drives sync through stale failures), docs/internals.md, docs/transactions.md, docs/debugging.md
difficulty: medium
----

# A refresh after a refused write asks for a tail no older than the revision it was told about

## What is wrong

A write is refused with `StaleFailure.staleAt = { blockId, rev }`: some machine read revision `rev` of that block out of its own storage as durably committed under another action. `Collection.syncAttempts` keeps that number as `lastStaleAt` and refreshes before the next attempt. The refresh (`Collection.updateInternal`) starts by reading the collection header and the log tail block unpinned (`Collection.readLogEnds`), and adopts what the tail's `state.latest` says. That read goes to whichever coordinator `NetworkTransactor.get` picks, and that coordinator answers from its own copy whenever its lazy read-repair window says the block was checked recently (`CoordinatorRepo.shouldReadRepair`, 10 s default).

When the answering coordinator is behind the machine that refused the write, the tail comes back at the revision the client already holds. `Collection.tailShowsNothingNewer` returns early, the collection's revision does not move, the next attempt requests the same taken revision, and after two such rounds `syncAttempts` throws `SyncRevisionStalledError`. That is the fast, correctly named failure `sync-fail-fast-on-a-stalled-revision-view` landed. It is still a failure, and a needless one: the client *knows* revision `rev` exists. It never says so.

Every commit touches the log tail block (its entry is appended there; a roll-over updates the old tail's `nextId`), so the tail block a header names at collection revision `R` is materialized at exactly `R`. The confirmed revision is therefore a **floor** for the tail read: any answer materialized below `staleAt.rev` is provably not the current tail.

## What to build

Three changes, all in db-core. Nothing changes for a reader's `update()` or for a refresh that follows no refusal.

### 1. The refresh carries the confirmed revision to its tail read

- `syncAttempts` passes `lastStaleAt?.rev` into the refresh it runs between attempts (the `updateInternal` call inside its inner `for (;;)` loop). Add an optional third parameter to `updateInternal(report, lastChance, tailFloor?: number)` and to `refreshInFlight(report, lastChance, tailFloor?)`. `TransactionCoordinator.commit`'s refresh passes none today, because the number is destroyed before its loop sees it (`backlog/debt-multi-collection-retry-cannot-see-the-taken-revision`); the parameter is the seam that ticket will use. A plain `update()` passes none.
- `readLogEnds(transactor, id, knownTailId, tailFloor?)` puts the floor on whichever request reads the tail: `floors: { [knownTailId]: tailFloor }` on the batched header-plus-tail request when the tail is known, and on `readLogTail`'s request when the header names a different tail (or none was known). The header itself gets no floor: it is only rewritten when the tail rolls over, so its materialized revision says nothing about the collection's revision.
- The floor is **for this one refresh only**. It is not raised into the handle's `BlockFloors`. A standing floor keyed by the tail id this handle remembers would be wrong whenever the tail rolled over between the held revision and the confirmed one: the old tail block's last revision is the roll-over revision, below the floor, so every later read of that block (the invalidation walk, the chain walk) would be judged below floor, never cached, and re-asked against a second coordinator for the life of the handle. A refresh-scoped floor cannot outlive the refresh.
- When the tail answer is still below the floor after the transactor has done what it can (see 2), the refresh proceeds exactly as today (`tailShowsNothingNewer` and the stall detector own what happens next) and logs one line on the `optimystic:db-core:collection` namespace: `collection:tail-below-floor id=… tag=… floorRev=… servedRev=…`. Judge with `servedRevision(tail)`, the same number every floor check uses. This is the line that separates "nobody could serve the confirmed revision" from "we never asked".

### 2. The transactor forwards the floor to the machines it asks

`NetworkTransactor.get` today builds `{ blockIds, context }` for every downstream `IRepo.get` and consumes `BlockGets.floors` inside the process. Change both `processBatches` calls (the first round and the retry round) to forward `floors` restricted to the batch's block ids, and to omit the field entirely when no block in the batch has one, so an unfloored read's request shape is unchanged. The existing reader-side check and the below-floor retry against a different coordinator stay exactly as they are; forwarding adds a third mechanism, not a replacement.

Why forward: the wire is plain JSON and `RepoService` hands `operation.get` to `CoordinatorRepo.get` verbatim, so the field reaches the coordinator with no protocol change. A coordinator that predates the field ignores it and serves as today, and the reader-side check still catches that answer, so no version gate is needed. What a coordinator that understands it does with it is the companion ticket `a-coordinator-told-of-a-newer-revision-consults-past-its-window`; with this ticket alone the floor is forwarded and unread.

### 3. Documentation and the field's contract

- `BlockGets.floors` doc in `packages/db-core/src/network/struct.ts`: it is no longer a "client-side hint, never on the wire". Rewrite: forwarded per batch; a peer that predates it ignores it; the reader-side check is what guarantees correctness either way; the companion ticket names what a coordinator does with it.
- `docs/internals.md`: the "asker's floor rides out on the request" bullet under Key Invariants and the "What this deliberately does not do" paragraph under § A block re-read after a refresh both say the floor never reaches a peer. Update both. Add the refresh's tail floor beside them: where it comes from (`staleAt`), why it is refresh-scoped, and why the header carries none.
- `docs/transactions.md` § Below-floor answers: the "Nothing new goes on the wire" bullet becomes "One optional field goes on the wire", with the compatibility argument above.
- `docs/debugging.md`: add `collection:tail-below-floor` to the collection sub-namespace row and a short reading of it in the sync-stalled section ("The write path's report of the same failure"): its presence right before a `collection:sync-stalled` strike means every reachable coordinator was asked for the confirmed revision and none could serve it.

## Why this shape and not the others

- **Not a standing floor.** See the roll-over argument in 1. Also `BlockFloor` requires an `actionId` for its log line and `staleAt` carries none; making it optional for one caller is a second reason the refresh-scoped form is cleaner.
- **Not a throw when nobody can meet the floor.** The accepted-tradeoff `NOTE:` at `TransactorSource.mayRetain` applies unchanged: a log entry is not proof its blocks landed, and a confirmed revision under a rival could in principle sit on a machine this node cannot reach. The stall detector already ends the write with a named error after two rounds; this ticket makes those rounds reach a machine that can answer, it does not add a new way to fail.
- **Not adopting `staleAt.rev` directly.** Settled in `sync-fail-fast-on-a-stalled-revision-view` and recorded in `backlog/more-design/6.5-partition-healing`: a bare revision without content would let the write land over history it never read.
- **Boundary with partition healing.** A floor helps a client that is merely *behind*. On a forked lineage both sides are internally consistent; the confirmed revision exists on the rival's history and the refresh, however well it reaches the right machine, adopts a tail whose entries disagree with the held context. That is reported by `collection:lineage-divergence` and owned by `backlog/more-design/6.5-partition-healing`. This ticket changes nothing on that path except that the divergence is reached in one round instead of never.

## Edge cases & interactions

- **The tail rolled over between the held revision and the confirmed one.** The known tail's last revision is the roll-over revision, which may be below the floor even on a current coordinator; that coordinator's header names the new tail, `readLogEnds` drops the known tail's answer and reads the new tail with the floor. Cost: one wasted retry round in the transactor when the first coordinator was current. Verified by inspection; leave a `NOTE:` at the floor's attachment site in `readLogEnds`.
- **The confirmed revision is below what the refresh would request anyway** (ordinary contention: the rival's commit is what the refresh adopts). The floor is met by the first answer; no retry, no line. Verified by the existing refresh-cost budgets in `packages/db-core/test/refresh-read-cost.spec.ts`, which must not move. Run them.
- **`lastStaleAt` names the client's own half-landed revision.** Excluded at the producers by `isOwnRevision`; a floor derived from it would be met by the tail that carries the own entry anyway. Inspection.
- **The refresh finds the write's own entry** (`completeOwnEntry`). Unchanged: the floor only affects which coordinator answers the tail read; it runs before any of that.
- **Every reachable coordinator is below the floor.** The transactor returns the highest served, unflagged (existing rule). The refresh logs `collection:tail-below-floor`, `tailShowsNothingNewer` returns early, the stall detector strikes. Pin with the test below.
- **A batched retry re-asks the header with the tail.** The transactor's retry is per batch (`NOTE:` on `BlockGets.floors`); here the batch is exactly the header and tail, so the "extra" block is one the refresh needed anyway. Inspection.
- **A coordinator on an older build.** Ignores the field, serves as today, the reader-side check and retry catch it. Inspection; no version gate.
- **`TestTransactor` and the reference peer's transactor** ignore `floors`; every db-core spec that drives sync through them is unaffected. Verified by the suite.
- **Concurrent reads of the tail** through the handle's own source while a refresh is in flight are pinned at the held revision, so `BlockFloors.applicableTo` gives them no floor and nothing here touches them. Inspection.
- **Request shape of an unfloored read is unchanged.** Pinned by inverting the existing `network-transactor.spec.ts` case (below).

## Tests

- `packages/db-core/test/network-transactor.spec.ts`: invert "never reaches a repo: the field is consumed inside this process" into two cases: a floored read's downstream requests (first round and retry) carry `floors` restricted to the batch's ids; an unfloored read's downstream request has exactly the keys `blockIds` and `context`. Both assert on the recorded `IRepo.get` arguments the existing case already records.
- A collection-level case beside `packages/db-core/test/refresh-below-floor.spec.ts` (or in it, extending `TwoReplicaTransactor`): two simulated repos behind one `NetworkTransactor`-shaped double, one lagging one revision behind; a rival commit lands on the current one; this handle's write is refused with `staleAt` at the rival's revision; the lagging repo is the first coordinator asked. Expected: the refresh's tail read is re-asked against the current repo, the next attempt requests one past the rival's revision, the write lands, and no `SyncRevisionStalledError` is thrown. This is the contract on the branching logic the ticket adds and the reproduction of the wedge it fixes.
- A second case on the same double where both repos lag: the sync throws `SyncRevisionStalledError` as today, and one `collection:tail-below-floor` line was logged per stalled refresh. Assert on the logger the existing collection specs already capture.
- No test for the doc-only changes or the parameter plumbing.

## TODO

- Thread `tailFloor` from `syncAttempts` through `updateInternal`, `refreshInFlight`, `readLogEnds` and `readLogTail`; attach it as `floors` on the tail's request only; log `collection:tail-below-floor` when the served tail is under it.
- Forward `floors` per batch in both `processBatches` calls of `NetworkTransactor.get`, omitting the field when the batch has none.
- Rewrite the `BlockGets.floors` doc comment; update `docs/internals.md`, `docs/transactions.md` and `docs/debugging.md` as listed.
- Invert the network-transactor wire-shape spec; add the two collection-level cases.
- Run `yarn workspace @optimystic/db-core build`, the db-core suite, `yarn lint`, `yarn lint:docs`, and the db-p2p and quereus-plugin suites against the rebuilt build.
