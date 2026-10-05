description: When a cohort member refuses a transaction because, by its own clock, the transaction has already expired, it should cast a signed "reject" vote saying so instead of throwing; today the throw makes the coordinator treat the honest member as unresponsive, penalize it, and report "0 rejections".
architecture: docs/correctness.md#74-clock-assumptions
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validateRecord` throws `Transaction expired`; `processUpdate`; `getTransactionPhase`; `handlePromiseNeeded` / `evaluatePromise` / `signPromiseVerdict`; `handleExpiration` signs a reject with the prose reason 'Transaction expired')
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises` turns a member's throw into `null` + `PenaltyReason.ConsensusTimeout`; `executeTransaction`'s rejected-by-validators / supermajority-failed branches; `ValidatorRejectionError`)
  - packages/db-core/src/cluster/structs.ts (`Signature`, `clusterVoteSigningPayload`, `clusterVoteVerificationPayload`)
  - packages/db-p2p/src/pend-validation.ts (home of the existing reason constants `PEND_NOT_VALIDATABLE`, `VALIDATOR_FAULT`)
  - packages/db-p2p/test/cluster-repo.spec.ts ("update - expiration" and "transaction expiration (TEST-5.1.2)" pin the current throw and must change)
  - packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts (mock-member harness for the coordinator test)
  - docs/correctness.md (§7.4 Clock Assumptions), docs/debugging.md, docs/internals.md (Key Invariants → Consensus Execution)
difficulty: medium
repro: verified
----

GitHub issue #24: https://github.com/gotchoices/Optimystic/issues/24. This does not drop the "clocks roughly synchronized" assumption (docs/correctness.md §7.4); it fixes what happens when a node breaks it.

# What happens today (reproduced)

A writer sets a transaction's expiration from its own clock (`NetworkTransactor`: `Date.now() + timeoutMs`, 30 s by default), and that becomes the cluster record's `message.expiration`. A cohort member whose clock is more than 30 s ahead of the writer's sees the record as already expired the moment it arrives, and `ClusterMember.validateRecord` (in `packages/db-p2p/src/cluster/cluster-repo.ts`) throws `Error('Transaction expired')`. `ClusterService` turns the throw into a structured error envelope, `ClusterClient.update` rethrows it on the coordinator, and `ClusterCoordinator.collectPromises` treats every throw alike: the result becomes `null` (no vote), and the member is charged `PenaltyReason.ConsensusTimeout`. `executeTransaction` then finds approvals short with zero rejections and lands in the `supermajority-failed` branch, whose message is the one a downstream repository matches to retry a *silent* cohort.

Reproduced with a two-member cohort (coordinator's own member approves; the remote member throws `Transaction expired` through the real `toClusterErrorEnvelope` → `clusterErrorFromEnvelope` round trip, `promiseImmediateRetries: 0`):

```
ERROR: Error Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)
PENALTIES: [["12D3KooW…","consensus-timeout"]]
```

So: the decided refusal is reported as silence, a downstream retry treats it as transient, and the honest peer is penalized once per attempt (eight per write in the issue).

The scratch spec used for this was deleted; the harness shape is the one in `cluster-coordinator-supermajority.spec.ts` (mock `ICluster` members, a `localCluster` approving in process, a `reputation` spy passed as the coordinator's 6th constructor argument).

# The fix

## Member: an expired record gets a signed reject vote, not a throw

Remove the expiration check from `validateRecord` (keep the membership, hash and signature checks there — those are real faults in the record). Expiry becomes a promise *verdict*: when the member still owes its promise vote (`getTransactionPhase` would return `OurPromiseNeeded`, i.e. `record.promises[ourId]` is absent) and `record.message.expiration <= Date.now()`, the member signs a `reject` vote for it. Natural home: the start of `evaluatePromise`, ahead of the membership gate and pend validation, so the existing `signPromiseVerdict` mapping produces the vote and the phase loop continues as for any other reject (the record becomes `Rejected` where one reject is terminal, e.g. a two-member cohort).

The vote must say *structurally* that it is an expiry, because the coordinator has to classify it without reading prose (the rule stated on `ValidatorRejectionError`: reject reasons are free-form signed text and "their wording must never become control flow"). Add an optional field to the `reject` variant of `Signature` in `packages/db-core/src/cluster/structs.ts` — recommended name `expiredAt: number`, the member's wall-clock reading (unix ms) when it judged the record expired — and fold it into the signed payload when present, through `clusterVoteSigningPayload` / `clusterVoteVerificationPayload`, so it cannot be altered in transit. Requirements on the encoding:

- A reject vote without the field must sign and verify byte-identically to today (old records, other reject reasons).
- It must be unambiguous: a reject with reason `"x:5"` and no `expiredAt` must not verify as reason `"x"` with `expiredAt: 5`. A delimiter that can occur in the reason is not enough on its own.

Give the reason prose a constant beside `PEND_NOT_VALIDATABLE` / `VALIDATOR_FAULT` in `packages/db-p2p/src/pend-validation.ts` (e.g. `TRANSACTION_EXPIRED = 'transaction-expired'`, rendered `transaction-expired: expiration <iso>, member clock <iso>` for humans), used here and by `handleExpiration`, which today signs the prose `'Transaction expired'` — it should sign the same structured vote, so a timer-driven expiry and an arrival-time expiry look the same to the coordinator.

Scope of the vote: only while the member has not yet voted. A member that already promised and then sees the record expire (its clock passed the expiration during the commit round) must not flip its vote — that is equivocation (`detectEquivocation`). For that case keep today's behavior (the expiry stays a thrown refusal for that delivery) and leave a `NOTE:` at the site saying so, and that it is the slow-transaction case rather than the skew case. Do not widen into it.

## Coordinator: count it as a rejection, name it, penalize nobody

With the vote in place the coordinator's counting already treats it as a rejection (`rejectionCount`), so the `supermajority-failed` branch and the `ConsensusTimeout` charge no longer fire for this case, and the two-member repro ends in the `rejected-by-validators` branch (which also broadcasts the abandonment, freeing members' reservations — correct, the record carries signed proof it is dead).

Name it: when the rejections that made super-majority unreachable are all expiry votes (every `reject` in `promises` carries `expiredAt`), throw a `TransactionExpiredError` that **extends `ValidatorRejectionError`** (so `CoordinatorRepo.classifyStaleRejection` and the commit-side sibling keep treating it exactly as a validator rejection — it is never a confirmed revision loss, so it stays a throw there). It carries:

- `expiration` — the record's `message.expiration`;
- `memberClocks` — per refusing peer, its signed `expiredAt`;
- `coordinatorClock` — this node's `Date.now()` when it raised the error;
- `apparentSkewMs` — the largest `expiredAt − coordinatorClock`, stated in the doc comment as an estimate inflated by round-trip latency. Note the lower bound `expiration − coordinatorClock` also holds and needs no member input; mention it in the message (“member clocks are at least N s ahead of this node's”).

The message must not contain "Failed to get super-majority" (that text is matched downstream to retry silence — see `tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md`); it should name the expiration, the skew estimate, and say plainly that the fix is the clock of whichever side is wrong (the coordinator cannot tell which).

A mix of expiry and non-expiry rejections stays a plain `ValidatorRejectionError`. A minority expiry reject under a super-majority approval stays the existing `disputed` marking; the dispute subsystem is dormant (`[dispute-subsystem-dormant]` in `packages/db-p2p/src/libp2p-node-base.ts`), so leave a `NOTE:` tripwire at the `disputed` site in `executeTransaction`: an expiry reject is a clock disagreement, not a validity judgement, and must not be offered as dispute evidence if the subsystem is ever wired.

## What this ticket deliberately leaves to the next one

How the typed error reaches the *writer*: today `CoordinatorRepo.pend` throws it, a remote coordinator's `RepoService` aborts the stream (the writer sees "The stream has been reset"), `NetworkTransactor.pend` re-picks another coordinator, and `Collection.sync` retries any non-success up to its budget. That is ticket `a-writer-is-told-its-transaction-expired-by-name` (prereq on this one). This ticket stops the misclassification and the penalty at the cluster layer, which is where both originate.

# Tests

One coordinator-level reproduction spec (new file, e.g. `packages/db-p2p/test/cluster-expired-vote.spec.ts`, using the mock-member harness): a two-member cohort whose remote member answers with an expiry `reject` vote. Assert the error is a `TransactionExpiredError` (and `instanceof ValidatorRejectionError`), its message does not contain "super-majority", it reports the member clock, and the reputation spy received no `ConsensusTimeout`.

One member-level test replacing the two existing "rejects expired transactions" cases in `packages/db-p2p/test/cluster-repo.spec.ts` (they assert a throw; there are three expiry cases in two `describe` blocks — fold them into the new behavior rather than duplicating): an expired fresh record returns a record carrying this member's signed `reject` vote with `expiredAt`, and that vote verifies; the "exactly now" and "future expiration" cases keep their meaning. If the signing payload gains an encoding branch, one assertion that a reject without `expiredAt` signs byte-identically to the old payload, and that the ambiguous pair above does not cross-verify.

# Docs

- `docs/correctness.md` §7.4: say what a node outside the bound sees — every write it coordinates or joins is refused by signed expiry votes and reported as `TransactionExpiredError`, not as an unreachable cohort, and nobody is penalized for it.
- `docs/debugging.md`: how to recognize it (`cluster-tx:rejected-by-validators` with expiry votes / the new error), and that the remedy is the clock.
- `docs/internals.md` → Key Invariants → Consensus Execution: one bullet that expiry is a promise verdict (signed reject with `expiredAt`), not a record-validation throw, and why (a throw is indistinguishable from silence at the coordinator).

# TODO

- Add the optional signed `expiredAt` to the `reject` variant of `Signature`; extend `clusterVoteSigningPayload` / `clusterVoteVerificationPayload` with an unambiguous encoding that leaves field-less rejects byte-identical.
- Add the `TRANSACTION_EXPIRED` reason constant beside the existing ones and re-export it where those are re-exported.
- Move the expiry check out of `ClusterMember.validateRecord` into the promise verdict (`evaluatePromise`), producing the structured reject; keep the already-voted case as it is, with a `NOTE:`.
- Make `handleExpiration` sign the same structured vote.
- Add `TransactionExpiredError extends ValidatorRejectionError` in `cluster-coordinator.ts`; raise it from `executeTransaction`'s rejected-by-validators branch when every reject is an expiry vote; add the dispute tripwire `NOTE:`.
- Replace the member expiry tests in `cluster-repo.spec.ts`; add the coordinator repro spec.
- Update `docs/correctness.md` §7.4, `docs/debugging.md`, `docs/internals.md`; run `yarn lint:docs`.
- Run `yarn workspace @optimystic/db-core build`, then db-p2p's build and `yarn test` in db-core and db-p2p (the build-freshness guard refuses a stale db-core build).
