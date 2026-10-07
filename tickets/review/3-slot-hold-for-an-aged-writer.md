description: A writer that keeps losing to a stream of quicker writers on the same collection can retry until it gives up, because each quick write lands and leaves before the slow one's attempt arrives. After a few such losses, the machines storing the collection now briefly hold the next slot for the slow writer, so it gets one clear chance to land.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`noteStaleLoss`, `noteStaleLossUnvoted`, `judgeSlotHolds`, `standingSlotHold`; the `staleLosses`, `countedStaleLosses` and `slotHolds` maps; the call in `validatePendOperations`'s stale branch, the hold check ahead of the pending-rival scan, and the `Rejected` arm of the phase loop)
  - packages/db-core/src/transaction/transaction.ts (`SlotHoldAfterLosses`), packages/db-core/src/transaction/index.ts (its export)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.slotHoldWindowMs`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`clusterPolicy.slotHoldWindowMs`, `DEFAULT_SLOT_HOLD_WINDOW_MS`, `resolveSlotHoldWindowMs`, the resolved field)
  - packages/db-p2p/src/cluster/race-resolution.ts and packages/db-p2p/src/repo/coordinator-repo.ts (comments that named the deferred follow-up now name the hold)
  - packages/db-p2p/test/cluster-slot-hold.spec.ts (member-level, injected clock), packages/db-p2p/test/aged-writer-slot-hold.spec.ts (mesh, 20 s; control arm behind `RUN_LONG_TESTS_CONTROL=1`), packages/db-p2p/test/cluster-policy.spec.ts (the knob's resolution)
  - docs/correctness.md (Theorem 9 "Bound" and the new "The slot hold" paragraph), docs/internals.md (the bullet after the `held` reservation bullet under Key Invariants), packages/db-p2p/docs/cluster.md (the knob), docs/debugging.md (the `cluster-member` namespace row)
difficulty: hard
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-07T01:28:19.008Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\3-slot-hold-for-an-aged-writer.review.2026-10-07T01-28-19-008Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

# Slot hold for an aged writer

## What was built

A storage member that has refused one action's pend as stale `SlotHoldAfterLosses` times (three) holds the next slot of every block that pend named for the action, in memory, for `slotHoldWindowMs` (default 3000, `0` disables). Until the action's own pend consumes the hold, every other action's pend of the block is answered with the same `held` vote a storage reservation produces, so the coordinator and the writer handle it with the retry they already have and nothing changes on the wire. The hold produces refusals only, never approvals.

Everything lives in `ClusterMember` (`packages/db-p2p/src/cluster/cluster-repo.ts`):

- `noteStaleLoss` counts a stale refusal and grants the hold at the threshold; called from the stale branch of `validatePendOperations` before the reject is returned. A block another action holds keeps that hold; a hold already this action's is renewed.
- `judgeSlotHolds` runs after the stale check and before the pending-rival scan: a foreign unexpired hold answers `held` naming the holder; the pend's own holds are consumed, in a second pass, so a pend refused on one block keeps its hold on another. A hold refusal never feeds `nameStuckReservation`.
- `standingSlotHold` drops a lapsed hold on the way through and logs it (`cluster-member:slot-hold-expired-unconsumed`, the count behind the per-block cooldown tripwire).
- Log lines: `cluster-member:slot-hold-granted`, `slot-hold-refused`, `slot-hold-consumed`, `slot-hold-expired-unconsumed`, `slot-hold-loss-unvoted`.

The knob flows through the existing path with no new wiring: `ClusterPolicyOptions.clusterPolicy.slotHoldWindowMs` is resolved by `resolveClusterPolicy` into `ResolvedClusterPolicy.slotHoldWindowMs`, which `createLibp2pNodeBase` already hands to `clusterMember` as `consensusConfig`, and the mesh harness's `resolveMeshPolicy` spreads `clusterPolicy` through the same resolver. The member re-applies `resolveSlotHoldWindowMs` to whatever config it is handed, so a hand-wired member and a node agree on the window and on `0` meaning off. A value that is not a finite number at or above zero throws at construction, as the cohort deadline does.

## One deviation from the plan, forced by measurement

The plan said every member counts because every attempt's promise round reaches every member. The round does reach them, but on a two- or three-member cohort the coordinating member's stale reject (cast in `prevoteLocalPromise` before the fan-out) is already terminal when the record arrives, so the other members never run validation and never counted. That alone would have been fine, since one `held` vote sinks a pend on those cohorts, except that the coordinator is picked per **block**: when the log tail rolled over in the middle of the slow writer's retry cycle, its later pends named a new tail whose nearest node was a different coordinator, the losses were split across members, and no member reached the threshold. Observed in the first run of the mesh spec as a write needing 6 pends with 3 holds granted in the whole run, and reproduced in a probe (a five-pend write whose second loss was its own roll-over attempt).

So a member now also counts a loss for a pend record it casts no vote on (`noteStaleLossUnvoted`, called from the `Rejected` arm of the phase loop when this member's vote is absent). The record is judged exactly as the vote would have judged it: the membership admission gate, then the stale rule with its own-revision carve-out, against this member's own storage. The arriving reject is never taken on trust, nothing is signed or answered, and a member behind the cohort counts nothing. One record counts once however many times it is delivered (`countedStaleLosses`, keyed by message hash), because the abandonment broadcast re-sends a refused record to every member. After this change seven probe runs of 20 s each showed no slow write needing more than 4 pends (three losses and the landing), and 58 hold lines per run instead of 18. The cost is one admission check and one storage read per terminal pend record per non-voting member, a path that did no I/O before.

## What was measured, with the hold on

Three-node in-process mesh, `clusterSize: 3`, one diary, fast writer appending every 200 ms, slow writer appending once a second with every repo call delayed 120 ms, 20 s runs on the same machine as the plan-stage table:

| run | fast commits in 20 s | slow writes | pends per slow write | holds granted (3 members) |
| --- | --- | --- | --- | --- |
| 1 | 72 | 8 | 3,1,3,1,4,4,4,2 | 58 lines |
| 2 | 68 | 8 | 3,1,1,3,4,4,4,2 | 58 lines |
| 3 | 66 | 8 | 3,3,1,1,4,4,4,2 | 58 lines |
| spec run | 72 | 6 | all at most 5 | at least 1 |

Against the plan-stage table (68 fast commits per 15 s uncontended, 4 slow commits per 15 s at this delay with a 9.6 s longest gap) the fast writer keeps roughly three quarters of its rate and the slow writer lands every write in about 2.5 s once it has lost three times, under a second of which is the hold itself. No slow write exceeded 4 pends in the probe runs; the spec's bound is `SlotHoldAfterLosses + 2` for the rival-already-past-its-promise-round case the plan describes, which was not observed after the fix.

## Tests

- `packages/db-p2p/test/cluster-slot-hold.spec.ts`, member level, injected clock, one `it` per branch: nothing held below the threshold; the next slot held at it, with the `held` vote naming the aged action and verifying; the holder's own pend consumes the hold and a fresh pend passes after it; a hold lapses unconsumed past the window and the lapse is logged; a redelivered pend over the holder's own committed revision passes (the own-revision carve-out); a second aged action is refused by the first's hold and granted its own once the first has committed; a record that arrived already refused by another member counts without this member voting; one record counts once however many times it is delivered; a pend refused on one block keeps its hold on another; no stuck-reservation line across ten distinct writers refused by a hold; `slotHoldWindowMs: 0` counts, grants and checks nothing.
- `packages/db-p2p/test/aged-writer-slot-hold.spec.ts`, mesh, 20 s: every slow write lands, each within `SlotHoldAfterLosses + 2` pends counted through the delaying wrapper, the fast writer commits at least 50 times, and at least one hold was granted. The control arm (hold disabled, 40 s) asserts at least one slow write gave up or took over 10 s; it runs only under `RUN_LONG_TESTS_CONTROL=1` and was run once by hand for this handoff.
- `packages/db-p2p/test/cluster-policy.spec.ts`: the window defaults to 3000 and passes 0 through; negative, NaN and Infinity throw.

Run: `yarn workspace @optimystic/db-p2p test` (3274 passing), `yarn workspace @optimystic/db-core test` (1879 passing), `yarn workspace @optimystic/quereus-plugin-optimystic test` on the rebuilt db-p2p (1001 passing), `yarn lint`, `yarn lint:docs`, both typechecks.

## Known gaps and things to look at

- **The mesh spec's throughput floor is machine-bound.** `fastCommits >= 50` in 20 s was measured at 66 to 73 on the machine the plan-stage numbers came from. A slower CI machine could fall under it without anything being wrong. If it flakes, the honest fix is a floor expressed against an uncontended control measured in the same run, not a lower constant.
- **The `+ 2` pend bound is reasoned, not observed.** The in-flight-rival case (a fast pend already approved when the hold is granted, so the slow writer's next pend meets its commit or its reservation) adds one pend; two such events in one write would need a third. Seven runs showed none. If a 6-pend write ever appears with holds granted for it, that is the case to look at first; a 6-pend write with no holds granted for it is the split-count shape, which the unvoted count should have closed.
- **The unvoted count bypasses nothing the vote checks, but it is new I/O on a dead record.** Every non-voting member now runs the admission gate and one `get` per refused pend record. On the measured shape that is two extra reads per slow loss across the cohort. Bounded by the dedup map, and skipped when the window is 0.
- **Roll-over wastes a hold.** A hold stands on the blocks the aged pend named; after a roll-over the next attempt names the new tail, the old holds lapse unconsumed, one fresh rival slips in, and the stale refusal regrants on the new tail. One extra loss, inside the bound, documented at the `slotHolds` map.
- **Restart forgets counts and holds**; the aged writer loses up to three more times. Accepted, noted at the maps.
- **Mixed versions.** A member on the previous release never holds and never counts; on a two- or three-member cohort one upgraded member is enough, since one `held` vote sinks the pend. From four members up the residual in Theorem 9 applies: the holding members must be enough to deny super-majority.
- **The field questions from the plan ticket stand as answered there:** every exhausted or torn write throws in this repository, so "the app reported nothing" was the host application clearing a composer on a failed write; nothing to change here, say so when closing GitHub #18.
- `tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md` still refers to `feat-occ-priority-reservation` by its old name in one sentence; left alone as a board file outside this ticket's scope.

## Tripwires parked in code

- Per-block cooldown between grants, if `cluster-member:slot-hold-expired-unconsumed` keeps recurring for one block: `NOTE:` at `slotHolds` in `packages/db-p2p/src/cluster/cluster-repo.ts`, with both cost bounds (honest: the holder's read-to-pend window per three losses; worst: the window per grant for a holder that never returns).
- Counting all-lose rounds (no member refuses stale, so the hold never arms) if a high-contention workload ever exhausts `maxAttempts` on them: the comment at the `ConflictRaceLostError` arm in `packages/db-p2p/src/repo/coordinator-repo.ts`.
