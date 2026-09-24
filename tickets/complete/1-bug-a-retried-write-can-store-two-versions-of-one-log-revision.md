description: A write that was refused used to rebuild its history record from scratch when it was retried, so two machines could end up holding different content for what is supposed to be the same saved revision. A retry now sends exactly the same bytes as the attempt it is repeating.
architecture: docs/internals.md#key-invariants
files:
  - packages/db-core/src/log/log.ts (`AddActionsOptions`, `LogOpenOptions`, `Log.open`, `Log.addActions`, `Log.getChainOptions`)
  - packages/db-core/src/collection/collection.ts (`Collection.logAppendBlockIds`, `mintedLogBlockIds`, `beginInFlightAction`, `syncInternal`, `syncAttempts`)
  - packages/db-core/src/transaction/coordinator.ts (`applyActionsToCollection`)
  - packages/db-core/src/testing/test-transactor.ts (`RecordsAttemptsRefusesFirstCommit`, `RecordedAttempt`)
  - packages/db-core/test/retry-resends-identical-transforms.spec.ts
  - docs/internals.md
----

# A retry re-sends the write instead of rebuilding it

A write's log append is now a fixed function of the write and the revision it is requesting: two attempts of one action at one revision produce byte-identical transforms. The two values the rebuild used to mint fresh on every attempt are now minted once per write.

**The entry's timestamp.** `Log.addActions`' trailing parameters (`collectionIds`, `reads`, `timestamp`) were folded into one options object. `Collection.syncInternal` mints the timestamp beside the action id and passes it through `syncAttempts`; `TransactionCoordinator.applyActionsToCollection` passes `transaction.stamp.timestamp`, which is fixed at BEGIN and was already stable across attempts.

**The id of the new history block.** When the current history block is full (32 entries) the append mints a new one. `Log.open` takes an optional `newDataBlockId` source, threaded into `Log.getChainOptions`' `createDataBlock`. `Collection.logAppendBlockIds` supplies one that hands back, in order, the ids an earlier attempt of this same write minted, and mints fresh past the end. The memory sits beside `inFlightAttempt`, keyed on the appending action id and on the revision, and is cleared with the rest of that state by `beginInFlightAction` and its disposer.

Both write paths — `Collection.sync` and `TransactionCoordinator.commit` — get the fix from the same two places, because the coordinator already marks each participant in flight.

## Why it mattered

Storage identifies a saved block revision by `(action id, revision)` and deliberately accepts a retry of the same action at the same revision: a machine that already stored that revision keeps what it has, a machine that did not stores what the retry sent. So when a first attempt landed on only some machines and was refused — the ordinary shape, since a commit is refused whenever fewer than a majority hold the revision — the retry used to write *different content* for the same `(action id, revision)` on the machines that missed the first attempt.

The block-id arm is the worse of the two. The new block itself would only be an orphan, but minting a second id also rewrites `nextId` on the block that was the tail and `tailId` on the collection header, so the two attempts send different update operations for two blocks that already exist. A machine that landed attempt 1 then reads the collection's history as ending in one block and a machine that landed attempt 2 reads it as ending in another, at one revision of one header block, permanently — a forked history, which downstream is exactly the shape `certifiedContentEquivocation` reports to an operator as a signing-key compromise.

## Review findings

### Checked, nothing found

- **Every `Log.addActions` call site.** Grepped the whole tree: no positional caller survives the options-object change, in `src` or in any spec.
- **The handoff's "nothing reads `LogEntry.timestamp` for logic" claim**, which it flagged for a second pair of eyes. Independently re-derived by grepping `.timestamp` across every `packages/*/src`: the only readers are `replay-guard.ts` (a cohort-topic anti-DoS entry, a different type entirely) and `reference-peer`'s CLI, which prints it. The claim holds, so moving the value from attempt-time to write-time changes no behaviour.
- **The `store.generateId()` / `createBlockHeader(type)` equivalence** the id source rests on. Every implementation in the tree — `Tracker`, `CacheSource`, `AtomicProxy` — forwards both to the same `TransactorSource`. Equivalent, as the handoff said, and still a convention rather than something a type enforces.
- **Moving `getNextRev()` above `Log.open` on both write paths.** `getNextRev` reads only `source.actionContext.rev`, which opening a log does not touch, so the reorder is behaviour-neutral.
- **The three comments the implement pass rewrote**, whose replacement reasoning the handoff asked to have checked. Read both refresh loops: at an unchanged revision a rebuild is now byte-identical, so nothing is at stake there; the harm appears only once a refresh has adopted a newer revision, where a new attempt appends a SECOND entry under one action id — which is the duplicate `consumeOwnEntry` exists to prevent. The replacement reasoning is correct.
- **The new spec's `movedTheLogTail` helper**, which reads a `tailId` update against the collection id as the overflow's signature. Confirmed at `Collection.createOrOpen`'s invent path: the chain header block IS the collection header block, so the helper cannot silently read as false.
- **Test value.** The three original cases were weighed against the "tests must pay for themselves" bar and all three kept: two different mechanisms on the collection path (timestamp with room in the block, minted block id on overflow) and a third path with a different timestamp source. None restates the implementation, none verifies a mock, and each asserts on the whole transform set rather than on a named field. Nothing was cut.

### Found and fixed in this pass

- **`logAppendBlockIds` keyed its memory on "some action is marked in flight" rather than on the appending action's own id** (`packages/db-core/src/collection/collection.ts`). The in-flight mark deliberately outlives the instance latch, so it is still set while a write is between attempts — and `TransactionCoordinator.execute` appends under a transaction it never marks. An `execute` landing in that window would have been handed the *other* write's remembered id for its own new log block: one block id inserted under two action ids, which is the divergence this ticket exists to close, arriving sideways. `logAppendBlockIds` now takes the appending `actionId` and reuses only when it matches the mark; both call sites pass theirs. The `NOTE:` tripwire at `applyActionsToCollection` and the paragraph in `docs/internals.md` were reworded to match, since both previously asserted that `execute` reaches the append "with nothing marked in flight", which was not true by construction.
- **One test case added** for that defect (`the minted ids belong to the marked action alone`), confirmed RED against the old predicate with exactly the expected failure. It is the only test added — every other rule in the change was already pinned.

### Recorded as a tripwire, not a ticket

- **A restage at an unchanged revision breaks the byte-identity this ticket establishes.** `restageIfBasesMoved` runs before every attempt and, when a pinned base has moved, replays the pending actions — which re-runs the action handlers, which mint fresh ids for whatever blocks they insert. If that happens while the collection's own revision has NOT advanced, the retry sends different content under this write's `(action id, revision)`. It takes a conjunction to reach: a block re-read that catches up while the log does not move (the abandoned-entry floor at `TransactorSource.mayRetain` is how that happens), and such an attempt is in any case refused by storage's own base guard on exactly the machines whose base moved. Parked as a `NOTE:` at the `restageIfBasesMoved` call site in `Collection.syncAttempts`, with a sentence in `docs/internals.md` so the new invariant is not stated more strongly than it holds.

### Appended as an arm to an existing ticket

- **`backlog/debt-collection-write-retry-logic-outgrew-its-file`.** `packages/db-core/src/collection/collection.ts` went from 2118 to 2203 lines (`wc -l`), and the growth is squarely in the unit that ticket already names: the in-flight state it lists now has two more pieces (`mintedLogBlockIds`, `logAppendBlockIds`), and `TransactionCoordinator.applyActionsToCollection` is a second caller reaching into it. Filed as evidence on the existing ticket rather than as a new one.

### No tickets filed

Nothing else reached the filing bar. The gaps the handoff was honest about are either closed above, already claimed by an open ticket (`backlog/speculative/6.5-block-id-derivation` for deterministic block-id derivation in general, `backlog/bug-a-refused-write-can-leave-its-log-entry-behind` for the abandoned-entry problem), or deliberately out of scope and unchanged (`Chain.open`'s own data-block mint, which is not reachable for a collection whose header came from `Log.create` and would be correct to reuse if it were; `Collection.logAppendBlockIds` being public, which is what `getNextRev` / `beginInFlightAction` / `retainInFlightAttempt` / `restageIfBasesMoved` already are).

## Validation

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`, `yarn lint:deps` — all run, all clean.
- `yarn workspace @optimystic/db-core test` — 1842 passing.
- `yarn workspace @optimystic/db-p2p test` — 3112 passing, 63 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 997 passing, 13 pending. `yarn workspace @optimystic/upgrade-check test` — 59 passing.
- `yarn test` from the root **aborts before those last two**, and not because of anything here: the build-freshness guard refuses the run because the sibling checkout at `C:\projects\quereus` has uncommitted source edits and a `dist` older than them. That is a human's in-flight work in another repository, so it was not written to `tickets/.pre-existing-error.md` — there is no defect in this repo for a triage pass to fix, and the guard's own message names the remedy. The two affected suites were run with `OPTIMYSTIC_SKIP_BUILD_CHECK=1` and are reported above with that caveat: they exercised the current `db-core` build (rebuilt for this pass) against a Quereus `dist` that may lag its source.
- `yarn test:integration` and `yarn check:rn` were **not** run (real TCP meshes, and Metro plus Hermes — both past an agent's wall-clock budget). Nothing here touches transport or the React Native entry.
- The downstream consequence chain (no digest check rejects the divergence, each side certifies its own version, repair declines permanently and reports a key compromise) remains traced statically and unconfirmed on a real mesh, as the fix ticket judged acceptable.
