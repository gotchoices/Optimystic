description: A new test tool can now make a second writer really save a change in the middle of another save, so the tests that claim "one save loses a race and then recovers" finally prove it instead of faking it. Six new tests use it to check the multi-collection save re-reads, re-applies its work, and loses nobody's update.
files:
  - packages/db-core/src/testing/test-transactor.ts (new: CompetingWriterTransactor, RivalWrite, CompetingWriterOptions, commitRivalTreeWrite)
  - packages/db-core/test/transaction.spec.ts (6 new cases in describe "Coordinator commit backoff+jitter retry (occ-default-backoff)"; makeMultiCollection gained an optional param)
  - packages/db-core/src/transaction/coordinator.ts (unchanged — behaviour under test: commit() retry ~144, pendPhase classification ~851, commitOnce snapshot/restore ~223)
  - packages/db-core/src/collection/collection.ts (unchanged — behaviour under test: updateInternal ~246, replayActions ~618)
difficulty: medium
----

# What landed

Coverage only. **No production code changed** — `git diff --stat` is two files, both test-side:

```
 packages/db-core/src/testing/test-transactor.ts | 111 ++++++++-
 packages/db-core/test/transaction.spec.ts       | 327 ++++++++++++++++++++++++-
```

## The harness (`src/testing/test-transactor.ts`)

`CompetingWriterTransactor` wraps a `TestTransactor` and, **exactly once**, runs a real second
writer to a durable commit *before* delegating the intercepted pend. The rival's write really lands
(real log entry, real revision bump), so the delegated pend then fails as a genuine
optimistic-concurrency loss. Contrast `FlakyCommitTransactor`, which returns a stale failure without
advancing any revision — with it, "lose the race and recover" is really "the obstacle vanished".

Surface:

```ts
export type RivalWrite = (inner: ITransactor) => Promise<void>;
export type CompetingWriterOptions = { when?: (request: PendRequest, callIndex: number) => boolean };

export class CompetingWriterTransactor implements ITransactor {
  pendCalls = 0; commitCalls = 0; firedAtCall?: number;
  constructor(inner: TestTransactor, rival: RivalWrite, options?: CompetingWriterOptions) {}
}

export async function commitRivalTreeWrite<TKey, TEntry>(
  inner: ITransactor, collectionId: CollectionId,
  keyFromEntry: (e: TEntry) => TKey, entries: TreeReplaceAction<TKey, TEntry>,
): Promise<void>
```

Both live in `test-transactor.ts` (already re-exported by `src/testing/index.ts`, the published
`@optimystic/db-core/test` subpath). No new file was needed — importing `Tree` there creates no
module cycle, since nothing under `src/` imports `src/testing/`.

Two design constraints from the plan are honoured and written into the class doc so a future reader
does not undo them:

- **Trigger is on PEND only; there is deliberately no commit trigger.** Firing at commit time would
  leave the loser already pending on the shared log-tail block, so the rival's own `policy: 'r'`
  pend would collide with it and burn its ~10-attempt / ~21s sync retry budget while the loser waits
  on the rival — a livelock dressed as a slow test.
- **The rival runs before delegation, never inside `TestTransactor`'s critical section.**
  `TestTransactor.get`/`commit` hold `TestTransactor.commit:${blockId}` latches, and `Latches` keys
  are process-global, so a rival invoked from inside one would self-deadlock on its own reads.

## The tests (`test/transaction.spec.ts`)

All six added to the existing `Coordinator commit backoff+jitter retry (occ-default-backoff)`
describe. Three shared helpers were added alongside `makeMultiCollection`: `logActions` (walks a
collection's committed log), `onPendTouching` (builds a `when` predicate keyed on a **block id set**
rather than pend call order — call order depends on `pendPhase`'s fan-out over the collection map),
and `captureStagedBlockIds`.

`makeMultiCollection` gained an optional second parameter `extraCollectionIds: string[] = []` and
now also returns `extras`. Existing callers pass one argument and are unaffected.

1. **`a REAL competing commit forces a rebase: non-overlapping keys both survive the retry`** —
   rival writes users key 2, transaction writes users key 1 + a posts row. Asserts: no error at all
   (so `CoordinatorPartialCommitError` is impossible on this path — the loss is in PEND, `posts` is
   cancelled, nothing durable); `firedAtCall` set; **exactly** `pendCalls === 4` (one losing round,
   one winning round) and `commitCalls === 2`; key 1 and key 2 both read back through the loser's
   own tree *and* through a fresh reader that shares no cache; `getCommittedActions().size === 2`;
   and the users log holds exactly two actions in order `[rival, transaction]` — the
   no-duplicate-log-entry check. Posts log length 1.
   Note: in a tree this small keys 1 and 2 share one leaf block, so this is non-overlapping *at the
   key level*, and the block-level conflict is what forces the replay. That is the intended shape.

2. **`an OVERLAPPING key rebases last-write-wins without erasing the rival from the log`** — both
   writers target users key 1. Asserts the rebased loser's value (`Alice`) wins the key, and that
   the log still contains **both** actions in order — the lost-update guard in both directions.

3. **`the retry's blanket refresh of a registered-but-untouched collection is a harmless no-op`** —
   registers a third `audit` collection the transaction never touches (pre-committed on the raw
   transactor first, so it opens with an empty tracker and is genuinely a non-participant). Proves
   `commit()`'s refresh loop calling `update()` on every registered collection does not abort an
   otherwise healthy retry with `CollectionHeaderVanishedError`, and appends nothing to it.

4-6. **`filterConflict during a coordinator retry`** (nested describe) — `Tree` supplies no
   `filterConflict` hook (confirmed: nothing in `src/` sets one), so cases 1-3 only exercise the
   block-level conflict → `replayActions` path. These three build a raw `Collection` with a
   recording hook and drive the same real-rival interception through a coordinator retry:
   - **KEEPING** — asserts the hook was invoked once with the local action and the rival's action as
     `potential` (`[{ value: 'local', potential: ['rival'] }]`), and both actions commit.
   - **REPLACING** — a new instance is returned; asserts `merged` commits and `local` does not.
   - **DISCARDING** — asserts the log holds only the rival, `getCommittedActions().size === 1`, and
     the transaction id never committed. (Mechanically: discarding empties `pending`, so the replay
     stages nothing and the retry's `commitOnce` finds no collection with transforms and returns.)

All six pass a small `baseBackoffMs`/`maxBackoffMs` (1-5ms) and a bounded
`maxAttempts: 4` + `deadlineMs: 4000`, so a rebase that silently stops working shows up as
exhaustion, not a slow pass. Mocha's 5s per-test timeout is the backstop against a rival livelock.

# Validation performed

```
yarn workspace @optimystic/db-core test        → 1374 passing, 0 failing
yarn workspace @optimystic/db-p2p test         → 1803 passing, 44 pending, 0 failing
npx tsc --noEmit -p packages/db-core           → clean
yarn workspace @optimystic/db-core build       → clean
```

db-p2p was run because it consumes the `@optimystic/db-core/test` subpath and the harness added a
runtime (not type-only) `Tree` import there. No pre-existing failures were observed, so
`tickets/.pre-existing-error.md` was not written.

**Non-vacuity check.** The plan's whole complaint is that existing tests prove nothing, so the new
ones were mutation-tested rather than merely run: `updateInternal`'s
`if (anyConflicts) await this.replayActions()` was temporarily gated off and the suite re-run.
**5 of the 6 fail**, with exactly the symptoms they exist to catch:

- case 1: `the rival's write was not lost: expected undefined to deeply equal { key: 2, name: 'Rival' }`
- case 2: rival's log action missing from the ordered log
- KEEPING: `expected [ 'local' ] to deeply equal [ 'rival', 'local' ]`
- REPLACING / DISCARDING: rival absent from the log

The mutation was reverted; `collection.ts` is byte-identical to HEAD (it does not appear in
`git diff --stat`). Case 3 (blanket refresh) survives the mutation — expected, since it asserts a
different property (the non-participant's `update()` does not throw), not the rebase result.

**No rebase or lost-update defect was found.** Nothing was filed to `fix/`.

# What a reviewer should hammer

Known gaps, stated plainly — treat these as the floor, not the ceiling:

- **Every race in these tests starts from an empty collection.** In all six cases both writers
  *invent* the collection, so the race is always revision 0 → 1. A rival landing at revision N > 1
  against a collection with prior committed state is **not covered**, even though the plan's
  mechanics narrative is written generally in N. That is the most likely place a real bug hides.
- **The single-fire latch is proven only indirectly.** `firedAtCall` proves the rival fired; nothing
  asserts a counter that it fired *once*. It is covered by termination (a second firing would
  collide with the loser's now-pending blocks and time out) and by the exact `pendCalls === 4`,
  but there is no direct assertion.
- **The rival always fires on the FIRST collection in the fan-out.** `onPendTouching` supports
  keying on any collection's blocks, but no case makes the rival land on `posts` instead of
  `users`. Order-dependence in `pendPhase` is therefore not really stressed.
- **`potential` is only ever a single rival action.** A rival committing multiple actions in one
  entry, or several rivals stacking entries between attempts, is untested.
- **`commitRivalTreeWrite` is only exercised for upserts** — never for a delete (`entry` omitted).
- **Commit-phase races are out of scope by design** (see the class doc's rationale). If a reviewer
  believes that gap matters, it needs a different tool, not a `when` option on this one.
- **The `filterConflict` cases use a single-collection coordinator.** A hook firing during a
  *multi*-collection retry, where one collection replays and another does not, is untested.

## Review findings (from implementation)

- Tripwire parked as a `NOTE:` on `commitRivalTreeWrite` in
  `packages/db-core/src/testing/test-transactor.ts`: the rival tree opens at the **default** node
  capacity (64) because fan-out is not persisted in the collection header. Harmless while both
  racers are default-fan-out trees; if a test ever races a small-capacity tree the two sides would
  split nodes at different fan-outs. Not filed as a ticket — it is conditional, not a latent defect.
