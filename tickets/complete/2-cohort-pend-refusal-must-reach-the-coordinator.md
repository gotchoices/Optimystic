description: A cohort member that refuses a write because someone else got there first now tells the node running that write, instead of keeping the refusal to itself — and a member that refused a write will no longer help finalise it. Together these stop a node from saving a version of a block nobody else has.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cohort-pend-refusal-channel.spec.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md
----

# Complete: cohort pend refusal must reach the coordinator

## What was built

Two arms, each covering the other's residual. Full description in the implement commit (`97da8fb4`); review fixes in the commit that carries this file.

**Arm 1 — a member's refusal travels back.** New optional advisory field `ClusterRecord.applyOutcomes` (db-core `structs.ts`) carries each member's own conflict-shaped pend verdict on the record it answers with. `ClusterMember.withOwnApplyOutcome` stamps it after the phase loop; `mergeRecords` unions it per peer. The coordinator collects it off both the commit-collection round and the consensus broadcast, taking **only** each peer's own entry re-keyed under the peer actually asked, re-checks the shape, and surfaces it as `cohortPendRefusals`. `CoordinatorRepo.pendThroughCluster` answers the writer with that conflict.

**Arm 2 — a member that refused a pend will not sign its commit.** Refusals are retained a second time keyed by actionId (a commit is a different message with a different hash), and `validateCommitAgainstRefusedPend` rejects the commit when local storage still corroborates the refusal.

## Key files

- `packages/db-core/src/cluster/structs.ts` — `applyOutcomes` / `MemberApplyOutcome`, and the trust rules.
- `packages/db-p2p/src/cluster/cluster-repo.ts` — member side: both retentions, `withOwnApplyOutcome`, `validateCommitAgainstRefusedPend`, `refusedPendConflictsWithLocalState`.
- `packages/db-p2p/src/repo/cluster-coordinator.ts` — `collectApplyOutcomes` / `mergeApplyOutcomes`, `cohortPendRefusals`.
- `packages/db-p2p/src/repo/coordinator-repo.ts` — `answerWithCohortRefusal`, the single rule every exit from `pendThroughCluster` passes through.

## Testing and usage

`packages/db-p2p/test/cohort-pend-refusal-channel.spec.ts` (7 cases) drives real `ClusterMember`s over real `StorageRepo`/`MemoryRawStorage` behind a real `ClusterCoordinator` and `CoordinatorRepo`, injecting the race where the trace showed it (rival's pend lands after the remote member answered the promise round). `coordinator-repo-pend-divergence.spec.ts` gains 8 seam-mock cases covering the aggregate arm.

Both arms were mutation-checked by neutering each in turn: arm 1 off → exactly one failure (the pend reported as a win, the original fork); arm 2 off → two failures. `yarn check` clean end to end — lint, doc citations, build, typecheck, unit (db-p2p 2646 passing) and integration suites, zero failures.

Nothing to configure. The wire field is optional in both directions: old peers never set it, old coordinators ignore it.

## Review findings

**Read first:** the implement diff was reviewed before this summary, per the stage rule.

### Major — none filed as tickets

No finding warranted a new ticket. The three defects below were all inside the change under review, at the same seam, and were fixed in this pass; filing tickets for holes in the diff being reviewed would have been worse than closing them.

### Minor — fixed in this pass

1. **`pendThroughCluster` applied the new rule on one path out of four.** The cohort refusal was consulted only where the local member had executed *and* retained a success. Three other exits still answered `success` while ignoring a reported refusal: the `!localExecuted` local-storage fallback, the no-verdict-retained fabricated success (member restart or retention TTL), and the bare-reason-fault fall-through. Each is the same fork class the ticket exists to close, reachable by a plain coordinator restart. Rather than patch the branch, the exits now pass through **one** rule, `answerWithCohortRefusal`: a reported refusal downgrades a *success* and nothing else. A local hard fault is deliberately left untouched — softening a validation failure into "retry" would send the writer round a loop that fails identically.

2. **A stale refusal could veto a commit the member itself held pended.** The actionId-keyed retention was never cleared when a *later* pend of the same action succeeded, so after a retry that won, any unrelated rival sitting on one of the blocks would satisfy the corroboration condition and the member would reject the commit of an action it was holding. Two pending actions on one block is ordinary. A successful apply now retires the entry.

3. **Mixed clocks in the new retention.** It was written with the injectable `this.now()` while the prune sweep and the executed-marker timestamps it is documented to share a TTL with both use `Date.now()`. Under an injected clock the entry prunes on the first sweep or never. Dormant in production (`now` defaults to `Date.now`), wrong regardless — now `Date.now()`, with a comment saying why.

4. **A test decoupling I reported as done had silently not applied.** The arm-2 cases were still asserting through `applyOutcomes` — arm 1's channel — so neutering arm 1 broke them in their *setup* and they stopped exercising arm 2 at all. They now read the verdict off `ClusterMember.getExecutedPendResult`. Confirmed by re-running both neuter passes: arm 1 off now fails exactly one test, and the arm-2 cases survive.

### Test coverage added

- The corrected rule: cohort refusal honoured with no local verdict, with no local execution, and alongside a bare-reason local fault; and *not* honoured over a local hard fault. (The prior test pinning the wrong behaviour — "ignores cohort refusals when this node retained no verdict at all" — was inverted, not deleted.)
- Refusal retirement after a later successful pend of the same action.

### Checked and found correct

- **Index alignment** of `results` to `peerIds` in both collection sites (commit round and broadcast); failures map to `null` and contribute nothing.
- **Wire safety**: no hash covers `applyOutcomes`, and `validateRecord` / `mergeRecords` compare only `message`, `peers` and the membership digest, so the field cannot break signature verification or the peers-mismatch invariant.
- **No cross-peer contamination**: a record re-broadcast by the scheduled commit retry now carries other peers' entries, but `collectApplyOutcomes` reads only `response.applyOutcomes[thatPeer]`, so an echo contributes nothing.
- **No reputation coupling**: nothing feeds a reported refusal into `IPeerReputation`, so a false entry cannot penalise an honest peer.
- **The extra storage read** in `refusedPendConflictsWithLocalState` is gated on a retained refusal for that exact actionId, so the common commit-promise path is unchanged.
- **Retention exits** are complete: `handleConsensus`'s catch (all pend ops in the record), the TTL sweep, `dispose()`, and now a successful re-apply. A message carries pend *or* commit operations, so there is no fifth path.

### Corrected from the implement handoff

- The handoff flagged "**two-member cohorts only**" as a limitation, implying arm 2 is weak at realistic widths. The arithmetic says otherwise: `maxAllowedRejections = peerCount - ceil(peerCount × 0.75)`, which is **0** at both size 2 and size 3 — one refusing member blocks the commit at either width. It is only from size 4 upward that a single reject is tolerated, and there a lost race typically leaves *several* members holding the winner. The limitation as written overstated the gap; a 3-member test would add nothing arm 2 does not already get at 2.

### Tripwires recorded (not tickets)

- **Unattributable entries.** Unlike a signed reject/conflict vote, an `applyOutcomes` entry cannot be pinned on its author, so no reputation penalty can follow a false one. Fine while the worst it buys is retry pressure a signed vote could already produce. `NOTE:` at the field in `db-core/src/cluster/structs.ts` names the observable symptom (writes exhausting their retry budget with `coordinator-repo:pend-remote-refusal` naming one peer repeatedly) and the fix direction (make the entry attributable, not trust it less).

### Known residuals carried forward

- **Late-applying member.** A member that reaches consensus only through the scheduled commit-retry timer applies after `executeClusterTransaction` has resolved, so its refusal never reaches the writer's answer. Arm 2 is the backstop; that specific path has no test, because the spec does not drive the retry timer. Documented at both `cohortPendRefusals` and in `docs/correctness.md`.
- **Retention is in-memory and TTL'd**, so arm 2's guarantee is time-bounded and a restart degrades it to the previous abstain behaviour. Deliberate, matching its sibling maps — and arm 1 now survives that same restart on the coordinator side, which it did not before this review.
- **Evidence base is one observed trace.** Unchanged.
- **Downstream re-check still owed:** whether `../sereus`'s boot-gate timeout ("Timeout waiting for C self-publishes its CadrePeer record") still occurs now that this and the gapped-base guard have landed. That is a sereus integration run for a human or a downstream agent, deliberately not attempted from this repo.

### Not re-filed

No accepted-tradeoff `NOTE:` at any touched site had its revisit condition trip.
