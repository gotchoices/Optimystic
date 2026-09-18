description: A transaction that writes several collections at once can save some of them and permanently lose the rest when the writer's own machine is behind on one of them, as on a node that has just joined. Make the commit phase keep trying to finish the collection it lost, the way a single-collection write already does, instead of giving up at the first refusal. This blocks the release planned for the morning of 2026-09-18.
files:
  - packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts (the reproducer; fails at HEAD, passes with the change below)
  - packages/db-core/src/transaction/coordinator.ts (`commitOnceLatched` partial-commit branch; `commitAttempts`; `commitCollection`'s comment; `CommitCycle.saved`'s comment; `commitOnce` threads the cycle)
  - packages/db-core/src/transactor/network-transactor.ts (`staleFromBatches` drops `reason` and `conflict`)
  - packages/db-core/test/transaction.spec.ts, packages/db-core/test/coordinator-rollback-pending.spec.ts, packages/db-core/test/coordinator-single-stamp.spec.ts, packages/db-core/test/network-transactor.spec.ts (nine tests pin the old contract; listed below)
  - docs/transactions.md ("Session-mode commit is not atomic across collections either", "The residual is the commit phase"), docs/internals.md (the sentence "db-core's `commitPhase` treats any returned `success:false` as a permanent stale failure"), packages/db-p2p/src/repo/coordinator-repo.ts (the same sentence in the comment above the local-fallback arm of `commit`), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitBatchLegacy`'s doc comment and NOTE)
difficulty: hard
repro: verified
----

# A multi-collection commit half-lands when the writer's replica lags

## What happens

A node joins a group and writes one transaction touching three collections: a Member row, that table's unique index, and a ConsumedInvite row. Its own replica has not yet received the founder's blocks for Member. Nobody else is writing. The index and the invite are saved; the Member row is not. The caller gets `CoordinatorPartialCommitError` ("Stale commit for collection …"), the invite is spent, the member is never seated, and nothing retries.

Found by sereus's release gate (7 of 312 integration tests, 6 traced to this). Reproduced in this repository; see below.

## Reproducer

`packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts`. Two nodes on the mock mesh, both declaring `Member` (with a UNIQUE column) and `ConsumedInvite`. The founder writes a seed transaction so every collection has a committed revision on both nodes. The joiner reads Member once. Then the joiner's raw storage is put behind a veil over Member's block ids: reads of them answer absent and materializing writes to them are dropped, so neither a read-repair nor a commit-time reconcile can land them; pending records pass through, so the joiner's member accepts the pend exactly as a behind replica does. The veil lifts on the joiner's first refused commit (standing in for peer-join catch-up landing a moment later). The joiner then writes Member + ConsumedInvite in one SQL transaction.

The assertion is all-or-nothing on both nodes through fresh trees: either every collection holds the joiner's write and the founder is refused when it reuses the joiner's StampId (the UNIQUE index landed too), or none of them does, and a refusal is not a `CoordinatorPartialCommitError`.

At HEAD it fails on every run (3 of 3), with the index and ConsumedInvite committed and Member failed. The captured trace matches sereus's exactly:

```
storage-repo commit:missing-base blockId=6iRt3… rev=2 actionId=tx:FKWv… detail=local latest none is not the declared base 1 of rev 2
reconcile-block reconcile:no-rev-quorum { rev: 2, cohortPeers: 1, holders: 0, behind: 1, required: 1 }
coordinator-repo:commit-local-refusal-tolerated { reason: 'missing-base-revision: …' }
coordinator-repo:commit-not-durable { rev: 2, durableHolders: 1, cohortSize: 2, remoteHolders: [founder], arm: 'local-executed' }
CoordinatorPartialCommitError: … Committed: [lag/Member/index/_uniq_7.stampid, lag/ConsumedInvite]. Failed: [lag/Member]. Underlying failure: Stale commit for collection lag/Member
```

Two things in the trace are worth knowing. First, the joiner's very first attempt was refused at PEND (it pended ConsumedInvite at revision 1, which the founder's seed had taken) and the coordinator's retry loop refreshed and re-drove it cleanly. The retry loop works; it is only the commit-phase refusal it abandons. Second, `reconcile:no-rev-quorum { behind: 1 }` says the founder had not yet applied the commit when the joiner's member reconciled, which is the race `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold` describes. That ticket stays open and is not this fix; the refusal is legitimate, and the coordinator must survive it either way.

The comparison tree at 13586033's parent was not run (it is not installed). The pre-13586033 mechanism is established by reading `Collection.syncAttempts` in `packages/db-core/src/collection/collection.ts`: it treats every `!attempt.success` as a failed attempt, retains it, refreshes (which finds the write's own log entry and finishes it, `completeOwnEntry`), and retries, up to ten times. The pended batch replaced that per-tree loop with `TransactionCoordinator.commit`, whose commit phase has no such recovery.

## Root cause: one site

`TransactionCoordinator.commitOnceLatched` (`packages/db-core/src/transaction/coordinator.ts`), the `committed.size > 0` branch after a failed `commitPhase`. It always throws `CoordinatorPartialCommitError` at once, and `commitAttempts` retries only a `CoordinatorStaleLossError`. So a commit-phase refusal that could clear (a lagging member that has not yet reconciled, the durability gate's `commit-not-durable`) is treated as final the moment any sibling has already committed. The commit fan-out is parallel, so a sibling nearly always has.

`commitCollection` already labels every returned commit failure as `stale: true`, and `commitPhase` sets `staleLoss` when every failure was returned rather than thrown. That is the signal the partial branch needs and ignores.

A second, diagnostic site: `NetworkTransactor.staleFromBatches` rebuilds the merged commit failure without the producer's `reason` or its `conflict` flag, so the coordinator's error text says "Stale commit" (a rival's win) for a refusal whose reason was `commit-not-durable`. That wording is what sent the first triage the wrong way. `pend`'s aggregation in the same file carries both fields; the commit one should too.

## The fix, verified

Forward recovery through the retry loop that already exists. When the partial landing's failures were all returned refusals, record the committed siblings in `cycle.saved` and throw `CoordinatorStaleLossError` instead of the partial error. `commitAttempts` then does what it does for a clean stale loss: backs off, refreshes every collection, and re-attempts. The refresh finds the failed collection's own log entry where the tail landed (the members that applied it hold it) and re-sends the retained attempt at the same revision (`Collection.completeOwnEntry`), or the next attempt re-pends at a fresh revision when nothing of it landed. The next attempt commits only what is still staged (`stagedCollections`), so the committed siblings are never re-logged. Every way the retry can still fail is reported through `reportSaved` as the `CoordinatorPartialCommitError` it is, with the saved siblings named as committed. The stamp stays open for the retry; `reportSaved` or the success path releases it.

This was prototyped and run. The diff, verbatim:

```diff
--- a/packages/db-core/src/transaction/coordinator.ts
+++ b/packages/db-core/src/transaction/coordinator.ts
@@ commitOnce
-			await this.commitOnceLatched(transaction, collectionData);
+			await this.commitOnceLatched(transaction, collectionData, cycle);
@@ commitOnceLatched signature
 	private async commitOnceLatched(
 		transaction: Transaction,
-		collectionData: { collectionId: CollectionId; collection: Collection<any> }[]
+		collectionData: { collectionId: CollectionId; collection: Collection<any> }[],
+		cycle: CommitCycle
 	): Promise<void> {
@@ the partial-commit branch, after the split local handling (fold committed / restore failed)
-				// The transaction half-landed, so it is neither cleanly retryable nor
-				// cleanly abortable: drop its stamp tracking (the success path does the
-				// same at the end) and surface the structured signal for reconciliation.
+				if (coordResult.staleLoss) {
+					// Every failure was a RETURNED refusal: a lagging member behind on the block's base
+					// (`commit-not-durable`), or a rival that took the revision slot. Siblings have landed
+					// and cannot be rolled back, so FORWARD recovery — finishing this collection — is the
+					// only way back to all-or-nothing, and the retry loop already does it: the refresh
+					// between attempts finds this transaction's own log entry and re-sends the retained
+					// attempt at the same revision (Collection.completeOwnEntry), or re-pends afresh. The
+					// committed siblings are recorded as saved so every remaining failure is reported as
+					// the partial landing it is (reportSaved); the next attempt commits only what is
+					// still staged. The stamp stays open; reportSaved or the success path releases it.
+					for (const collectionId of committed) cycle.saved.add(collectionId);
+					throw new CoordinatorStaleLossError([...(coordResult.failedCollections ?? new Set<CollectionId>())], coordResult.error);
+				}
+				// Half-landed on a HARD failure (transport budget exhausted, structural rejection):
+				// neither cleanly retryable nor cleanly abortable — drop the stamp and report it.
 				this.stampData.delete(transaction.stamp.id);
 				throw new CoordinatorPartialCommitError(
--- a/packages/db-core/src/transactor/network-transactor.ts
+++ b/packages/db-core/src/transactor/network-transactor.ts
@@ staleFromBatches
-		const staleAt = highestStaleAt(stale.map(b => (b.request!.response! as StaleFailure).staleAt));
+		const responses = stale.map(b => b.request!.response! as StaleFailure);
+		const staleAt = highestStaleAt(responses.map(r => r.staleAt));
+		const reason = responses.map(r => r.reason).find(r => r !== undefined);
 		return {
-			missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing).filter((x): x is ActionTransforms => x !== undefined)),
+			missing: distinctBlockActionTransforms(responses.flatMap(r => r.missing).filter((x): x is ActionTransforms => x !== undefined)),
 			...(staleAt === undefined ? {} : { staleAt }),
+			...(reason === undefined ? {} : { reason }),
+			conflict: responses.some(isConflictFailure),
 			success: false as const
 		};
```

Results with the prototype built into `dist/`:

| Run | Result |
|---|---|
| the reproducer, 3 runs | 3 passing; the trace shows the re-send at revision 2 of the retained attempt and both nodes applying it |
| `quereus-plugin-optimystic` `yarn test` | 997 passing, 0 failing |
| `db-p2p` `yarn test` | 3023 passing, 0 failing |
| `db-core` `yarn test` | 1794 passing, 9 failing, every one pinning the old contract (listed below) |

The prototype was then reverted and `dist/` rebuilt at HEAD, so this ticket's tree contains only the reproducer. The sereus session asked to be told before `dist/` is rebuilt: it was rebuilt twice during this fix stage (once with the prototype, once back to HEAD), and the implement stage will rebuild it again.

## Decisions taken, and why

**Forward recovery over the two alternatives sereus listed.** Catching up before pending cannot be done from the writer's side: the member accepts the pend without holding the base (the NOTE in `StorageRepo.pend` defers the refusal to the durability gate on purpose), and the gate can refuse even a caught-up replica when its reconcile races the other member's apply (the backlog ticket above). Holding every sibling's commit until every participant can commit is a cross-collection prepare that does not exist (`backlog/feat-cross-collection-atomic-commit`); commits are per-collection consensus. Forward recovery reuses the loop, the retained attempt, and `completeOwnEntry`, all of which are already tested on the clean-stale-loss path, and it also covers the other member of this class: a commit refused because a rival's cancel raced it (`cancelling-a-refused-write-blocks-another-writers-commit` found that shape) is a returned refusal too and half-lands the same way today.

**Do not gate the retry on `isConflictFailure` yet.** Today's rule is "returned failure ⇒ stale ⇒ retryable"; a returned refusal is by construction one the identical request cannot win, and the retry is a different request (refreshed, or re-sent at the entry's own revision). Gating on `isConflictFailure` would turn a solo node's `missing-base-revision` (a bare `reason`, no `conflict`, no `missing`) into a hard failure and change behaviour on a path this ticket has no evidence about. Carry `reason` and `conflict` through `staleFromBatches` now, so the wording is honest and a later change can gate on the machine-readable flag with `isCommitNotDurableFailure` (`packages/db-p2p/src/storage/storage-repo.ts`) as the model.

**The durability gate and the missing-base check are untouched.** Both were right: the write was not durable on a majority when it was refused.

**The retry is bounded by the same budget as a clean stale loss** (`maxAttempts`, `deadlineMs`, the backoff in `utility/backoff.ts`). A partial landing that never clears costs the budget (about 21 s at defaults) before it is reported, where today it is reported at once. That is the price of landing the write; the caller that wants the old fail-fast passes a small `maxAttempts`.

## Session mode

Session-mode transactions (`TransactionSession.commit`) share this commit phase and so share the defect and the fix. The reproducer covers the legacy batch; cover session mode with a db-core test on the existing doubles (see the tests below) rather than a second mesh spec.

## Tests that pin the old contract

All nine failed against the prototype. Each must be re-pointed at the new contract, not skipped or loosened:

- `transaction.spec.ts` "a PARTIAL landing throws CoordinatorPartialCommitError and is NOT auto-retried" (`PartialLossTransactor`, which refuses the poison collection forever and counts commit calls). Becomes two tests: (a) a poison that refuses N times then accepts lands the whole transaction and `commit()` resolves, with the loser committed at the re-sent revision and the winner logged exactly once; (b) a poison that refuses forever is reported as `CoordinatorPartialCommitError` once the budget ends, run with `maxAttempts` small and `baseBackoffMs`/`maxBackoffMs` tiny so it does not time out at mocha's 5 s. The `commitCalls` assertion changes from "not re-driven" to "re-driven once per attempt for the loser only".
- `transaction.spec.ts` "durably commits one collection, permanently fails another, and reports the partition honestly" and "re-driving commit() after a partial landing re-attempts only the failed collection (no double-apply on the winner)" (session mode). The partition is still reported honestly and `stampData` is still cleared, but only once the budget ends; pass a small `maxAttempts`. The re-drive test's premise (the caller re-drives) now also holds for the coordinator's own retry: assert the winner is logged once across the automatic retries. Use one of these as the session-mode arm above.
- `transaction.spec.ts` "should cancel pended collections when commit fails for one collection", "should handle transactor becoming unavailable during cancel phase gracefully", "should do forward recovery and targeted cancel on partial commit failure" (TEST-2.2.2, TEST-10.2.1). Same shape: pass a small budget, then assert the cancel of the failed collection's pended blocks happened on each attempt and the committed one was never cancelled.
- `coordinator-rollback-pending.spec.ts` "stays a no-op after a partial landing dropped the stamp, leaving the winner durable" and `coordinator-single-stamp.spec.ts` "a partial commit drops the stamp, so a new stamp is accepted": the stamp is dropped by `reportSaved` when the budget ends, not on the first refusal; pass a small budget.
- `network-transactor.spec.ts` "carries staleAt through a rebuilt commit failure even though the reason is dropped": the reason is now carried; assert `reason` equals the producer's and `conflict` is carried, and rename the test.

## Wording to update

- `commitCollection`'s comment block in `coordinator.ts` ("A returned { success:false } is a permanent stale loss … the identical request can never win, so return immediately without retrying"): the identical request still is not retried there, but the coordinator-level retry now covers the partial case; say so.
- `CommitCycle.saved`'s comment ("Participants an attempt itself commits are not recorded here"): no longer true.
- `CoordinatorStaleLossError`'s message says "no collection durably committed". It is only ever caught by `commitAttempts` and escapes wrapped by `reportSaved`, so the message is never wrong for a caller, but a distinct internal signal, or a message that does not assert emptiness, would be cleaner.
- `docs/transactions.md` § "Session-mode commit is not atomic across collections either" and § "The residual is the commit phase": the residual is now a commit-phase refusal that does not clear within the budget, reported as partial after the retries; a refusal that clears lands the whole transaction.
- `docs/internals.md`, the sentence starting "db-core's `commitPhase` treats any returned `success:false` as a permanent stale failure", and its twin in the comment above the local-fallback arm of `CoordinatorRepo.commit` in `packages/db-p2p/src/repo/coordinator-repo.ts`.
- `commitBatchLegacy`'s doc comment in `txn-bridge.ts` ("A commit-phase split … one lost permanently after every pend succeeded"), and its NOTE, which assumes a behind tree costs "one refused attempt" at pend: it can also cost a refused commit and a retry round.
- `docs/debugging.md` if it describes what follows a `commit-not-durable` line; it should now say the coordinator retries.

## TODO

- Apply the coordinator change: thread `cycle` into `commitOnceLatched`; in the partial branch, when `coordResult.staleLoss`, add the committed set to `cycle.saved` and throw `CoordinatorStaleLossError`; keep the hard-failure path as it is.
- Carry `reason` and `conflict` through `staleFromBatches` in `network-transactor.ts`, mirroring `pend`'s aggregation.
- Make the reproducer pass and keep it; run it several times.
- Re-point the nine tests listed above; add the "refuses N times then accepts, lands whole" arms for `coordinator.commit` and for `session.commit`, and the "refuses forever, reported partial after the budget" arm with a small budget.
- Update the comments and docs listed under "Wording to update"; run `yarn lint:docs`.
- Run `yarn build`, then `yarn test` for db-core, db-p2p and quereus-plugin-optimystic, then `yarn check` (the release gate).
- In the review handoff, say that `dist/` was rebuilt so the sereus session can re-run its gate.
