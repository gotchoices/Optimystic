description: Let one consensus vote carry the reservations, or the commits, of several collections written by the same transaction, so a later change can send a table and its indexes to the other machines in one request instead of one per collection. This ticket makes the machines that vote and store handle such a combined vote correctly; nothing sends one yet.
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/db-core/src/network/repo-protocol.ts (`RepoMessage`), packages/db-p2p/src/cluster/record-operations.ts (`getActionId`, new `batchShapeFault`), packages/db-p2p/src/cluster/cluster-repo.ts (`validateRecord`, `handleConsensus`, `applyConsensusOperation`, `retainCommitVerdict`, `reconcileRefusedCommit`, `getExecutedPendResult`, `getExecutedCommitResult`, `withOwnApplyOutcome`, `captureCommitCert`), packages/db-p2p/src/cluster/client.ts (`recordCoordinatorForRecordIfSupported`), packages/db-p2p/src/repo/late-pend-refusals.ts, packages/db-p2p/src/repo/cluster-coordinator.ts (`soleReservationsOnly`, `mayDeferPendDelivery` doc), packages/db-p2p/src/cluster/commit-proof.ts (`findClaimedCommitOp`, read-only check), packages/db-p2p/src/dispute (read-only check of `message.operations` use)
----
# A consensus record carries several collections of one action

First of three tickets for GitHub [#42](https://github.com/gotchoices/Optimystic/issues/42): a transaction that writes several collections (a table plus its index and UNIQUE trees, or several tables) costs the other member of a two-member group about four cluster requests per collection — 24 for a one-row insert into a table with five indexes — because the transaction coordinator runs one pend and one commit consensus round per collection. The fix, settled in planning and carried out across `a-coordinator-runs-an-actions-collections-as-one-record` and `a-transaction-pends-and-commits-its-collections-together`, is to put every collection's pend into ONE consensus record (and every collection's commit into one), so the cost is three requests per transaction, exactly what a one-collection write costs today.

This ticket is the cohort-member side: what a member does when a record's message carries more than one operation. The member code already loops over `record.message.operations` for validation and apply, but several places keep a single value per record and the last operation silently overwrites the earlier ones.

## The shape: a batch

`RepoMessage.operations` (`packages/db-core/src/network/repo-protocol.ts`) is typed today as a one-element tuple, and comments call the loops over it "a formality". Widen it to a non-empty list — name the element union `RepoOperation` and type the field `[RepoOperation, ...RepoOperation[]]` — and document the one rule a message of more than one operation must meet, called a **batch**:

- every operation is a `pend`, or every operation is a `commit` (no `get`, `cancel` or `invalidate`, no mixing);
- every operation names the same action id;
- no block id appears in two operations (collections never share blocks; a duplicate would pend or commit one block twice under one action at two revisions).

A one-operation message is trivially a batch. The rule is written once, as `batchShapeFault(operations): string | undefined` in `packages/db-p2p/src/cluster/record-operations.ts` (the reason prose, or `undefined` when the shape is fine). `ClusterMember.validateRecord` refuses a record that fails it, in the same way it refuses its other record faults (membership digest, hash, signatures) — it is a fault of the record, not a promise verdict. The next ticket calls the same function at the repo protocol's ingress. Update `getActionId`'s doc: a batch names one action, so the first operation's id is the message's.

Each operation keeps its own `PendRequest` / `CommitRequest` exactly as today — its own revision, its own log tail, its own `baseRevs`, `blockDigests` and `soleReservation`. Nothing in `StorageRepo` changes: the member applies the operations one at a time, as it already does.

## What the member keeps per record, and how it folds

`ClusterMember` keeps one retained verdict per `messageHash` for pends (`executedPendResults`) and one for commits (`executedCommitResults`), read by `getExecutedPendResult` / `getExecutedCommitResult` (the coordinating node's own member) and by `withOwnApplyOutcome` (every other member's report on `ClusterRecord.applyOutcomes`). With several operations the apply loop overwrites these, so a refusal of the first collection's pend is replaced by the second's success, and the coordinator answers a refused pend as accepted. Keep the per-operation results during the apply and retain one folded verdict per record:

- **Pend fold.** Success only when every operation's storage pend succeeded; the success's `blockIds` is the union and its `pending` the concatenation. Otherwise the folded verdict is the first conflict-shaped refusal (`isConflictFailure`) if there is one, else the first refusal. Conflict first because it is the verdict that changes the writer's answer: `CoordinatorRepo.pendThroughCluster` returns a local conflict and tolerates a local bare-reason fault, so a fold that let a fault hide a conflict would answer success over a refusal. An expiry can only arrive as a whole-record vote, never per operation, so the fold needs no expiry arm.
- **Per-block pend refusals** (`retainPendRefusal` / `retirePendRefusal`, keyed by action and block) already work per operation and need no change; check that the rollback branch in `handleConsensus` still retires every operation's refusals.
- **Commit fold.** Each commit operation gets its own post-reconcile durable verdict (`durableCommitVerdict`), as today. The record's retained verdict is a success only when every operation's is; otherwise the first refusal. The record counts as behind (`behindCommitRefusals`) when any refused operation was behind-shaped. `reportBlockHolders` runs per operation whose own verdict succeeded.
- **`reconcileRefusedCommit`** today finds the first commit operation only. Make it reconcile every commit operation whose own verdict is a behind-shaped refusal, recompute those verdicts, and re-retain the fold — with the existing guard that it never resurrects a retention pruned or rolled back while it ran.
- **Commit certificate.** All operations share one action id and one record, so `captureCommitCert` runs once per record, before the first operation's storage commit, with the commit-vote preimage computed once. The ordering comment in `applyConsensusOperation` (capture before `StorageRepo.commit` emits its change event) must still hold for the first operation, and therefore for all.
- **Commit proof.** `buildBlockCommitProof(record)` is a projection of the record and is the same for every operation, so build it once per record and pass it to each operation's storage commit. `findClaimedCommitOp` in `packages/db-p2p/src/cluster/commit-proof.ts` already searches every commit operation for the claimed block, so verification needs no change; confirm it.

Hold the per-operation results in whatever shape is simplest (a small array keyed by `messageHash`, or locals inside the loop folded at its end); the requirement is that every reader of the retained verdicts — `getExecutedPendResult`, `getExecutedCommitResult`, `withOwnApplyOutcome`, `reconcileRefusedCommit`, the prune and rollback paths — sees the fold.

## Other single-operation readers to check

- `ClusterClient.recordCoordinatorForRecordIfSupported` (`packages/db-p2p/src/cluster/client.ts`) reads `operations[0]` to record a coordinator hint. For a batch, record the hint for the first block of every operation, since the follow-up commit asks for each collection's blocks.
- `LatePendRefusals.retain` (`packages/db-p2p/src/repo/late-pend-refusals.ts`) must keep a refusal under every block the record's pend operations name, so `take(actionId, blockIds)` for any collection of the action finds it.
- `soleReservationsOnly` in `packages/db-p2p/src/repo/cluster-coordinator.ts` already requires every operation to be a marked pend. Rewrite the first bullet of `mayDeferPendDelivery`'s doc for the batch case: a record whose every pend is marked carries every reservation of the action, and its commit is one record sent to this node, so a member that refuses any operation's pend late refuses that one commit record before anything of the action is durable (the reason is in *Why the deferral is safe for a batch* below). Do not loosen the code.
- The dispute service and `race-resolution.ts` read `record.message.operations`; check each loop is correct for several operations of one kind (`operationsConflict` over the union of blocks is correct as is).

## Why the deferral is safe for a batch

This answers the parent ticket's open question: how is a late refusal of one collection's pend reported when the collections travel together. On a two-member group the coordinating node holds back the pend record's decision and sends it ahead of the commit's first request (`deferPendDelivery`). With every collection in one pend record and one commit record, the other member applies the whole pend record before it votes on the commit record. If its storage refuses any operation, that refusal is retained per block, and `validateCommitAgainstRefusedPend` — which loops over every commit operation — refuses to co-sign the whole commit record, because that record contains the refused collection's blocks. So no collection of the action commits, and `CoordinatorRepo.commit` answers with the late refusal (`takeLatePendRefusals`) as the retryable conflict the pend would have returned. The reason a multi-collection pend may not be deferred today — one collection's late refusal surfacing after another collection's commit landed — does not arise, because there is no other commit record. The safety therefore depends on the commit going as one record; the third ticket owns that rule on the sending side.

## Edge cases & interactions

- **Mixed or malformed batch** (a commit beside a pend, two action ids, one block in two operations, a `cancel` in a batch): refused by `validateRecord` with the `batchShapeFault` reason. Verified by inspection; one function, two callers.
- **First operation refused, second accepted** (pend): the folded verdict is the refusal, not the later success. Test below.
- **Conflict in one operation, bare fault in another** (pend): the fold returns the conflict. Inspection, against the fold rule.
- **Mid-loop throw** (a genuine storage fault on operation 2 after operation 1 applied): unchanged — `handleConsensus` rolls back the marker and every retained verdict for the record, retires every operation's pend refusals, and rethrows; a redelivery re-applies operation 1 idempotently (`isOwnRevision`). Inspection.
- **Commit: one operation durable, another behind with no holder yet**: folded verdict is the refusal and the record is marked behind; a later `reconcileRefusedCommit` reconciles only the behind operation and flips the fold to success once it lands. Inspection.
- **Redelivery of an already-applied batch** (`handleAlreadyExecuted`): runs `reconcileRefusedCommit` over every behind operation. Inspection.
- **Durable executed marker**: still one per record, written after every operation applied; unchanged.
- **Reactivity**: each operation's `StorageRepo.commit` emits its own collection's change event; the one captured cert, keyed by action id, resolves for each. Inspection.
- **Proof size**: a proof carries the commit message whole, so a batch's proof grows with the number of collections (each operation's block ids and digests). Six collections of a few blocks each are a few kilobytes, well inside the 1 MiB message bound. Leave a `NOTE:` at `buildBlockCommitProof` saying so, and that a proof could be trimmed to the claimed operation if proof storage ever matters.
- **A member on an older build** folds nothing and keeps the last operation's verdict. Mixed builds in one group are out of scope for now (AGENTS.md: no backwards compatibility yet); nothing on this side sends a batch until the third ticket.

## Tests

One new spec in `packages/db-p2p/test/` (a `ClusterMember` over a real `StorageRepo`, following the existing cluster-member specs), two cases:

- A two-operation pend record (two collections of one action) whose apply meets a rival's pending record on the second collection's tail — placed in this member's storage after its promise vote and before it applies, the window a deferred delivery opens (placed before the vote, the member would vote `held` and the record would never reach consensus): `getExecutedPendResult(messageHash)` is a conflict refusal, not a success; and the same action's two-operation commit record is refused at the promise vote with the `refused pend` reason, so neither collection commits on this member. This is the safety property the deferral rests on.
- A two-operation commit record applied cleanly: both collections' blocks hold the action's revisions, and `getExecutedCommitResult(messageHash)` is a success.

No other new tests: the shape check and the hint and late-refusal fixes are covered by inspection and by the SQL request-count spec the third ticket re-pins.

## TODO

- Widen `RepoMessage.operations` to a non-empty `RepoOperation` list and document the batch rule; fix any type fallout.
- Add `batchShapeFault` in `record-operations.ts`; refuse a record that fails it in `ClusterMember.validateRecord`; update `getActionId`'s doc.
- Fold the pend and commit verdicts per record in `ClusterMember` (apply loop, retention, rollback, prune, `withOwnApplyOutcome`).
- Make `reconcileRefusedCommit` cover every behind commit operation.
- Capture the commit certificate and build the proof once per record; add the proof-size `NOTE:`.
- Fix `recordCoordinatorForRecordIfSupported` and check `LatePendRefusals.retain`, dispute and race-resolution loops for several operations.
- Rewrite the `mayDeferPendDelivery` doc bullet for a batch.
- Write the spec above; run `yarn workspace @optimystic/db-p2p test` and `yarn typecheck` from the root (rebuild db-core first — the stale-build guard refuses otherwise).
