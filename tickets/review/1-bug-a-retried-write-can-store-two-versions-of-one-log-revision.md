description: A write that was refused used to rebuild its history record from scratch when it was retried, so two machines could end up holding different content for what is supposed to be the same saved revision. A retry now sends exactly the same bytes as the attempt it is repeating.
architecture: docs/internals.md#key-invariants
files:
  - packages/db-core/src/log/log.ts (`AddActionsOptions`, `LogOpenOptions`, `Log.open`, `Log.addActions`, `Log.getChainOptions`)
  - packages/db-core/src/collection/collection.ts (`Collection.logAppendBlockIds`, `mintedLogBlockIds`, `beginInFlightAction`, `syncInternal`, `syncAttempts`)
  - packages/db-core/src/transaction/coordinator.ts (`applyActionsToCollection`)
  - packages/db-core/src/testing/test-transactor.ts (`RecordsAttemptsRefusesFirstCommit`, `RecordedAttempt`)
  - packages/db-core/test/retry-resends-identical-transforms.spec.ts (new)
  - packages/db-core/test/log-reads.spec.ts, packages/db-p2p/test/cascade.spec.ts (call sites updated for the options object)
  - docs/internals.md
----

# A retry re-sends the write instead of rebuilding it

## What changed

A write's log append is now a fixed function of the write and the revision it is requesting: two attempts of one action at one revision produce byte-identical transforms. The two values the rebuild used to mint fresh on every attempt are now minted once per write.

**The entry's timestamp.** `Log.addActions`' trailing parameters (`collectionIds`, `reads`, `timestamp`) were folded into one options object, because the interesting one is last and a caller that needs only the timestamp should not have to spell out the two before it. `Collection.syncInternal` mints the timestamp beside the action id and passes it through `syncAttempts`; `TransactionCoordinator.applyActionsToCollection` passes `transaction.stamp.timestamp`, which is fixed at BEGIN and was already stable across attempts.

**The id of the new history block.** When the current history block is full (32 entries) the append mints a new one. `Log.open` now takes an optional `newDataBlockId` source, threaded into `Log.getChainOptions`' `createDataBlock`. `Collection.logAppendBlockIds` supplies one that hands back, in order, the ids an earlier attempt of this same action minted, and mints fresh past the end. The memory sits beside `inFlightAttempt`, keyed on the in-flight action id (cleared with the rest of that state by `beginInFlightAction` and its disposer) and on the revision, so a retry at a moved revision mints afresh.

Both write paths — `Collection.sync` and `TransactionCoordinator.commit` — get the fix from the same two places, because the coordinator already marks each participant in flight.

## Why it matters, for a reader without the fix ticket

Storage identifies a saved block revision by `(action id, revision)` and deliberately accepts a retry of the same action at the same revision: a machine that already stored that revision keeps what it has, a machine that did not stores what the retry sent. So when a first attempt landed on only some machines and was refused — the ordinary shape, since a commit is refused whenever fewer than a majority hold the revision — the retry used to write *different content* for the same `(action id, revision)` on the machines that missed the first attempt.

The block-id arm is the worse of the two. The new block itself would only be an orphan, but minting a second id also rewrites `nextId` on the block that was the tail and `tailId` on the collection header, so the two attempts send different update operations for two blocks that already exist. A machine that landed attempt 1 then reads the collection's history as ending in one block and a machine that landed attempt 2 reads it as ending in another, at one revision of one header block, permanently — a forked history, which downstream is exactly the shape `certifiedContentEquivocation` reports to an operator as a signing-key compromise.

## Test added

One spec, `packages/db-core/test/retry-resends-identical-transforms.spec.ts`, pinning the general rule rather than the two values found today. It asserts on the **whole** recorded transform set, so it fails for any per-attempt value added later.

| case | what it verifies |
| --- | --- |
| collection path, history block has room | the timestamp arm: a retry on a fresh collection re-sends the first attempt byte for byte. Also asserts the tail did *not* move, so the case is distinguishable from the next one. |
| collection path, history block full (32 prior syncs) | the minted-block-id arm, including the `nextId`/`tailId` updates on the two pre-existing blocks. Asserts the overflow actually ran (`tailId` rewritten on the header) before asserting identity, so the case cannot pass vacuously. |
| coordinator path (`TransactionCoordinator.commit`) | the same rule on the other write path, where the timestamp comes from `transaction.stamp`. |

The driving double is `RecordsAttemptsRefusesFirstCommit` in `packages/db-core/src/testing/test-transactor.ts` — records each `pend`'s transforms, action id and revision, refuses the first `commit` outright so nothing lands, and can be re-armed (`refuseNextCommits`) after a test's setup writes. It lives beside `CommitLandsButReportsStale` for the reason that one already gives: the collection spec and the coordinator spec must not drift apart on a shared double.

No other tests were added. `own-entry-completes-the-action.spec.ts`, `collection-own-action-replay.spec.ts` and `coordinator-own-action-replay.spec.ts` remain the safety net for the retry machinery, and all still pass.

**All three cases were confirmed RED before the fix**, each failing on exactly the value the fix ticket described — the timestamp for cases 1 and 3, and the new block id plus its `nextId`/`tailId` updates for case 2.

## How to validate

- `yarn workspace @optimystic/db-core test --grep "byte-identical"` — the three new cases.
- `yarn test` from the root — run, all green (db-core 1841, db-p2p 3112 + 63 pending, quereus-plugin-optimystic 997 + 13 pending, and the rest).
- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:deps`, `yarn lint:docs` — all run, all clean.
- `yarn test:integration` and `yarn check:rn` were **not** run (real TCP meshes, and Metro plus Hermes — both past an agent's wall-clock budget). Nothing here touches transport or the React Native entry, but that is reasoning, not a run.

## Honest gaps, and what to look at

- **`LogEntry.timestamp` changed meaning on the coordinator path**, from "when this attempt appended" to "when the transaction began". Nothing in the tree reads the field for logic — it is informational — which is what makes the change safe, and the fix ticket judged the write's own time the more honest value anyway. Worth a second pair of eyes on the "nothing reads it" claim: established by grepping for `LogEntry`/`entry.timestamp` across `packages/*/src`, not by an exhaustive type-driven search.
- **`Collection.logAppendBlockIds` is public** so the coordinator can call it, alongside `getNextRev` / `beginInFlightAction` / `retainInFlightAttempt` / `restageIfBasesMoved`, which are public for the same reason. It is not part of any consumer-facing surface, but it is one more method on an already-large class.
- **The id source is handed a `BlockStore` and calls `store.generateId()`**, where the old code reached the same generator through `createBlockHeader(type)`'s `newId ?? this.generateId()`. Every implementation in the tree delegates both to the same `TransactorSource`, so they are equivalent — but that equivalence is a convention held across `Tracker`, `CacheSource` and `AtomicProxy`, not something a type enforces.
- **`Chain.open` can also mint a data block** (when a header lacks `headId`/`tailId`), which would consume index 0 of the memory. Not reachable for a collection whose header came from `Log.create`, and reuse would be correct there anyway — but it is why the memory is an ordered list rather than a single id.
- **Three now-stale comments were corrected**, at `Collection.inFlightAttempt`, at `syncAttempts`' refresh-retry loop, and at `TransactionCoordinator.commit`'s refresh loop. Each justified its behaviour with "a rebuilt attempt takes a fresh timestamp", which is no longer true. The behaviours are unchanged; the *reasons* were rewritten to the one that still holds — once a refresh adopts a newer revision, a new attempt appends a SECOND entry under one action id, the duplicate `consumeOwnEntry` exists to prevent. That replacement reasoning is mine, derived from reading the paths rather than from a test that exercises it. Please check it.
- **Tripwire parked at `applyActionsToCollection`** (a `NOTE:` in `packages/db-core/src/transaction/coordinator.ts`): `TransactionCoordinator.execute` reaches the append with nothing marked in flight and so mints afresh. Correct today — it re-runs the engine and re-stages, so a re-drive is a different write, and nothing re-drives it under one transaction id (it returns its failure rather than looping). If `execute` ever grows a retry that reuses the transaction id, it must mark participants in flight the way `commitOnce` does or it reintroduces this divergence. Deliberately out of scope per the fix ticket.
- **Not attempted, per the fix ticket**: deterministic block-id derivation in general (`6.5-block-id-derivation`), and the abandoned-entry problem (`bug-a-refused-write-can-leave-its-log-entry-behind`) — a refused write leaving a history record behind at all is a different root cause in the same neighbourhood.
- **The downstream consequence chain was never run end to end.** The fix ticket traced it statically — no digest check rejects the divergence, each side certifies its own version, repair declines permanently and reports a key compromise — and judged confirming it on a real mesh optional. It remains unconfirmed.
