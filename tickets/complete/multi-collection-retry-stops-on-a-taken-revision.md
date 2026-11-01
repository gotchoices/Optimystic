description: When a write that spans several collections keeps losing to a revision someone else already committed, it now stops within a couple of attempts and says why, as a write to one collection already did. The confirmed revision is carried to the retry loop per collection, where it also floors the refresh's log-tail read and skips the backoff while a member holds the slot.
architecture: docs/internals.md#the-revision-context-is-monotonic
files: packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transaction/errors.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/transaction/index.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/transaction.spec.ts, packages/db-core/test/stale-failure.spec.ts, docs/internals.md, docs/transactions.md, docs/debugging.md, docs/correctness.md, docs/offline-sync.md
difficulty: hard
----

## What landed

Implemented in `ticket(implement): multi-collection-retry-stops-on-a-taken-revision`; the review pass made the small changes listed under *Found and done* below.

The stall rule that `Collection.sync` applied alone — "the refresh moved this collection nowhere while a responder keeps confirming a revision at or above the one the next attempt would request, so the next attempt is byte-identical to the one that just failed" — now exists once, as `RevisionStallWatch` in `packages/db-core/src/collection/write-attempts.ts`, and both retry loops keep one: `AttemptCycle` one per write, the coordinator's `RetryBudget` one per participant. The multi-collection loop (`TransactionCoordinator.commit` and `commitEntry`, through the shared `commitAttempts`) checks every participant before every attempt, in sorted collection-id order, logs a strike as `commit:revision-stalled` under `trx:coordinator`, and throws `CoordinatorRevisionStalledError` (a subclass of `CoordinatorStaleLossError`, so `classifyCommitFailure` files it as `contention` unchanged) on the first participant to reach `maxStalledAttempts` (default 2). After a sibling has landed it surfaces as a `CoordinatorPartialCommitError`'s `reason`, through `commit`'s existing single catch.

The confirmed revision reaches the loop per collection. A refusal of one collection's own request is that collection's number whatever block it names (`ownStaleAt`); a batched refusal's one number goes to the collection owning the block it names and to no other (`batchStaleAt` over `staleAtOwner` in `packages/db-core/src/network/stale-failure.ts`). The map rides on `PendRejectedError`, `PendPhaseFailure`, the refused arm of `CollectionCommitOutcome`, `CoordinationResult` and `CoordinatorStaleLossError.staleAtByCollection`. A collection refused with no number, or cancelled beside a refused sibling, is noted with nothing and never strikes. The same evidence floors each participant's refresh of its log tail (`RetryBudget.tailFloor`, through `RefreshParticipant.refresh` to `Collection.refreshInFlight` and `HeadCommitHandle.refresh`) and skips the backoff while any participant's members hold the next slot (`RetryBudget.pause`).

## Review findings

**Checked, by reading the implement diff first and then the handoff.**

- The `AttemptCycle` refactor is behaviour-neutral: the watch's two flags (the attempt's own confirmation for the stall check, the latest loss's confirmation for the slot hold, cleared by a refused refresh round) reproduce the old field-plus-local pair exactly; `noteCommit` resets everything but `confirmedLosses`, as `recordCommit` did. The single-collection suites pass unchanged.
- Attribution. The pend-failure path of `commit` lists every collection of the attempt as failed (the `allCollectionIds` default at `cleanFailureError`'s call), so a sibling cancelled beside a refused collection is noted with `undefined` as the handoff says. `pendFailure`'s "the maps are disjoint" holds because each collection pends once per phase, and the batched pend's fallback to per-collection pends produces one set of reasons, not two.
- Loop ordering. `assertOpen` precedes `assertNotStalled`, which sits outside the `try`, so a stall propagates exactly as a budget-exhausted `CoordinatorStaleLossError` thrown from `recordLoss` does, and the `nothingLeft` exit after a refresh runs before the next check. A stall is thrown after a refresh round and before an attempt, so every collection is in the state an attempt would have found it in.
- The unlatched `nextRevisions()` in `commit` can only understate: a concurrent reader's refresh raises `getNextRev()`, which the check reads as progress and resets, and an attempt that requested above what the check saw makes the next check read progress too. Never a false stall.
- Watches created at the first check rather than lazily at the first loss: agreed with the handoff. `AttemptCycle.beforeAttempt` records the first attempt's requested revision before any loss, so a participant whose first refresh moves it forward resets rather than strikes, and the coordinator loop now matches that.
- `recordRefusedRound` clears every participant's hold, not only the refused one's; conservative (one jittered sleep a member's hold would have let it skip), never wrong.
- The handoff's `pause()` concern (a saved participant's watch outliving its save for one pause): traced and confirmed unreachable. The watch set is re-synced by `recordLoss` before any pause reads it, because a successful refresh round returns from `refreshRounds` without another pause, and the next pause follows the next loss.
- `CoordinatorRevisionStalledError`: the subclass relation keeps every `instanceof CoordinatorStaleLossError` catch and the failure classifier working; the only consumers outside the coordinator are `commit-failure-class.ts` and the Quereus bridge's `instanceof` checks, which need no change. The `staleAtByCollection` naming deviation from the ticket is the right call: the subclass's `staleAt` is the one revision, matching `SyncRevisionStalledError.staleAt`, and TypeScript forbids redeclaring a property at an incompatible type.
- `errors.ts` type-imports `ConfirmedRevision` from the collection module; `import type` is erased and creates no runtime edge, so the barrel-cycle guard is not at risk.
- Docs: every file the change touches was read against the new reality. `docs/internals.md` (three sites), `docs/transactions.md`, `docs/debugging.md` (namespace row and the stalled-line paragraph), `docs/correctness.md` (slot-hold paragraph) and the doc comments all describe the code as it is now. No reference to the retired backlog slug remains outside `tickets/.garden-report.md`, which is the runner's own record.
- Tests. Both new coordinator tests reproduce the defect the ticket fixes (two pends against a budget of ten; the partial landing reporting the stall as its reason) and the `staleAtOwner` table pins the attribution rule, which has real branching. Nothing cut. Nothing added: the `commitEntry` path shares `commitAttempts`, and `EntryParticipants.nextRevisions()` is glue over handle getters the entry-commit suite already exercises; the batched attribution is `staleAtOwner` behind a two-line wrapper, and the mesh spec drives the batched path end to end.

**Found and done (minor, fixed in this pass).**

- `RetryBudget.assertNotStalled` spelled the collection-id comparator inline, a fourth copy beside `commitOnce`'s, `execute`'s default sort and `compareCollectionIds` in `entry-commit.ts`, whose `NOTE:` already says the three must agree. Exported `compareCollectionIds` and used it there (its comment now names this fourth caller, where only determinism matters).
- `docs/offline-sync.md`'s failure-class table named `CoordinatorStaleLossError` as the coordinator's counterpart of the two sync errors; it now names the new subclass beside it.
- `tickets/backlog/debt-collection-write-retry-logic-outgrew-its-file.md` re-measured: `write-attempts.ts` 610 lines (from 460), `coordinator.ts` 2677 (from 2474), with what this ticket moved and where a split would cut. Not a new ticket: the size debt is already filed and the arm is evidence for it.

**Major findings:** none. The rule is shared rather than copied, the attribution understates and never overstates, and the only new error is a subclass of one every caller already handles.

**Tripwires:** none new. The two conditional concerns the handoff raised (a saved participant's hold, the all-watches clear on a refused round) were traced to "cannot happen" and "conservative" respectively, both recorded above rather than at a code site, since neither has a condition that can trip.

**Considered and declined:** the `StallVerdict` union's `strike` and `stalled` arms carry the same fields and could be one arm with a two-valued `kind`; left as is, since the separate arms read better at the two call sites.

## Validation run in review

- `packages/db-core`: `yarn build`, `yarn typecheck`, `yarn test` — 2040 passing.
- `yarn lint` and `yarn lint:docs` (48 documents, all citations resolve) — clean.
- `packages/quereus-plugin-optimystic`: `yarn test` — 1204 passing, 14 pending, smoke ok.
- `packages/db-p2p`: the `OfflineQueue on a two-member mesh` specs (the batched pend and commit path on a real cohort) — 5 passing. The full db-p2p suite was run by the implement stage (3607 passing, 75 pending) and nothing in this pass changed behaviour.
