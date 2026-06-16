description: The multi-cohort "sweep" step of voting-quorum discovery ignores its time budget — it can keep querying shards long after the caller's patience window should have closed, so a quorum assembly can run much longer than promised.
files:
  - packages/db-core/src/matchmaking/multi-cohort-seeker.ts (runMultiCohortSweep / MultiCohortSweepOptions — needs a deadline/patience budget)
  - packages/db-p2p/src/matchmaking/module.ts (createMatchmakingQuorumDiscovery.sweep — drops req.patienceMs today)
  - packages/db-core/src/matchmaking/voting-quorum.ts (assembleQuorum — passes the draining budget to the sweep hop expecting it to be honoured)
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts (reference: the walk leg DOES honour patienceMs via a wall-clock deadline)
----

## Problem

The voting-quorum `QuorumDiscovery` seam (`docs/matchmaking.md` §Voting-quorum assembly) defines two
hops, each carrying a `patienceMs` "budget remaining for this hop":

```ts
export interface QuorumDiscoveryRequest {
  readonly topicId: Uint8Array;
  readonly wantCount: number;
  readonly patienceMs: number;   // "drains across walk → sweep"
}
```

`VotingQuorumAssembler.assembleQuorum` fixes a wall-clock deadline at entry and passes the **remaining**
slice to `walk`, then to `sweep` — relying on each port to stop when its slice is exhausted.

- The **walk** leg honours it: `createMatchmakingQuorumDiscovery.walk` threads `req.patienceMs` into
  `SeekerWalkClient`, which fixes a deadline and drains it across hops + hang-out.
- The **sweep** leg does **not**: `createMatchmakingQuorumDiscovery.sweep` calls `runMultiCohortSweep`,
  whose `MultiCohortSweepOptions` has **no patience/deadline field**. `req.patienceMs` is silently
  dropped. `runMultiCohortSweep` then issues `fetchAggregate()` + up to `maxShards` (default 16)
  sequential `queryShard()` RPCs with no deadline check between them.

So `assembleQuorum`'s intended "the sweep stops when patience drains" does not hold. In the worst case a
hot-topic quorum assembly blocks for roughly `maxShards × per-RPC-timeout` on the sweep leg regardless of
how little patience remained when the sweep started — well past the caller's window. It is bounded (not an
infinite hang), but it is **not** the fine-grained budget the seam advertises, and a coordinator that set
e.g. a 30 s patience can overshoot substantially when each shard RPC is slow.

This was not caught at implement time because the db-core voting-quorum module was built against an
injected mock `QuorumDiscovery` (the real walk/sweep had not yet landed), and the mock returns instantly
without consuming the budget. The gap only appears once the real db-p2p adapter (which landed with
`matchmaking-sweep-adversarial-module`) binds the sweep to `runMultiCohortSweep`.

## Expected behaviour

The sweep hop must honour the patience budget it is handed, the same way the walk hop does:

- `runMultiCohortSweep` should accept a deadline/patience budget (a `patienceMs` plus injected `clock`,
  or an `AbortSignal`/deadline) and stop electing/querying further shards once it is exhausted, returning
  whatever it has unioned so far (a partial sweep is acceptable — `assembleQuorum` already treats a short
  result as `metTarget = false`).
- `createMatchmakingQuorumDiscovery.sweep` must thread `req.patienceMs` (and the shared `clock`) into that
  parameter instead of dropping it.

The shard fan-out cap (`maxShards`) stays as the secondary bound; the deadline is the primary one.

## Notes / scope

- Per-shard RPC cancellation (aborting an in-flight `queryShard` mid-call) is a nice-to-have; the minimum
  bar is to **stop starting new shard queries** once the deadline passes. Note whichever is implemented.
- Keep the change additive: the budget should be optional on `runMultiCohortSweep` so existing
  `multi-cohort-seeker.spec.ts` callers (which pass no budget) still get the current "query all selected
  shards" behaviour when no budget is supplied.
- Add a test that a sweep with an already-drained budget queries zero (or only the in-flight) shards and
  returns promptly, and one that a generous budget queries all selected shards as today.
- After the fix, revisit the `assembleQuorum` docstring in `voting-quorum.ts` (softened during review to
  note the sweep leg was budget-unaware) and restore the stronger "never blocks past patienceMs" wording.
