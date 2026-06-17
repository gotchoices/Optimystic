description: The multi-cohort "sweep" step of voting-quorum discovery ignores its time budget — it can keep querying shards long after the caller's patience window should have closed. Give the sweep a deadline and have the caller pass the remaining budget into it, so a quorum assembly stops on time.
prereq:
files:
  - packages/db-core/src/matchmaking/multi-cohort-seeker.ts (runMultiCohortSweep / MultiCohortSweepOptions — add the budget)
  - packages/db-p2p/src/matchmaking/module.ts (createMatchmakingQuorumDiscovery.sweep + MatchmakingSeekerSession.walk — thread the budget)
  - packages/db-core/src/matchmaking/voting-quorum.ts (assembleQuorum docstring — restore the stronger wording)
  - packages/db-core/test/matchmaking/multi-cohort-seeker.spec.ts (new budget tests)
  - packages/db-p2p/test/matchmaking/module.spec.ts (sweep threads req.patienceMs)
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts (reference pattern: clock + deadline + remaining())
difficulty: easy
----

## Summary

The voting-quorum `QuorumDiscovery` seam (`docs/matchmaking.md` §Voting-quorum assembly) defines two
hops — `walk` then `sweep` — each carrying a `patienceMs` "budget remaining for this hop", drained from a
wall-clock deadline `VotingQuorumAssembler.assembleQuorum` fixes at entry. The **walk** leg honours its
slice (`SeekerWalkClient` fixes `deadline = clock() + patienceMs` and checks `remaining()` before every
hop + hang-out poll). The **sweep** leg does **not**: `runMultiCohortSweep` has no patience/deadline
input, and `createMatchmakingQuorumDiscovery.sweep` silently drops `req.patienceMs`. So the sweep runs
`fetchAggregate()` + up to `maxShards` (default 16) sequential `queryShard()` RPCs with no deadline check,
regardless of how little patience remained when the sweep started.

The result is bounded (≤ `maxShards × per-RPC-timeout`), not an infinite hang, but it is **not** the
fine-grained budget the seam advertises: a coordinator that set e.g. 30 s patience can overshoot
substantially on the sweep leg when each shard RPC is slow.

## Root cause (confirmed by inspection)

This is a design-gap bug, not a logic error — the budget parameter does not exist to thread, so there is
nothing to "reproduce" against the current API (any repro would have to first add the very `clock` the fix
introduces). The evidence is structural:

- `packages/db-core/src/matchmaking/multi-cohort-seeker.ts`
  - `MultiCohortSweepOptions` (≈ lines 116-131) has fields `topicId / wantCount / verifyEntry / filter /
    targetTier / maxShards / overprovision` — **no** patience, deadline, or clock.
  - `runMultiCohortSweep` (≈ lines 187-199) does `for (const shard of selected) { await
    ports.queryShard(...) }` with **no** deadline check between iterations.
- `packages/db-p2p/src/matchmaking/module.ts`
  - `createMatchmakingQuorumDiscovery.sweep` (≈ lines 343-353) builds the sweep opts from
    `req.topicId / req.wantCount / verifyEntry / filter` and never reads `req.patienceMs` (nor
    `deps.clock`).
  - `MatchmakingSeekerSession.walk` (≈ lines 278-287) has the same gap on the public-session path.
- Contrast `packages/db-p2p/src/matchmaking/seeker-walk-client.ts` — the canonical pattern to mirror:
  injected `clock` (default `Date.now`), `this.deadline = this.clock() + this.patienceMs`, and
  `private remaining() { return Math.max(0, this.deadline - this.clock()); }` gating every hop.

Why it slipped through implement: db-core voting-quorum was built against an injected **mock**
`QuorumDiscovery` that returns instantly without consuming the budget; the gap only manifests once the
real db-p2p adapter binds the sweep to `runMultiCohortSweep` (which landed with
`matchmaking-sweep-adversarial-module`). The `assembleQuorum` docstring was already softened during that
review to admit "the multi-cohort sweep leg is currently bounded by its shard fan-out rather than the
budget — see the sweep-patience follow-up" (voting-quorum.ts ≈ lines 271-280) — this ticket is that
follow-up.

## Fix design

Mirror the walk leg's wall-clock-deadline pattern, kept **additive** (optional) so existing callers that
pass no budget keep today's "query all selected shards" behaviour.

### db-core — `runMultiCohortSweep` honours an optional budget

Add two optional fields to `MultiCohortSweepOptions`:

```ts
export interface MultiCohortSweepOptions {
  // ...existing fields...
  /** Patience budget (ms) for the whole sweep; drains across the shard fan-out. Omitted ⇒ unbounded
   *  (query every selected shard, today's behaviour). Mirrors the walk leg's budget. */
  readonly patienceMs?: number;
  /** Wall clock (unix ms); injectable for tests. Default `Date.now`. Only consulted when `patienceMs` set. */
  readonly clock?: () => number;
}
```

In `runMultiCohortSweep`:
- When `patienceMs` is supplied, fix `const deadline = clock() + patienceMs` once, and define
  `const remaining = () => Math.max(0, deadline - clock())`.
- **Stop starting new shard queries** once the budget is exhausted: check `remaining() <= 0` (equivalently
  `clock() >= deadline`) at the top of the shard loop and `break` — return whatever unioned so far.
  `shardsQueried` then reflects only the shards actually queried; `selectedShards` still reflects the full
  election (so a partial sweep is visible).
- Recommended early-out: if the budget is already drained at entry (`remaining() <= 0`), skip
  `fetchAggregate()` too and return `emptyResult(false, false)` so an already-expired sweep returns
  promptly without even the aggregate RPC. (A drained budget arriving at the sweep means the walk already
  consumed all patience — there is no point spending an RPC on an aggregate we have no time to act on.)
- When `patienceMs` is **absent**, behave exactly as today (no clock calls, query all selected shards).

Per-shard RPC **cancellation** (aborting an in-flight `queryShard` mid-call) is out of scope — the minimum
and chosen bar is to stop *starting* new shard queries once the deadline passes. Document this in the
function docstring. (If a later ticket wants true cancellation, thread an `AbortSignal` into
`MultiCohortSweepPorts.queryShard` then — not here.)

No new exports are required: `runMultiCohortSweep` and `MultiCohortSweepOptions` are already exported; the
new fields are optional additions to the existing interface.

### db-p2p — thread the budget at the two call sites

- `createMatchmakingQuorumDiscovery.sweep` (the draining-budget seam — primary fix): pass
  `patienceMs: req.patienceMs` and `...(deps.clock !== undefined ? { clock: deps.clock } : {})` into the
  `runMultiCohortSweep` opts. This restores `assembleQuorum`'s intended "the sweep stops when patience
  drains" — the assembler already passes `remaining()` as `req.patienceMs` to the sweep hop, and now the
  sweep honours it.
- `MatchmakingSeekerSession.walk` (secondary, public-session path): also pass a budget so the sweep is
  bounded by patience there too. Note this path does **not** track a draining remainder (the
  `SeekerWalkClient` ran on its own deadline), so passing `want.patienceMs` gives the sweep a *fresh* full
  budget — a coarser bound than the quorum path's draining slice, but still an honest "never run the sweep
  longer than patienceMs" guarantee and strictly better than unbounded. Thread `deps.clock` alongside.
  Document this coarser-bound tradeoff in a comment.

### db-core — restore the docstring

In `voting-quorum.ts`, `assembleQuorum`'s docstring (≈ lines 271-280) currently ends with the softened
caveat: "*(Honouring that budget is the port's duty: the single-cohort walk enforces it; the multi-cohort
sweep leg is currently bounded by its shard fan-out rather than the budget — see the sweep-patience
follow-up.)*" Replace it with the stronger guarantee now that both legs honour the budget — e.g. note that
both the walk and the sweep stop when their patience slice drains, so assembly never blocks materially
past `patienceMs` (the residual being one in-flight shard RPC, not the full fan-out). Keep wording honest
about the in-flight-RPC residual; do not over-promise hard real-time.

## Tests

`packages/db-core/test/matchmaking/multi-cohort-seeker.spec.ts` (extend the existing
`runMultiCohortSweep` describe; reuse `MockSweepPorts`, `aggregate(...)`, `makeEntry`, `fakeVerify`):

- **already-drained budget queries zero shards and returns promptly.** Build a virtual clock
  `let now = 0; const clock = () => now`. Inject `queryShard` that advances `now` (so the first query
  alone would blow the budget — or simply start with `patienceMs: 0`). Assert `ports.queriedShards` is
  empty (or only the single in-flight shard, matching whichever stop-point is implemented) and the call
  resolves. With the recommended entry early-out, `patienceMs: 0` ⇒ zero `queryShard` calls and
  `aggregateAvailable === false`.
- **budget that drains mid-fan-out stops electing further shards.** Aggregate electing ≥ 3 shards; a
  `queryShard` that advances the virtual clock by a fixed step each call; a `patienceMs` that covers ~1–2
  shards. Assert `shardsQueried` < `selectedShards.length` and the returned providers are the union of
  only the queried shards.
- **generous budget queries all selected shards (parity with today).** Same multi-shard aggregate, large
  `patienceMs`, clock that barely advances. Assert all selected shards queried — equivalent to the
  existing "unions providers across selected shards" test, confirming the budget path is a no-op when
  ample.
- **no budget supplied ⇒ unchanged behaviour.** The existing tests already cover this; confirm they still
  pass untouched (the new fields are optional).

`packages/db-p2p/test/matchmaking/module.spec.ts` (quorum-discovery binding describe):

- Extend the sweep mock to **record the `patienceMs` it was invoked under** (e.g. have the
  `createMatchmakingQuorumDiscovery` deps inject a `clock` from `virtualTime()` and a `sweepPorts` whose
  `queryShard` advances the clock), then assert that a `sweep({ ..., patienceMs })` with a tiny budget
  stops early while a generous one queries the shard — i.e. `req.patienceMs` is now actually threaded
  through. At minimum, assert the existing sweep test still returns the unioned entries with
  `childCohortCount === 0` (no regression) and add one asserting the small-budget early stop.

## TODO

- [ ] Add optional `patienceMs?: number` and `clock?: () => number` to `MultiCohortSweepOptions` in
  `packages/db-core/src/matchmaking/multi-cohort-seeker.ts`, with doc comments mirroring the walk leg.
- [ ] In `runMultiCohortSweep`: fix a `deadline` when `patienceMs` is set, add `remaining()`, and `break`
  the shard loop once the budget is exhausted; add the entry early-out (skip `fetchAggregate` on an
  already-drained budget). Leave behaviour identical when `patienceMs` is absent. Update the function
  docstring to state the "stop starting new shard queries" bar (no in-flight cancellation).
- [ ] In `packages/db-p2p/src/matchmaking/module.ts` `createMatchmakingQuorumDiscovery.sweep`: pass
  `patienceMs: req.patienceMs` and `clock` (from `deps.clock`) into the `runMultiCohortSweep` opts.
- [ ] In `MatchmakingSeekerSession.walk`: pass `patienceMs: want.patienceMs` and `clock` into the sweep
  opts, with a comment noting it is a fresh (coarser) bound, not a draining remainder.
- [ ] In `packages/db-core/src/matchmaking/voting-quorum.ts`: restore the stronger "both legs honour
  patienceMs" wording in `assembleQuorum`'s docstring, keeping the in-flight-RPC residual caveat honest.
- [ ] Add the budget tests to `multi-cohort-seeker.spec.ts` (drained → zero/one shard; mid-fan-out stop;
  generous → all shards; no-budget parity).
- [ ] Add/extend the sweep-binding test in `packages/db-p2p/test/matchmaking/module.spec.ts` to prove
  `req.patienceMs` is threaded (small-budget early stop; no regression on the unioned-entries assertion).
- [ ] Build + run the affected packages' tests:
  - `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core-test.log`
  - `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`
  (confirm `multi-cohort-seeker`, `module`, and `mesh-sweep` specs are green; the mesh-sweep specs pass no
  budget, so they must remain unchanged.) Verify package/test runner commands against the repo's
  `package.json` scripts first.
