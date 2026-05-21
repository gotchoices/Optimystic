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
  signature:       string              // over capabilities + capacityBudget + topicId + correlationId
}
```

The registration uses cohort-topic tier `T2` (functional). TTL is the cohort-topic default for the provider's node profile — typically 90 s on a Core node, 60 s on Edge. Providers renew normally; if a provider stops renewing, its registration ages out and seekers stop seeing it.

Providers are not exclusive. The same node may provide for multiple `T` simultaneously, registering at each topic's tree independently. The cohort-topic per-cohort topic budget bounds how much breadth any single cohort sees.

### Provider self-throttling

A provider whose `capacityBudget` is reached has two options:

- **Withdraw** by sending a `RenewV1` with TTL = 0, evicting the registration immediately.
- **Stay listed but signal full** by setting `capacityBudget` to 0 in subsequent renewals. Seekers can interpret this as "available but at capacity"; appropriate when a fast turnover is expected.

Either way, the layer enforces correctness only at the registration level; the seeker is responsible for picking among current providers.

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
  signature:      string
}
```

with TTL set short — typically 5–15 s — since seekers normally don't wait long.

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

### Distributing the query across the tree

When a topic is hot enough that providers live across many tier-`d ≥ 1` cohorts, a seeker may want a representative sample across the ring. Two patterns:

1. **Single-cohort sample.** The seeker queries the cohort it registered with. Providers held there are sharded by peer-ID prefix; the sample is biased toward providers whose peer-ID shares the seeker's prefix. Often this is fine — geographic and latency locality often correlate with prefix locality in deployed networks.
2. **Multi-cohort sweep.** The seeker, after registering at its natural tier, additionally queries the root cohort (tier 0). The root maintains aggregated provider counts (not individual entries, but bucketed counts per tier-1 shard) and can redirect the seeker to specific tier-1 cohorts holding many providers. The seeker then queries those directly.

The multi-cohort sweep costs more RPCs and is reserved for use cases where representativeness matters more than latency (voting quorums, capability fairness audits).

---

## Voting-quorum assembly

Voting is a first-class consumer of matchmaking. The voting subsystem assembles a quorum of peers to count ballots, validate eligibility, and produce a threshold-signed tally. Matchmaking provides the discovery primitive:

1. A proposal `P` defines a `topicId = H("quorum" ‖ proposalHash(P) ‖ "match")`.
2. Eligible voters (or vote-counters, depending on the voting protocol) register as providers at this topic. Their `capabilities` field carries proof-of-eligibility tags (e.g., a signature over the proposal from a stake-bearing key).
3. The voting coordinator registers as a seeker, queries the cohort, and receives the set of eligible registered voters.
4. The coordinator selects a quorum from the returned set, using whatever quorum rule the voting protocol specifies (random sample, stake-weighted selection, geographic distribution, etc.).
5. The coordinator dials the selected providers directly and runs the protocol-specific vote-collection RPCs (which are *not* part of matchmaking).
6. When voting concludes, the topic's tree demotes naturally as providers stop renewing.

### Why this works for voting

- **Anti-flood under heavy participation**: a high-profile vote will produce a deep tree as registrations exceed `cap_promote`; queries shard across the tree without overloading the root cohort or any single cohort.
- **Verifiable eligibility**: provider registrations are signed, eligibility evidence is part of `capabilities`, and the cohort's threshold-signed responses anchor the result.
- **Bounded membership**: TTL ensures dead voters age out; the cohort never reports staler-than-TTL registrations.
- **Resists Sybil at the matchmaking layer**: the cohort doesn't validate eligibility (that's the application's job), but the per-peer rate limits and signature requirements raise the cost of forging mass registrations.

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
   If `currentMatches + expectedNewMatches ≥ wantCount × contentionFactor`, **hang out**: keep the seeker registration alive via TTL renewals; re-query at `requery_interval_ms` (default 1 s; see §Configuration) until `wantCount` matches accumulate or `patienceMs` elapses.
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

### Edge cases

The §Decision rule above is the common path. A few specific situations need explicit handling:

1. **`topicTraffic` absent on the reply.** The substrate guarantees `topicTraffic` on `Accepted` and `Promoted` (see [cohort-topic.md §Topic traffic signal](cohort-topic.md#topic-traffic-signal) for the per-result presence matrix). If a reply omits the field — an older peer, a protocol mismatch, or a malformed responder — the seeker treats the cohort as zero-rate and walks one tier toward the root without hanging out. No estimation is attempted against absent inputs.

2. **`arrivalsPerMin = 0` immediately after a cohort epoch change.** Per-topic counters reset on rotation (see [cohort-topic.md:242](cohort-topic.md#topic-traffic-signal)). For the first ~`windowSeconds` of a new epoch the rate under-reports — possibly to zero — even if the underlying provider population is healthy. A seeker tolerates this by **not withdrawing on a single zero reading**. Instead it issues one `QueryV1` first; if the query returns ≥ `wantCount` matchable providers, the cohort was simply quiet, not empty. The seeker escalates only when the query also yields below threshold.

3. **`UnwillingCohort` before `topicTraffic` is computed.** The registration was refused at the substrate level (see the walk-reply table above); the hang-out decision is not entered at all because the seeker never received `Accepted`. Standard substrate back-off applies.

4. **Filter that matches almost nothing.** As successive queries return providers that fail the seeker's `filter`, `filterAcceptRatio` decays toward zero. `expectedNewMatches` collapses with it; the threshold check fails at every tier; the seeker walks all the way to the root. This is the right outcome — a pathological filter is inherently expensive, and the root's aggregated pool gives the filter its best chance.

5. **Many seekers competing simultaneously.** A burst of competing seekers drives `queriesPerMin` up, which drives `contentionFactor` up, which makes the threshold harder to meet at any given tier — so more seekers escalate toward the root, which is where aggregation lives. The multiplier is capped at `contention_factor_cap = 4.0` (see §Configuration) so a runaway query rate cannot pin every seeker to the root indefinitely. Self-balancing.

### Test expectations

Matchmaking has no implementation yet; the cases below are doc-as-spec. Each becomes a unit or integration test when the package lands.

- *Hot topic, deep tier suffices.* Seeker stops at the first `Accepted` whose query meets `wantCount`; no walk past the tier of first match.
- *Cold topic, walks to root.* Seeker traverses every tier from `d_max` down to `d = 0`; `wantCount` is met only at the root.
- *Borderline topic, hangs out for full patience.* Seeker stays at the accepting tier, re-queries roughly `patienceMs / requery_interval_ms` times, and returns the partial set if still under-met when patience drains.
- *Patience drains correctly across walked tiers.* Each escalation hop deducts elapsed time from the budget; the final hang-out at the terminal tier sees the original `patienceMs` minus all hops' elapsed time.
- *Seeker withdraws cleanly on escalation.* An outgoing `RenewV1` with `TTL = 0` is sent before re-registering at `d − 1`; cohort gossip evicts the seeker within one round.
- *Stale `arrivalsPerMin = 0` after epoch rotation.* Seeker first issues a `QueryV1`; if the query yields ≥ `wantCount`, no walk; otherwise the seeker walks on the next reading, matching the edge case above.
- *`topicTraffic` missing on reply.* Seeker walks one tier toward the root without hanging out.
- *Filter accept ratio decays across walk.* After two cohorts each return only ~10% matchable providers, `filterAcceptRatio` settles near 0.1 and subsequent `expectedNewMatches` reflects this.

### Out of scope (for this section)

A cohort-side push channel — where the cohort notifies a hanging-out seeker as new matchable providers arrive, replacing the polling `requery_interval_ms` — is a plausible future refinement, but its design (push transport, back-pressure, fairness across seekers) belongs in a separate ticket and is deferred until polling shows observable cost.

---

## Failure modes (matchmaking-specific)

### Adversarial cohort traffic reporting

`RegisterReplyV1` and `QueryReplyV1` carry `topicTraffic` under the cohort *primary's* single-member signature, not a threshold signature (see the `QueryReplyV1` note in §Wire formats below). A malicious primary can therefore over- or under-report.

- **Over-reporting** — claiming a hot tier so the seeker hangs out — is bounded by the seeker's `patienceMs`. Worst-case outcome is wasted patience plus one extra `register → walk` hop after timeout. No spatial flood: the decision rule only walks *toward the root*, never speculatively outward, so the substrate's anti-flood guarantee is preserved.
- **Under-reporting** — claiming a cold tier so the seeker escalates — is also bounded. The seeker takes one extra hop per affected tier and terminates at the root, where aggregated truth is hardest to fake (the root sees the union of all sub-tier providers and runs its own cohort gossip).
- **Cross-check via cohort gossip.** Other members of the same cohort can detect a primary whose reported rate diverges from the gossip-derived view that drives their own replies. Detection routes through the reputation subsystem (out of scope here; see [architecture.md](architecture.md) §Reputation).
- **No threshold signature on the reply.** Reasonable for now: a threshold signature on every registration and query reply is expensive, and the bounded worst-case above does not justify the cost. A future ticket may revisit if observed abuse warrants it.

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

### Provider registration payload

```
interface ProviderAppPayloadV1 {
  kind:            "match-provider"
  capabilities:    string[]
  capacityBudget:  number
  serviceUntil?:   number
  contactHint:     string             // multiaddr or PeerId, application-defined format
  signature:       string             // base64url, over (topicId, capabilities, capacityBudget, correlationId)
}
```

### Seeker registration payload

```
interface SeekerAppPayloadV1 {
  kind:           "match-seeker"
  wantCount:      number
  filter?:        CapabilityFilter
  contactHint:    string
  signature:      string
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

### Aggregated provider counts (root cohort, multi-cohort sweep)

```
interface AggregateCountV1 {
  v:           1
  topicId:     string
  bucketCounts: {
    targetTier:  number               // typically 1
    prefixSlot:  number               // 0..(F − 1)
    count:       number               // log-bucketed
  }[]
  signature:   string
  cohortEpoch: string
}
```

Returned only by promoted cohorts; cold cohorts that fall through to `NoState` don't produce this.

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
| `requery_interval_ms` | 1 000 | How often a hanging-out seeker re-issues `QueryV1` against its cohort |

The last five rows are consumed only by the seeker — they tune the hang-out decision (see [§Hang-out vs. continue](#hang-out-vs-continue)). The cohort layer is unaware of them, so they're application-level rather than protocol-level: changing them on a seeker has no wire impact. No corresponding per-peer rate limit yet exists for `QueryV1` (only `RegisterV1` is rate-limited via `register_rate_per_peer = 4 / min`); at the default `requery_interval_ms = 1000` and `patience_default_ms = 10000` a hanging-out seeker issues at most ~10 queries per match, which is within current cohort budgets. Adding a `QueryV1` rate ceiling is out of scope here; see the matchmaking backlog.

The cohort-topic tier for matchmaking is **T2 (functional)**; matchmaking registrations are declined freely by cohorts under T0/T1 load. The seeker's only recourse is to wait — the cohort-topic anti-flood properties prevent the seeker from making things worse by retrying aggressively.

---

## Worked scenarios

### Capability lookup in a sparse network

A node needs a peer that holds the `geocode-resolver` capability. Network has 5 000 peers, ~30 of which offer this capability.

Provider side: 30 nodes have each registered at `topicId = H("capability" ‖ "geocode-resolver" ‖ "match")`. With `n_est = 5000`, `d_max = log_16(5000) − 1 ≈ 2`. Most providers walked from `d = 2` toward the root; with only 30 providers the tier-0 cohort accepts them all (well under `cap_promote = 64`).

Seeker side: a node needs three resolvers. Walks from `d_max = 2`: probes `coord_2(self, topicId)` → `NoState`; `d = 1` → `NoState`; `d = 0` → `Accepted` as seeker, then issues `QueryV1{limit: 16}`. Cohort returns the 30 providers. Seeker picks three (e.g., by latency to its peer ID), dials each directly, gets work done.

### Voting on a popular proposal

A governance proposal has 200 000 eligible voters; topic `topicId = H("quorum" ‖ proposalHash ‖ "match")`. Within the voting window, eligible voters register as providers carrying their eligibility signatures.

The tree grows to depth `⌈log_16(200000 / 64)⌉ = 3` tiers. Each tier-3 cohort holds ~50 providers from its prefix-shard.

The voting coordinator (or a delegated quorum-assembler peer) registers as a seeker at the root, queries with `AggregateCountV1`, learns where the populations are, then does a multi-cohort sweep across selected tier-3 cohorts to assemble a quorum of, say, 64 random voters. Each query returns its slice of providers (with eligibility sigs included); the coordinator validates and selects.

Throughout, the root cohort's load is bounded: registration storms get `Promoted(1)` quickly; only the seeker's `AggregateCountV1` and the demoted "almost everyone left" tail hit the root directly. Tier-1 and below carry the bulk of provider state.

### Sparse provider, very large network

A specialty capability (`zk-snark-prover-v2`) has 5 providers in a network of 10 M peers.

Each provider, walking from `d_max = log_16(10M) − 1 ≈ 5`, falls through all the way to the root. Five registrations at the root cohort; far below `cap_promote`. Tree stays at depth 0.

A seeker similarly walks 5 tiers toward the root, registers, queries, gets the 5 providers. Total cost: 6 RPCs (`d = 5, 4, 3, 2, 1, 0`), the cost of which is dominated by FRET routing not provider lookup. The cost-per-seek is logarithmic in network size, not linear in provider count.

---

## Interaction with other subsystems

- **Cohort topic** ([cohort-topic.md](cohort-topic.md)) — substrate. Matchmaking is the directory application.
- **Reactivity** ([reactivity.md](reactivity.md)) — sibling application on the same substrate. Operationally independent; matchmaking does not consume reactivity notifications and vice versa.
- **Transaction log** ([transactions.md](transactions.md)) — provider eligibility for some matchmaking topics derives from committed state (stake, reputation, signed capability claims). The voting use case is the most explicit example.
- **FRET** ([../../Fret/docs/fret.md](../../Fret/docs/fret.md)) — ring, cohorts, routing. Reached through cohort-topic.
- **Reputation** (see [architecture.md](architecture.md)) — providers' reputation scores may be consumed by seekers when ranking candidates; the matchmaking layer carries the identity, the reputation subsystem provides the metric.
- **Voting** (forthcoming doc) — first-class consumer; matchmaking provides quorum-member discovery, voting provides the ballot and tally protocols.
