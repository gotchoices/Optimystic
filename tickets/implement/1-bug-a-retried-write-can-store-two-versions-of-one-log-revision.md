description: When a write is retried, the record it adds to the collection's history is rebuilt from scratch, so two machines can end up storing different content for what is supposed to be the same saved revision of the same block. Make a retry send exactly the same bytes as the attempt it is repeating.
architecture: docs/internals.md#key-invariants
files:
  - packages/db-core/src/collection/collection.ts (`syncInternal` — mints the one action id a write reuses across attempts; `syncAttempts` — rebuilds the log entry on every attempt; `beginInFlightAction` / `inFlightAttempt` — the existing per-write state this joins)
  - packages/db-core/src/log/log.ts (`addActions` — `timestamp` already a parameter, defaulted to `Date.now()`; `getChainOptions` — `createDataBlock`, which mints the random id for a new log block; `open`)
  - packages/db-core/src/chain/chain.ts (`add` — calls `createDataBlock` when the current tail is full; `EntriesPerBlock` is 32)
  - packages/db-core/src/transaction/coordinator.ts (`applyActionsToCollection` — the same rebuild on every `commitOnce`; `commitOnceLatched`; the transaction's stable `stamp.timestamp`)
  - packages/db-core/src/testing/test-transactor.ts (`DelegatingTransactor` and the existing doubles — where the new recording double belongs)
  - packages/db-p2p/src/storage/storage-repo.ts (`pend`, `commit` — the `isOwnRevision` carve-out that makes a member keep what it already holds; no change expected here)
difficulty: medium
repro: verified
----

# A retry must re-send the write, not rebuild it

## What is wrong

A write adds one record ("log entry") to its collection's history. A write that is refused is retried under the **same action id**, and if nothing else committed in between the retry also asks for the **same revision**. But each attempt builds that record from scratch, and two things in it are minted fresh every time:

- the entry's **timestamp**, and
- when the current history block is full (32 entries), the **random id of the new block** the entry starts.

Storage identifies a saved block revision by `(action id, revision)` and deliberately accepts a retry of the same action at the same revision: a machine that already stored that revision keeps what it has, a machine that did not stores what the retry sent. So when a first attempt lands on only some machines and is refused — the ordinary shape, since a commit is refused whenever fewer than a majority hold the revision — the retry writes *different content* for the same `(action id, revision)` on the machines that missed the first attempt.

Expected: every machine that stores a given `(action id, revision)` of a block stores identical bytes.

## Reproduced

Both arms were driven on the in-memory `TestTransactor`, through a wrapper that records each attempt's pended transforms and refuses the first commit outright (so nothing lands and the refresh cannot find the entry — this is the case `Collection.completeOwnEntry` does *not* reach).

**Arm 1 — the timestamp.** A fresh collection, one action, first commit refused. Both attempts pend the same action id at the same revision, and the two transform sets differ in exactly one place: the entry's `timestamp` (`...921` against `...952`). Everything else — the log block id, the header, the id of the block the action inserted — is identical, because the action is executed once at `act()` and the log block was created at `createOrOpen`.

**Arm 2 — the new block's id, and it is worse than a fresh block.** Fill the first history block with 32 entries, then refuse the 33rd write's first commit. Attempt 1 mints log block `01fGtd...`; attempt 2 mints `qyEiKc...`. The new block itself is only an orphan, but the two attempts also send **different update operations for two blocks that already exist**, under the same action id and revision:

```
attempt 1   old tail  [["nextId",0,0,"01fGtd..."]]    header  [["tailId",0,0,"01fGtd..."]]
attempt 2   old tail  [["nextId",0,0,"qyEiKc..."]]    header  [["tailId",0,0,"qyEiKc..."]]
```

So a machine that landed attempt 1 reads the collection's history as ending in `01fGtd...` and a machine that landed attempt 2 reads it as ending in `qyEiKc...`, both at the same revision of the same header block, permanently. That is a forked history, not an orphan.

The two reproduction cases were run and then deleted; rebuilding them as a spec is the first TODO below.

## Why it is worth fixing, and what nothing catches today

Traced statically from the reproduced divergence, not observed end to end:

- **Nothing rejects it at commit.** The per-block content digest a commit declares is checked only by a member that holds a pending transform for the action. The member that already holds the revision marks the block `satisfied` at pend and stores no record, so its digest check abstains, and its commit is `alreadyDone`.
- **Each side then certifies its own version.** A member persists the cohort's commit proof only when its own materialization matches the digest that commit declared — true on both sides, because each side's proof comes from the attempt it actually applied. Two verified proofs then declare different content digests for one revision.
- **Repair declines, permanently, and calls it a key compromise.** That is exactly the shape `certifiedContentEquivocation` looks for in `packages/db-p2p/src/cluster/reconcile-block.ts`: the content selection declines rather than picking a side, so the block is never repaired, and the operator is told (`reconcile:certified-content-equivocation`) that whoever holds the cohort's signing keys signed both sides — a compromise investigation for a bug that is ours.

Confirming that chain on a real mesh is optional; it is not needed to justify the fix, and the fix is cheap.

## What is already covered

The neighbouring case is closed: when the retry's refresh **finds** the write's own log entry, it re-sends the refused attempt **verbatim** from the retained transforms rather than rebuilding (`Collection.completeOwnEntry`, `Collection.inFlightAttempt`). This ticket is the case that path does not reach — the refresh read from a machine that had not stored the log block, or the collection is brand new and its header was among the blocks the refused commit left behind, so the log cannot be reached at all.

## The rule to establish

**A write's log append is a fixed function of the write and the revision it is requesting.** Two attempts of one action at one revision produce byte-identical transforms.

The action id is already minted once per write and held on the collection for exactly this reason (`Collection.inFlightActionId`). The timestamp and any minted log-block id join it there, so both write paths — `Collection.sync` and `TransactionCoordinator.commit`, which already marks each participant in flight — get the fix from one place. `Collection.beginInFlightAction` resets that state only when the action id *changes*, so state added beside `inFlightAttempt` already survives across attempts and is already cleared by the same disposer.

### Arm 1 — one timestamp per write

`Log.addActions` already takes a `timestamp` parameter, and nothing in the tree reads `LogEntry.timestamp` for logic (it is informational), so making it the *write's* time rather than the *attempt's* is safe and is arguably the more honest value.

- `Collection.syncInternal` mints it beside the action id and passes it down through `syncAttempts`.
- `TransactionCoordinator.applyActionsToCollection` passes `transaction.stamp.timestamp`, which is set once at BEGIN and is already stable across attempts — no new state needed there.

`addActions`' trailing parameters are already `(..., collectionIds = [], reads?, timestamp = Date.now())`, so the collection path would have to pass `[], undefined, ts` positionally. Folding those three into a single options object is the better shape; only three call sites in `src` and a handful in `test` pass more than four arguments, so the churn is small. Either way is acceptable — the requirement is that the timestamp is threaded, not how the signature looks.

### Arm 2 — reuse the log block id a previous attempt minted, at the same revision only

`Chain.add` mints a new data block through `options.createDataBlock`, which `Log.getChainOptions` binds to a random header id. Give `Log.open` an optional id source for that (the shape `Log.create`'s `options` already has), and have the collection supply one that hands back the id an earlier attempt of this same action minted, in order, falling back to a fresh random id.

`addActions` appends exactly one entry, so at most one new block per attempt — a single remembered id is enough, but write the memory as an ordered list so a future multi-entry append cannot silently reintroduce the bug.

**Key the memory on the in-flight action id and the revision, and reuse only when the retry requests the same revision.** At a *different* revision the write is genuinely different, and re-inserting an id that an earlier attempt may have committed at the old revision would give that block a second revision on the machines that landed attempt 1 and a first revision on the machines that did not — the same divergence through another door. A revision change is observable without extra bookkeeping: `Collection.getNextRev()` only ever rises, so "same revision" is "`getNextRev()` unchanged since the id was minted".

The coordinator path needs no separate mechanism: it calls `Collection.beginInFlightAction(transaction.id)` for each participant, so per-collection memory keyed on the in-flight action serves it too. `applyActionsToCollection` opens the log through `collection.tracker`; it should open it with the same id source.

### Not in scope

- `TransactionCoordinator.execute` re-runs the engine and re-stages, so a re-drive of it is not the same write. Leave it alone, and leave a short comment there saying why if one reads as warranted.
- Deterministic derivation of block ids in general is `6.5-block-id-derivation` (speculative, security-motivated, blocked on design decisions). Nothing here depends on it: reusing an id this write already minted needs no derivation scheme.
- The abandoned-entry problem — a refused write leaving a history record behind at all — is `bug-a-refused-write-can-leave-its-log-entry-behind`. Different root cause, same neighbourhood; do not try to solve it here.

## Tests

One new spec pinning the general rule, so the whole class is caught rather than the two values found today: **a retry at the same revision sends byte-identical transforms.** Put the recording double in `packages/db-core/src/testing/test-transactor.ts` beside `CommitLandsButReportsStale` and `TailLandsButReportsStale`, for the reason the comment on the former already gives — so the collection spec and the coordinator spec cannot drift apart. It needs to record each `pend` request's transforms, action id and revision, and refuse the first `commit` with a retryable conflict (`{ success: false, conflict: true, reason: ... }`) without landing anything.

Three cases, because three different code paths mint per-attempt values:

- collection path, history block has room — the timestamp arm;
- collection path, history block full (32 prior syncs) — the minted-block-id arm, including the `nextId` / `tailId` updates on the pre-existing blocks;
- coordinator path (`TransactionCoordinator.commit`); one collection is enough.

Assert on the whole serialized transform set, not on the timestamp field: the point of the test is that it fails for *any* future per-attempt value, not just these two.

No other new tests. The existing `collection-own-action-replay.spec.ts`, `coordinator-own-action-replay.spec.ts` and `own-entry-completes-the-action.spec.ts` are the safety net for the retry machinery.

## Documentation

`docs/internals.md` already states the retained-attempt rule under *The writer's retry finishes its own half-landed action* ("The transforms are retained rather than rebuilt because a rebuilt attempt re-appends the log entry with a fresh timestamp..."). Extend that so the invariant is stated for the rebuild path too — a same-revision retry is byte-identical because the timestamp and any minted log-block id are per-write, not per-attempt — rather than only for the verbatim re-send.

## TODO

- Rebuild the two reproduction cases as a new spec (red before the fix): a recording/refusing `DelegatingTransactor` in `src/testing/test-transactor.ts`, and the collection-path case on a fresh collection.
- Add the history-block-overflow case (32 prior syncs) and confirm it fails on the `nextId` / `tailId` updates as well as on the new block id.
- Add the coordinator-path case through `TransactionCoordinator.commit`.
- Thread a per-write timestamp: mint it in `Collection.syncInternal` beside the action id and pass it through `syncAttempts` to `Log.addActions`; pass `transaction.stamp.timestamp` from `TransactionCoordinator.applyActionsToCollection`. Decide whether to fold `addActions`' trailing parameters into an options object, and update the call sites either way.
- Give `Log.open` an optional new-data-block id source, threaded into `Log.getChainOptions`' `createDataBlock`.
- Hold the minted log-block ids on `Collection` beside `inFlightAttempt`, keyed on the in-flight action id and the revision they were minted for; supply them to both `Log.open` call sites that append (`Collection.syncAttempts`, `TransactionCoordinator.applyActionsToCollection`); mint fresh when the revision has moved, and say in a comment why.
- Confirm the new spec goes green and that `own-entry-completes-the-action.spec.ts`, `collection-own-action-replay.spec.ts` and `coordinator-own-action-replay.spec.ts` still pass.
- Run `yarn test` from the root, and `yarn lint:docs` after the `docs/internals.md` edit.
