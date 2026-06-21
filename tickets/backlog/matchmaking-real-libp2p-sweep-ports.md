description: Wire the "search many cohorts at once" fast path for matchmaking over real network connections, so a busy popular service can be found across the whole tree instead of just one starting point.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-p2p/src/matchmaking/aggregate-counts.ts
  - packages/db-core/src/matchmaking/sweep.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - docs/matchmaking.md
difficulty: hard
----

# Real-libp2p multi-cohort sweep ports (`sweepPorts`)

## Why this exists

The seeker query transport landed its **walk** half over real libp2p
(`createLibp2pMatchmakingTransport` / `createLibp2pMatchmakingSeekerSession` in
`matchmaking/query-transport.ts`, confirmed by §5c of `substrate-real-libp2p.integration.spec.ts`).
A live `MatchmakingSeekerSession` is therefore **walk-only**: `MatchmakingSeekerSessionDeps.sweepPorts`
is intentionally left unbound, and `createMatchmakingQuorumDiscovery.sweep` has no real-socket binding.

On a **hot** topic (one that has promoted, `childCohortCount > 0`) the single-cohort walk samples a
prefix-biased subset of providers; the design (`docs/matchmaking.md` §Multi-cohort sweep) escalates to a
sweep across the high-population tier-`d ≥ 1` shards, unioning the deduped, re-validated provider sets.
The pure sweep engine (`db-core` `runMultiCohortSweep`) and its mock-tier validation are already complete
(`11.8-matchmaking-sweep-adversarial-module`, `matchmaking-sweep-patience-budget`); what is missing is the
db-p2p binding of `MultiCohortSweepPorts` to real RPCs.

## What this needs

The sweep ports require the promoted-tree **`AggregateCountV1`** RPC — a threshold-signed attested
registered-provider count produced by serving tier-`d ≥ 1` cohorts — to pick which shards to sweep, plus
fan-out `QueryV1` dials across those shards. `AggregateCountV1` production is gated on the cohort-topic
**promotion** follow-ons (a real promoted tree must exist before a tier-`d ≥ 1` shard can attest a count),
so this is a future concern rather than presently-actionable work — hence backlog, not plan/implement.

When the promotion path is real, this ticket should:

- Bind `MultiCohortSweepPorts` (the `aggregateCounts` + per-shard `query` seams) to libp2p RPCs in
  `query-transport.ts`, and pass `sweepPorts` through `createLibp2pMatchmakingSeekerSession` (and the
  `createMatchmakingQuorumDiscovery` binding) so a live session escalates walk → sweep on a hot topic.
- Add a gated real-socket e2e (a §5d alongside §5c): stand up a **promoted** matchmaking tree, register
  providers across multiple tier-1 shards, and assert the sweep unions providers no single-cohort walk
  would have seen — with forged entries still dropped seeker-side by `verifyProviderEntry`.
- Drop the "multi-cohort sweep remains deferred" caveats in `docs/matchmaking.md`
  (§Seeker query note + §Real-libp2p e2e coverage) once confirmed.

## Related deferred hardening (smaller, can fold in or split)

- **Real `RenewV1` keep-alive on the walk.** `SeekerWalkTransport.renew()`/`withdraw()` are documented
  no-ops in the live transport (fine for the single-tier-0 milestone, where the seeker's query does not
  depend on its own brief record). A multi-tier walk with a long hang-out that escalates past the root
  would want a real `RenewV1` ping so the seeker record does not TTL-expire mid-walk.
- **Multi-tier walk-down driven by the real `d_max` estimate + `selfServe`.** §5c drives the walk at
  `dMax: 0`; the transport already throws loudly on a self-routed primary when `selfServe` is absent.
  Wiring `selfServe` from the seeker's own host and driving from `estimateDMax` would exercise the
  tier-`d ≥ 1` walk-down over real sockets.
