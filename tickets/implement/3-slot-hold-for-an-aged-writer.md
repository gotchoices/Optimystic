description: A writer that keeps losing to a stream of quicker writers on the same collection can retry until it gives up, because each quick write lands and leaves before the slow one's attempt arrives. After a few such losses, the machines storing the collection should briefly hold the next slot for the slow writer, so it gets one clear chance to land.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations`: the stale check and the `held` verdict; `refusalLogTag`; the constructor, which already takes `consensusConfig` and an injectable `now`)
  - packages/db-core/src/transaction/transaction.ts (beside `MaxPriority`: the shared loss threshold)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig`: the hold window knob)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy`: default and validation of the knob)
  - packages/db-p2p/src/repo/stuck-reservation.ts (must NOT be fed by a hold refusal)
  - packages/db-p2p/src/cluster/race-resolution.ts and packages/db-p2p/src/repo/coordinator-repo.ts (comments naming `feat-occ-priority-reservation` as the deferred follow-up; this ticket is that follow-up)
  - packages/db-p2p/src/testing/mesh-harness.ts (`wrapRepo`, which the mesh test uses to slow one writer's every call)
  - packages/db-p2p/test/cluster-member-promise-vote.spec.ts or packages/db-p2p/test/cluster-repo.spec.ts (pattern for a member-level vote test with an injected clock)
  - docs/correctness.md (Theorem 9 "Bound" paragraph and the Byzantine note), docs/internals.md (the `held` vote bullets under Key Invariants), packages/db-p2p/docs/cluster.md (the knob)
difficulty: hard
----

# Slot hold for an aged writer

## What was measured (plan stage, 2026-10-06, working tree at 1.11.0)

The GitHub #18 shape was reproduced on the in-process mesh (three nodes, `clusterSize: 3`, one `Diary`). A fast writer appends sequentially with a 200 ms pause between writes. A slow writer appends once a second, through a transactor whose every repo call (`get`, `pend`, `commit`, `cancel`) is delayed by a fixed amount, which models a phone over a relay whose event loop is also being starved. The delay is the only difference between the two writers.

| slow writer's per-call delay | fast commits in 15 s | slow commits in 15 s | longest gap between slow commits |
| --- | --- | --- | --- |
| 0 ms | 68 | 14 | 1.2 s |
| 40 ms | 68 | 10 | 2.3 s |
| 120 ms | 66 | 4 | 9.6 s |

Two 40 s runs at 120 ms:

| slow writer's backoff | fast commits | slow commits | slow writes that gave up | longest slow outage | slow pends refused `stale` |
| --- | --- | --- | --- | --- | --- |
| default (100 ms doubling to 5 s, jittered) | 182 | 3 | 1 (after 22.8 s) | 36 s | 23 of 26 |
| none (1 ms) | 180 | 5 | 3 (after 5 to 8 s each) | 34 s | 45 of 50 |

Every failure was `SyncRetryExhaustedError` with reason `stale revision`. The slow writer made about four `get` calls and one `pend` per attempt (196 gets for 50 pends in the no-backoff run): the refresh's header-and-tail read, the walk, the re-reads the replay needs, then the pend. Each is a sequential round trip.

Three conclusions, each of which decides something below:

- **The mechanism is the window, not the pacing.** Call the slow writer's read-to-pend window W (from the tail read that fixes its requested revision to the moment the members judge its pend) and the fast writer's commit interval I. The slow writer lands only if no fast commit falls inside W. At 120 ms per call W is about 0.6 to 0.8 s and I is about 0.25 s, so it almost never does. Nine out of ten refusals are confirmed stale, matching the 95 percent the field report measured, and the surviving attempts are the lucky phase alignments.
- **Client-side pacing cannot fix it.** Removing the backoff altogether changed nothing except that the write gave up sooner. A backoff that favours the biggest loser is the same lever and is rejected for the same reason: the slow writer is not in a herd, it is behind a stream.
- **Shrinking W helps probabilistically, never with a guarantee.** The 40 ms row shows the slow writer landing every write once W is at or below I. Fewer round trips per attempt move that boundary (parked in backlog `feat-a-refresh-prefetches-the-blocks-it-cleared`), but a rival fast enough always exists. The guarantee the ticket asks for needs the cluster to hold a slot.

The pend itself is already that hold, once it lands: a pending record reserves its blocks until commit or cancel, and every later writer is answered `held` (`Signature.heldBy`). What the slow writer cannot do is land the pend. So the design is the smallest thing that extends the existing reservation one step earlier, to a writer the member has itself watched lose.

## The design

**A member holds the next slot of a block for an action it has itself refused as stale enough times.** State and rule live in `ClusterMember` (`packages/db-p2p/src/cluster/cluster-repo.ts`), in memory, beside the reservation table.

- `SlotHoldAfterLosses` (db-core, `packages/db-core/src/transaction/transaction.ts`, beside `MaxPriority`): the number of stale refusals of one action id a member must have issued itself before it holds for that action. Default 3. Shared with the client follow-on ticket so both sides count the same thing.
- `slotHoldWindowMs` (`ClusterConsensusConfig`, resolved by `resolveClusterPolicy`): how long a hold stands before it expires unconsumed. Default 3000 ms. `0` disables the mechanism on that member. Validated the way `cohortQueryTimeoutMs` is.
- Per member: a bounded map from action id to the count of stale refusals this member issued for it (`LruMap`, 1000 entries; an action id is one sync cycle, so the count only rises and never needs resetting), and a bounded map from block id to the one hold standing on it: `{ actionId, untilMs }`.

In `validatePendOperations`, for a pend operation:

1. The stale check runs exactly as today. When it refuses the pend as stale (and the revision is not the action's own), the member increments the action's count first. If the count is at or past `SlotHoldAfterLosses`, it grants a hold on every block the pend names whose standing hold is absent, expired, or already this action's: `{ actionId, untilMs: now + slotHoldWindowMs }`. A block held for a different action keeps that hold. The refusal verdict is unchanged.
2. When the pend passes the stale check, every block it names is checked against its hold, before the pending-rival scan. A hold for this action is consumed (deleted) and the check continues. An unexpired hold for a different action answers the `held` verdict kind with `heldBy` naming the holder and a prose reason such as `slot held for aged action <id>: block <id>`. An expired hold is deleted and logged as expired unconsumed.
3. Nothing else changes: the pending-rival scan, the validator check, the apply-time checks in `StorageRepo.pend`, the commit path. A hold produces only refusals, never approvals.

Why the `held` kind and not a new vote: `held` already means "not now, a reservation stands, retry" at every threshold (`getTransactionPhase` counts it with `conflict`, never as a rejection; the coordinator raises `BlocksHeldError`, returned as a `StaleFailure` with `conflict: true`; `Collection.sync` and the coordinator back off and retry). A hold is exactly that, with the reservation granted one step earlier. No wire or signed-layout change is needed.

Why the member and not the coordinator: a pend's promise round reaches every member of the cohort on every attempt, while the writer's transactor may pick a different coordinator per attempt. The member is the one place every refusal of an action is seen.

Why the count is the member's own: the self-asserted `priority` field is deliberately not read. A member grants only on refusals it issued, so no claimant can talk a member into a hold with a number.

## The two questions the plan ticket said must be settled

**Byzantine verifiability.** The hold hands no peer a lever it did not already have. Any writer with write access to a block can today pend and never commit or cancel, which reserves the block for every other writer for the life of the pending record (field instances in backlog `debt-unpromotable-pending-records-need-a-sweep` refused hundreds of writes). A hold is bounded at `slotHoldWindowMs` per grant, is granted only after `SlotHoldAfterLosses` round trips the claimant has to spend on refused pends, is held by at most one action per block, and is in memory on each member separately. An attacker who wants a block idle gets strictly more from the existing pend. The priority field remains advisory and never reaches the hold. The one honest-looking abuse, a claimant that earns a hold, lets it expire, and earns it again, costs the attacker a refused round trip per window and is counted by the expired-unconsumed log line, which is the tripwire for adding a per-block cooldown.

**Throughput bound.** While a hold stands the block admits no other writer's pend. The time lost on the block per hold is `min(slotHoldWindowMs, time until the holder's next pend is judged)`. For an honest holder that is its own window W, so the fast writer loses roughly W of commit time per `SlotHoldAfterLosses` losses of the slow writer, which at the measured numbers is under a second per three slow losses. The worst case is a holder that never returns: `slotHoldWindowMs` idle per grant, and a grant needs `SlotHoldAfterLosses` refusals of one action first. Both bounds are stated at the knob. The mesh test below measures the fast writer's commit rate with holds on so the honest cost is a number, not an estimate.

## Interactions with the stated theorems

- Theorem 1 and Theorem 2 (consensus and partition safety) are about approvals. A hold only turns an approval into a `held`, so neither proof changes.
- Theorem 7 (termination). A hold expires on the member's own clock at `untilMs`, is never persisted, and cannot be renewed except by a fresh stale refusal. Transaction expiration is untouched. No cross-machine clock comparison is introduced (§7.4 holds).
- Theorem 9. The "Bound" paragraph's sequential-starvation residual closes for cohorts where the members holding can deny the fresh rival its promise bar: every cohort of two or three, and a cohort of four or more whenever at least `cohort − ⌈0.75·cohort⌉ + 1` members refused the aged writer. In the shape measured, every attempt's promise round reaches every member, so every member counts. The new residual is a member unreachable during the aged writer's attempts.
- The membership admission gate, read-repair, lineage and torn-action handling never see a hold: it lives entirely in the promise vote.

## Edge cases & interactions

- **A rival already past its promise round when the hold is granted.** It lands, the aged writer is refused stale once more, the count is still past the threshold, and the hold is regranted. The aged writer lands on the attempt after. Bound: `SlotHoldAfterLosses + 1 + (rivals in flight at the grant)` attempts, which with one sequential rival is at most five. Verified by the mesh test's per-write pend count.
- **Two aged writers.** The first to cross the threshold on a member holds; the second is answered `held` by that hold, and when the first commits the second is refused stale once more and gets its own hold. Verified by inspection; the member-level test covers "a hold for one action refuses another aged action's pend".
- **The holder gives up or dies.** The hold expires unconsumed, logged `cluster-member:slot-hold-expired-unconsumed`. The application's re-drive mints a new action id and counts from zero. Verified by the member-level expiry test.
- **The holder's next attempt names different blocks** (the log tail rolled over, or the replay re-staged a different leaf). The old holds stand on blocks the holder no longer names and expire unconsumed; a fresh rival on the new tail can slip in once, after which the stale refusal regrants on the new blocks. Bounded as the first case. Verified by inspection; say so in the hold's doc comment.
- **A hold and the action's own redelivered pend.** `isOwnRevision` keeps a redelivered pend approvable; a hold for this action is consumed, never refuses it. Verified by the member-level test "a hold never refuses its own action".
- **The coordinator's own member.** `prevoteLocalPromise` runs the same `validatePendOperations`, so the coordinating node holds and refuses exactly as a remote member does. By inspection.
- **Cohorts of four or more, mixed with members that missed rounds.** A member that did not see the refusals does not hold; the fresh rival passes if the holding members cannot deny it super-majority. Degrades to today's behaviour. Documented as the residual in Theorem 9; no test.
- **Mixed versions.** A member on the previous release never holds. The hold on upgraded members is still a `held` vote the old coordinator and old writers already understand, so nothing breaks; on a two- or three-member cohort one upgraded member is enough. By inspection.
- **The stuck-reservation diagnostic.** A hold refusal must not call `nameStuckReservation`: a hold is not a storage record and is never stuck. On the coordinator, `CoordinatorRepo.pend`'s enrichment read finds no pending record for the holder, so the answer is the bare conflict and `noteStuckReservation` is not fed. Verified by the member-level test asserting no `cluster-member:stuck-reservation` line across repeated hold refusals.
- **Apply-time scan.** `StorageRepo.pend` is not changed. A pend that reached consensus on other members (four and up) applies here regardless of a hold; the aged writer's next pend then meets that record's reservation or its commit, both handled today. By inspection.
- **Restart.** Holds and counts are in memory and are lost; the aged writer loses up to `SlotHoldAfterLosses` more times. Accepted; note at the maps.
- **Memory.** Two `LruMap`s of 1000 entries. A hold refusal costs one map lookup per block named.
- **Disabled** (`slotHoldWindowMs: 0`). No count, no grant, no check: the vote path is byte-for-byte today's. Verified by the negative control.

## Tests

- `packages/db-p2p/test/aged-writer-slot-hold.spec.ts` (mesh, 20 s): the measured shape with the slow writer's calls delayed 120 ms. Asserts every slow write commits, each within `SlotHoldAfterLosses + 2` pends (count through the delaying wrapper, as the plan-stage measurement did), the fast writer commits at least 50 times in the 20 s, and at least one hold was granted (the test would otherwise pass on a lucky phase; capture the `cluster-member:slot-hold-granted` line or count through a test seam). A negative control with `slotHoldWindowMs: 0` reproducing the starvation (at least one slow write exceeding 10 s or giving up) goes behind `RUN_LONG_TESTS_CONTROL=1`, since it burns its budget by construction.
- A member-level spec with an injected `now` (the `ClusterMember` constructor takes one): the threshold (two stale refusals grant nothing, the third grants, a current-revision pend from another action is answered `held` naming the holder, the holder's own pend consumes the hold and the next rival pend is approved); expiry (advance the clock past the window, the rival is approved, the expired-unconsumed line is logged); a hold never refuses its own action; no stuck-reservation line is produced by hold refusals. One `it` per branch.

## Field questions from the plan ticket, answered

- "The app reported nothing": in this repository every exhausted or torn write throws (`Collection.actAndSync`, which `Tree.replace` and `Diary.append` use, and the Quereus bridge rethrows a mapped refusal rather than swallowing it). A composer that cleared on a failed write dropped the rejection in the host application. Nothing to change here; say so when closing GitHub #18.
- "Re-measure before designing": done above, and the numbers are in this ticket so the implementer and reviewer can compare against them.

## TODO

- Add `SlotHoldAfterLosses` to `packages/db-core/src/transaction/transaction.ts` with a doc comment stating what the member counts and why the self-asserted priority is not used; export it from the package index beside `MaxPriority`.
- Add `slotHoldWindowMs` to `ClusterConsensusConfig` and resolve it in `resolveClusterPolicy` (default 3000, `0` disables, validated as a finite non-negative number); thread it through the one production construction site in `libp2p-node-base.ts` the way `cohortQueryTimeoutMs` is, and through the mesh harness's policy resolution.
- Implement the two bounded maps, the count on stale refusal, the grant, the consume and the hold refusal in `validatePendOperations`; log `cluster-member:slot-hold-granted`, `cluster-member:slot-hold-refused`, `cluster-member:slot-hold-consumed`, `cluster-member:slot-hold-expired-unconsumed` with block id, action ids, count and remaining window. Leave `nameStuckReservation` out of the hold refusal.
- Put the two bounds (honest cost and the never-returns worst case) and the per-block cooldown tripwire as a `NOTE:` at the hold map.
- Write the two specs above; run `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/db-core test` in the foreground.
- Update docs/correctness.md Theorem 9: replace the "Bound" paragraph's deferral with the hold, its residual (members that missed the refusals), and the Byzantine comparison against the existing pend reservation; docs/internals.md: one bullet beside the `held` bullets saying where a hold comes from and that it is not a stuck reservation; packages/db-p2p/docs/cluster.md: the knob and its default; docs/debugging.md if it lists the member's refusal log lines.
- Replace the `feat-occ-priority-reservation` mentions in `race-resolution.ts` and `coordinator-repo.ts` with the hold's name and site.
