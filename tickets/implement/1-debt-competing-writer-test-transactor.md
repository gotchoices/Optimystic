description: Tests that claim to prove "a save loses a race with another writer and then recovers" all fake the rival — no test tool can actually land a competing change while a save is in flight, so the recovery is unproven. Build that rival-writer tool, then use it to prove the multi-collection save really does re-read, re-apply, and win.
files:
  - packages/db-core/src/testing/test-transactor.ts (add the competing-writer wrapper next to TestTransactor / FlakyCommitTransactor)
  - packages/db-core/src/testing/index.ts (barrel — re-exports test-transactor.js already)
  - packages/db-core/test/transaction.spec.ts (describe "Coordinator commit backoff+jitter retry (occ-default-backoff)" ~4130 — add the new cases here)
  - packages/db-core/src/transaction/coordinator.ts (commit() retry loop ~144; pendPhase conflict classification ~851; commitOnce snapshot/restore ~223)
  - packages/db-core/src/collection/collection.ts (updateInternal ~246 — conflict detect + replayActions; syncInternal ~501)
  - packages/db-core/src/transactor/transactor-source.ts (transact ~140 — the rival's pend uses policy 'r')
  - packages/db-core/src/collections/tree/tree.ts (Tree.createOrOpen, replace(), getCollection())
  - packages/db-core/test/collection.spec.ts (~554 — existing filterConflict collection factory to reuse)
difficulty: medium
----

# A test transactor that actually commits a competing change, and the coordinator retry test that needs it

## Why

Optimistic concurrency is defined by what happens when *someone else got there first*. The test
kit cannot currently produce that "someone else" at the moment it matters.
`FlakyCommitTransactor` returns a `{ success: false }` stale failure **without advancing any
block's revision** — it just stops refusing after N calls. So every test that reads like "lose
the race, recover, win" actually reads "the obstacle vanished". Nothing proves the loser
*observed* a newer revision, *re-applied* its work on top of it, and *did not lose an update*.

This ticket delivers the missing rival writer, then spends it on the one gap it most directly
closes: `TransactionCoordinator.commit`'s built-in retry across multiple collections.

Coverage-only. No production change is expected. If a test surfaces a real rebase defect, do
**not** grow this ticket — file it (see *If a test fails* below).

## The harness

Add to `packages/db-core/src/testing/test-transactor.ts` (already re-exported by
`src/testing/index.ts`, which is a published subpath export of `@optimystic/db-core`):

```ts
/** A competing writer. Receives the UNWRAPPED transactor so its own pend/commit calls are
 *  invisible to the interceptor's counters and cannot re-trigger it. */
export type RivalWrite = (inner: ITransactor) => Promise<void>;

export type CompetingWriterOptions = {
  /** Fires on the first pend whose request satisfies this predicate. `callIndex` is 1-based
   *  over ALL pend calls seen. Default: fire on the first pend call. */
  when?: (request: PendRequest, callIndex: number) => boolean;
};

/**
 * Wraps a {@link TestTransactor} and, exactly once, runs a real competing writer to
 * completion BEFORE delegating the intercepted pend. The rival durably commits, so the
 * delegated pend then fails as a GENUINE optimistic-concurrency loss — nothing is forced.
 */
export class CompetingWriterTransactor implements ITransactor {
  pendCalls = 0;
  commitCalls = 0;
  /** The 1-based pend call index the rival fired on; undefined if it never fired. */
  firedAtCall?: number;
  constructor(inner: TestTransactor, rival: RivalWrite, options?: CompetingWriterOptions) {}
  // get/getStatus/cancel/commit delegate unchanged.
}
```

### Two design decisions, already made — do not re-litigate

**1. Intercept PEND, not COMMIT.** The rival is a real `Collection`/`Tree`, so its write goes
through `TransactorSource.transact`, which pends with `policy: 'r'`
(`transactor-source.ts:141`). `TestTransactor.pend` rejects a pend whose blocks already carry a
*pending* action. So:

- Fire **before** the loser's pend delegates → the loser has pended nothing yet → the rival
  pends and commits cleanly → the loser's delegated pend then fails with `missing` (a real
  conflict). ✔
- Fire at commit time → the loser is already pending on the shared log-tail block → the rival's
  own pend collides with it, and the rival's sync retry loop spins (~10 attempts, ~21s) while
  the loser sits awaiting the rival inside its own commit. That is a livelock dressed as a
  slow test. ✘

So the wrapper offers **no commit trigger at all**. Say why in the class doc so the next reader
doesn't add one.

**2. The rival runs before delegation, never inside `TestTransactor`'s critical section.**
`TestTransactor.get`/`commit` acquire per-block latches (`TestTransactor.commit:${blockId}`). A
rival invoked from inside one of those would self-deadlock. Interception in the wrapper, before
`await this.inner.pend(...)`, is outside every such section. State this in the doc comment.

### Sibling ticket, same file

`debt-txn-coordinator-cache-tests` (in `tickets/plan/`) also wants a **pend-flaky** harness in
this same file — one that makes a *pend* fail, for the network-transactor retry path. That is a
different tool from this one and is not yours to build. Name yours so the two read as distinct
(`CompetingWriterTransactor` vs. a future flaky-pend wrapper) and don't pre-build theirs.

## The rival helper

Both this ticket's tests and the follow-on (`debt-e2e-stale-cache-hit-read-rejected`) need the
same thing: *durably commit a conflicting change to collection C on transactor T*. Factor it
once, next to the wrapper:

```ts
/** Opens a SECOND Tree over the same transactor + collection id and commits `entries`,
 *  producing a real log entry and a real revision bump — the durable competitor. */
export async function commitRivalTreeWrite<TKey, TEntry>(
  inner: ITransactor,
  collectionId: string,
  keyFromEntry: (e: TEntry) => TKey,
  entries: [TKey, TEntry][],
): Promise<void>
```

Implement it as `Tree.createOrOpen(inner, collectionId, keyFromEntry)` then
`await tree.replace(entries)` (`replace` = act + `updateAndSync`, i.e. a full durable commit
through the single-collection sync path). If importing `Tree` from `src/testing/` creates an
awkward module cycle, put this helper in a new `src/testing/competing-writer.ts` and export it
from `src/testing/index.ts`; keep `CompetingWriterTransactor` in `test-transactor.ts` either
way.

## Arm A — the coordinator retry, against a real competitor

`TransactionCoordinator.commit` (`coordinator.ts:144`) retries a clean optimistic-concurrency
loss: back off (jittered), re-read **every** registered collection via `collection.update()`,
then re-drive `commitOnce`. The shipped tests (`transaction.spec.ts:4130`) exercise the retry's
*control flow* — backoff, `maxAttempts`, `deadlineMs`, abort signal, no re-drive of a partial
landing. None makes a rival actually commit, so the property that separates this retry from
"try again and hope" is unproven for the multi-collection path.

Add cases to that same describe block, reusing its existing `makeMultiCollection` helper
(users + posts trees, one two-collection transaction).

### Expected mechanics (verified by reading the code — assert these, don't rediscover them)

1. Rival commits on `users` at revision N.
2. The loser's `users` pend also asks for revision N (`getNextRev()` is still stale) →
   `TestTransactor.pend` sees `latestRev >= rev` → returns `{ success: false, conflict: true,
   missing }`.
3. `pendCollection` wraps it as `PendRejectedError(conflict: true)`; the `posts` pend succeeds
   and is then cancelled by `pendPhase`. Classification is `anyConflict && !anyHard` → a clean
   stale loss, nothing durable.
4. `commitOnce` restores every tracker from its pre-append snapshot (so the staged log entry is
   undone), throws `CoordinatorStaleLossError`.
5. `commit()` backs off, then calls `collection.update()` on both collections. `updateInternal`
   reads the rival's log entry, clears the rival's block ids from the read cache, sets
   `anyConflicts` (the loser's tracker holds an update to the same leaf block), advances the
   action context, and calls `replayActions()` — which resets the tracker and re-applies the
   loser's pending actions against the rival's committed base.
6. Attempt 2 pends at revision N+1 and commits.

### Cases to write

- **Non-overlapping keys, clean rebase.** Rival writes users key 2; the transaction under test
  writes users key 1 (+ the posts row). Assert, on the transactor's durable state and via
  fresh reads: key 1 and key 2 both present, the posts row present, `inner.getCommittedActions()`
  shows the transaction landed **exactly once** (no duplicate log entry), and the rival's action
  is also present. Assert `flaky`-style call counts: the wrapper's `firedAtCall` is set (proving
  the rival really ran) and `pendCalls` shows a second round.
  *Note for the implementer:* in a tree this small, keys 1 and 2 live in the **same leaf block**,
  so this is "non-overlapping at the key level", not "disjoint blocks". That is fine and is
  exactly the interesting case — the block-level conflict is what forces the replay. Do not
  spend effort trying to build a tree large enough to split leaves.
- **Overlapping key, last-write-wins.** Rival writes users key 1 = `{name:'Rival'}`; the
  transaction under test writes users key 1 = `{name:'Alice'}`. After the retry, assert key 1
  reads `Alice` (the rebased loser's value wins because its replay re-applies over the rival's
  base) and the rival's write is still in the log. This is a **lost-update** guard: the rival's
  commit must not be silently erased from the log, and the loser's must not be silently dropped.
- **`filterConflict` really runs during a coordinator retry.** `Tree` supplies **no**
  `filterConflict` hook (confirmed: nothing in `src/` sets it), so the two cases above exercise
  the block-level conflict → `replayActions` path only. To cover the hook, build a raw
  `Collection` with a `filterConflict` that records its invocations (copy the factory shape from
  `test/collection.spec.ts:554`+), register it in a `TransactionCoordinator`, drive the same
  rival interception, and assert the hook was called with the rival's actions as `potential` and
  that its return value (keep / replace / discard) is what ends up committed. Discard is the
  sharpest assertion: a discarded action must leave nothing of the loser's write behind.

## Edge cases & interactions

- **Rival fires exactly once.** A `fired` flag, not just a counter — otherwise the retry's
  second pend re-triggers it and the transaction can never win. Assert `firedAtCall` is set and
  the test still terminates.
- **Picking the right pend in a two-collection fan-out.** `pendPhase` fans out with
  `Promise.allSettled` over the collection map's insertion order (`users`, then `posts`), and
  each wrapper `pend` increments its counter synchronously before its first await — so call
  index 1 is deterministically `users`. That is stable but implementation-ordering-dependent:
  prefer a `when` predicate that matches on a **block id** the test captured from
  `usersCollection.tracker.transforms` (inserts + updates keys) after `applyActions` and before
  `commit`. Do not use `Object.values(request.transforms.inserts)[0].header.collectionId` — an
  already-existing collection's transforms are updates, so there is no insert to read.
- **Rival must not deadlock against the loser.** Covered by the pend-only trigger above; add a
  test-level guard (a short `deadlineMs`/`maxAttempts` on the coordinator call) so a regression
  fails fast instead of hanging the suite for the runner's 10-minute idle timeout.
- **Partial landing must stay impossible here.** The rival conflicts with `users` only, but the
  loss happens in PEND, so `posts` is cancelled and nothing is durable. Assert
  `CoordinatorPartialCommitError` is **not** thrown — if a future change moves the loss to the
  commit phase, this case silently turns into a partial landing and the test must notice.
- **No duplicate log entry on the winning attempt.** `inner.getCommittedActions().size` counts
  the transaction once; also assert the collection's log does not contain the loser's action
  twice (walk it via `collection.selectLog()` or count committed actions per collection).
- **Retry re-reads non-participants too.** `commit()`'s refresh loop calls `update()` on every
  registered collection, not just participants (see its NOTE at `coordinator.ts:196`). If you
  register a third, untouched collection, its `update()` must be a harmless no-op — worth one
  cheap assertion, since a `CollectionHeaderVanishedError` there would abort an otherwise
  healthy retry.
- **Bounded, not lucky.** Every new case must pass a small `baseBackoffMs`/`maxBackoffMs`
  (1–5ms, as the existing cases do) and assert a *bounded* attempt count, so a rebase that
  silently fails shows up as exhaustion rather than a slow pass.

## If a test fails

If one of these tests surfaces a genuine rebase / lost-update defect in `updateInternal`,
`replayActions`, or `commitOnce`, that is a real find — do **not** fix production code inside
this ticket and do **not** weaken the assertion. Land the failing case as a skipped-free,
accurately-described `fix/` ticket naming the one code site, and say so plainly in the review
handoff.

## Validation

```
yarn workspace @optimystic/db-core test
```
Run it in the foreground, unredirected. `packages/db-core/test/transaction.spec.ts` is the file
that grows; nothing under `src/transaction/` or `src/collection/` should need to change.

## TODO

- Add `CompetingWriterTransactor` + `RivalWrite`/`CompetingWriterOptions` to
  `src/testing/test-transactor.ts`, with the pend-only-trigger and no-latch-reentry rationale in
  the class doc.
- Add `commitRivalTreeWrite` (same file, or `src/testing/competing-writer.ts` + barrel export if
  importing `Tree` there cycles).
- Extend the `Coordinator commit backoff+jitter retry (occ-default-backoff)` describe with the
  non-overlapping-key rebase case.
- Add the overlapping-key last-write-wins / lost-update case.
- Add the raw-`Collection` `filterConflict` case (keep / replace / discard) driven through a
  coordinator retry.
- Add the edge-case assertions listed above (single fire, no partial landing, no duplicate log
  entry, untouched third collection, bounded attempts).
- Run the db-core suite green; hand off to `review/` naming anything left uncovered.
