description: Two people writing at the same time used to both fail on the first try and start over. Now one of them wins outright and the other succeeds on its second try — on groups of two or three machines; on four or more the old behaviour remains, and that limit is written down.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`prevoteLocalPromise` — new; `collectPromises` — runs it and excludes self from the round)
  - packages/db-p2p/src/cluster/race-resolution.ts (`resolveRace` — unchanged code, new `NOTE:` recording the three-members-and-up residual)
  - packages/db-p2p/test/transaction-node-count-sweep.spec.ts (round-1 assertion at cohort size 2; the explanatory comment corrected)
  - docs/correctness.md (Theorem 9 restated per retry cycle)
  - docs/internals.md (new section "Both consensus rounds carry the coordinator's own member's vote")
  - packages/db-p2p/docs/cluster.md (Phase 1: Promise Collection)
  - tickets/backlog/bug-a-late-promise-invalidates-the-commit-signatures-already-collected.md (update arm appended, no code change)
----
# The coordinator's own member votes before the promise round fans out

## What landed

`ClusterCoordinator.collectPromises` now hands the record to this node's own cluster member, in process, **before** the fan-out, merges that member's promise into the record, and sends that record to the remote members. `prevoteLocalPromise` is the promise-round twin of the commit round's existing `presignLocalCommit`, and the member is then left out of the round it has already voted in.

`resolveRace` is untouched; what changed is the input it gets. Its first comparison is the count of `approve` promise votes, and that comparison gates the aged priority and message hash below it — the comparisons that make every member pick the same winner. A record fanned out with no vote on it lost that count to any rival the member it landed on had already voted on, so a first-round collision was decided by arrival order and the tie-breaks never ran. On a two-member cohort where each writer coordinates through its own node that was a guaranteed double loss.

Three rules hold the change together, each stated at its code site: the pre-vote's outcome is the member's outcome for the round on both paths (a throw counts as the one invocation the promise phase allows the local member); only `promises` is merged, never `commits`; and `undefined` from the pre-vote means there is no local member in this cohort, so the round runs over every peer unchanged.

## Measured behaviour

`packages/db-p2p/test/transaction-node-count-sweep.spec.ts` prints a per-size table whose last column reports how the first round went. After the change:

| machines | round 1 | lost attempts |
| --- | --- | --- |
| 2 | one node wins — which one varies per run, the message hash decides | 1 |
| 3 | one node wins | 1 |
| 4 | both lost | 2 |
| 5 | both lost | 2 |

The spec asserts the size-2 row. Sizes 3 to 5 are reported but not asserted.

## What this does not fix

The pre-vote makes the two racing **coordinators'** members agree. A member that is neither coordinator still votes for whichever record reached it first, and its own approval re-inflates that record to two against the newcomer's one, so from three members up the count comparison can decide again one layer out. Both writers then re-drive and the retry loop's jittered backoff separates them, so it costs a round rather than correctness. Recorded as a `NOTE:` at `resolveRace`, including why it is not simply relaxable. No ticket filed for it: it is a documented limit of the current design, not queued work.

## Review findings

Reviewed the implement diff first, then the handoff. Everything below was checked by reading the code and by running it.

### Verified — the central claim, and the assertion that pins it

The one thing worth an experiment: whether the new size-2 assertion actually fails without the change. It does. With `prevoteLocalPromise` temporarily short-circuited, every size from two to five reports `round 1: both lost` and the assertion fails (`expected +0 to equal 1`), reproducing the handoff's before-table exactly. The change was then restored. So the test pins the behaviour rather than restating it.

### Verified — the three reviewer questions the handoff raised

- **Excluding self on the throw path.** Correct, and the asymmetry with `presignLocalCommit` is right. `updateMember`'s documented contract is that the local member is invoked exactly once in the promise phase; the pre-vote *is* that invocation, so re-including self on the throw path would be a second call. `cluster-coordinator-promise-retry.spec.ts` ("does NOT retry the LOCAL cluster on a throw") still passes for the right reason: the local cluster is called once, from the pre-vote.
- **`roundPeers` indexing.** Correct. `promiseRequests` is built from `roundPeers` and the per-response handlers index `roundPeers[idx]`, so the two cannot drift. `collectPromises` is always called with the same peer map that `makeRecord` stored as `record.peers`, so `peerIds` and `Object.keys(record.peers)` are the same list and the filter cannot remove a peer the pre-vote did not cover.
- **Reputation reporting against self.** Correct that it is pre-existing and not introduced here — but it is a real defect, so it is now filed rather than left as an open question. See below.

### Found and fixed in this pass

- **A doc comment overstated its own premise.** `prevoteLocalPromise` claimed a record carrying one vote is never a super-majority "at any cohort size this class runs on". A cohort of one *can* reach this class — `CoordinatorRepo`'s solo short-circuit runs off a separate cohort lookup, so a cohort that shrinks between the two, admitted by `allowUnvalidatedSmallCluster`, arrives here. The consequence is benign (the member applies during the pre-vote and `presignLocalCommit` re-collects the commit signature on the next round, exactly as the round did before, since the round's own merge loop is also promises-only), but the premise as written was wrong. Rewritten to match its commit-round twin, which already states the escape hatch honestly.
- **A dead computation in the round's request loop.** `isLocal` was recomputed per peer and can now never be true: every local member the round could have held is the one the pre-vote removed. Removed, with the reason stated; the log field is kept as a literal so the payload shape is unchanged, and the pre-vote logs its own request with `isLocal: true, prevote: true`.
- **The corrected spec comment was itself wrong about three members.** The ticket set out to fix a comment that attributed the all-lose round to the wrong mechanism at every size. The replacement grouped three with two ("one writer wins outright"), which contradicts both the new `NOTE:` at `resolveRace` and the handoff's own stated reason for not asserting at three. Three members has a member that is neither coordinator, so it is in the residual; what it does *not* have is four's second mechanism (super-majority reachable without one member). Rewritten as three cases instead of two.
- **Stale vote-kind documentation in a section this change edited.** `packages/db-p2p/docs/cluster.md` Phase 1 said a member answers with "exactly one of three signed vote kinds" and listed a three-variant type; there are four — `held` has existed since the reserved-blocks refusal landed — and the illustrative handler snippet predated `signPromiseVerdict`. Pre-existing drift, but in the paragraph this change inserted into, so corrected rather than left. Added a line naming which kinds are permanent and which are transient, with a link to Theorem 9.

### Checked and found sound — no change needed

- **The promises-only merge.** Cross-checked against the round's own merge loop, which is also promises-only, so the pre-vote introduces no second rule. Confirmed the backlog defect it could have inherited (`bug-a-late-promise-invalidates-the-commit-signatures-already-collected`) cannot reach it: `handlePromiseNeeded` reaches `OurCommitNeeded` only on a super-majority of approvals, which one vote is not at any size this class runs at with more than one peer.
- **Record mutation.** The pre-vote hands the member a copy and merges the member's returned map immutably; `ClusterMember.handlePromiseNeeded` returns new objects and never mutates in place, so the shallow copy is sufficient.
- **Accounting downstream.** `pendCohortDurability` reads `record.promises` and then overrides self from `selfAccepted`, so self's vote arriving one step earlier changes nothing. `executeClusterTransaction` skips self when building `cohortPendRefusals` and `cohortCommitOutcomes`, which is unaffected. The round's `summary` still carries exactly one entry per cohort member, so the per-peer logging, the reputation accounting and the shortfall arithmetic see what they saw before.
- **Ordering.** The pre-vote runs before the transaction is registered in `this.transactions`, but the local member's first await returns control before anything is registered — the same ordering the round already had, since `updateMember`'s local branch entered the member synchronously too.
- **Wire cost.** Unchanged: the local member was never a network call, so a two-member group still costs four `/cluster` calls per single-collection write. The figure in docs/internals.md stands.
- **Test bar.** The implementer added no new test beyond tightening the existing sweep, which is the right call — the reproduction was already in the tree and only lacked an assertion, and a unit test that `prevoteLocalPromise` is called once would test wiring the promise-retry spec already constrains. Nothing here restates the implementation or verifies a mock, so nothing was cut.

### Filed

- **`bug-a-node-penalizes-its-own-peer-id-for-its-own-faults`** (`tickets/backlog/`). `prevoteLocalPromise` reports the local peer to `IPeerReputation` on a throw, faithfully preserving what the round's catch did before it. The handoff flagged it as odd and out of scope; it is worse than odd. `PeerReputationService` has no notion of its own identity, so it cannot refuse such a report, and sixteen local consensus faults inside the thirty-minute decay window put the node's own identifier past the ban threshold — after which `Libp2pKeyPeerNetwork.isSelectable` drops it from coordinator selection, and on a one- or two-machine deployment there is no other candidate. Filed at the root cause (the service, which every caller must currently remember to exclude itself from) rather than as two point fixes at the two coordinator call sites, with the other `isBanned` consumer named. `repro: static` — inferred by reading, not observed; the ticket says what would confirm it. Site-claim grep over the open board found nothing touching `peer-reputation.ts`.

### Noticed, deliberately not filed and not made a tripwire

- **`packages/db-p2p/src/repo/cluster-coordinator.ts` is 1482 lines** (`wc -l`), up 83 from this change. Large enough to be worth splitting one day — cohort lookup, the two rounds, the broadcast, the retry timers and the abandonment path are separable — but this change is 6% of it and not what made it big, and a size ticket is neither a current-release anchor nor a class-level invariant, so it does not meet the filing bar. Recorded here so the next reviewer of this file has the measurement.
- **The pre-vote serializes the local member ahead of the fan-out**, so the promise round's latency is now local plus the slowest remote, rather than the slowest of all. Not recorded as a `NOTE:` because the commit round has paid exactly the same serialization since `presignLocalCommit` landed and carries no such note; adding one only here would read as an asymmetry that is not there. No change was measurable in the sweep — the two-member race phase runs in about 100 ms either way.

### Empty categories

No accepted-tradeoff `NOTE:` was found at any site a finding landed on, so nothing was declined-by-design and left alone. No pre-existing test failure surfaced, so `tickets/.pre-existing-error.md` was not written.

## Validation

All from the repository root, all green:

- `yarn lint`, `yarn lint:docs` (47 documents, 169 anchored citations, all resolve)
- `yarn build`, `yarn typecheck`
- `yarn workspace @optimystic/db-p2p test` — 3109 passing, 63 pending
- `yarn test` — 6m 36s
- `yarn test:integration` — 4m 59s, 1002 passing, 8 pending

`yarn lint:deps` and `yarn check:rn` were not re-run: this pass changed one log payload literal, comments and a markdown file, none of which can move a dependency range or a React Native bundle. The implement stage ran both green on the code as it stands.
