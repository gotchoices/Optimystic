description: Build the missing network piece that lets one peer ask another peer's group "who can do this job?" over a real connection, so that finding providers actually works between separate machines rather than only in the in-process test simulation.
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/cohort-topic/protocols.ts
  - packages/db-p2p/src/matchmaking/query-handler.ts
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
----

# Matchmaking seeker QueryV1 RPC transport over real libp2p

## Why this exists

The real-libp2p e2e tier (`substrate-e2e-real-libp2p-tier`) found that the matchmaking **seeker query path
is unbound in production**. A production `createLibp2pNode({ cohortTopic: { enabled: true } })` registers
the five cohort-topic protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) — but **no
`QueryV1` RPC handler**. So:

- A provider CAN register over the real cohort (confirmed in `substrate-real-libp2p.integration.spec.ts`:
  the registration lands in the routed primary's store and replicates over `/cohort-gossip`).
- A remote **seeker CANNOT read** that provider set over the wire: `SeekerWalkClient`'s
  `SeekerWalkTransport.query(treeTier)` seam has no production binding, `handleMatchmakingQuery`
  (`query-handler.ts`) has no production dialer, and `MatchmakingSeekerSessionDeps.queryCohort`
  (`module.ts`) is injected only by the mock harness.

The hang-out *decision* logic and the cold/sparse/hot walk regimes are already validated at the mock tier
(`matchmaking/mesh-walk.spec.ts`) and the simulator. What is missing is purely the **transport**: a real
libp2p protocol that carries a `QueryV1` to a cohort member and returns a `QueryReplyV1`, plus the seeker
walk client binding that dials it.

## What to build

- A new cohort-topic protocol id (e.g. `/optimystic/cohort-topic/1.0.0/query`) registered by the host
  (`host.ts`), whose handler decodes a `QueryV1`, resolves the served coord, and answers from the matching
  `CoordEngine.records(topicId)` via the existing pure `handleMatchmakingQuery` (which already takes
  `records` / `sign` / `topicTraffic` seams). The handler must apply the same per-coord scoping the register
  handler uses.
- A `SeekerWalkTransport.query(treeTier)` binding that dials that protocol against the routed cohort member
  (mirroring how `register` already routes), so `SeekerWalkClient.run` converges to a match over real sockets.
- Wire `MatchmakingSeekerSession` / `createMatchmakingQuorumDiscovery` (`module.ts`) to the real transport so
  the public session layer — not just the lower-level walk client — is driveable on a live node.

## Acceptance / use cases

- The `it.skip('[requires production wiring: matchmaking QueryV1 RPC handler …] a seeker hang-out walk
  queries real cohorts over real sockets and converges to a match')` in
  `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` becomes a real, passing gated test: a
  provider registers on a real cohort, a remote seeker runs the walk, queries the cohort over the new RPC,
  and converges to a match (regime-appropriate — assert convergence, not an exact hop count).
- The query handler re-validates each returned `ProviderEntryV1`'s `registrationSig` (a forged shard entry is
  dropped), matching the mock-tier sweep contract.
- Default `yarn test` stays green; the new coverage lives in the env-gated integration spec.

## Notes

- This is the seeker-side socket continuation of the mock-tier matchmaking work; the provider-directory half
  is already real (see the real-libp2p suite + `docs/matchmaking.md` §Real-libp2p e2e coverage).
- Anti-DoS for the query path already has a sibling concern (`tickets/backlog/matchmaking-query-rate-limit`);
  coordinate the rate-limit gate with this transport rather than duplicating it.
