description: A cohort member that refuses a write because someone else got there first now tells the node running that write, instead of keeping the refusal to itself — and a member that refused a write will no longer help finalise it. Both were needed to stop a node from saving a version of a block that nobody else has.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cohort-pend-refusal-channel.spec.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md
difficulty: hard
----

# Review: cohort pend refusal must reach the coordinator

Implements the two-arm design from the implement ticket of the same slug. Both arms landed; no arm was deferred.

## What was built

### Arm 1 — a member's refusal travels back on the response record

- **`ClusterRecord.applyOutcomes`** (new, optional, in `packages/db-core/src/cluster/structs.ts`) — `{ [peerId]: { pend?: PendResult } }`, plus the `MemberApplyOutcome` type. Unsigned advisory data: no hash covers it, deliberately, because a member writes it *after* its votes are cast. Old peers never set it, old coordinators ignore it.
- **Member side** (`cluster-repo.ts`): `withOwnApplyOutcome` stamps the member's own conflict-shaped pend verdict onto the record it answers with, called at the end of `processUpdate` (after the phase loop, so a redelivery answers with the same verdict rather than an empty one). Only conflict-shaped refusals travel; successes and bare-reason faults are omitted. `mergeRecords` unions the field per peer, first-seen wins, and omits it entirely when neither side carries one.
- **Coordinator side** (`cluster-coordinator.ts`): `broadcastMergedRecord` now keeps each peer's response and `collectApplyOutcomes` takes **only** `response.applyOutcomes[thatPeerId]`, re-keyed under the peer actually asked — a peer that echoes a record full of entries contributes exactly one. Outcomes are also collected off the commit-collection round (members that already held super-majority promises reach consensus there). `executeClusterTransaction` re-checks each entry's shape and surfaces the rest as `cohortPendRefusals`, excluding self (already carried, more directly, by `localPendResult`).
- **`CoordinatorRepo.pendThroughCluster`**: a local conflict still wins; a local **success** no longer settles it — a reported cohort refusal is returned as the retryable conflict. Selection is lowest peer id, so two coordinators facing the same cohort answer identically.

### Arm 2 — a member that refused a pend will not sign that action's commit

- **`refusedPendActions`** (`cluster-repo.ts`): conflict-shaped pend refusals retained a second time, keyed by **actionId**. The existing map is keyed by messageHash, and a commit is a different message with a different hash, so the commit-promise check had no way to find the refusal. Same TTL and pruning as its sibling; rolled back alongside the executed marker in `handleConsensus`'s catch; cleared in `dispose()`.
- **`validateCommitAgainstRefusedPend`** — new promise-round check, wired into `evaluatePromise` between `validateCommitRevisions` and `validateCommitOperations`. Rejects only when *both* (a) a refusal for `commit.actionId` is retained and (b) `refusedPendConflictsWithLocalState` confirms local storage still backs it (a rival pending holds a block, or a different action took `commit.rev`). Read faults abstain, never throw out of the vote path.

Condition (b) is the whole reason the lagging-member and cohort-drift tolerances survive: a member that merely *missed* the pend retains no refusal, and one whose rival has since been cancelled abstains rather than vetoing a commit the rest of the cohort holds fine.

### Docs

`packages/db-p2p/docs/cluster.md` promise-phase section (now three commit checks, plus a new "What a member reports back after applying" subsection); `docs/correctness.md` — commit-revision-staleness paragraph narrowed, and a new **Pend refusal reporting** definition. The two in-code residual prose blocks the ticket named (`validatePendOperations`' abstain comment, the `validateCommitRevisions` residual) and the `applyConsensusOperation` NOTE were rewritten to match the new reality rather than left describing the hole.

## Testing

`packages/db-p2p/test/cohort-pend-refusal-channel.spec.ts` (new, 6 cases) drives **real** `ClusterMember`s over real `StorageRepo`/`MemoryRawStorage`, behind a real `ClusterCoordinator` and `CoordinatorRepo`. The race is injected where the trace showed it: the rival's pend lands on the remote member *after* it has answered the promise round.

- the writer gets a retryable conflict when a **non-coordinating** member refused — and the assertion also proves the coordinator's own storage accepted the pend, so the conflict came from the channel under test and not from the coordinator noticing the rival itself;
- a commit driven anyway cannot assemble consensus, and neither member's block leaves rev 1 (arm 2, end to end);
- an uncontested pend still succeeds (no false conflicts);
- a member votes reject on the commit of an action whose pend it refused; abstains once the rival is cancelled; abstains for an action it never saw the pend of.

`coordinator-repo-pend-divergence.spec.ts` gains 4 seam-mock cases: remote refusal beats local success, local refusal beats remote, deterministic selection across several refusals, and cohort refusals ignored when no local verdict was retained at all.

**Both arms were verified to actually catch the bug**, by neutering each in turn and re-running: with arm 1 disabled the pend is reported as a win (the original fork); with arm 2 disabled the member votes approve on the commit it had refused. The arm-2 cases read the refusal off `getExecutedPendResult` rather than off the response record, so they do not silently depend on arm 1 being wired.

`yarn check` is clean end to end: lint, doc citations, build, typecheck, every package's unit suite (db-p2p 2642 passing) and the integration suites — zero failures.

## Known gaps and things to push on

- **Evidence base is one observation.** The whole design rests on a single captured trace (block `14YGUoeu…` rev 7, one `../sereus` run). The reasoning holds statically, but no second occurrence corroborates the frequency or the exact ordering.
- **Late-applying member is still uncovered by arm 1.** A member that reaches consensus only through the scheduled commit-retry timer applies *after* `executeClusterTransaction` has resolved, so its refusal never reaches the writer's answer. Arm 2 is the backstop and there is no test for that specific path — the retry timer is not driven in this spec.
- **`refusedPendActions` is in-memory only.** A member restart, or the 10-minute TTL, degrades arm 2 to the previous abstain behaviour. Deliberate (it matches the sibling retention maps), but it means arm 2's guarantee is time-bounded and a reviewer should decide whether that is acceptable or wants a durable marker.
- **Two-member cohorts only, in the tests.** Both arms are exercised at `clusterSize: 2`, where one reject makes super-majority unreachable. At realistic widths (3+) a single refusing member's reject does *not* block a commit, so arm 2's practical effect is weaker there and only arm 1 answers the writer. No test covers a 3-member cohort with one refuser; worth adding.
- **`cohortPendRefusals` picks one refusal and drops the rest.** Every entry is conflict-shaped and means "retry", so the outcome is the same, but the writer only ever sees one member's `pending`/`missing` lists. If a caller ever needs the union, the aggregate is available on the record.
- **`mergeApplyOutcomes` mutates the record in place**, matching the surrounding commit-merge code in `commitTransaction` (which already does `record.commits = ...`). Consistent with its neighbours, but it is mutation on a shared object and deserves a look.
- **Downstream re-check, out of band:** the fix ticket asked whether `../sereus`'s boot-gate timeout ("Timeout waiting for C self-publishes its CadrePeer record", the `7 skipped` shape) still occurs now that the gapped-base guard has landed, and again after this ticket. That is a sereus integration run for a human or a downstream agent — deliberately not attempted from this repo.

## TODO (review)

- Read the implement diff first, fresh, before this summary: `git log --grep="ticket(implement): 2-cohort-pend-refusal-must-reach-the-coordinator" -1 --format=%H`.
- Push on the two-member-cohort limitation above: does arm 2 do anything useful at width 3+, and if not, is the ticket's claim about it overstated in the docs?
- Check the unsigned-field argument in `ClusterRecord.applyOutcomes` holds under an adversarial member that reports a refusal on *every* transaction — the claim is "retry pressure only"; confirm nothing upstream converts sustained retry pressure into a permanent failure or a reputation penalty against the wrong peer.
- Confirm `withOwnApplyOutcome` firing on every `processUpdate` return (not only after a consensus apply) has no unwanted effect on the promise/commit-collection responses, which now carry the field too.
- Verify the actionId-keyed retention cannot leak: `handleConsensus`'s catch clears it, the TTL prunes it, `dispose()` clears it — is there a fourth exit (a record whose pend applies then whose later operation throws)?
