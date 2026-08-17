----
description: A test tool now makes a second writer really save a change in the middle of another save, so the tests that claim "one save loses a race and then recovers" prove it instead of faking it. Nine tests use it; the review added three of them and fixed a flaw that let wrapped tests silently skip a whole consensus phase.
files:
  - packages/db-core/src/testing/test-transactor.ts (DelegatingTransactor, CompetingWriterTransactor, RivalWrite, CompetingWriterOptions, commitRivalTreeWrite; FlakyCommitTransactor rebased onto the new base)
  - packages/db-core/test/transaction.spec.ts (9 cases under describe "Coordinator commit backoff+jitter retry (occ-default-backoff)"; PartialLossTransactor/MixedPendTransactor rebased onto DelegatingTransactor)
  - docs/optimystic.md (Test harness paragraph)
difficulty: medium
----

# What landed

Test coverage plus one harness defect fix. **No production code changed** across implement + review —
`packages/db-core/src/transaction/coordinator.ts` and `packages/db-core/src/collection/collection.ts`
are byte-identical to their pre-ticket state; they are the behaviour under test, not the subject of
an edit.

## The harness (`packages/db-core/src/testing/test-transactor.ts`)

`CompetingWriterTransactor` wraps a `TestTransactor` and, exactly once, runs a real second writer to
a durable commit *before* delegating the intercepted pend. The rival's write really lands (real log
entry, real revision bump), so the delegated pend then fails as a genuine optimistic-concurrency
loss. Contrast `FlakyCommitTransactor`, which returns a stale failure without advancing any
revision — with it, "lose the race and recover" is really "the obstacle vanished".

```ts
export abstract class DelegatingTransactor implements ITransactor { /* forwards everything */ }

export type RivalWrite = (inner: ITransactor) => Promise<void>;
export type CompetingWriterOptions = { when?: (request: PendRequest, callIndex: number) => boolean };

export class CompetingWriterTransactor extends DelegatingTransactor {
  pendCalls = 0; commitCalls = 0; firedAtCall?: number; rivalRuns = 0;
  constructor(inner: TestTransactor, rival: RivalWrite, options?: CompetingWriterOptions) {}
}

export async function commitRivalTreeWrite<TKey, TEntry>(
  inner: ITransactor, collectionId: CollectionId,
  keyFromEntry: (e: TEntry) => TKey, entries: TreeReplaceAction<TKey, TEntry>,
): Promise<void>
```

Everything is re-exported by `src/testing/index.ts`, i.e. the published `@optimystic/db-core/test`
subpath. Importing `Tree` there creates no module cycle — nothing under `src/` imports `src/testing/`
(verified by grep).

Two design constraints from the plan are honoured and written into the class doc so a future reader
does not undo them:

- **Trigger is on PEND only; there is deliberately no commit trigger.** Firing at commit time would
  leave the loser already pending on the shared log-tail block, so the rival's own `policy: 'r'`
  pend would collide with it and burn its sync retry budget while the loser waits on the rival — a
  livelock dressed as a slow test.
- **The rival runs before delegation, never inside `TestTransactor`'s critical section.**
  `TestTransactor.get`/`commit` hold `TestTransactor.commit:${blockId}` latches, and `Latches` keys
  are process-global, so a rival invoked from inside one would self-deadlock on its own reads.

## The tests (`packages/db-core/test/transaction.spec.ts`)

Nine cases in the existing `Coordinator commit backoff+jitter retry (occ-default-backoff)` describe,
sharing three helpers alongside `makeMultiCollection`: `logActions` (walks a collection's committed
log), `onPendTouching` (a `when` predicate keyed on a **block id set** rather than pend call order,
which depends on `pendPhase`'s fan-out over the collection map), and `captureStagedBlockIds`.
`makeMultiCollection` gained an optional `extraCollectionIds` parameter.

1. **Non-overlapping keys both survive the retry** — rival writes users key 2, transaction writes
   users key 1 + a posts row. Asserts no error at all (a pend-phase loss cancels `posts` and lands
   nothing, so `CoordinatorPartialCommitError` is impossible here), `rivalRuns === 1`, exactly
   `pendCalls === 4` / `commitCalls === 2`, both keys readable through the loser's tree *and* a
   cache-sharing-nothing fresh reader, and a users log of exactly `[rival, transaction]`.
2. **Overlapping key rebases last-write-wins without erasing the rival from the log** — both writers
   target users key 1; the rebased loser's value wins the key and both actions remain in the log.
3. **Rival restructures a collection with prior committed history** *(added in review)* — both
   collections start with committed state, and the rival writes 110 keys that all sort *below* the
   transaction's key, forcing a split that moves the transaction's key into a block its staged
   transform does not name.
4. **Rival lands on the other collection in the fan-out** *(added in review)* — same race aimed at
   `posts` instead of `users`, so nothing depends on which collection loses.
5. **A wrapper reproduces the inner transactor's `queryClusterNominees` support** *(added in
   review)* — see the finding below.
6. **Blanket refresh of a registered-but-untouched collection is a harmless no-op** — a third
   `audit` collection the transaction never touches, pre-committed on the raw transactor so it opens
   with an empty tracker. Proves `commit()`'s refresh loop does not abort a healthy retry with
   `CollectionHeaderVanishedError`.

7-9. **`filterConflict` during a coordinator retry** (nested describe) — `Tree` supplies no
   `filterConflict` hook, so the cases above only exercise the block-conflict → `replayActions` path.
   These build a raw `Collection` with a recording hook and drive the same real-rival interception
   through a coordinator retry, covering **keep** (hook sees the rival as `potential`; both commit),
   **replace** (the replacement commits, the original does not), and **discard** (only the rival is
   in the log; the transaction id never commits, because discarding empties `pending` so the retry's
   `commitOnce` finds nothing to stage).

All cases pass a 1-5 ms backoff and a bounded `maxAttempts: 4` + `deadlineMs: 4000`, so a rebase
that silently stops working shows up as exhaustion rather than a slow pass.

# Validation performed

```
npx tsc --noEmit -p packages/db-core   → clean
yarn lint                              → clean
yarn workspace @optimystic/db-core build → clean
yarn workspace @optimystic/db-core test  → 1377 passing, 0 failing
yarn workspace @optimystic/db-p2p test   → 1803 passing, 44 pending, 0 failing
```

db-p2p is run because it consumes the `@optimystic/db-core/test` subpath and the harness added a
runtime (not type-only) `Tree` import there. No pre-existing failures were observed, so
`tickets/.pre-existing-error.md` was not written.

**Non-vacuity, re-verified in review.** `updateInternal`'s `if (anyConflicts) await
this.replayActions()` was temporarily gated off and the suite re-run; the mutation was then
reverted (`git diff` shows `collection.ts` unmodified). Six of the nine cases fail under it with
exactly the symptoms they exist to catch — e.g. `the rival's write was not lost: expected undefined
to deeply equal { key: 2, name: 'Rival' }`, and `expected [ 'local' ] to deeply equal [ 'rival',
'local' ]`. The three that survive do so for stated reasons: the blanket-refresh case asserts a
different property, and the `queryClusterNominees` case does not involve the rebase at all.

# Review findings

## Checked

Read the implement diff (`git show 54a545f`) before the handoff summary, then read the behaviour
under test rather than trusting the summary's description of it: `coordinator.ts` `commit` /
`commitOnce` / `gatherPhase` / `pendPhase`, `collection.ts` `updateInternal` / `replayActions` /
`selectLog` / `doFilterConflict`, the `ITransactor` contract, and every `implements ITransactor` in
the repo. Ran lint, typecheck, build, and both test suites; independently re-ran the mutation test
rather than taking the handoff's word for it. Read every doc that mentions the test harness
(`docs/optimystic.md`, `docs/architecture.md`, `docs/internals.md`, `packages/demo/README.md`).
Grepped the open board for tickets already claiming the touched files.

## Found and fixed inline

- **Wrapping transactors silently dropped `queryClusterNominees`, disabling the GATHER phase.**
  `ITransactor.queryClusterNominees` is optional, and `gatherPhase` treats its absence as "no
  supercluster — use single-collection consensus". `CompetingWriterTransactor` (and, pre-existing,
  `FlakyCommitTransactor` plus two spec-local wrappers) forwarded only five methods and omitted it,
  so any test that set `inner.queryClusterNominees` and then wrapped would skip GATHER entirely and
  pass vacuously. Nothing fails loudly when this happens — it is silent under-coverage.
  Fixed at the highest rung rather than per-wrapper: added an exported abstract
  `DelegatingTransactor` that forwards the entire surface, with `queryClusterNominees` exposed as a
  **getter** so a wrapper reproduces the inner transactor's answer in both directions (defining it
  unconditionally would be the opposite bug — forcing every wrapped multi-collection test onto the
  GATHER path). All four wrappers now extend it, and a test pins the forwarding.
- **Coverage gap: the race always started from an empty collection.** The handoff flagged this as
  "the most likely place a real bug hides" and left it. Added case 3. Getting it non-vacuous took
  two attempts and is worth recording: with prior committed history the loser's staged change is an
  *update* transform that merges cleanly onto the rival's version of the same block, so a rival
  writing keys *above* the transaction's key still passes with `replayActions` gated off. The case
  only depends on the rebase once the rival's keys sort *below* it, so the split relocates the
  transaction's key into a block the stale transform does not name. That is stated in a comment at
  the test, since the key ordering looks arbitrary and is not.
- **Coverage gap: the rival always fired on the first collection in the fan-out.** Added case 4,
  aimed at `posts`.
- **`rivalRuns` counter.** The handoff noted the single-fire latch was only proven indirectly. The
  private `fired` boolean is now a public `rivalRuns` counter, asserted `=== 1` where it matters.
- **A throwing rival was undiagnosable.** It escaped as a rejected pend, which `pendPhase` flattens
  to a bare message string with the stack discarded, so a broken rival read as an unexplained
  coordinator pend failure. The rival call is now wrapped so the message names the source (and
  `cause` retains the original).
- **Dead cast.** `makeMultiCollection` reached into the tree with
  `(usersTree as unknown as { collection: any }).collection` while the same function used the public
  `getCollection()` two lines later. Both now use `getCollection()`.
- **Docs were out of date.** `docs/optimystic.md`'s "Test harness" paragraph described only
  `TestTransactor` and `MeshHarness`. It now covers both wrappers and states the
  extend-`DelegatingTransactor` rule, since the failure mode above is invisible at review time.

## Found and filed

- **`packages/db-core/test/transaction.spec.ts` is 5,150 lines** (measured; see the ticket for the
  command), more than twice the next-largest spec in the repo, and covers half a dozen unrelated
  subjects. That size is the direct cause of the wrapper duplication fixed above — nobody scrolling
  to line 4,100 knows what exists at line 900. Too large to split inside a review pass, so filed as
  `tickets/backlog/debt-transaction-spec-oversized.md`, with an optional `max-lines` lint cap as a
  second arm so it does not re-grow. No open ticket claimed the file's size (three claimed line
  ranges inside it; the ticket notes the sequencing conflict).
- **Arm appended, not re-filed:** `tickets/backlog/debt-session-mode-bridge-coverage.md` already
  claims `test-transactor.ts` and plans a hand-rolled selective-commit-failure wrapper. Added a note
  there pointing at `DelegatingTransactor` instead of filing a duplicate.

## Tripwires

- Carried forward from implement, unchanged and still accurate: a `NOTE:` on `commitRivalTreeWrite`
  in `packages/db-core/src/testing/test-transactor.ts` — the rival tree opens at the **default**
  node capacity (64) because fan-out is not persisted in the collection header. Harmless while both
  racers are default-fan-out trees; if a test ever races a small-capacity tree the two sides would
  split nodes at different fan-outs.
- No new tripwires. Everything conditional that surfaced in this pass was either already parked at
  its site by the implementer or turned out to be a present-tense gap, so it was fixed or filed
  above rather than deferred.

## Accepted tradeoffs

None encountered. No `NOTE:` marking a declined finding exists at any site this review touched, so
nothing was left alone on those grounds.

## Not fixed, and why

- **Remaining coverage gaps, all deliberate.** `potential` is only ever a single rival action (a
  rival committing several actions in one entry, or several rivals stacking entries between
  attempts, is untested); `commitRivalTreeWrite` is exercised only for upserts, never a delete; and
  the `filterConflict` cases use a single-collection coordinator, so a hook firing during a
  *multi*-collection retry where one collection replays and another does not is untested. Each is a
  further multiplication of an already-covered mechanism rather than a distinct path, so the return
  on more cases here is low — recorded so the next reader knows the boundary, not filed.
- **Commit-phase races remain out of scope by design**, per the class doc's livelock rationale. That
  gap needs a different tool, not a `when` option on this one.
