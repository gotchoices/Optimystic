description: Wire the "search many cohorts at once" fast path for matchmaking over real network connections, so a busy popular service can be found across the whole tree instead of just one starting point. Blocked on two pieces of plumbing that don't exist yet.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-p2p/src/matchmaking/aggregate-counts.ts
  - packages/db-p2p/src/matchmaking/protocols.ts
  - packages/db-core/src/matchmaking/sweep.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - docs/matchmaking.md
difficulty: hard
----

# Real-libp2p multi-cohort sweep ports (`sweepPorts`)

## Plain-language summary

When a seeker looks for providers of a *popular* service, walking from one starting cohort
only samples a biased slice of who's out there. The "sweep" is the fast path that fans out to
the busy shards of the tree at once and unions everyone it finds. The pure sweep logic already
exists and is tested; what's missing is connecting it to **real network calls** so a live seeker
actually escalates walk → sweep over sockets.

This can't be built yet — it depends on two things that don't exist in the codebase today
(see *What blocks this*). File it here so it surfaces the moment those land; it is **not** a
human decision and **not** an external dependency, so it is not `blocked/`.

## What's already done (verified 2026-07)

- **Walk half over real libp2p is live.** `createLibp2pMatchmakingTransport` /
  `createLibp2pMatchmakingSeekerSession` in `matchmaking/query-transport.ts` bind the seeker
  register + one-shot `QueryV1` over real sockets, re-validating every forwarded entry
  (`verifyEntry` → `verifyPeerSig`). Exercised by §5c of
  `substrate-real-libp2p.integration.spec.ts`.
- **Pure sweep engine is done.** `db-core` `runMultiCohortSweep` (`db-core/src/matchmaking/sweep.ts`)
  plus its mock-tier validation (patience/budget, adversarial module) — the dedup + re-validate +
  union logic the ports feed.
- **Aggregate-count *builder* is done.** `matchmaking/aggregate-counts.ts` `buildAggregateCount`
  produces the threshold-signed `AggregateCountV1` from injected root per-shard counts — but it is
  **unit-only**; nothing calls it over a wire.
- **The session already has the escalation hook.** `MatchmakingSeekerSession.walk` (`module.ts`)
  escalates to `runMultiCohortSweep` **only when `sweepPorts` is bound**. `sweepPorts` is
  intentionally left `undefined` in `createLibp2pMatchmakingSeekerSession` — so a live session is
  correctly walk-only today. Same for the `createMatchmakingQuorumDiscovery` binding.

## What blocks this (two missing pieces, both in-repo)

Neither is a human/external dependency — both are unwritten code elsewhere in the tree:

1. **A real `AggregateCountV1` serve RPC.** There is no protocol id for it
   (`matchmaking/protocols.ts` defines only `/query`), no serve handler, and no host binding that
   feeds `buildAggregateCount` its `shardCounts` (per-tier-1-shard provider counts from child-cohort
   accounting), `treeDepth`, `cohortEpoch`, and the cohort threshold signer. `host.ts:2052-2054`
   itself flags this: *"When the AggregateCountV1 sweep RPC lands it is another genuine cohort query
   and should bump the same [`recordQuery`] seam."* The sweep ports pick which shards to sweep from
   this attested count, so without it there is nothing to bind.

2. **A real promoted multi-tier tree over libp2p.** `AggregateCountV1` is only produced when
   `treeDepth >= aggregate_count_minimum_tier` (default 1) — i.e. a cohort that has actually
   promoted and has tier-1 children. Driving real promotion past `cap_promote` so a live tier-1
   child instantiates and completes a child-link RPC over real sockets is explicitly deferred to the
   "real-libp2p tier / CI" (see `cohort-topic-scale-lifecycle.spec.ts` skipped cases): the child-link
   RPC frequently stays `awaiting_parent` in the mock mesh, so it is not reliably driveable in-agent.
   Promotion/demotion, child-link recording, and gossip convergence *are* done at unit + gossip level
   (`cohort-topic-parent-child-link`, `cohort-topic-child-link-replicate-unlink`); what is missing is
   the full live promotion path.

Once BOTH exist, this ticket is implementable and should probably be split into
`prereq:`-chained pieces (the serve RPC + host binding is one coherent change; the seeker-side
port binding + e2e is another).

## What this ticket must do (once unblocked)

- **Bind `MultiCohortSweepPorts` to real RPCs** in `query-transport.ts`: the `aggregateCounts` seam
  dials the promoted root's new `AggregateCountV1` RPC (verifying the threshold signature seeker-side),
  and the per-shard `query` seam fans out `QueryV1` dials across the high-population tier-1 shards the
  aggregate count identifies.
- **Pass `sweepPorts` through** `createLibp2pMatchmakingSeekerSession` and the
  `createMatchmakingQuorumDiscovery` binding so a live session escalates walk → sweep on a hot topic
  (`childCohortCount > 0`).
- **Add a gated real-socket e2e (§5d, alongside §5c)** in
  `substrate-real-libp2p.integration.spec.ts`: stand up a **promoted** matchmaking tree, register
  providers across multiple tier-1 shards, assert the sweep unions providers no single-cohort walk
  would have seen, and assert forged entries are still dropped seeker-side by `verifyProviderEntry`.
- **Drop the deferral caveats** in `docs/matchmaking.md` (§Seeker query note + §Real-libp2p e2e
  coverage — the "multi-cohort sweep remains deferred" lines) once confirmed.

## Edge cases & interactions (for whoever implements)

- **Aggregate-count verification, not trust.** The seeker must verify the `AggregateCountV1` threshold
  signature (`>= minSigs` signers) before acting on `shardCounts`; a forged or single-signed count must
  not steer the sweep. Log-bucketed counts are coarse by design — the port picks *which* shards, the
  per-shard `QueryV1` supplies the real entries.
- **Cold / unpromoted root.** `buildAggregateCount` returns `undefined` below the depth gate; the
  seeker must fall back cleanly to the single-cohort walk sample (no throw, no hang), matching the
  existing `NoState` fallback.
- **Fan-out partial failure.** Some shard dials will fail/time out or return empty; the sweep must
  union what it got and stay within `patienceMs` rather than block on the slowest shard.
- **Dedup across walk ∪ sweep.** The union keys on `participantId`; a provider appearing in both the
  walk result and a swept shard must not double-count. (`module.ts` `walk` already merges into a
  `Map` — the e2e should assert this holds across the real path.)
- **Query accounting.** The `AggregateCountV1` serve is a genuine cohort query — it must bump the same
  `engine.recordQuery` seam as `QueryV1` (`matchmaking-query-accounting-seam`), gated after any
  rate-limit / no-engine guard, so it feeds `queriesPerMin` without inflating on dropped queries.
- **Self-routed shard primary.** As with the walk's `dialQuery`, a swept shard whose FRET-routed
  primary is the seeker itself cannot be dialed over libp2p — route through `selfServe` or skip it
  loudly, never silently hang.

## Related deferred hardening (fold in or split when picked up)

Both are walk-side and share the same gate (a real promoted multi-tier tree over libp2p), which is why
they live here rather than as separate active tickets:

- **Real `RenewV1` keep-alive on the walk.** `SeekerWalkTransport.renew()` / `withdraw()` are
  documented no-ops in the live transport (fine for the single-tier-0 milestone, where the seeker's
  query does not depend on its own brief record). A multi-tier walk with a long hang-out that escalates
  past the root wants a real `RenewV1` ping so the seeker record does not TTL-expire mid-walk.
- **Multi-tier walk-down driven by the real `d_max` estimate + `selfServe`.** §5c drives the walk at
  `dMax: 0`; the transport already throws loudly on a self-routed primary when `selfServe` is absent.
  Wiring `selfServe` from the seeker's own host and driving from `estimateDMax` would exercise the
  tier-`d ≥ 1` walk-down over real sockets.
