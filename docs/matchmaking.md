# Matchmaking

Rendezvous-based peer discovery and quorum assembly for Optimystic, built as the **directory application** of the cohort-topic substrate ([cohort-topic.md](cohort-topic.md)). Matchmaking provides the discovery primitive used wherever the system needs to find peers: forming processing clusters, requesting work, locating capability-bearing nodes, and assembling voting quorums.

---

## Overview

Matchmaking solves a single problem: given a *task* or *capability label*, find a small set of peers willing to act on it. The task might be:

- Forming a cluster to validate a transaction (engaged by the transaction coordinator).
- Recruiting workers to perform off-chain computation.
- Discovering peers that hold a specific capability (storage class, geographic region, hardware feature).
- Assembling a voting quorum for a governance decision.

A matchmaking participant adopts one of two roles:

- **Provider** — "I am available to perform task T." Registers long-lived. Renews until work arrives or it withdraws.
- **Seeker** — "I need peers willing to perform task T." Registers short-lived, queries existing provider registrations at the same cohort, makes its choices, and detaches.

Both roles use the same cohort-topic registration mechanism with stable topic anchors. The walk-toward-root from `d_max`, willingness checks, promotion/demotion, primary/backup sharding, and TTL semantics are all inherited unchanged. This document specifies only the matchmaking-specific shape: anchor derivation, the provider/seeker registration payloads, the query protocol, and the voting-quorum use case.

This replaces the earlier Kademlia `provide`/`findProviders` framing. The cohort-topic layer gives matchmaking what the original provide-based approach could not: tree growth that automatically adapts to hot tasks (without flooding), cohort-stable forwarder identity (instead of fragile per-key replication), and shared infrastructure with reactivity and future directory consumers.

> **Implemented** (mock-tier e2e: `db-p2p` `matchmaking/mesh-{lifecycle,walk,sweep}.spec.ts` over
> `matchmaking-mesh-harness.ts` — see §Test expectations "Mock-tier e2e"; the per-feature callouts below
> still read "mock-tier e2e pending" for the narrower slice each describes). The cohesive public module is
> `packages/db-p2p/src/matchmaking/module.ts`: `MatchmakingProviderSession`
> (`register(topic, payload)` / `renew` / `withdraw` / `setCapacity` / `signalFull`) and
> `MatchmakingSeekerSession` (`register(topic, payload)` / `query(q)` / `walk(topic, want)` — the hang-out
> engine escalating to the multi-cohort sweep on a hot topic), both wired to `CohortTopicService` at tier
> **T2** via the provider/seeker managers + seeker walk client. `createMatchmakingQuorumDiscovery` binds
> the db-core voting `QuorumDiscovery` port to walk (single-cohort) + sweep, so `VotingQuorumAssembler`
> runs over real substrate I/O. (The `*Session` classes are the substrate-wired public entry points; the
> same-named db-core `MatchmakingProvider` / `MatchmakingSeeker` are the transport-free state +
> signed-payload builders they compose.) Substrate I/O — walk transport, one-shot query, `d_max`
> estimate, sweep ports — is injected, so the module unit-tests without a live libp2p stack. Spec:
> `module.spec.ts` (db-p2p). Config + wire types are exported from the `db-core` and `db-p2p` matchmaking
> package indexes.

---

## Goals and non-goals

### Goals
- One mechanism to find peers willing to do a task, scaling from tiny networks to millions of peers.
- Identical infrastructure for provider discovery, work matching, capability lookup, and voting-quorum assembly.
- Anti-flood behavior under hot tasks (popular voting topics, hot capabilities) without configuration tuning.
- Light cost on lightweight nodes: phones can be seekers freely, providers within capacity, and never forwarders.
- Verifiable provider identity (signed registrations).

### Non-goals
- Authoritative "who is the worker for X" answers — matchmaking returns a *set* of candidates; the seeker selects.
- Cross-task atomicity. Each match is a single task; multi-task transactions belong to the coordinator layer.
- Strict freshness. Provider registrations are TTL-bounded; queries see whatever's currently registered. Stale providers expire naturally.
- Geographic or latency optimization. Matchmaking returns identities; the seeker dials and measures.

---

## Anchor: stable per-task

Unlike reactivity, matchmaking topics do not rotate. A task or capability label has a stable identity over its useful lifetime, and matchmaking participants benefit from the tree persisting:

```
topicId(task T) = H(T.kind ‖ T.label ‖ "match")
```

Where:
- `T.kind` is one of `"task"`, `"capability"`, `"quorum"`, `"capacity-class"`, etc. — categorizes the topic so unrelated namespaces don't collide.
- `T.label` is application-defined. For a capability lookup, the capability name; for a voting quorum, the proposal hash; for a work task, the task type identifier.

The cohort-topic tier addressing proceeds normally on this stable `topicId`. Long-lived tasks (capabilities that persist across many work items) develop a tree that matures over time; short-lived tasks (a single voting proposal) form a shallow tree that demotes back to a single root cohort once the work is done.

> **Implemented** (mock-tier e2e pending). `packages/db-core/src/matchmaking/topic-anchor.ts`
> (`createMatchTopicAnchor` / `matchTopicId`) derives `topicId = H(kind ‖ label ‖ "match")` over the
> **same** db-core {@link IRingHash} (256-bit SHA-256) the cohort-topic `coord_d` input uses — never a
> FRET import — so the 32-byte anchor feeds cohort-topic tier addressing verbatim. Concatenation is
> delimiter-free exactly as written; this is unambiguous because `MatchTopicKind` is a closed set
> (`task` / `capability` / `quorum` / `capacity-class`) in which no member is a prefix of another, so
> `kind ‖ label` can never alias a different `(kind, label)` pair. Spec: `topic-anchor.spec.ts`
> (deterministic, distinct per `(kind, label)`, distinct across kinds for a shared label).

---

## Provider registration

A node willing to perform task `T` registers as a provider:

```
SubscribeAppPayloadV1.kind == "match-provider"
```

with `appPayload`:

```
ProviderAppPayloadV1 {
  kind:            "match-provider"
  capabilities:    string[]            // application-defined attribute tags
  capacityBudget:  number              // tasks this provider will accept concurrently
  serviceUntil?:   number              // unix ms, soft expiry hint to seekers
  contactHint:     string              // multiaddr or PeerId-based callback
  signature:       string              // over (topicId, capabilities, capacityBudget) — see §Wire formats
}
```

The registration uses cohort-topic tier `T2` (functional). TTL is the cohort-topic default for the provider's node profile — typically 90 s on a Core node, 60 s on Edge. Providers renew normally; if a provider stops renewing, its registration ages out and seekers stop seeing it.

Providers are not exclusive. The same node may provide for multiple `T` simultaneously, registering at each topic's tree independently. The cohort-topic per-cohort topic budget bounds how much breadth any single cohort sees.

### Provider self-throttling

A provider whose `capacityBudget` is reached has two options:

- **Withdraw** by sending a `RenewV1` with TTL = 0, evicting the registration immediately.
- **Stay listed but signal full** by setting `capacityBudget` to 0 in subsequent renewals. Seekers can interpret this as "available but at capacity"; appropriate when a fast turnover is expected.

Either way, the layer enforces correctness only at the registration level; the seeker is responsible for picking among current providers.

> **Resolved (GROUNDING): polite withdrawal is an optimization, not a correctness requirement.**
> Withdrawal (the matchmaking-doc `RenewV1` TTL = 0) only lowers the seeker's lingering footprint in
> cohort gossip; correctness never depends on it. A non-withdrawn registration is bounded by TTL
> eviction and worst-case yields **one stale entry** to a seeker, which the seeker re-validates
> (`registrationSig`) and re-queries past. Worst-case eviction latency ≈ one TTL + one gossip round.
>
> **Implemented** (mock-tier e2e pending). Provider state/decision is
> `packages/db-core/src/matchmaking/provider.ts` (`MatchmakingProvider`): capability tags, a live
> `capacityBudget`, the signed `ProviderAppPayloadV1` builder (signing scope
> `(topicId, capabilities, capacityBudget)` — see the signing-scope note in §Wire formats), plus `setCapacity` /
> `signalFull` (`capacityBudget = 0`) / `markWithdrawn`. It is crypto-free — signing is an injected
> callback (db-p2p supplies the libp2p peer key), mirroring the cohort-topic `ParticipantSigner`.
> db-p2p wiring is `packages/db-p2p/src/matchmaking/provider-manager.ts`
> (`MatchmakingProviderManager`): register/renew/withdraw against `CohortTopicService` at tier **T2**
> with a profile-based TTL (Core 90 s / Edge 60 s via `providerTtlForProfile`). **Substrate mapping
> surfaced honestly:** the cohort-topic `RenewV1` carries no `appPayload` and no `ttl`, so a capacity
> change ("signal full") is realized by **re-registering** with the new signed payload (updating the
> record's `appState`), not by a renewal; and immediate withdrawal (TTL = 0) has no wire realization
> yet, so `withdraw` stops renewing and the record ages out by TTL — acceptable precisely because
> withdrawal is an optimization (above). An immediate-tombstone renew is a documented cohort-topic
> follow-on. Spec: `registration.spec.ts` (capacity tracking, signal-full re-sign, withdrawal intent,
> provider-TTL renewal keeps the record alive).

---

## Seeker query

A seeker looking for providers also registers at the topic, briefly, so that:

- Other seekers can find it (useful for collective work assembly: voting quorum members can find one another).
- The cohort knows there's active demand for this topic, biasing willingness and promotion behavior.

```
SubscribeAppPayloadV1.kind == "match-seeker"
```

with `appPayload`:

```
SeekerAppPayloadV1 {
  kind:           "match-seeker"
  wantCount:      number              // number of providers desired
  filter:         CapabilityFilter?   // optional, see below
  contactHint:    string              // for collective-assembly use
  pushOnArrival?: boolean             // opt into arrival pushes; default false (poll path)
  signature:      string
}
```

with TTL set short — typically 5–15 s — since seekers normally don't wait long. A
hanging-out seeker that set `pushOnArrival` keeps its registration alive via TTL
renewals while it waits for pushes (see [§Arrival push on provider arrival](#arrival-push-on-provider-arrival)).

> **Implemented** (mock-tier e2e pending). Seeker state + the signed `SeekerAppPayloadV1` builder
> (signing scope `(topicId, wantCount)` — see the signing-scope note in §Wire formats) is
> `packages/db-core/src/matchmaking/seeker.ts` (`MatchmakingSeeker`); db-p2p wiring is
> `packages/db-p2p/src/matchmaking/seeker-manager.ts` (`MatchmakingSeekerManager`), which registers at
> tier **T2** with the short `seeker_ttl` (default 10 s) and **does not renew by default**, so the
> registration ages out by TTL — the eviction property the registration slice proves. The `QueryV1`
> issuance, the capability-filter evaluation, and the hang-out-vs-continue decision below are now
> implemented too — see the callouts under §Capability filter and §Hang-out vs. continue. Spec:
> `registration.spec.ts` (brief seeker registration evicts on TTL while a renewed provider survives).

After registering, the seeker queries the cohort:

```
QueryV1 { topicId, includeProviders: true, includeSeekers: false, limit }
QueryReplyV1 {
  providers:  ProviderEntryV1[]       // up to limit
  seekers?:   SeekerEntryV1[]         // when includeSeekers
  truncated:  boolean
  cohortEpoch: string
}
```

The cohort returns its locally-known direct provider registrations matching `filter`. If `truncated == true`, the cohort had more matches than `limit` allowed; the seeker may re-query at a different cohort within the same tree (any cohort along the seeker's walk path, since each tier holds a disjoint shard of providers by peer-prefix). For most cases a single cohort's slice is sufficient.

### Capability filter

```
CapabilityFilter {
  must:        string[]      // tags that must all be present
  mustNot:     string[]      // tags that must not be present
  minBudget?:  number        // skip providers whose capacityBudget is below this
}
```

The filter is evaluated locally at the cohort. Filters are advisory: they bias which providers the cohort returns but do not constitute admission. The seeker re-validates against the returned set.

> **Implemented**, serve side live over real libp2p. `matchesFilter` (must / mustNot / minBudget) is
> `packages/db-core/src/matchmaking/capability-filter.ts`; the pure query evaluation (filter +
> `limit` truncation + `truncated` flag + entry building, providers and seekers) is `query-eval.ts`
> (`evaluateQuery`); the cohort-side binding that serves a `QueryV1` from the cohort's local
> registration records and attaches `topicTraffic`, `cohortEpoch`, and the primary's reply signature
> is `packages/db-p2p/src/matchmaking/query-handler.ts` (`handleMatchmakingQuery`). The production
> transport that resolves the serving tier-0 engine off the live `CoordRegistry` and rides the
> request-reply stream is `packages/db-p2p/src/matchmaking/query-transport.ts`
> (`registerMatchmakingQueryHandler` over `/optimystic/matchmaking/1.0.0/query`), wired at the
> composition root (`libp2p-node-base.ts`); a topic the node serves no engine for gets **no reply**
> (the handler never instantiates an engine — DoS guard). The seeker re-validates each returned entry's
> `registrationSig` via `verifyProviderEntry` / `verifySeekerEntry` (`wire.ts`) — see the signing-scope
> note in §Wire formats. Spec: `capability-filter.spec.ts`, `query-eval.spec.ts`, `entry-verify.spec.ts`
> (db-core, including the sign → forward → verify round trip), `query-handler.spec.ts` +
> `query-transport.spec.ts` (db-p2p), and the gated real-socket §5b in `substrate-real-libp2p`. The
> **outbound** seeker walk client remains the follow-on (`matchmaking-query-rpc-seeker-walk`).

### Distributing the query across the tree

When a topic is hot enough that providers live across many tier-`d ≥ 1` cohorts, a seeker may want a representative sample across the ring. Two patterns:

1. **Single-cohort sample.** The seeker queries the cohort it registered with. Providers held there are sharded by peer-ID prefix; the sample is biased toward providers whose peer-ID shares the seeker's prefix. Often this is fine — geographic and latency locality often correlate with prefix locality in deployed networks.
2. **Multi-cohort sweep.** The seeker, after registering at its natural tier, additionally queries the root cohort (tier 0). The root maintains aggregated provider counts (not individual entries, but bucketed counts per tier-1 shard) and can redirect the seeker to specific tier-1 cohorts holding many providers. The seeker then queries those directly.

The multi-cohort sweep costs more RPCs and is reserved for use cases where representativeness matters more than latency (voting quorums, capability fairness audits).

> **Implemented** (mock-tier e2e pending). The seeker-side sweep orchestration —
> `runMultiCohortSweep` / `selectShards` (high-population tier-1 shards first, accumulating bucketed
> counts to `wantCount`, capped at a fan-out ceiling) plus the per-shard filter + `registrationSig`
> re-validation + dedup — is `packages/db-core/src/matchmaking/multi-cohort-seeker.ts` (pure; the root
> aggregate fetch, per-shard query, and threshold-verify are injected as a `MultiCohortSweepPorts` port).
> The root-side producer — log-bucketed per-tier-1-shard counts, **threshold-signed**, **gated on tree
> depth ≥ `aggregate_count_minimum_tier`** (a cold cohort that fell through to `NoState` returns
> `undefined`) — is `packages/db-p2p/src/matchmaking/aggregate-counts.ts` (`buildAggregateCount`;
> per-shard counts / depth / epoch / threshold signer all injected). Counts are quantized through
> `logBucketCount` (largest power of two `≤ n`), which rounds *down* so the consumer's shard selection
> over-provisions rather than under-selects. The public seeker session escalates walk → sweep on a hot
> topic (`childCohortCount > 0`) or `preferSweep`; db-p2p binds the sweep to the voting
> `QuorumDiscovery.sweep` port. When an optional `patienceMs` budget is supplied, the sweep fixes a
> wall-clock deadline at entry and stops *starting* new shard queries once it drains (an in-flight
> `queryShard` is not cancelled) — mirroring the single-cohort walk's patience model; absent it, every
> elected shard is queried. Spec: `multi-cohort-seeker.spec.ts` (db-core), `aggregate-counts.spec.ts`
> (db-p2p).

---

## Voting-quorum assembly

> **Implemented** — *discovery flow only* (mock-tier e2e pending). The discovery-side assembler that
> composes the matchmaking surface into "assemble a quorum of eligible voters for proposal `P`" is
> `packages/db-core/src/matchmaking/voting-quorum.ts` (`VotingQuorumAssembler`): the `quorumTopic`
> anchor, the eligibility-proof-bearing voter registration (`registerEligibleVoter`), and the
> coordinator/delegated-assembler `assembleQuorum` discover → verify → select pipeline (single-cohort
> walk, hot-topic multi-cohort sweep, dedup, reply-side `registrationSig` + `verifyEligibility`
> filtering, selection). The discovery I/O (walk + sweep) is injected as a `QuorumDiscovery` port,
> bound in db-p2p to `MatchmakingSeeker.walk` + `multi-cohort-seeker`. Spec:
> `voting-quorum.spec.ts`. **The voting protocol itself** — eligibility-proof *minting*, the quorum
> *selection rule*, ballots, tally aggregation, dispute escalation, ballot privacy — is **not**
> implemented here; it is injected (`verifyEligibility` / `select` / `reputationPrefilter`) or left to a
> forthcoming separate voting doc. No matchmaking wire-protocol change is introduced.

Voting is a first-class consumer of matchmaking. The voting subsystem assembles a quorum of peers to count ballots, validate eligibility, and produce a threshold-signed tally. Matchmaking provides the discovery primitive:

1. A proposal `P` defines a `topicId = H("quorum" ‖ proposalHash(P) ‖ "match")`.
2. Eligible voters (or vote-counters, depending on the voting protocol) register as providers at this topic. Their `capabilities` field carries proof-of-eligibility tags (e.g., a signature over the proposal from a stake-bearing key).
3. The voting coordinator registers as a seeker, queries the cohort, and receives the set of eligible registered voters.
4. The coordinator selects a quorum from the returned set, using whatever quorum rule the voting protocol specifies (random sample, stake-weighted selection, geographic distribution, etc.).
5. The coordinator dials the selected providers directly and runs the protocol-specific vote-collection RPCs (which are *not* part of matchmaking).
6. When voting concludes, the topic's tree demotes naturally as providers stop renewing.

### Why this works for voting

- **Anti-flood under heavy participation**: a high-profile vote will produce a deep tree as registrations exceed `cap_promote`; queries shard across the tree without overloading the root cohort or any single cohort.
- **Verifiable eligibility**: provider registrations are signed, eligibility evidence is bound into `capabilities` (so the provider's `registrationSig` attests it), and the coordinator re-validates every forwarded entry's `registrationSig` *and* its eligibility proof per entry. Signature anchoring is layered: a `QueryReplyV1` carries the cohort primary's **single-member** signature (advisory — vouches only for "the set I held"), while the multi-cohort-sweep `AggregateCountV1` is **threshold-signed** (an attested *registered*-provider count). Neither attests *eligibility* — that is the application's job, done reply-side.
- **Bounded membership**: TTL ensures dead voters age out; the cohort never reports staler-than-TTL registrations. Because a voting window (`patienceMs` 30–300 s) can exceed `provider_ttl` (60–90 s), voters MUST renew to stay listed for the whole window, and the assembled set is a **TTL-bounded snapshot** — a voter that stops renewing may be returned-then-dead between assembly and vote-collection, so the voting layer re-validates liveness on dial. Matchmaking does not "pin" voters.
- **Resists Sybil at the matchmaking layer**: forging mass registrations is rate-limited to `register_rate_per_peer` per cohort per peer, so cost scales with distinct peer identities, not free registrations; independently, the application's `verifyEligibility` rejects any voter without a valid stake/eligibility proof regardless of how it registered.

### Resolved design decisions (discovery flow)

The discovery flow's plan stage resolved four questions; the implementation reflects them and they hold for downstream voting work:

1. **Eligibility filtering placement → reply-side per-entry verification is the default and required path; a client-side reputation pre-filter is optional and additive.** Voting is correctness-critical and adversarial, so coupling quorum-assembly *liveness* to reputation-subsystem *availability* is unacceptable: reputation must be an optimization (`reputationPrefilter`, applied *before* verification to trim candidates), never a dependency. Matchmaking already forwards each entry's `registrationSig` plus the proof in `capabilities`, so reply-side verification is effectively free; the bandwidth cost of discarding ineligible entries is bounded by `query_limit_max` (256) × swept-cohort-count.
2. **Flash-vote fairness among competing coordinators → a voting-layer concern; no matchmaking signal is added.** Matchmaking is non-authoritative: it returns an advisory *candidate set*, never an allocation. Multiple coordinators sweeping the same pool all receive overlapping sets; quorum non-collision is decided by the voting protocol. The existing arrival-push FCFS-by-`attachedAt` fan-out governs only the *notification* race for scarce capacity, not quorum allocation.
3. **No matchmaking protocol additions are needed.** Discovery is fully covered by register / query / sweep / arrival-push. A cohort-attested count of *eligible* voters is out of matchmaking's remit by construction (the cohort does not validate eligibility), so the only attested counts are `AggregateCountV1`'s threshold-signed *registered*-provider buckets; an attested *eligible*-voter count, if voting needs one, is a voting-layer aggregate computed after discovery+verification, not a matchmaking message.
4. **Quorum-assembler delegation → the seeker role may be held by the coordinator itself or by a delegated assembler peer; whoever holds it owns `patienceMs` and the reply-side re-validation duty.** A delegated assembler returns an already-validated `ProviderEntryV1[]`; because every entry is self-checkable (`registrationSig` + the proof in `capabilities`), the coordinator MAY re-validate on receipt (trust-but-verify) by re-running the verify→select pipeline. The hand-back transport (assembler → coordinator) is a voting-layer RPC, not matchmaking.

The voting protocol itself — ballot privacy, tally aggregation, dispute escalation — is out of scope for this document and will be specified separately. Matchmaking only provides "find the peers."

---

## Walk and willingness, in matchmaking terms

The cohort-topic walk-toward-root from `d_max` and reply set apply unchanged:

| Reply | Meaning for matchmaking |
|---|---|
| `Accepted` | Provider or seeker registered at this cohort. Reply carries `topicTraffic`; seekers use it to decide hang-out vs. continue (see [Hang-out vs. continue](#hang-out-vs-continue)) |
| `NoState` | This cohort doesn't yet serve this topic; walk one tier toward the root |
| `Promoted(targetTier)` | Tree has grown past this tier; register deeper using your own peer prefix. Reply still carries the outgoing cohort's `topicTraffic`, hinting at conditions at the target tier |
| `UnwillingMember` | This cohort member declines; ask a sibling member |
| `UnwillingCohort` | No member of this cohort will serve this topic; back off in time, retry from `d_max` |

`UnwillingCohort` is particularly important for matchmaking on hot topics: if every cohort along the walk path is busy with higher-tier work (T0 commits, T1 chain serving), the seeker waits rather than re-probing aggressively. The wait drains as load shifts; the seeker is not punished for participating in a popular task, but it is asked not to make the popularity worse.

There is no separate "try inward and outward" exploration mode. Provider and seeker walks are the same single-direction walk that every cohort-topic application uses.

---

## Hang-out vs. continue

`Accepted` tells a seeker that this cohort is in the tree for the topic. It does not tell the seeker whether *this tier* is the right place to wait. A cohort deep in the tree (high `d`) holds only the seeker's prefix-shard of providers — a small, fast-to-query slice, but possibly too thin if `wantCount` is high or providers are sparse. A cohort near the root holds many shards merged — a much larger pool, at the cost of being one or more hops farther up.

The cohort-topic `topicTraffic` field on every `Accepted` and `Promoted` reply gives the seeker enough information to choose.

### Decision inputs

From the reply:

- `directParticipants` — providers known at this cohort right now.
- `arrivalsPerMin` — provider registration and renewal rate; predicts how quickly new matchable providers appear here.
- `queriesPerMin` — competing seeker activity over the same provider pool.
- `childCohortCount` — non-zero means this tier has promoted; descending would lead to live shards, ascending would lead to broader aggregation.

From the seeker:

- `wantCount` — providers needed.
- `patienceMs` — how long the seeker is willing to wait at this tier before escalating. Per-task, not per-cohort.
- `filter` — capability filter, narrowing the matchable subset.

### Decision rule

After receiving `Accepted` with `topicTraffic` at tier `d`:

1. **Immediate-match check.** Issue `QueryV1`. If providers matching `filter` ≥ `wantCount`, done.
2. **Hang-out feasibility.** Estimate matchable arrivals over the remaining patience budget:
   ```
   expectedNewMatches ≈ arrivalsPerMin × filterAcceptRatio × (patienceMs / 60000)
   contentionFactor   ≈ min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1), contention_factor_cap)
   ```
   If `currentMatches + expectedNewMatches ≥ wantCount × contentionFactor`, **hang out**: keep the seeker registration alive via TTL renewals until `wantCount` matches accumulate or `patienceMs` elapses. How the hanging-out seeker watches for fresh arrivals depends on whether it opted into pushes:
   - **Push path (`pushOnArrival = true`).** The seeker does not poll at `requery_interval_ms`. It waits for `ArrivalPushV1` from its assigned cohort primary, issuing a `QueryV1` only as a sparse safety poll every `push_safety_poll_ms` (default 5 s) **and once more immediately before `patienceMs` drains**. See [§Arrival push on provider arrival](#arrival-push-on-provider-arrival).
   - **Poll path (default).** The seeker re-queries at `requery_interval_ms` (default 1 s; see §Configuration).
   `filterAcceptRatio` starts at 1.0 and can be refined from observed query yields; `meanWantCount` is a small constant or learned from prior interactions.
3. **Otherwise, walk toward the root.** Withdraw the seeker registration (`RenewV1` with TTL = 0; polite but optional), then re-register at `d − 1`. Repeat the decision there. The patience budget continues to drain, so each escalation step makes hang-out at the new tier slightly less attractive — which is correct, since the root is the terminal.

At `d = 0`, there is nowhere further to walk: hang out for whatever patience remains, then return whatever matched (possibly fewer than `wantCount`) to the caller.

### Patience budgeting

`patienceMs` is per-seeker, per-task — the layer does not dictate. Indicative ranges:

| Use case | `patienceMs` |
|---|---|
| Latency-sensitive task assignment | 1–5 s |
| Interactive capability lookup | 5–30 s |
| Voting-quorum assembly | 30–300 s |
| Background work batching | minutes |

A seeker is also free to split its budget — e.g., spend a quarter of `patienceMs` at each visited tier and walk on if the local rate doesn't promise a result in the slice allotted. The doc does not prescribe a strategy; only the inputs.

### Why this works

- **Hot topic.** Even a deep-tier prefix-shard sees enough churn that the seeker stays put. The root is bypassed entirely. This is the dominant case for popular tasks.
- **Cold topic.** Each tier's `topicTraffic` reports a thin pool; the seeker walks all the way to the root, where the aggregated population is largest, and waits there. Cost: log-many extra RPCs in network size, identical to the existing cold-walk pattern.
- **Borderline topic.** The seeker estimates wrong, hangs out for a while, gives up, escalates. Cost: one wasted patience-slice plus one extra register hop. Bounded.
- **No outward probing.** The decision is always "wait here" or "walk one tier toward the root." Seekers never speculatively probe deeper than where they started; the anti-flood properties of the substrate are preserved.

### Worked example

A seeker needs 8 providers of `pdf-render`, `patienceMs = 10 s`. Network has 200 such providers.

`d_max = 3`. Probes:

- `d = 3` → `NoState`. `d = 2` → `NoState`.
- `d = 1` → `Accepted` with `topicTraffic = { directParticipants: 6, arrivalsPerMin: 90, queriesPerMin: 4 }`.
- Query returns 6 matching providers. Need 8. `expectedNewMatches ≈ 90 × 1.0 × (10/60) ≈ 15`. `contentionFactor ≈ 1 + (4 × 3 / 90) ≈ 1.13`. Threshold `8 × 1.13 ≈ 9.05`; have `6 + 15 = 21`. Hang out.
- Within 4 s two more renewals land; the seeker re-queries, total 8, dials.

Contrast: the seeker's prefix lands it in a thinner shard with `directParticipants: 1, arrivalsPerMin: 8`. `expectedNewMatches ≈ 1.3`. Threshold not met. Withdraw, walk to `d = 0`. Root reports `directParticipants: 200, arrivalsPerMin: 600`. Query returns 8 immediately.

> **Simulator-validated** (`packages/substrate-simulator`, `matchmaking.ts` decision engine +
> `seeker-walk.ts`). The decision math is confirmed exactly against the formulas:
>
> - **Worked example trace — confirmed.** `arrivalsPerMin = 90`, `queriesPerMin = 4`, `wantCount = 8`,
>   `patienceMs = 10 s`, `filterAcceptRatio = 1.0`, `currentMatches = 6`:
>   `expectedNewMatches = 90 × 1.0 × (10/60) = 15.00`,
>   `contentionFactor = min(1 + (4 × 3)/90, 4) = 1.13`, threshold `8 × 1.13 = 9.07`; have `6 + 15 = 21
>   ≥ 9.07` → **hang out** (reason `feasible`). Matches the doc figures to 2 d.p.
> - **`contention_factor_cap = 4.0` — confirmed, keep global.** The cap exists to bound the
>   `queriesPerMin / arrivalsPerMin` ratio in `contentionFactor`. On a thin, heavily-queried tier
>   (`arrivalsPerMin = 10`, `queriesPerMin = 100`, modeling ~100 competing seekers), the **uncapped**
>   factor is `1 + (100 × 3)/10 = 31`, which would set the threshold to `wantCount × 31 = 93` —
>   unreachable at any tier, pinning every seeker to the root (a self-inflicted escalation storm).
>   The cap clamps the factor to **4** and the threshold to **12**, so contended seekers still
>   escalate toward aggregation (correct) without the threshold exploding. The sensitivity sweep
>   (`sweep.ts`, cap ∈ {1, 2, 4, 8}) gives thresholds 3, 6, 12, 24 on this fixed hot reply; the
>   decision flips from hang-out to escalate at cap ≥ 2, so **4 sits safely in the escalate regime
>   with headroom**. **It should stay a global scalar, not per-tier:** the failure it guards
>   (divide-by-small-`arrivalsPerMin`) is a property of the ratio, not the tier, and
>   `refinement-signal.ts` shows the exact-`Σ wantCount` seeker-pool refinement only ever *flips* a
>   decision in the **un-capped** regime — once both approx and exact saturate at the cap they agree,
>   so a per-tier cap buys nothing here. (Evidence: `scenarios.ts` adversarial-reporting,
>   `sweep.ts` `contention_factor_cap` rows, `refinement-signal.ts`.)

> **Implemented** (mock-tier e2e pending). The pure decision engine — `decide` (immediate-match /
> hang-out feasibility / escalate), `expectedNewMatches`, `contentionFactor`, and the running
> `filterAcceptRatio` refinement — is `packages/db-core/src/matchmaking/seeker-walk.ts`; the walk
> orchestration (register from `d_max`, immediate `QueryV1`, renew + requery at `requery_interval_ms`
> on hang-out, withdraw + re-register on escalate, terminal hang-out at `d = 0`, patience draining
> across hops via a single wall-clock deadline) is
> `packages/db-p2p/src/matchmaking/seeker-walk-client.ts` (`SeekerWalkClient`, **poll path only** —
> the arrival-push path is a separate slice). Future refinements tracked as backlog tickets:
> `matchmaking-per-tier-patience-splitting` (strategies beyond the fixed
> `patience_per_tier_fraction = 1.0` implemented here) and `matchmaking-contention-from-seeker-pool`
> (exact `Σ wantCount` contention instead of the `meanWantCount × queriesPerMin` approximation
> implemented here). Spec: `seeker-walk.spec.ts` (db-core — the worked-example arithmetic and edge
> cases 2/4/5), `seeker-walk-client.spec.ts` (db-p2p — the §Test expectations hang-out bullets).

### Edge cases

The §Decision rule above is the common path. A few specific situations need explicit handling:

1. **`topicTraffic` absent on the reply.** The substrate guarantees `topicTraffic` on `Accepted` and `Promoted` (see [cohort-topic.md §Topic traffic signal](cohort-topic.md#topic-traffic-signal) for the per-result presence matrix). If a reply omits the field — an older peer, a protocol mismatch, or a malformed responder — the seeker treats the cohort as zero-rate and walks one tier toward the root without hanging out. No estimation is attempted against absent inputs.

2. **`arrivalsPerMin = 0` immediately after a cohort epoch change.** Per-topic counters reset on rotation (see [cohort-topic.md:242](cohort-topic.md#topic-traffic-signal)). For the first ~`windowSeconds` of a new epoch the rate under-reports — possibly to zero — even if the underlying provider population is healthy. A seeker tolerates this by **not withdrawing on a single zero reading**. Instead it issues one `QueryV1` first; if the query returns ≥ `wantCount` matchable providers, the cohort was simply quiet, not empty. The seeker escalates only when the query also yields below threshold.

3. **`UnwillingCohort` before `topicTraffic` is computed.** The registration was refused at the substrate level (see the walk-reply table above); the hang-out decision is not entered at all because the seeker never received `Accepted`. Standard substrate back-off applies.

4. **Filter that matches almost nothing.** As successive queries return providers that fail the seeker's `filter`, `filterAcceptRatio` decays toward zero. `expectedNewMatches` collapses with it; the threshold check fails at every tier; the seeker walks all the way to the root. This is the right outcome — a pathological filter is inherently expensive, and the root's aggregated pool gives the filter its best chance.

5. **Many seekers competing simultaneously.** A burst of competing seekers drives `queriesPerMin` up, which drives `contentionFactor` up, which makes the threshold harder to meet at any given tier — so more seekers escalate toward the root, which is where aggregation lives. The multiplier is capped at `contention_factor_cap = 4.0` (see §Configuration) so a runaway query rate cannot pin every seeker to the root indefinitely. Self-balancing.

### Test expectations

The wire codecs, the stable topic anchor, both registration roles (provider attach/renew/self-throttle; seeker short-TTL registration), the query/filter evaluation, and the seeker hang-out engine are now implemented (see the callouts in §Anchor, §Provider registration, §Seeker query, §Capability filter, §Hang-out vs. continue, and §Wire formats). Each hang-out bullet below has a corresponding passing unit test — `seeker-walk.spec.ts` (db-core) for the decision arithmetic, `seeker-walk-client.spec.ts` (db-p2p) for the walk behavior. The arrival-push bullets remain doc-as-spec until `matchmaking-cohort-push-on-arrival` lands.

> **Mock-tier e2e (implemented).** The mock-transport integration tier
> (`packages/db-p2p/src/testing/matchmaking-mesh-harness.ts`, layered on the cohort-topic mesh harness)
> drives the **real** provider/seeker managers, the **real** cohort `QueryV1` handler, and the **real**
> seeker walk client over an in-process mesh on a virtual clock. The hang-out *decision math* is the
> `seeker-walk.spec.ts` floor (above); the mesh tier proves a modeled traffic regime drives the real walk
> over real records. Mapping of the poll bullets to mesh tests (`packages/db-p2p/test/matchmaking/`):
>
> - *Cold topic, walks to root* → `mesh-walk.spec.ts` "sparse/cold regime" (real `NoState` fall-through to
>   the root, `wantCount` met there) and "sparse provider, very large network" (`d_max+1` real hops).
> - *Hot topic, deep tier suffices* → realized **at the root** by `mesh-walk.spec.ts` "hot regime (root)"
>   (immediate query meets `wantCount`, no walk past the accepting tier, hotness signal surfaced). The
>   *deep* (`d ≥ 1`) variant needs a serving promoted child cohort and is tagged-unimplemented
>   (`it.skip` → `cohort-topic-followon-derivation`).
> - *Borderline topic, hangs out for full patience* → `mesh-walk.spec.ts` "borderline regime" (drains
>   ≈`patienceMs` across `requery_interval_ms` polls, returns the partial set).
> - *Patience drains correctly / withdraws cleanly / stale `arrivalsPerMin=0` / missing `topicTraffic` /
>   filter-accept-ratio decay* → covered by `seeker-walk-client.spec.ts` (db-p2p, scripted transport) —
>   the mesh tier does not re-assert per-hop wall-clock draining (register hops are instant on its virtual
>   clock). The adversarial over-report bound (`docs` §Failure modes) is additionally exercised end-to-end
>   over the real walk in `mesh-walk.spec.ts` "adversarial over-report …" (wasted hang-out ≤ `patienceMs`,
>   no spatial flood). Provider register→query round-trip, the capability filter, capacity self-throttling
>   / TTL-withdrawal, and the multi-cohort sweep over real records live in `mesh-{lifecycle,sweep}.spec.ts`.

- *Hot topic, deep tier suffices.* Seeker stops at the first `Accepted` whose query meets `wantCount`; no walk past the tier of first match.
- *Cold topic, walks to root.* Seeker traverses every tier from `d_max` down to `d = 0`; `wantCount` is met only at the root.
- *Borderline topic, hangs out for full patience.* Seeker stays at the accepting tier, re-queries roughly `patienceMs / requery_interval_ms` times, and returns the partial set if still under-met when patience drains.
- *Patience drains correctly across walked tiers.* Each escalation hop deducts elapsed time from the budget; the final hang-out at the terminal tier sees the original `patienceMs` minus all hops' elapsed time.
- *Seeker withdraws cleanly on escalation.* An outgoing `RenewV1` with `TTL = 0` is sent before re-registering at `d − 1`; cohort gossip evicts the seeker within one round.
- *Stale `arrivalsPerMin = 0` after epoch rotation.* Seeker first issues a `QueryV1`; if the query yields ≥ `wantCount`, no walk; otherwise the seeker walks on the next reading, matching the edge case above.
- *`topicTraffic` missing on reply.* Seeker walks one tier toward the root without hanging out.
- *Filter accept ratio decays across walk.* After two cohorts each return only ~10% matchable providers, `filterAcceptRatio` settles near 0.1 and subsequent `expectedNewMatches` reflects this.

Arrival-push behavior (see [§Arrival push on provider arrival](#arrival-push-on-provider-arrival)):

- *Fresh arrival pushes to longest waiters.* One fresh matchable provider with `capacityBudget = 2` and 5 matching local push-opted seekers → exactly the 2 smallest-`attachedAt` seekers receive an `ArrivalPushV1`.
- *Poll-path seekers are not push targets.* With `capacityBudget = 2` and matching local seekers where the 2 longest-waiting are poll-path (`pushOnArrival` unset), the push goes to the 2 longest-waiting *push-opted* seekers, and the poll-path seekers receive no `ArrivalPushV1`.
- *Renewal does not push.* A renewal of an already-held provider produces no `ArrivalPushV1`.
- *`capacityBudget = 0` does not push.* A fresh arrival with budget 0 produces no push.
- *Coalescing.* Three providers arriving within `push_coalesce_ms` yield one `ArrivalPushV1` of length 3 per selected seeker, not three pushes.
- *Filter miss excluded.* A fresh provider failing a seeker's `filter` (including `minBudget`) does not push to that seeker and does not count toward fan-out.
- *Missed push, final poll recovers.* With pushes suppressed (simulated drop), the hanging-out seeker still returns the provider via the mandatory final `QueryV1` before `patienceMs` drains.
- *Push/poll overlap deduped.* A provider delivered by both an `ArrivalPushV1` and a subsequent safety poll is dialed once and counts once toward `wantCount`.
- *Sparse safety-poll cadence.* A push-aware seeker that gets no pushes issues ≈ `patienceMs / push_safety_poll_ms` queries (≈ 2 at defaults), not `patienceMs / requery_interval_ms` (≈ 10).
- *Promotion observed via folded topicTraffic.* After the cohort promotes, the seeker's next push (or safety poll) reports `childCohortCount > 0` and the seeker enters the descend branch.
- *Push forgery rejected.* An `ArrivalPushV1` whose entries carry an invalid `registrationSig` is discarded; the seeker does not dial the forged provider.
- *Stale push acked `unknown_seeker`.* A push to a seeker that has re-registered (new `correlationId` / epoch) returns `ArrivalPushAckV1{ unknown_seeker }` and the primary drops the binding.

### Replacing the poll with a push

A seeker that opts in (`pushOnArrival`) replaces the polling `requery_interval_ms` loop with a cohort-side push: its assigned cohort primary notifies it as fresh matchable providers arrive. The channel, fairness, coalescing, and failure semantics are specified in [§Arrival push on provider arrival](#arrival-push-on-provider-arrival). A push-disabled seeker keeps the `requery_interval_ms` poll described above.

---

## Arrival push on provider arrival

A hanging-out seeker that set `pushOnArrival` does not poll at `requery_interval_ms`. Instead its assigned cohort primary **pushes** a notification when a fresh matchable provider lands at the cohort. The push is a **pure optimization over the polling baseline**: correctness never depends on it (see [§Arrival push missed or primary fails mid-coalesce](#arrival-push-missed-or-primary-fails-mid-coalesce)). A seeker that opts out, predates push support, or loses every push degrades silently to a sparse safety poll — never worse than the legacy poll path.

### Push channel

The push is delivered by the **seeker's assigned cohort-topic primary** — the member computed by the standard `primary(participantId, cohortMembers)` slot hash. Seekers are `directParticipants` and already hold a primary, so no new assignment machinery is needed. Delivery rides a new matchmaking application protocol, addressed to the seeker's `contactHint`:

```
/optimystic/matchmaking/1.0.0/arrival-push   — cohort-primary → seeker arrival notification
```

This mirrors the pattern reactivity uses to fan `NotificationV1` to direct subscribers ([reactivity.md §Propagation](reactivity.md#propagation)): the cohort-topic layer supplies cohort identity plus primary/backup assignment; the application supplies the delivery RPC. It is **not** intra-cohort gossip — seekers are external participants, not cohort members, so gossip never reaches them — and **not** a new transport — it reuses the primary the seeker already holds.

Trigger source: provider registrations are replicated to every cohort member via standard cohort gossip ([cohort-topic.md §Registration record](cohort-topic.md#registration-record)). The seeker's primary therefore observes a newly-added provider `RegistrationRecord` for this topic within ≤ one gossip round; no new cohort-topic mechanism is required. [cohort-topic.md §Application policies](cohort-topic.md#application-policies) already authorizes applications to drive per-registration behavior off the existing gossip channel, so the cohort-topic substrate needs **no** protocol change.

### Fairness — FCFS by `attachedAt`, fan-out bounded by `capacityBudget`

On a fresh matchable arrival, the primary notifies the **`min(provider.capacityBudget, |matching local push-opted seekers|)` longest-waiting** matching seekers — smallest `attachedAt` first (`attachedAt` is already held per seeker; see `SeekerEntryV1` in §Wire formats). Only seekers that set `pushOnArrival` are notify targets and only they count toward the fan-out: a seeker on the poll path holds no push binding and self-serves via `requery_interval_ms`, so including it in the set would waste a slot on a seeker the primary cannot reach. Rationale:

- The push is advisory — the cohort allocates nothing; seekers dial the provider directly and the provider enforces its own `capacityBudget`. Fan-out therefore only needs to fill the provider's real slots, not broadcast.
- `capacityBudget` is the natural fan-out bound: a provider admitting *c* concurrent tasks justifies notifying *c* racers. Notifying more only manufactures losing dials; notifying fewer under-fills the provider. No new fan-out config is introduced — `capacityBudget` (already in `ProviderAppPayloadV1`) is the per-arrival cap; the fan-out is in turn bounded by the matching-seeker count, which cannot exceed the `cap_promote (~64)` participant ceiling a cohort holds.
- FCFS-by-`attachedAt` yields a **deterministic, defensible** winner (longest-waiting), unlike broadcast-and-race (which favors low-latency seekers arbitrarily) or random sampling (nondeterministic).

A fresh arrival with `capacityBudget == 0` is skipped entirely — a "listed but full" provider ([§Provider self-throttling](#provider-self-throttling)) is not a new matchable slot.

### Coalescing — per-seeker batch over a short window

The primary accumulates fresh matchable arrivals per target seeker and flushes **one** `ArrivalPushV1` carrying the batch, rather than one push per (arrival × seeker). A flush fires when either a `push_coalesce_ms` timer (default 250 ms) elapses **or** the batch reaches the seeker's outstanding need (`wantCount −` matches already pushed). This collapses an arrival burst to ≤ one push per seeker per window.

The coalescing buffer is **soft, transient, non-gossiped** state held only on the current primary. On primary failover the unflushed batch is simply lost; the seeker's safety/final poll covers it. No replay buffer is added — that is reactivity's concern because reactivity must not lose committed revisions, whereas matchmaking arrivals are advisory and re-discoverable by query.

### Folded `topicTraffic`

Each `ArrivalPushV1` carries a current `topicTraffic` snapshot alongside the provider batch. This lets a hanging-out seeker re-run its hang-out-vs-continue math — and observe `childCohortCount > 0` (promotion → descend) — on every push without a separate poll, preserving the structural-change handling the poll loop got for free.

### Failure mode — optimization-only

A missed push (seeker briefly offline, primary failover mid-coalesce-window, dropped RPC) must never make the seeker worse than the polling baseline. The push-aware seeker therefore always runs, beneath the push, a **sparse safety poll** every `push_safety_poll_ms` (default 5 s) **plus one mandatory final `QueryV1` immediately before `patienceMs` drains** (catches any provider whose push was lost right at expiry). Because the safety poll is always present:

- A seeker that receives no pushes — its cohort predates push support, or every push was lost — degrades silently to the sparse-poll cadence. **No push/no-push handshake or capability detection is needed.**
- A withholding primary costs the seeker nothing beyond the safety-poll cadence — no worse than baseline.

Because the same fresh provider can surface in both a push and a later safety/final `QueryV1`, the seeker dedups returned providers by `participantId` before counting them toward `wantCount` or dialing. This also makes a primary's re-pushes after failover (which resets the per-binding "already pushed" count) harmless.

### Edge cases & interactions

- **Renewal vs. fresh arrival.** Only a *fresh* provider registration (a `participantId` not previously held for this topic at this cohort) triggers a push; a renewal of an already-known provider must not — seekers already saw it. Because `arrivalsPerMin` combines fresh registrations and renewals ([cohort-topic.md §Topic traffic signal](cohort-topic.md#topic-traffic-signal)), the trigger keys off the record set transitioning absent→present, **not** off the arrivals counter.
- **`capacityBudget == 0` arrival.** Skipped (listed-but-full is not a new slot).
- **Filter miss.** A fresh arrival that fails a seeker's `filter` produces no push to that seeker and does not count toward fan-out.
- **`minBudget` filter vs. fan-out.** A seeker whose `filter.minBudget` exceeds the arriving provider's `capacityBudget` is not a match — excluded from both the matching set and the FCFS fan-out count.
- **Burst exceeding remaining need.** Several providers arriving within one coalesce window are carried in one batched push; the seeker dials up to its outstanding `wantCount`.
- **Primary failover during the coalesce window.** The unflushed batch is lost (transient, non-gossiped); the safety/final poll recovers it. No replay buffer.
- **`cohortEpoch` change / primary handoff.** The seeker's primary may move ([cohort-topic.md §Membership rotation and primary handoff](cohort-topic.md#membership-rotation-and-primary-handoff)). The old primary stops pushing; the new primary begins pushing future arrivals; the seeker rebinds on its next renewal. In-flight arrivals during the gap are covered by the safety poll. A push whose echoed `correlationId` no longer matches the seeker's current registration (the seeker re-registered) is acked `ArrivalPushAckV1{ unknown_seeker }`, and the primary drops the binding.
- **Promotion while hanging out.** After the cohort promotes, fresh providers are redirected to tier `d+1` and stop landing here, so pushes cease. The seeker observes `childCohortCount > 0` via the folded `topicTraffic` on its last push (or via a safety poll) and re-runs the descend decision per [§Decision rule](#decision-rule). This is pre-existing polling behavior, not push-specific — the folded `topicTraffic` simply keeps the seeker informed without extra RPCs.
- **`arrivalsPerMin = 0` right after epoch rotation.** Counters reset on rotation, but pushes are driven by record-set deltas, not the counter, so push delivery is unaffected by the stale-zero window. The existing edge-case rule (do not withdraw on a single zero reading) is unchanged.
- **Final-poll boundary.** A provider that arrives in the last `push_coalesce_ms` before `patienceMs` expiry may not be pushed in time; the mandatory final `QueryV1` guarantees it is still seen. The final poll fires even when a push is in flight.
- **Contention-signal interaction (beneficial).** Pushes are not `QueryV1`s, so they do not inflate `queriesPerMin`. As seekers adopt `pushOnArrival`, `queriesPerMin` falls, which lowers `contentionFactor` ([§Decision rule](#decision-rule)) for everyone — the hang-out threshold relaxes as polling load disappears. No code beyond not counting pushes as queries.
- **Adversarial primary.** The push carries a single-member (primary) signature, not a threshold signature — the same posture as `QueryReplyV1`. A malicious primary can withhold pushes (the seeker degrades to safety poll — no worse than baseline) or push junk providers (the seeker re-validates each `ProviderEntryV1.registrationSig` and discards forgeries). Bounded; see [§Arrival push missed or primary fails mid-coalesce](#arrival-push-missed-or-primary-fails-mid-coalesce).

---

## Failure modes (matchmaking-specific)

### Adversarial cohort traffic reporting

`RegisterReplyV1` and `QueryReplyV1` carry `topicTraffic` under the cohort *primary's* single-member signature, not a threshold signature (see the `QueryReplyV1` note in §Wire formats below). A malicious primary can therefore over- or under-report.

- **Over-reporting** — claiming a hot tier so the seeker hangs out — is bounded by the seeker's `patienceMs`. Worst-case outcome is wasted patience plus one extra `register → walk` hop after timeout. No spatial flood: the decision rule only walks *toward the root*, never speculatively outward, so the substrate's anti-flood guarantee is preserved.
- **Under-reporting** — claiming a cold tier so the seeker escalates — is also bounded. The seeker takes one extra hop per affected tier and terminates at the root, where aggregated truth is hardest to fake (the root sees the union of all sub-tier providers and runs its own cohort gossip).
- **Cross-check via cohort gossip.** Other members of the same cohort can detect a primary whose reported rate diverges from the gossip-derived view that drives their own replies. Detection routes through the reputation subsystem (out of scope here; see [architecture.md](architecture.md) §Reputation).
- **No threshold signature on the reply.** Reasonable for now: a threshold signature on every registration and query reply is expensive, and the bounded worst-case above does not justify the cost. A future ticket may revisit if observed abuse warrants it.

> **Simulator-validated** (`simulator-matchmaking-hangout`). Both adversarial bounds are reproduced
> as assertions in the modeled seeker walk: under-reporting costs **≤ one extra register hop per
> tier** (the seeker still terminates at the root), and over-reporting costs **≤ `patienceMs` of
> wasted hang-out drain** (no spatial flood — the walk only ever steps toward the root).

> **Implemented** (mock-tier e2e pending). The seeker-side bounds are
> `packages/db-p2p/src/matchmaking/traffic-validation.ts` (`boundReportedTraffic`): `capPatienceMs =
> max(0, patienceRemaining)` (over-report can waste at most the remaining wall-clock patience) and
> `escalateAfterTiers = 1` (under-report costs at most one extra hop per tier). The bounds hold **by
> construction** of the existing toward-root-only walk (`SeekerWalkClient`), so this function documents
> + asserts them rather than changing the walk topology; `maxWalkHops(dMax) = (dMax + 1)` is the
> total-hop ceiling. **Reputation cross-check hooks** are provided as *emission points* only:
> `boundReportedTraffic` emits `TrafficCrossCheckSignal`s (over-/under-report suspicion, cross-checking a
> reply's reported population against the seeker's own immediate-query yield), and `reportTrafficCrossCheck`
> is a thin bridge into the existing `IPeerReputation` (`reportPeer` with `ProtocolViolation`); the
> aggregation/decay/penalty policy that turns advisory signals into an actual sanction stays the
> reputation subsystem's job (out of scope here, see [architecture.md](architecture.md) §Reputation). Spec:
> `traffic-validation.spec.ts` (db-p2p) — the bound unit tests plus an **end-to-end adversarial walk**
> over the real `SeekerWalkClient` asserting under-report ≤ one hop/tier (terminating at the root) and
> over-report ≤ wasted-patience + one hop (no outward probing).
>
> **GROUNDING resolutions (recorded):**
> 1. **No threshold signature is added per `QueryReplyV1`** — the cohort primary's single-member
>    signature stands. The bounded worst-case above (patience-capped over-report; one-hop-per-tier
>    under-report) does not justify the per-reply threshold cost. A future ticket may revisit if observed
>    abuse warrants it. (The multi-cohort-sweep `AggregateCountV1` *is* threshold-signed — see §Wire
>    formats — because it attests an aggregate the cohort vouches for, not one primary's advisory view.)
> 2. **Eligibility filtering may be done either client-side via the reputation subsystem *or* via
>    per-entry `registrationSig` verification on the query reply, and matchmaking supports both** — it
>    carries identity + signatures (so reply-side `registrationSig` + proof verification is free), while
>    the reputation subsystem provides the metric (an optional, additive pre-filter, never a dependency).
>    The voting plan ticket decides the policy; the discovery flow already wires reply-side verification as
>    the default-and-required path (§Voting-quorum, resolved decision 1).

### Arrival push missed or primary fails mid-coalesce

A hanging-out seeker on the push path ([§Arrival push on provider arrival](#arrival-push-on-provider-arrival)) never depends on the push for correctness. Its sparse safety poll (`push_safety_poll_ms`) plus a mandatory final `QueryV1` before `patienceMs` drains make the push a **pure optimization**: a seeker that receives no pushes returns the same providers it would have under the legacy `requery_interval_ms` poll, only at a coarser cadence.

The primary's per-seeker coalescing buffer is **soft, transient, non-gossiped** state. On primary failover the unflushed batch is lost and nothing replays it — unlike reactivity's replay buffer, which exists because committed revisions must not be lost; matchmaking arrivals are advisory and re-discoverable by query. The safety/final poll recovers the lost arrivals.

A withholding or forging primary is bounded exactly as [§Adversarial cohort traffic reporting](#adversarial-cohort-traffic-reporting) describes: withholding costs the seeker nothing beyond the safety-poll cadence, and a forged `ArrivalPushV1` is rejected because the seeker re-validates each entry's `registrationSig` before dialing.

### Provider primary fails mid-renewal
Standard cohort-topic primary handoff. The registration record is in cohort gossip, backups take over. Seekers querying during the gap may not see this provider; on the seeker's next query (or on the provider's next renewal) it reappears.

### Seeker dies mid-query
Seeker registration ages out via short TTL. Providers may notice (if they monitor seeker activity for collective assembly) but in general nothing else needs to happen.

### Topic suddenly becomes hot
A topic's tree grows by normal promotion. Seekers querying during a promotion event may receive the cohort's pre-promotion provider set; this is acceptable because matchmaking returns advisory sets — the seeker re-queries if it didn't get enough matches, which naturally happens at the next-tier cohort after the redirect.

### Topic mostly empty but has stale registrations
TTL expiry handles this. Eviction is gossiped within the cohort; queries always return the post-eviction view.

### Topic root cohort overloaded by simultaneous bootstrap
A topic that becomes hot all at once (e.g., a flash vote) has its first wave of registrations land at the root. The root accepts up to `cap_promote = 64` then fast-promotes (`cap_promote_fast = 32` under load). Subsequent registrations get `Promoted(1)` immediately. The "all at once" wave is bounded by the cohort-topic per-peer rate limit (`register_rate_per_peer = 4 / min` per cohort), which slows pathological storms structurally.

---

## Wire formats

Matchmaking reuses `RegisterV1`, `RenewV1`, etc., from cohort-topic. The application-specific additions:

> **Implemented** (mock-tier e2e pending). Codecs + per-message validation are
> `packages/db-core/src/matchmaking/wire.ts`, matching the cohort-topic wire conventions exactly: all
> JSON, **timestamps unix-ms**, **byte fields base64url (no padding)** via the shared cohort-topic
> `bytesToB64url` / `b64urlToBytes` helpers, per-message structural validation on decode, and stable
> byte fidelity (encode→decode→encode). The provider/seeker app payloads are serialized to opaque
> UTF-8 JSON bytes for the cohort-topic `RegisterV1.appPayload` slot (base64url-wrapped by the
> substrate); the query-protocol messages ride the same length-prefixed framing as cohort-topic
> messages. Validation enforced on decode: `kind` exactly matches the discriminant; `limit <=
> query_limit_max` (256); `capacityBudget >= 0`; `wantCount >= 1`; malformed/oversized payloads
> rejected with `CohortWireError`. The `QueryReplyV1` *producer* is now implemented
> (`packages/db-p2p/src/matchmaking/query-handler.ts`, signed via `queryReplySigningPayload`); the
> `AggregateCountV1` producer lands with the multi-cohort sweep. Spec: `wire.spec.ts`,
> `entry-verify.spec.ts`.

### Provider registration payload

```
interface ProviderAppPayloadV1 {
  kind:            "match-provider"
  capabilities:    string[]
  capacityBudget:  number
  serviceUntil?:   number
  contactHint:     string             // multiaddr or PeerId, application-defined format
  signature:       string             // base64url, over (topicId, capabilities, capacityBudget) — see the signing-scope note below
}
```

### Seeker registration payload

```
interface SeekerAppPayloadV1 {
  kind:           "match-seeker"
  wantCount:      number
  filter?:        CapabilityFilter
  contactHint:    string
  pushOnArrival?: boolean             // NEW — opt into arrival pushes; default false (poll path)
  signature:      string              // base64url, over (topicId, wantCount) — see the signing-scope note below
}

interface CapabilityFilter {
  must:        string[]
  mustNot:     string[]
  minBudget?:  number
}
```

### Query

```
interface QueryV1 {
  v:                  1
  topicId:            string
  includeProviders:   boolean
  includeSeekers:     boolean
  filter?:            CapabilityFilter
  limit:              number          // up to 256 entries per response
  requesterId:        string          // PeerId
  timestamp:          number
  signature:          string
}

interface QueryReplyV1 {
  v:             1
  providers?:    ProviderEntryV1[]
  seekers?:      SeekerEntryV1[]
  truncated:     boolean
  cohortEpoch:   string
  topicTraffic:  TopicTrafficV1        // see cohort-topic.md
  signature:     string                // cohort primary's reply signature; not threshold
}

interface ProviderEntryV1 {
  participantId:  string              // PeerId
  capabilities:   string[]
  capacityBudget: number
  contactHint:    string
  attachedAt:     number
  registrationSig: string             // the provider's original signature, forwarded
}

interface SeekerEntryV1 {
  participantId:  string
  wantCount:      number
  contactHint:    string
  attachedAt:     number
  registrationSig: string
}
```

The query reply is signed by the cohort primary (single-member signature, not threshold) because the response is advisory: the seeker re-validates `registrationSig` on each entry to confirm provider authenticity. The cohort does not vouch for the providers; it vouches only for "these were the registrations I held."

> **Signing scope (resolved).** The provider/seeker registration signatures cover
> `(topicId, capabilities, capacityBudget)` and `(topicId, wantCount)` respectively — the matchmaking
> `correlationId` is deliberately **excluded** from the signed image. A forwarded `ProviderEntryV1` /
> `SeekerEntryV1` carries no `correlationId`, so binding the signature over it would leave the seeker
> unable to reconstruct the exact signed image, making the re-validation above unbuildable.
> Replay-binding of the registration itself is handled independently by the cohort-topic `RegisterV1`
> envelope (its own per-probe `correlationId`, replay guard, and peer-key signature); the matchmaking
> signature attests only authorship of the advertised capability/want claims, anchored to the entry's
> `participantId`. Canonical images: `providerSigningPayload` / `seekerSigningPayload`; seeker-side
> verification: `verifyProviderEntry` / `verifySeekerEntry`
> (`packages/db-core/src/matchmaking/wire.ts`; spec `entry-verify.spec.ts` covers the
> sign → forward → verify round trip and tamper rejection).

### Arrival push (cohort-primary → seeker)

A seeker that set `pushOnArrival` receives arrival notifications over a dedicated matchmaking application protocol. Per [cohort-topic.md §Protocol IDs](cohort-topic.md#protocol-ids), application-specific protocols live under their own subsystem prefix and reuse only the cohort identity and primary/backup assignment from the substrate:

```
/optimystic/matchmaking/1.0.0/arrival-push   — cohort-primary → seeker arrival notification
```

```
interface ArrivalPushV1 {
  v:            1
  topicId:      string
  cohortEpoch:  string
  correlationId: string            // the seeker registration this push is bound to; a
                                   //   seeker that has since re-registered under a new
                                   //   correlationId acks unknown_seeker (see §Edge cases)
  providers:    ProviderEntryV1[]   // fresh, filter-matched, coalesced batch
  topicTraffic: TopicTrafficV1      // current snapshot — lets the seeker re-run its
                                    //   hang-out math and observe childCohortCount>0
                                    //   (promotion → descend) without a separate poll
  signature:    string             // cohort primary's single-member sig — advisory,
                                   //   same trust model as QueryReplyV1; the seeker
                                   //   re-validates each ProviderEntryV1.registrationSig
}

interface ArrivalPushAckV1 {
  v:      1
  result: "ok" | "unknown_seeker"  // unknown_seeker: primary moved / seeker re-registered;
                                   //   primary drops the binding and stops pushing
}
```

Folding `topicTraffic` into the push means a hanging-out seeker re-evaluates hang-out-vs-continue (and sees promotion via `childCohortCount`) on every push, so the structural-change handling the poll loop got for free is preserved. See [§Arrival push on provider arrival](#arrival-push-on-provider-arrival) for fairness, coalescing, and failure semantics.

### Aggregated provider counts (root cohort, multi-cohort sweep)

```
interface AggregateCountV1 {
  v:           1
  topicId:     string
  bucketCounts: {
    targetTier:  number               // typically 1
    prefixSlot:  number               // 0..(F − 1)
    count:       number               // log-bucketed: largest power of two ≤ raw count
  }[]
  signature:   string                 // cohort THRESHOLD-signature blob (not single-member)
  signers:     string[]               // PeerIds of the ≥ minSigs threshold signers; aligns the blob
  cohortEpoch: string
}
```

Returned only by promoted cohorts; cold cohorts that fall through to `NoState` don't produce this.

> **Threshold-sig envelope (resolved).** Unlike `QueryReplyV1` (single-member, advisory),
> `AggregateCountV1` is **threshold-signed** — it attests a cohort-agreed *registered*-provider count, so
> it carries the same `(signature, signers)` envelope as the cohort-topic `PromotionNoticeV1` /
> `DemotionNoticeV1`: `signature` is the concatenated multisig blob and `signers` is the distinct
> `≥ minSigs` member subset that produced it (chunk `i` ↔ `signers[i]`). `signers` is required because a
> threshold blob is unverifiable without the signer set, exactly as for the other threshold-signed
> notices. The canonical signed image (`aggregateCountSigningPayload`) covers `v`, `topicId`,
> `cohortEpoch`, and the bucket set sorted by `(targetTier, prefixSlot)` — order-independent so signer and
> verifier agree. (It still attests only *registered*-provider counts, never *eligibility*; that remains
> the application's reply-side job — see §Voting-quorum.)

---

## Configuration

### Defaults (matchmaking-specific)

| Parameter | Default | Description |
|---|---|---|
| `provider_ttl` (Core) | 90 s | Provider registration TTL on Core nodes |
| `provider_ttl` (Edge) | 60 s | Provider registration TTL on Edge nodes |
| `seeker_ttl` | 10 s | Seeker registration TTL |
| `query_limit_max` | 256 | Max entries returned in a single QueryV1 |
| `aggregate_count_minimum_tier` | 1 | Root cohorts produce aggregate counts only when tree depth ≥ this |
| `seeker_renew_grace` | 5 s | Time a seeker may finish querying after TTL expires (still queryable but not returned in future queries) |
| `patience_default_ms` | 10 000 | Fallback `patienceMs` when the caller does not specify it per-task |
| `patience_per_tier_fraction` | 1.0 | Fraction of remaining patience spent at one tier before considering escalation; 1.0 means "spend it all here before walking" |
| `filter_accept_ratio_initial` | 1.0 | Starting estimate for `filterAcceptRatio`, refined per walk from observed query yields |
| `contention_factor_cap` | 4.0 | Upper bound on the contention multiplier; protects the hang-out decision against pathological `queriesPerMin / arrivalsPerMin` ratios |
| `requery_interval_ms` | 1 000 | How often a hanging-out seeker re-issues `QueryV1` against its cohort on the **non-push** path (a seeker that does not set `pushOnArrival`) |
| `push_coalesce_ms` | 250 | Window the seeker's primary batches fresh matchable arrivals before flushing one `ArrivalPushV1` (see [§Arrival push on provider arrival](#arrival-push-on-provider-arrival)) |
| `push_safety_poll_ms` | 5 000 | Sparse fallback `QueryV1` cadence for a push-aware hanging-out seeker (replaces the 1 s `requery_interval_ms` on the push path) |

> **Defaults validated by simulator.** `contention_factor_cap = 4.0` is confirmed by the design
> simulator and **kept as a global scalar** — see §Hang-out vs. continue for the measured trace
> (uncapped factor 31 → clamped to 4 → threshold 12 vs. an unreachable 93, preventing root-pinning;
> sensitivity sweep thresholds 3/6/12/24 for cap 1/2/4/8). `meanWantCount = 3`, `patience_default_ms
> = 10 000`, `requery_interval_ms = 1 000`, and `push_safety_poll_ms = 5 000` are confirmed as the
> inputs the decision math was validated against (worked example: ~10 polls/match on the poll path,
> ~3 on the push path). No matchmaking default changes for downstream tickets. (Evidence:
> `matchmaking.ts`, `sweep.ts` `contention_factor_cap` rows, `seeker-walk.ts`.)

All of these rows except `push_coalesce_ms` are consumed only by the seeker — they tune the hang-out decision and the seeker's poll/push-fallback cadence (see [§Hang-out vs. continue](#hang-out-vs-continue) and [§Arrival push on provider arrival](#arrival-push-on-provider-arrival)). The cohort-topic layer is unaware of them, so they're application-level rather than protocol-level: changing them on a seeker has no wire impact. `push_coalesce_ms` is the one cohort-side knob — it tunes the batching window on the seeker's matchmaking-app primary, not the cohort-topic substrate, so it likewise carries no cohort-topic protocol impact. No corresponding per-peer rate limit yet exists for `QueryV1` (only `RegisterV1` is rate-limited via `register_rate_per_peer = 4 / min`). On the **non-push** path, at the default `requery_interval_ms = 1000` and `patience_default_ms = 10000` a hanging-out seeker issues at most ~10 queries per match. On the **push** path it issues at most `patienceMs / push_safety_poll_ms + 1` queries (≈ 3 at defaults — the sparse safety polls plus the mandatory final poll), and zero in the common case where the first push already satisfies `wantCount`. Either way it stays within current cohort budgets. Adding a `QueryV1` rate ceiling is out of scope here; see the matchmaking backlog.

The cohort-topic tier for matchmaking is **T2 (functional)**; matchmaking registrations are declined freely by cohorts under T0/T1 load. The seeker's only recourse is to wait — the cohort-topic anti-flood properties prevent the seeker from making things worse by retrying aggressively.

### Operating envelope

> **Operating envelope (measured).** The validity-envelope finder (`packages/substrate-simulator`,
> `boundary.ts` + `boundary-matchmaking.ts`) measures, per matchmaking claim, the **edge** at which it
> flips pass→fail along a monotone-in-harm axis and the **margin** to the design's operating point —
> re-derived from the committed simulator (`findBoundary` per axis, deterministic from `(seed, config)`).
> One claim sits inside its envelope; the other has a **negative margin**, stated plainly below.
>
> - **`bounded-harm` vs lying-reporter fraction `f`** (§Adversarial cohort traffic reporting; justifies
>   `patience_default_ms` and the `+1 hop / tier` escalation structure). A lying cohort reporter is
>   claimed to cost the seeker `≤ +1` hop per under-reported tier and `≤ patienceMs` of drain while the
>   seeker **still matches**. Against a **per-query-flip** adversary (which the seeker cannot settle
>   against, since the lie flips each query), holds for **`f < 0.187`** (margin **+0.187** to the
>   all-honest design point `f = 0`). Past the edge — once ~2 path tiers flip — the seeker fails to
>   **match at all** (`harmMechanism = match-failure`), because `patience_per_tier_fraction = 1.0`
>   commits the whole patience budget to a single lied-about (provider-less) tier. The **static**
>   under-report control still holds at `f = 1`, so the margin is the flip adversary's, not vacuous.
>   This `f*` is the principled measure of the need for `matchmaking-per-tier-patience-splitting` —
>   per-tier patience budgets would raise it. (`patienceMs = 10 s`, 8-tier path, `wantCount = 8`.)
> - **`hang-out-fairness` vs seeker:provider ratio `ρ` — negative margin (known operating-point
>   caveat)** (§Hang-out vs. continue → Decision rule, §Configuration `contention_factor_cap`). The
>   shipped capped-approximation hang-out decision is claimed to track the exact `Σ wantCount` decision.
>   It holds only for **`ρ < 2.5`**, which is **below** `ρ = 3 = cap − 1` — the ratio at which the exact
>   contention `1 + ρ` saturates `contention_factor_cap = 4`, the design's assumed worst-case
>   contention. The margin is therefore **−0.5** (`designInsideEnvelope = false`): the approximation
>   **misfires before** contention even reaches the cap (exact contention at the edge is 3.5 < 4), so a
>   seeker hangs out where the exact-sum rule says escalate. This negative margin is the principled
>   signal that the deferred exact-sum refinement (`matchmaking-contention-from-seeker-pool`) **is**
>   warranted, to preserve the hang-out decision across the `2.5 ≤ ρ < 3` divergence window. It does
>   **not** contradict the §Worked example finding that the cap should stay a *global scalar*: that
>   concerns the divide-by-small-`arrivalsPerMin` protection and the un-capped flip regime (the flip at
>   `ρ* = 2.5` is itself in the regime where the exact contention 3.5 is still below the cap), so the
>   global cap and the exact-sum refinement address different questions.

---

## Worked scenarios

> **Simulator scenarios.** The adversarial-traffic-reporting case (§Adversarial traffic reporting) is
> executed by the simulator's scenario runner (`packages/substrate-simulator`, `scenarios.ts` →
> `AdversarialReportingScenario`, on top of `seeker-walk.ts`): it validates bounded harm — a lying
> primary that under-reports costs ≤ one extra escalation hop per under-reported tier, and one that
> over-reports wastes ≤ `patienceMs` of hang-out drain.
>
> **Measured (validated by simulator).** `AdversarialReportingScenario`: an **under-reporting**
> primary (claims upper tiers are cold) cost the seeker **+2 escalation hops over 2 under-reported
> tiers (≤ 1/tier)** and the seeker still terminated at the root (matched). An **over-reporting**
> primary (claims a thin tier is hot) wasted **9,000 ms of hang-out ≤ `patienceMs = 10,000 ms`**, and
> the seeker terminated at **10,000 ms ≤ `patienceMs` + setup**. Both adversarial bounds hold. The
> three worked examples below are confirmed against the decision engine.

### Capability lookup in a sparse network

A node needs a peer that holds the `geocode-resolver` capability. Network has 5 000 peers, ~30 of which offer this capability.

Provider side: 30 nodes have each registered at `topicId = H("capability" ‖ "geocode-resolver" ‖ "match")`. With `n_est = 5000`, `d_max = log_16(5000) − 1 ≈ 2`. Most providers walked from `d = 2` toward the root; with only 30 providers the tier-0 cohort accepts them all (well under `cap_promote = 64`).

Seeker side: a node needs three resolvers. Walks from `d_max = 2`: probes `coord_2(self, topicId)` → `NoState`; `d = 1` → `NoState`; `d = 0` → `Accepted` as seeker, then issues `QueryV1{limit: 16}`. Cohort returns the 30 providers. Seeker picks three (e.g., by latency to its peer ID), dials each directly, gets work done. **Confirmed:** this is the simulator's cold-walk shape — `wantCount` met only at the root, hop count `= d_max + 1` inward probes (no bootstrap, since the root already holds providers); the cold-*bootstrap* worst case adds one (`d_max + 2`, per the `d_max_cap` sweep). **Mock-tier e2e:** `mesh-walk.spec.ts` "sparse/cold regime" reproduces this over the real seeker walk + real cohort store (`d_max + 1` real register hops, `wantCount` met at the root, every returned entry `registrationSig`-re-validated).

### Voting on a popular proposal

A governance proposal has 200 000 eligible voters; topic `topicId = H("quorum" ‖ proposalHash ‖ "match")`. Within the voting window, eligible voters register as providers carrying their eligibility signatures.

The tree grows to depth `⌈log_16(200000 / 64)⌉ = 3` tiers. Each tier-3 cohort holds ~50 providers from its prefix-shard. **Confirmed:** the depth law holds exactly at this scale — the simulator's voting-quorum scenario settles a 5,000-voter herd at depth 2 with the root never exceeding `cap_promote = 64`, and the scale sweep measures depth 3 at N = 100k and 4 at N = 1M, so 200k → depth 3 as written.

The voting coordinator (or a delegated quorum-assembler peer) registers as a seeker at the root, queries with `AggregateCountV1`, learns where the populations are, then does a multi-cohort sweep across selected tier-3 cohorts to assemble a quorum of, say, 64 random voters. Each query returns its slice of providers (with eligibility sigs included); the coordinator validates and selects. **Mock-tier e2e:** the sweep *port-binding* — `runMultiCohortSweep` over the real `buildAggregateCount` (depth-gated, log-bucketed, threshold-signed) and real shard records, with per-entry `registrationSig` re-validation (a forged shard entry rejected) — is exercised in `mesh-sweep.spec.ts` over a single modeled tier-1 shard backed by the real cohort store. The *multi-tier topology* (a depth-3 tree with many real tier-3 shards) and real `k − x` threshold assembly remain gated on the cohort-topic promotion follow-ons; the depth law itself is simulator-confirmed (above).

Throughout, the root cohort's load is bounded: registration storms get `Promoted(1)` quickly; only the seeker's `AggregateCountV1` and the demoted "almost everyone left" tail hit the root directly. Tier-1 and below carry the bulk of provider state.

### Real-libp2p e2e coverage

> **Provider registration AND the seeker query RPC serve side confirmed over real sockets; the outbound
> seeker walk client deferred.**
> [`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`](../packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts)
> (env-gated) stands up 3–16 production `cohortTopic`-enabled libp2p nodes over real TCP. The **provider
> side** is confirmed real: a provider registration at the matchmaking application tier (T2) is admitted by a
> real cohort over the real willingness quorum, the routed primary **holds the provider record** (the read a
> `QueryV1` serves from — `CoordEngine.records`), and the record **replicates into a sibling cohort member
> over real `/cohort-gossip`**.
>
> The **seeker query RPC serve side is now live in production** (`matchmaking/query-transport.ts`, registered
> at the composition root over `/optimystic/matchmaking/1.0.0/query`): test 5b has a **remote** node dial the
> routed primary with an encoded `QueryV1` and asserts the decoded `QueryReplyV1` carries the provider entry
> (with a forwardable `registrationSig` re-validated end-to-end via `verifyProviderEntry`), the cohort's
> `topicTraffic` snapshot, and the node's single-member reply signature — plus the **no-reply** (0-byte frame)
> DoS-guard path for a topic the dialed node serves no engine for. This completes the provider-directory half
> of §Seeker query end-to-end over real sockets.
>
> **What is NOT yet real (tagged `it.skip`, not faked):** the **seeker hang-out walk converging to a match**
> over real sockets. The serve RPC it queries is live (5b), but no production *client* drives the outbound
> multi-tier walk + hang-out poll loop — the seeker walk's `query()` / `register()` driver is unbound. The
> hang-out *decision* logic (hang-out-vs-continue, adversarial bounds) is mock-tier-validated
> (`matchmaking/mesh-walk.spec.ts`) and simulator-validated (above). **No real-network observation here
> contradicts the simulator** — the provider-directory substrate plus the query serve RPC are confirmed on
> real libp2p; the outbound seeker walk client is the documented follow-on, tracked by
> `matchmaking-query-rpc-seeker-walk` (the `SeekerWalkTransport.query` socket binding — the continuation of
> the mock-tier sweep/walk work).

### Sparse provider, very large network

A specialty capability (`zk-snark-prover-v2`) has 5 providers in a network of 10 M peers.

Each provider, walking from `d_max = log_16(10M) − 1 ≈ 5`, falls through all the way to the root. Five registrations at the root cohort; far below `cap_promote`. Tree stays at depth 0.

A seeker similarly walks 5 tiers toward the root, registers, queries, gets the 5 providers. Total cost: 6 RPCs (`d = 5, 4, 3, 2, 1, 0`), the cost of which is dominated by FRET routing not provider lookup. The cost-per-seek is logarithmic in network size, not linear in provider count. **Confirmed:** the `d_max_cap` sensitivity sweep measures cold-walk hops as exactly `d_max + 2` when the root must also bootstrap (5, 6, 7, 8 hops for `d_max` = 3, 4, 5, 6); here the root already holds the 5 providers, so the seeker is `Accepted` at `d = 0` without the extra bootstrap hop — 6 RPCs (`d_max + 1`), as written. **Mock-tier e2e:** `mesh-walk.spec.ts` "sparse provider, very large network" drives exactly this — `d_max = 5`, 5 real providers at the root, **6** real register hops (`d = 5…0`) terminating with `wantCount` met.

---

## Interaction with other subsystems

- **Cohort topic** ([cohort-topic.md](cohort-topic.md)) — substrate. Matchmaking is the directory application.
- **Reactivity** ([reactivity.md](reactivity.md)) — sibling application on the same substrate. Operationally independent; matchmaking does not consume reactivity notifications and vice versa.
- **Transaction log** ([transactions.md](transactions.md)) — provider eligibility for some matchmaking topics derives from committed state (stake, reputation, signed capability claims). The voting use case is the most explicit example.
- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — ring, cohorts, routing. Reached through cohort-topic.
- **Reputation** (see [architecture.md](architecture.md)) — providers' reputation scores may be consumed by seekers when ranking candidates; the matchmaking layer carries the identity, the reputation subsystem provides the metric.
- **Voting** (forthcoming doc) — first-class consumer; matchmaking provides quorum-member discovery, voting provides the ballot and tally protocols.
