description: A writer that keeps losing to a stream of quicker writers on the same collection can retry until it gives up, because each quick write lands and leaves before the slow one's attempt arrives. After a few such losses, the machines storing the collection now briefly hold the next slot for the slow writer, so it gets one clear chance to land.
architecture: docs/correctness.md#theorem-9-progress-under-contention
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`staleRevisionAgainst`, `noteStaleLoss`, `noteStaleLossUnvoted`, `judgeSlotHolds`, `standingSlotHold`; the `staleLosses`, `countedStaleLosses` and `slotHolds` maps; the stale branch of `validatePendOperations`, the hold check ahead of the pending-rival scan, and the `Rejected` arm of the phase loop)
  - packages/db-core/src/transaction/transaction.ts (`SlotHoldAfterLosses`), packages/db-core/src/transaction/index.ts (its export)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.slotHoldWindowMs`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`clusterPolicy.slotHoldWindowMs`, `DEFAULT_SLOT_HOLD_WINDOW_MS`, `resolveSlotHoldWindowMs`, the resolved field)
  - packages/db-p2p/src/cluster/race-resolution.ts and packages/db-p2p/src/repo/coordinator-repo.ts (comments that named the deferred follow-up now name the hold)
  - packages/db-p2p/test/cluster-slot-hold.spec.ts (member-level, injected clock), packages/db-p2p/test/aged-writer-slot-hold.spec.ts (mesh, 5 s alone then 20 s contended; control arm behind `RUN_LONG_TESTS_CONTROL=1`), packages/db-p2p/test/cluster-policy.spec.ts (the knob's resolution)
  - docs/correctness.md (Theorem 9 "Bound" and "The slot hold"), docs/internals.md (the bullet after the `held` reservation bullet under Key Invariants), packages/db-p2p/docs/cluster.md (the knob), docs/debugging.md (the `cluster-member` namespace row)
difficulty: hard
----
# Slot hold for an aged writer

## What landed

Implemented in `ticket(implement): slot-hold-for-an-aged-writer`, reviewed here. A storage member that has refused one action's pend as stale `SlotHoldAfterLosses` times (three) holds the next slot of every block that pend named for the action, in memory, for `slotHoldWindowMs` (default 3000 ms, `0` disables). Until the action's own pend consumes the hold, every other action's pend of the block is answered with the same `held` vote a storage reservation produces, so the coordinator and the writer handle it with the retry they already have and nothing changes on the wire. The hold produces refusals only, never approvals, so the consensus and partition safety arguments are untouched.

A member counts every refused pend of the action whose promise round reached it, voting or not. On a two- or three-member cohort the coordinating member's stale reject is terminal before the others vote, and the coordinator is picked per block, so counting only one's own votes split a writer's losses across members when its log tail rolled over mid-cycle. A record that arrives already refused is re-judged against this member's own storage under the same rule and counted without a vote; nothing is signed, nothing is taken on trust, and one record counts once however many times the abandonment broadcast delivers it.

The knob flows through `resolveClusterPolicy` into the member's `consensusConfig` with no new wiring; the mesh harness picks it up through the same resolver. The writer-side half, retrying at once instead of backing off once a member holds for it, landed separately as `a-writer-that-lost-to-committed-rivals-stops-backing-off` and is reviewed under its own ticket.

Measured on a three-node in-process mesh (fast writer every 200 ms, slow writer once a second with every repo call delayed 120 ms, 20 s runs): every slow write lands in at most 4 pends, the fast writer keeps roughly three quarters of its uncontended pace, and 58 hold lines per run across the three members. The plan-stage control at the same delay saw nine of ten slow pends refused, one write giving up after 22.8 s and a 36 s outage over 40 s.

## Review findings

Read the implement diff first with fresh eyes, then the handoff. Checked: the grant, consume and lapse paths against the vote order in `evaluatePromise`; that a terminal local reject still fans the record out so the unvoted count is reached (it does, `prevoteLocalPromise` only removes self from the round); that one `held` vote sinks a pend on cohorts of two and three (super-majority at 0.75 is the whole cohort there); that a `held` vote neither counts as a rejection nor feeds the stuck-reservation counters on either side; the own-revision carve-out on both counting paths; the LRU bounds on the three maps; the knob's resolution and its failure on degenerate values; that the hold interacts safely with the in-memory race arbiter (a co-pending rival is settled by `findConflict` before validation runs, so the hold only ever sees sequential rivals); the docs the change touched and the ones it should have (all four reflect the new reality, and `yarn lint:docs` resolves every citation); and the two follow-on comments in `race-resolution.ts` and `coordinator-repo.ts`.

**Fixed inline (minor):**

- **The unvoted count skipped the expiry check the vote runs first.** `evaluatePromise` answers expiry ahead of admission and staleness, but `noteStaleLossUnvoted` went straight to admission, so an expired pend that arrived already refused on a small cohort would have been counted and could earn a hold for a writer that stops on `TransactionExpiredError` and never returns, idling its blocks for the whole window. The unvoted count now returns on `expiryOf(record)` like the vote does, and its doc comment says why.
- **The stale rule was written twice, the second copy with non-null assertions.** The vote and the unvoted count each spelled out "a committed revision at or above the requested one that is not this action's own". Both now call one module-level `staleRevisionAgainst(latest, pendRequest)` in `cluster-repo.ts`, which returns the refusing revision or `undefined`, so the two paths cannot drift on what a loss is and the `!` assertions are gone. No behaviour change on the voted path.
- **The mesh spec's throughput floor was a constant measured on one machine.** `fastCommits >= 50` in 20 s sat about 25% under what this machine produces, which the handoff itself flagged as a flake risk on slower CI. The spec now runs the fast writer alone for 5 s first, and asserts the contended count keeps half of that pace scaled to the run length. Half separates the hold's honest cost (measured at about three quarters) from a hold that idles the tail, with room for a slower machine. The spec costs 5 s more.

**Verified by running:** `yarn workspace @optimystic/db-p2p test` (3274 passing, 70 pending, 3 m), `yarn workspace @optimystic/quereus-plugin-optimystic test` on the rebuilt db-p2p (1001 passing, 14 pending, 3 m), `yarn workspace @optimystic/db-p2p build` (typechecks the source), `yarn lint`, `yarn lint:docs`. The two slot-hold specs were also run alone after the edits (12 passing, the control arm pending as designed). No pre-existing failures were seen.

**Major findings:** none. The design is sound for what it claims: the hold is a refusal-only, bounded, member-local mechanism, and the one place a class-level invariant was at risk (two copies of the stale rule) is now one function.

**Tests:** none cut. Each `it` in `cluster-slot-hold.spec.ts` pins a distinct branch of the contract (threshold, consume, lapse, carve-out, two aged writers, unvoted count, dedupe, per-block consumption, no stuck-reservation line, the off switch); none restates the implementation or verifies a mock. None added: the expiry fix mirrors a check the existing expiry specs already pin at the vote, and the refactor is covered by the eleven member-level cases plus the mesh run.

**Tripwires parked in code (unchanged from the handoff, confirmed in place):**

- Per-block cooldown between grants, if `cluster-member:slot-hold-expired-unconsumed` keeps recurring for one block: the `NOTE:` at the `slotHolds` map in `packages/db-p2p/src/cluster/cluster-repo.ts`, with both cost bounds.
- Counting all-lose rounds (no member refuses stale, so the hold never arms) if a high-contention workload ever exhausts `maxAttempts` on them: the comment at the `ConflictRaceLostError` arm in `packages/db-p2p/src/repo/coordinator-repo.ts`.

**Considered and left alone:**

- `cluster-slot-hold.spec.ts` duplicates about a hundred lines of harness from `cluster-pend-held-vote.spec.ts` (record builder, mock repo, vote verification) and says so in its header. Extracting a shared support module would touch a spec outside this ticket; worth doing the next time a third spec needs the same harness.
- The unvoted count is new I/O on a dead record (one admission check and one storage read per refused pend record per non-voting member). Bounded by the dedupe map, skipped when the window is 0, and two extra reads per slow loss on the measured shape. Not worth a cache.
- Restart forgets counts and holds (the aged writer loses up to three more times); a roll-over wastes a hold (one extra loss, inside the bound); a member on the previous release never holds (one upgraded member is enough on cohorts of three or fewer). All documented at the maps and in Theorem 9.
- The `SlotHoldAfterLosses + 2` pend bound in the mesh spec is reasoned, not observed (seven runs showed at most 4). If a 6-pend write ever appears with holds granted for it, the in-flight-rival case is the first thing to look at.
- The field questions from the plan ticket stand as answered there: every exhausted or torn write throws in this repository, so "the app reported nothing" on GitHub #18 was the host application clearing its composer on a failed write. Say so when closing #18.
- `tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md` still refers to `feat-occ-priority-reservation` by its old name in one sentence; a board file outside this ticket's scope.

**Conditional or speculative findings:** none beyond the tripwires above, which already had homes.
