description: When several nodes race to write the first entry of the same shared collection, occasionally every writer loses the tie-break — and after that none of them can ever succeed, because each writer's own half-finished first attempt permanently blocks its retries.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts:1246-1281 (validatePendOperations staleness check — refuses a re-pend of a block the SAME action already committed; the sibling pending-rival check below it explicitly excludes self, this branch does not)
  - packages/db-core/src/transactor/network-transactor.ts:682-735 (commit ordering — private/new tail block commits durable BEFORE the contested shared block, so losing the shared-block race leaves a durable orphan)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1488 (classifyStaleRejection — same staleness wording; check whether the own-action carve-out is needed here too)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (the intermittent reproducer — "should handle concurrent writes from multiple nodes"; do not weaken it)
  - tickets/.logs/1-consensus-pend-refusal-commit-tier-verify3.refpeer.log (captured wedge run, 2026-08-31; pruned after ~14 days — key lines quoted below)
difficulty: hard
repro: verified
----

# All-lose conflict race + torn first commit = permanent wedge for every concurrent writer

## What was observed (verified, log captured)

Three nodes concurrently append the first entry to a freshly created diary
(reference-peer "should handle concurrent writes from multiple nodes"). Under heavy
DEBUG logging (which slows the rounds and shifts interleaving), ALL THREE writes failed
with:

```
sync for collection concurrent-test-… exhausted 10 retries: stale revision: block
<writer's own chain-node block> at rev 1, requested rev 1, last seen block <same> at rev 1
```

and the diary ended with ZERO entries. The same test passes cleanly without DEBUG
(re-run twice: full workspace sweep and a scoped run, 3/3 writes landed, ~2.6s). The
failure is a timing-dependent race, not a deterministic regression.

Important framing: the commit-tier acknowledgement fix (see
`review/1-consensus-pend-refusal-commit-tier`) held in both outcomes — no write was
acknowledged and then lost. In the wedge run zero writes were acknowledged and zero
landed. This ticket is about liveness (writers wedge forever), not durability.

## Mechanism, step by step (from the captured log)

Each append transaction touches TWO blocks: the shared collection header
(`concurrent-test-…`, contested by all three writers) and a fresh private chain-node
block holding the entry (unique per writer: `On6P09…`, `sdoIHU…`, `IB0mH8…`).

1. All three writers pend both blocks at rev 1 (`storage-repo pend … blockIds=2 rev=1`)
   and all pends reach consensus — the header contention is only discovered at commit.
2. `NetworkTransactor.commit` commits the TAIL (private chain-node) block first, then
   sweeps the remaining blocks (the shared header). Each writer's private-block commit
   REACHES CONSENSUS AND BECOMES DURABLE on all 3 members
   (`storage-repo commit actionId=… rev=1 blockIds=1`, three times, one group per writer).
3. Each writer's header commit then loses the conflict race:
   `cluster-tx:conflict-race-lost` … `'Conflict race lost: 2/3 member(s) hold a
   conflicting winner (1/2 approvals)'`. With three contenders the members' conflict
   votes split so that EVERY contender is told it lost — there is no winner. The header
   is never committed by anyone (zero `storage-repo commit` lines for it; final reads
   show `cluster-fetch:no-quorum holders: 0`).
4. Each writer cancels and re-drives (the conversion arms from the commit-tier fix
   surface the loss correctly). But since nobody won, `update()` finds the collection
   unchanged, so the retry re-stages the SAME transform: same private block id, same
   requested rev 1, same actionId (verified: retries reuse the actionId — e.g.
   `kRNa8EOW…` pended 3 times with one id).
5. The retry's pend is refused by `validatePendOperations`' staleness check:
   `latestRev >= pendRequest.rev` → `stale revision: block <own block> at rev 1,
   requested rev 1`. The rev-1 holder of that block is THIS VERY ACTION's own step-2
   commit. The check has no own-action carve-out — unlike the pending-rival check
   directly below it, which deliberately excludes self ("Self is excluded so a
   redelivered pend for this same action stays approvable").
6. Every retry of every writer is refused the same way. After 10 attempts each writer
   throws `SyncRetryExhaustedError`. Permanent wedge; zero entries.

The wedge needs BOTH ingredients: the all-lose race (step 3) so that no winner advances
the shared block and retries regenerate identical transforms, and the torn commit
(step 2) so that each writer's own durable orphan poisons those retries. When a winner
exists (the common case — this is what the db-p2p mesh spec exercises, and what the
passing runs show), losers re-drive against the winner's advanced chain, their retry
transform differs, and the orphaned private block is mere garbage, not poison.

## Root-cause sites and candidate directions (design choice needed — do not just patch blind)

- Smallest change: give the staleness check in `validatePendOperations` the same
  self-exclusion its sibling already has — when `latest.rev === pendRequest.rev` AND the
  action that committed that rev IS this pend's action (the rev→action machinery from the
  commit-tier fix — `IRevisionActionReader` / `confirmCommitRivalAgainstLocal` — already
  answers this), treat the pend as a redelivery, not staleness. That lets a torn
  transaction complete on re-drive instead of being refused by its own half. Check
  whether `coordinator-repo.ts:1488` (classifyStaleRejection) needs the mirror change.
- Ordering change: commit the CONTESTED/shared blocks before fresh private blocks in
  `NetworkTransactor.commit`, so losing the shared-block race leaves nothing durable
  behind. Bigger blast radius — the current tail-first order is documented as deliberate
  (tail is the reactivity/linchpin anchor); weigh before touching.
- Heaviest: durably invalidate the orphaned committed blocks when the transaction loses
  (the durable-invalidation cascade, docs/right-is-right.md). Correct end-state but the
  cascade is not fully wired (see that doc).

Also worth a look while in there: whether an all-lose conflict round (step 3) is
avoidable or at least should randomize/bias retry so the round after has a likely winner
— today the livelock relies on it. Even with a self-carve-out, an all-lose round costs a
full retry cycle for every writer.

## Constraints

- The reference-peer test stays as-is in shape and strength (no timeout widening, no
  retry-count changes to make it "pass").
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits a different
  arm of the same `validatePendOperations` function — expect a textual conflict for
  whoever lands second; the two tickets are otherwise independent.
- Acknowledged-means-durable is settled behavior — whatever unwedges retries must not
  re-introduce acknowledging a torn action (see the non-tail sweep comment in
  `network-transactor.ts:714-729`).
