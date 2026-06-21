description: Add the client side of "who can do this job?" — let a peer run the matchmaking search over real network connections, asking a remote cohort for providers until it finds a match, and turn on the end-to-end test that proves it works between separate nodes.
prereq: matchmaking-query-rpc-cohort-serve
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-p2p/src/matchmaking/index.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - packages/db-p2p/src/testing/matchmaking-mesh-harness.ts
difficulty: hard
----

# Matchmaking `QueryV1` RPC — seeker walk client over real libp2p

## Why this exists

The prereq `matchmaking-query-rpc-cohort-serve` lands the cohort-side `/optimystic/matchmaking/1.0.0/query`
serve handler + the `CoordEngine.topicTraffic` accessor. This ticket lands the **client half**: a real
`SeekerWalkTransport` that dials the cohort over real sockets so `SeekerWalkClient.run` converges to a match,
plus the `module.ts` session/quorum-discovery binding, plus flipping the gated e2e test.

Today `SeekerWalkClient`'s `SeekerWalkTransport` seam (`register`/`query`/`renew`/`withdraw`) has **no
production binding** — only the mock harness (`src/testing/matchmaking-mesh-harness.ts`
`buildWalkTransport`) implements it, in-process. And `MatchmakingSeekerSessionDeps.walkTransport` /
`queryCohort` / `estimateDMax` (`module.ts`) are injected only by unit tests
(`test/matchmaking/module.spec.ts`).

## Design (resolved)

### A libp2p `SeekerWalkTransport` factory (`matchmaking/query-transport.ts`)

Add `createLibp2pMatchmakingTransport(deps)` returning the seams the session/walk consume. It is the
real-socket analogue of the mock harness's `buildWalkTransport` + `queryCohort`. `deps`:

- `node: Libp2p`, `fret` (with `assembleCohort(coord, wants) => string[]`), `selfPeerId: string`
- `key: PrivateKey` (the seeker's node key — signs its own register frames and the entry verifier)
- `wantK: number`, `maxBytes: number`
- `addressing = createTierAddressing(new RingHash())` (byte-identical to host)
- protocol ids: cohort-topic `register` (`DEFAULT_COHORT_TOPIC_PROTOCOLS.register`) and matchmaking `query`
  (`DEFAULT_MATCHMAKING_PROTOCOLS.query`).

**Routing model: dial the FRET-routed primary directly** (do NOT build a separate FRET `routeAndAct` path).
This mirrors (a) the mock harness, which calls `mesh.nodeNearest(coord)` then the engine directly, (b) the
provider integration test, which calls `handleRegister` on `primaryFor(coord)`, and (c) the host's existing
**direct-dial** `/register` path (`host.ts` ~2084: a direct dial decodes the frame, recomputes the served
coord, and runs the cohort decision locally). For a tier `d`:
```
coord   = d === 0 ? addressing.coord0(topicId) : addressing.coord(d, seekerBytes, topicId)
primary = fret.assembleCohort(coord, wantK)[0]   // the routed primary, == the test's primaryFor()
```

`walkTransport(topicId): SeekerWalkTransport`:

- **`register(treeTier)`** — build a signed seeker `RegisterV1` carrying the `MatchmakingSeeker` app payload
  (op-tier `Tier.T2`, tree tier `treeTier`, `ttl ~10_000`), mirroring the mock harness `buildSeekerRegister`,
  then dial `primary`'s cohort-topic `/register` with `requestResponse`, decode the `RegisterReplyV1`, and map
  to `SeekerProbeReply` (mirror the mock harness `toProbeReply`: pass through `result`; on `accepted`/`promoted`
  copy `topicTraffic` and `targetTier`).
  - **Tier-0 register is a `bootstrap: true` T2 register and the production node's bootstrap-evidence gate is
    configured** (node-base wires `antiDos.reputation`). So the tier-0 seeker register MUST attach a
    **self-vouch reputation endorsement**, exactly as the provider/reactivity integration tests do
    (`serializeBootstrapEvidenceEnvelope({ v:1, reputation: { referee, sig: signPeer(key, bootstrapBoundImage(body)) } })`,
    attached to the body BEFORE the final `registerSigningPayload` sign — `bootstrapBoundImage` binds only
    `(topicId, tier, participantCoord, timestamp)`). Build this into the transport's register-frame builder.
    A tier-`d>0` register sets `bootstrap: false` (plain walk step that falls through `no_state`).
- **`query(treeTier)`** — encode a `QueryV1` (`encodeQueryV1`; `includeProviders: true`, `includeSeekers:
  false`, the seeker's `filter` if any, `limit: QUERY_LIMIT_MAX` or `256`, `requesterId: selfPeerId`,
  `timestamp: Date.now()`, `signature: 'AA'`), dial `primary`'s matchmaking `/query`, and `decodeQueryReplyV1`
  the reply. **On a missing/empty reply or a dial failure, resolve a benign empty reply**
  `{ v:1, truncated:false, cohortEpoch:'', topicTraffic: <zeros>, signature:'', providers: [] }` (a
  client-internal object — `SeekerWalkClient.collect` only reads `.providers`; the hang-out decision uses the
  *probe* reply's `topicTraffic`, not the query reply's). This keeps the walk from throwing when the dialed
  node does not serve the topic (the serve handler returns no frame in that case, per the prereq).
- **`renew()` / `withdraw()`** — for the single-tier-0 milestone the seeker record lives in the cohort store
  for the walk's duration; `renew` may re-touch via the cohort-topic `/register` `RenewV1` ping (preferred:
  keeps the record warm during a real hang-out) and `withdraw` may send a best-effort TTL=0 `RenewV1`. A
  no-op is acceptable for the milestone (mirrors the mock harness) — document whichever is chosen. Note the
  walk only escalates past the root in multi-tier topologies (gated follow-on), so `withdraw` is rarely hit
  here.

`queryCohort(q: QueryV1): Promise<QueryReplyV1>` — one-shot: resolve `coord0(q.topicId)`'s primary, dial
`/query`, decode. Same empty-reply fallback.

`estimateDMax(topicId): Promise<number>` — bind to db-core `makeDMaxComputer({ estimator: new
FretSizeEstimator(fret), F: fanout }).dMax()` (the same computer `CohortTopicService` uses). With small N the
estimate is small ⇒ `d_max` ~0, so the walk registers at tier 0 and queries there.

`verifyEntry: EntrySigVerifier` — `(participantId, payload, sig) => verifyPeerSig(participantId-bytes,
payload, sig)`, the same binding the mock harness uses (re-validates each forwarded `registrationSig`).

**Self-routed-primary short-circuit:** if `primary === selfPeerId`, libp2p cannot dial self. Handle it: the
factory should accept an optional local-serve hook (the node's own host registry + the serve handler /
dispatch) so a self-primary register/query is served in-process; OR document that the driving caller passes a
`resolvePrimary` that excludes self. For the e2e test the seeker is deliberately a *remote* node, so the
happy path never self-dials — but the production factory must not silently hang on a self-primary. Simplest:
expose a `selfServe?` seam and, when `primary === selfPeerId`, route register/query to it; default that seam to
"throw a clear error" so the gap is loud, not silent.

### `module.ts` session binding (driveable on a live node)

`MatchmakingSeekerSession` / `createMatchmakingQuorumDiscovery` already accept `walkTransport` / `queryCohort`
/ `estimateDMax` / `verifyEntry` (and optional `sweepPorts`). Provide a thin constructor in the matchmaking
module — `createLibp2pMatchmakingSeekerSession(deps)` — that builds `MatchmakingSeekerSessionDeps` from
`createLibp2pMatchmakingTransport`, so the public session layer (not just the lower-level walk client) is
driveable over a live node. `sweepPorts` stays **unbound** (the multi-cohort sweep needs the promoted-tree
aggregate-count RPC, a separate follow-on) — absent `sweepPorts` ⇒ walk-only, which is the correct
single-tier-0 behavior. Export from `matchmaking/index.ts`. No node-base change is strictly required (the
serve handler is registered by the prereq); optionally expose the factory off the node for app convenience,
but the gated test constructs it directly (mirroring how the reactivity recover test constructs its
transport directly).

### Flip the gated e2e test

In `substrate-real-libp2p.integration.spec.ts`, replace the
`it.skip('[requires production wiring: matchmaking QueryV1 RPC handler ...] a seeker hang-out walk queries
real cohorts over real sockets and converges to a match')` with a real, gated `it`:

1. Reuse a real cohort + willingness quorum for a match topic (as test §5 does: `engines(matchCoord)`,
   `quorumOn`, register a provider via `handleRegister` with `{ tier: 2, selfVouch: true }`, gossip-replicate).
2. Pick a **remote** seeker node (`!== matchPrimary`). Build `createLibp2pMatchmakingTransport` (or the
   session) against the seeker's `node`/`fret`/`key`.
3. Run `SeekerWalkClient.run()` (or `session.walk(...)`) with `wantCount: 1`, a generous `patienceMs`, and the
   real transport.
4. Assert convergence: `result.metWantCount === true` (or `result.providers.length >= 1`) and the matched
   provider's `participantId` equals the registered provider. **Assert convergence, not an exact hop count**
   (regime-appropriate, per the acceptance criteria). Use bounded polling / generous timeouts (the suite's
   `waitFor`, no fixed sleeps).
5. **Forged-entry drop (the re-validation contract):** add a sub-assertion or sibling test that a provider
   record whose forwarded `registrationSig` is forged is dropped by the seeker's `verifyProviderEntry`
   (mirrors the mock-tier sweep contract). Easiest: register a second "provider" whose app-payload signature
   is over the wrong key / topic, confirm it appears in the raw `/query` reply but is absent from the walk's
   matched set.

## TODO

- Implement `createLibp2pMatchmakingTransport` in `matchmaking/query-transport.ts` (register/query/renew/
  withdraw dialer + `queryCohort` + `estimateDMax` + `verifyEntry`, self-primary handling, empty-reply
  fallback, self-vouch tier-0 register). Reuse `requestResponse` from `cohort-topic/stream-util.ts`.
- Add `createLibp2pMatchmakingSeekerSession` (module-level convenience) wiring the transport into
  `MatchmakingSeekerSessionDeps`; export from `matchmaking/index.ts`.
- Flip the gated walk-converges test to a real passing test; add the forged-entry-drop assertion.
- Keep `yarn build` + default `yarn test` (unit) green. Run the gated suite once with
  `OPTIMYSTIC_INTEGRATION=1 yarn test:integration 2>&1 | tee /tmp/mm-walk.log` to confirm convergence; if
  real-FRET stabilization at small N makes it timing-flaky, document in the review handoff rather than
  loosening assertions to mask a real bug.

## Edge cases & interactions

- **Willingness gate:** the seeker's tier-0 register is admitted only after the topic's willingness quorum is
  seeded. The e2e reuses the provider topic (already quorum-seeded); document that a seeker against a
  never-seeded topic gets `no_state`/refusal and the walk returns empty (not a hang).
- **Bootstrap-evidence gate:** tier-0 T2 `bootstrap: true` needs the self-vouch envelope (above). Without it
  the configured production node refuses the seeker register and the walk never reaches `accepted` — this is
  the single most likely cause of a non-converging test; build the self-vouch into the register-frame builder
  and assert `accepted` in an intermediate step while debugging.
- **Self-routed primary:** `fret.assembleCohort(coord, wantK)[0]` may be the seeker itself; must not dial
  self (libp2p rejects / hangs). Short-circuit to a local serve or fail loudly (above).
- **Empty / no-frame query reply:** the serve handler returns no frame when it does not serve the topic;
  `query()` must resolve a benign empty `QueryReplyV1` (not reject) so `SeekerWalkClient.collect` continues.
- **Replication lag:** the seeker may dial the primary before the provider record has settled; the walk's
  hang-out + re-query cadence covers this — assert convergence within the polling bound, not on the first
  query.
- **Dedup across queries:** `SeekerWalkClient` already dedupes matched providers by `participantId`; a
  provider returned by two queries counts once (no transport-side change needed).
- **Forged forwarded entry:** must be dropped by `verifyProviderEntry` (seeker re-validation), even though the
  cohort served it — the cohort vouches only for "what I held", never provider authenticity. This is the
  explicit acceptance contract; test it.
- **`childCohortCount` / sweep escalation:** the single-tier-0 milestone reports `childCohortCount: 0`, so
  `session.walk` never escalates to the (unbound) sweep — `sweepPorts` absent is correct. Do not bind a
  half-built sweep here.
- **Patience budget:** the walk drains a single wall-clock deadline across hops + hang-out; pass a generous
  `patienceMs` so real socket round-trips do not exhaust it before the first match (the mock tier uses a
  virtual clock and cannot surface this — real RTT can).
- **Concurrent provider renew vs. seeker query:** a provider renewing/re-registering during the seeker's walk
  changes the served set between queries; the dedup + convergence-not-hop-count assertions absorb this.
