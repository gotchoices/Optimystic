description: Made the multi-cohort provider sweep stop early once the caller's waiting-time budget runs out, so both halves of quorum discovery now respect how long the caller is willing to wait.
files:
  - packages/db-core/src/matchmaking/multi-cohort-seeker.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-core/src/matchmaking/voting-quorum.ts
  - packages/db-core/test/matchmaking/multi-cohort-seeker.spec.ts
  - packages/db-p2p/test/matchmaking/module.spec.ts
  - docs/matchmaking.md
----

# Multi-cohort sweep patience budget — completed

Threaded an optional patience (wall-clock) budget through `runMultiCohortSweep` so the multi-cohort
sweep leg of voting-quorum discovery honours the caller's time budget, mirroring the single-cohort
walk leg. Previously the sweep was bounded only by its shard fan-out ceiling, so a quorum assembler
that had already burned most of its patience on the walk could still block on a full shard fan-out.

## What shipped (implement stage)

- `MultiCohortSweepOptions` gained `patienceMs?` (budget for the whole sweep) and `clock?` (injectable
  for tests). When `patienceMs` is set, `runMultiCohortSweep` fixes `deadline = clock() + patienceMs`
  at entry, skips even `fetchAggregate` if the budget is already drained, and breaks the shard loop
  before *starting* any further query once `remaining() <= 0`. In-flight `queryShard` RPCs are not
  cancelled. Absent `patienceMs`, every elected shard is queried (unchanged behaviour).
- db-p2p `module.ts`: both call sites pass the budget — `createMatchmakingQuorumDiscovery.sweep`
  forwards the assembler's draining `req.patienceMs`; `MatchmakingSeekerSession.walk` passes a fresh
  `want.patienceMs` (see findings).
- `voting-quorum.ts`: `assembleQuorum` docstring updated — both legs now honour `patienceMs`, residual
  ≤ one in-flight shard RPC.

## Review findings

**Scope reviewed:** the full implement-stage diff (1ed9e3f) read first with fresh eyes — both db-core
and db-p2p source + test changes, the `voting-quorum.ts` assembler draining wiring it depends on, the
`QuorumDiscovery`/`SeekerWalkRequest` request types, and `docs/matchmaking.md` §Multi-cohort sweep /
§Voting-quorum assembly. Aspect angles checked: correctness of the deadline/break logic, SPP/DRY,
type safety (optional-field threading), error/edge paths, resource cleanup (in-flight RPCs),
performance (entry-drain short-circuit), and docs currency.

**Correctness — clean.** The deadline model is sound. Traced the mid-fan-out drain by hand
(deadline=150, +100ms/shard → 2 of 3 queried) and it matches the test. The entry short-circuit
(`patienceMs: 0` → skip `fetchAggregate`) is correct and saves an RPC the caller has no time to act on.
`remaining()` clamps to `>= 0`, so `<= 0` is effectively `=== 0`; the `deadline !== undefined` guard in
the entry check is redundant (an undefined deadline already yields `Infinity`) but harmless and reads as
belt-and-suspenders — left as-is.

**Build + tests — pass.** `yarn build` (tsc typecheck) green for both packages. Full suites:
db-core **827 passing**; db-p2p **733 passing, 27 pending** (integration, expected). The pending count
and a "parent unreachable" log line are pre-existing negative-path test output, unrelated to this diff.
(Root `lint` is a no-op echo — `tsc` is the type gate.)

**Test coverage — adequate, no gaps filed.** Happy path (generous budget → all shards), two edge cases
(drained-on-entry, drains-mid-fan-out), and the db-p2p end-to-end binding (threads `req.patienceMs`) are
covered. The `patienceMs`-absent regression is covered implicitly by every pre-existing sweep test (none
set a budget). The cold-root / failed-verify error paths are independent of patience and already tested;
adding patience variants would be redundant. No new tests warranted.

**Findings (minor, no action) / accepted design choices:**

1. **`MatchmakingSeekerSession.walk` passes a *fresh* `want.patienceMs` to the sweep, not a draining
   remainder.** Worst case the standalone seeker session spends up to ~2× `patienceMs` (full walk, then
   full sweep). This is a *deliberate, documented* choice (code comment + implement handoff): the
   standalone seeker prioritises a representative cross-ring sample over a hard time bound, and the
   `SeekerWalkClient` does not surface elapsed time for the session to drain against. Threading a
   draining remainder here would also risk the existing "walk escalates to the sweep on a hot topic"
   test (the walk can legitimately consume most of patience during hang-out, which would then starve the
   sweep). The **voting-quorum path** — the one with hard deadlines — *does* drain correctly
   (`assembleQuorum` → `discovery.sweep({ patienceMs: remaining() })`). Accepted as-is; not escalated.

2. **`aggregateTrusted` set when a verifier exists (multi-cohort-seeker.ts ~L190).** Flagged by the
   implementer. This block is *pre-existing* (not in this diff). The logic is correct: a failing
   verifier early-returns `emptyResult(true, false)`, so `aggregateTrusted = true` only survives to the
   final return when the verifier actually passed. No change.

3. **`emptyResult(false, false)` on the entry-drain path reports `aggregateAvailable = false`** even
   though an aggregate might exist — but the sweep never asked, so this is honest ("not determined"), and
   neither field is consumed by the `QuorumDiscovery.sweep` binding (only `result.providers` is used).
   No change.

**Fixed in this review pass (minor):**

- `docs/matchmaking.md` §Multi-cohort sweep implementation note now states that the sweep honours an
  optional `patienceMs` budget (stops starting new shard queries on drain; in-flight query not
  cancelled). The note previously described the orchestration without mentioning patience, so it was
  incomplete rather than wrong; updated to reflect the new reality. No source-code changes were needed.

## Follow-ups

None filed. In-flight `queryShard` cancellation (threading an `AbortSignal` into
`MultiCohortSweepPorts.queryShard`) remains a possible future enhancement noted by the implementer, but
the residual is bounded to a single in-flight RPC and does not warrant a ticket on its own.
