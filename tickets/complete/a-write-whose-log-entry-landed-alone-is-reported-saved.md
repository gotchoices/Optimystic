description: A write could be reported as saved when only its log record was stored and the table data it changed never was, so the row was silently lost on every machine. The writer's retry now finishes the half-stored write before reporting it saved, and refuses with a named error when it cannot.
files:
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `tornFromRefusal`, `retainInFlightAttempt`, `InFlightAttempt`, `inFlightAttempt`; changes in `updateInternal`, `syncAttempts`, `beginInFlightAction`)
  - packages/db-core/src/collection/struct.ts (`TornActionError`, `TornActionReason`; `SyncRetryExhaustedError` doc)
  - packages/db-core/src/transaction/coordinator.ts (`commit` retry loop; `commitOnceLatched` retains failed attempts)
  - packages/db-core/src/testing/test-transactor.ts (`TailLandsButReportsStale`; `TestTransactor.pend`/`.commit` mirror the real own-revision handling)
  - packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/repo/coordinator-repo.ts (NOTE comments only)
  - packages/db-core/test/own-entry-completes-the-action.spec.ts, packages/db-core/test/collection-own-action-replay.spec.ts, packages/db-core/test/coordinator-own-action-replay.spec.ts
  - packages/db-p2p/test/half-landed-write-is-finished.spec.ts (real 3-node mesh)
  - docs/internals.md, docs/correctness.md, packages/db-core/docs/collections.md
----

# What was wrong

A write touches its collection's **log tail** (the block recording "action X at revision N changed these blocks") and its **data blocks**. `NetworkTransactor.commit` commits the tail first and stores the rest only if the tail answered success. A failed tail answer does not mean the tail is absent: the durability gate answers `commit-not-durable` when fewer than a majority hold the revision, even though some members stored it. The writer then cancelled (dropping the data blocks' pending records everywhere), refreshed, found its own log entry, and treated that as proof the write was saved. `sync()` returned success, the revision advanced, and every data block stayed at its old revision on every node.

# The rule now enforced

**A sync or a transaction commit reports success only if every block the action's log entry names holds that action's revision. Finding the entry proves only that the tail landed.**

# How

- Every failed attempt is retained verbatim on the collection (`retainInFlightAttempt`: transforms, revision, tail id, block digests), tied to the in-flight action mark and cleared with it.
- When a refresh finds the write's own entry, `completeOwnEntry` re-sends that retained attempt at the **same action id and revision** before the entry is consumed. The storage tiers already treat a block holding exactly that action at exactly that revision as satisfied (`isOwnRevision`), so the re-send lands precisely the missing blocks. It runs before `updateInternal` changes anything, so any throw leaves staged actions, tracker and revision untouched.
- The re-send's `WriteDurability` is what `sync()` reports.
- When finishing fails: `TornActionError` with a `reason` — `rival-holds-revision` (permanent), `completion-refused` (can clear; both write paths retry **the refresh, never a new attempt**, against the existing budget and deadline, then rethrow it), `transforms-not-held` (own entry found with blocks missing and no retained attempt at its revision). Never re-driven at a new revision; staged actions are left in place.
- `TransactionCoordinator.commit` follows the same rule; the session-mode path had the same hole and is covered by the same kind of test.

# Review findings

## What was checked

- The implement diff (`3416d5a8`) read in full before the handoff: `collection.ts`, `struct.ts`, `coordinator.ts`, `test-transactor.ts`, the two NOTE-only files, all four spec files, and the three docs.
- The refusal classification (`tornFromRefusal` reading `staleAt` / non-empty `missing` as "a rival committed") against `StorageRepo.pend`: the writer's own revision is set aside as `satisfied` before either field is built. One wrinkle: when a rival *has* committed past the tail, `listRevisions(rev, latest)` does put the writer's OWN action into `missing` beside the rival's — harmless, because that only happens when `staleAt` is also set and a rival really does hold a later revision. No producer was found that lists the writer's own action with no rival present. `superclusterNominees` and `validation` consumers were traced (see below).
- The three rewritten `landedCommits === 1` assertions: not weakened. The counter genuinely can no longer tell "finished" from "replayed" (the re-send is a successful commit that writes nothing), and each site now asserts the storage revision through a fresh reader, which a replay would bump.
- `TestTransactor`'s new own-revision handling against `StorageRepo.pend` / `.commit`: same partition (`satisfied` / `alreadyDone`), same "no pending record written" rule. Full db-core suite green, so no existing spec depended on the old refusal.
- Resource cleanup: the retained attempt is cleared with the in-flight mark on every exit (`syncInternal`'s `finally`; the coordinator's disposers in `commit`'s `finally`); re-marking the same id keeps it, a different id drops it. The sync path hands over the abandoned snapshot tracker's transforms uncopied (nothing mutates them afterwards); the coordinator copies, because its tracker is live until the restore.
- Validation, all from the repo root, all passing on the final tree: `yarn lint`, `yarn lint:docs`, `yarn build`, typecheck of db-core and db-p2p, `yarn workspace @optimystic/db-core test` (1714 passing), `yarn workspace @optimystic/db-p2p test` (2924 passing, 63 pending — existing skips), `yarn workspace @optimystic/quereus-plugin-optimystic test` (966 passing, 13 pending, smoke ok). The plugin suite first refused to run over a stale db-p2p `dist` (the implementer's last comment-only edit postdated their build); it was rebuilt and then run, so this is the first plugin run over the final tree. No pre-existing failures seen.

## Fixed in this pass (minor)

- **Test gap, collection-level rival case.** It asserted only "a `TornActionError` with some blocks". It now pins `reason === 'rival-holds-revision'`, that `staleAt` is carried, that no second attempt was made, that storage took exactly two revisions past the start (torn tail + rival — a re-drive would be a third), and that the writer's revision did not advance.
- **Test gap, coordinator path.** Added "finishing refused forever" (`completion-refused` escapes as `TornActionError`, not `CoordinatorStaleLossError`; one revision; logged once; action still staged) and the handoff's untested mixed case, "one participant finished and another torn for good".
- **Doc overstatement.** The docs and `TornActionError`'s comment said `SyncRetryExhaustedError` means "the write never landed". Not so: no refresh follows the attempt that spends the budget, so that attempt's log entry can be standing unnoticed. Corrected on `SyncRetryExhaustedError`, in `collections.md`, and parked as a `NOTE:` at the throw site in `syncAttempts`.
- **`docs/internals.md`** presented "a finished participant plus a torn one surfaces as `TornActionError`" as the design. Reworded as the known reporting gap it is, pointing at the fix ticket below.

## Major — filed

- **`fix/a-half-saved-multi-collection-commit-is-reported-as-not-saved`.** Once a refresh between attempts has made one participant durable (finished it, or — this predates the ticket — consumed its entry), every later terminal failure of that `commit()` (`TornActionError` on a sibling, stale-loss exhaustion, any hard error) is reported as if nothing were saved. The Quereus bridge treats anything but `CoordinatorPartialCommitError` as a clean rollback and does not latch its degraded state, and a whole-transaction re-drive would double-apply the saved participant. One site: the retry loop in `TransactionCoordinator.commit`. The new mixed-participant spec case reaches the state and is written to pass before and after the fix.
- **`backlog/bug-a-refused-write-can-leave-its-log-entry-behind`.** The handoff's first known gap, unfiled until now: a refused half-landed write leaves a permanent log entry for data that never landed (any rival commit to the collection in the backoff window makes this the outcome), nothing marks or removes it, and resubmitting logs the actions twice. No wrong read results today — trees are read from blocks, and the only in-tree log reader is the diary, which cannot be half-saved — so it is backlog, not fix.
- **`backlog/debt-collection-write-retry-logic-outgrew-its-file`.** `collection.ts` is 1559 lines (`wc -l`), `syncAttempts` about 250 of them with a loop nested in a loop, and `coordinator.ts` now carries a near-copy of the inner loop.

## Appended to existing tickets (no new ticket)

- **`backlog/feat-no-deployment-validates-transactions-at-pend`** — new arm. The coordinator path's re-send is a plain pend: it drops the `validation` pair (transaction + operations hash) the original pend carried. Dormant, because no deployment hands members a checker; the moment one does, the finishing blocks are approved unchecked under the default policy and refused outright under `'reject'` (loudly). Retaining and re-sending the pair is not obviously right either (a member re-executing after a sibling collection has landed starts from different state), so this is a design arm for that ticket, with a `NOTE:` at the re-send site.
- **`backlog/debt-torn-commit-mesh-coverage-drops-no-blocks`** — new arm. The mesh spec stores the tail on **all three** nodes and then answers failure; production's trigger is a tail held by a **minority**, whose re-send has to be accepted by members that never stored it. That shape has no mesh case.

## Tripwires (parked at the site, not ticketed)

- `completeOwnEntry`'s status-read fallback recognising a whole write returns `undefined`, so such a sync would answer "nothing was written" for a saved write. Reachable only on the forked-lineage path. `NOTE:` at the `return undefined`.
- The implementer's two existing `NOTE:`s (the fallback judges by latest revision; the re-send always costs a full round) were read and left as they are.

## Considered and left alone

- **`TornActionError.blockIds` over-approximates** on a refused re-send. It is documented on the field, used only for a message, and the refusal genuinely does not say which blocks are missing.
- **The coordinator's re-send carries no block digests.** Members fall back to corroboration, which is the documented behaviour for any undeclared block; not a correctness gap.
- **After `TornActionError`, calling `sync()` again logs the actions a second time.** Documented on the error; the underlying leftover entry is the backlog bug above.
- **Same-revision ordinary retry rebuilds the log entry with a new timestamp** — already filed by the implementer as `backlog/bug-a-retried-write-can-store-two-versions-of-one-log-revision`; checked that the finish path itself re-sends verbatim and does not add to it (it can re-send a *rebuilt* second attempt's tail when the first attempt's tail was the one that landed — that is the same defect and the same ticket).

## Empty categories

- **Security:** nothing new reachable today; the one concern (unchecked re-send) is dormant behind the validator ticket above.
- **Performance:** no hot-path change. The only added cost is one pend + commit round on a path that runs only after a failed commit whose own log entry is found.
- **Pre-existing failures:** none seen; `tickets/.pre-existing-error.md` not written.

# Downstream confirmation — still needs a human

With optimystic rebuilt (`yarn build`), from `../sereus/packages/integration-tests` run `npx vitest run --reporter=verbose src/scenarios/strand-chat-participants-converge.integration.ts -t "IMMEDIATELY"` at least 10 times. Expect no `_fk_Message_ParticipantId` failure. In that two-member scenario finishing can itself keep being refused as `commit-not-durable` while the joiner's own member still lacks the log tail (`backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold`). If so the run now fails loudly with `TornActionError` (`completion-refused`) instead of silently losing the row — that is this ticket working, and the remaining failure belongs to that backlog ticket. Then tell sereus so it can revisit `tickets/blocked/device-shape-join-write-blocked-on-optimystic-read-after-write.md`.
