description: A cohort member that refuses a transaction because, by its own clock, the transaction has already expired now casts a signed "expired" reject vote instead of throwing, so the coordinator reports a named clock disagreement, penalizes nobody, and no longer reports the refusal as an unreachable cohort.
architecture: docs/correctness.md#74-clock-assumptions
files:
  - packages/db-core/src/cluster/structs.ts (`Signature` reject variant gains `expiredAt`; `ClusterVote`; `clusterVoteSigningPayload(hash, vote)`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`expiryOf`, `expiredVerdict`, `voteFor`, `refusalLogTag`, `provenAbandoned`; `evaluatePromise`, `getTransactionPhase`, `processUpdate`, `handleExpiration`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`expiryRejectionClocks`; rejected-by-validators branch; dispute `NOTE:`)
  - packages/db-p2p/src/pend-validation.ts (`TRANSACTION_EXPIRED`)
  - packages/db-core/test/cluster-vote-payload.spec.ts, packages/db-p2p/test/cluster-expired-vote.spec.ts, packages/db-p2p/test/cluster-repo.spec.ts
  - docs/correctness.md (§7.4), docs/debugging.md, docs/internals.md
----

GitHub issue #24. A member whose clock was more than the transaction timeout (30 s by default) ahead of the writer's used to throw `Transaction expired` out of `validateRecord`. The coordinator read the throw as no vote, charged the member `ConsensusTimeout`, and failed with the "Failed to get super-majority" text that a downstream repository retries as a silent cohort.

# What landed

Landed in `ticket(implement): a-writer-refused-for-clock-skew-is-reported-as-silence`. The follow-on `ticket(implement): a-writer-is-told-its-transaction-expired-by-name` later reshaped the coordinator half: `TransactionExpiredError` became db-core's class, deliberately not a `ValidatorRejectionError`, and is returned to the writer as an `ExpiredFailure`.

- **Member.** Expiry is now a promise verdict. When a member has not yet voted on a record and `expiration <= Date.now()`, it signs a `reject` carrying `expiredAt` (its own clock reading) plus a prose reason. `getTransactionPhase` routes an expired record this member has not voted on to `OurPromiseNeeded` ahead of `findConflict`, so an expired record cannot clear a live rival's reservation. `handleExpiration` signs the same vote. A member that has already voted still throws.
- **Signing payload.** `clusterVoteSigningPayload` takes the unsigned vote object. Every vote without `expiredAt` produces exactly the bytes it did before. An expiry vote encodes as `<hash>:reject-expired:<json [expiredAt, reason|null]>`.
- **Coordinator.** An expiry vote counts as an ordinary rejection. When every reject is an expiry vote, the coordinator raises the expiry error, logs `expiredAt` and `expiration`, broadcasts the abandonment, and penalizes nobody.

# Review findings

Checked: the implement diff with fresh eyes, then the current state of every touched file after the follow-on reshaped the coordinator half. Covered the payload encoding's ambiguity, the phase routing order, the already-voted throw, the timer path, the coordinator's trust in `expiredAt`, the dispute interaction, the tests, and the docs.

**Fixed inline (minor):**
- **An expired record that was already dead still threw.** A member that had voted, whose clock had since passed the expiration, threw on every later delivery. That included the coordinator's abandonment broadcast, where its job is only to compute `Rejected` and drop the record. This was the handoff's "abandonment broadcast after expiry rejects" gap. In a cohort of four or more, the member kept the reservation until a sweep removed it. In the two-member repro, every expiring member logged a spurious error on the broadcast. `processUpdate` now lets the delivery through when its signed votes already prove the record `Rejected` or `ConflictSuperseded` (new `provenAbandoned`). The phase loop then only clears the record and adds no vote, so equivocation cannot arise. `getTransactionPhase` has no side effects for a record this member has already voted on, because `findConflict` runs only on the unvoted branch. Regression test: "clears an expired record it voted on when the delivery proves it rejected" in `packages/db-p2p/test/cluster-repo.spec.ts`. Without the fix it would hit the throw. docs/correctness.md §7.4 and the docs/internals.md Consensus Execution bullet now name this exception.

**Checked, no change needed:**
- **Payload ambiguity.** The `reject-expired` tag can never be mistaken for any other vote's tag, because a base64url hash ends at the first `:`. The JSON array cannot be read as a different pair of values. `NaN` and `null` serialize alike, but no honest signer produces `NaN`, and JSON cannot carry it on the wire. `cluster-vote-payload.spec.ts` pins byte-identity for field-less votes and the non-collision cases.
- **Timer path.** `handleExpiration` re-checks against the wall clock, and a timer that fires early does nothing. As the existing comment in `findConflict` says, every record in `activeTransactions` already carries this member's vote, so that branch is effectively unreachable today. That matches its behaviour before this change.
- **Coordinator trust.** `expiryRejectionClocks` requires a finite number. `expiredAt` gets the same trust as `conflictWith` and `heldBy`, because the coordinator does not verify votes.
- **Tests.** The two new specs are each at the lowest layer that shows their behaviour. The cluster-repo expiry cases replace three tests that asserted the old throw, one of which passed by accident. I cut nothing.
- **Docs.** correctness.md §7.4, the debugging.md `cluster-tx:rejected-by-validators` entry, and the internals.md bullet all match the code after the follow-on.

**Tripwires (already parked at their sites by the implementer, confirmed present):**
- **Minority expiry voter, commit round.** In a cohort of four or more, a member whose expiry vote was in the minority is sent the commit round. It has already voted, so it throws, and the coordinator charges it a commit-round `ConsensusTimeout`. Parked as the `NOTE:` in `processUpdate`.
- **Dispute evidence.** A minority expiry vote lands in `disputeEvidence`. Parked as the `NOTE:` at the `disputed` site in `cluster-coordinator.ts`, to be filtered if dispute origination is ever enabled.
- **Clock injection.** `expiryOf` reads the real `Date.now()`, not the injectable `now()`, as the old check did. The `<=` boundary is therefore unpinned by any test.

**Considered, not filed:**
- **Mixed versions.** An older-build member verifying a newer member's expiry vote fails the signature and reports `InvalidSignature`. This is covered by the single-deployable-unit rule stated at `validateRecord` and by the project's "no backwards compatibility yet" rule. Commit-proof verification is unaffected, because it checks only `approve` votes.
- **Public API change** to `clusterVoteSigningPayload`. All in-repo callers are updated, and the project's "no backwards compatibility yet" rule covers out-of-repo callers.

**Validation:** db-p2p `yarn build`, `tsc --noEmit`, eslint on touched files, and `yarn test` in db-p2p (3222 passing, 68 pending) all pass, as does `yarn lint:docs`. I did not re-run db-core, because nothing there changed in this pass. Integration suites were not run.
