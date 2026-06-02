description: Matchmaking wire codecs, stable topic anchor topicId(kind,label)=H(kind‖label‖"match"), and provider/seeker registration (provider T2 register/renew/self-throttle; seeker short-TTL register).
prereq: cohort-topic-core-module-fret-integration
files:
  - docs/matchmaking.md (§Anchor ~L44-56, §Provider registration ~L60-92, §Seeker query ~L96-133, §Wire formats ~L329-425, §Configuration ~L429-449)
  - packages/db-core/src/matchmaking (new: wire.ts, topic-anchor.ts, provider.ts, seeker.ts, config.ts, index.ts)
  - packages/db-p2p/src/matchmaking (new: provider-manager.ts, seeker-manager.ts wiring to CohortTopicService)
  - packages/db-core/src/cohort-topic (RegisterV1/RenewV1, appPayload extension point, base64url codec helpers)
effort: high
----

Foundation layer for the matchmaking **directory application** of the cohort-topic substrate ([cohort-topic.md](../../docs/cohort-topic.md), [matchmaking.md](../../docs/matchmaking.md)). This ticket lands all matchmaking wire types, the stable topic-anchor derivation, and both registration roles' attach/renew/throttle paths. It deliberately stops short of the query/filter evaluation and the seeker hang-out engine (next ticket, `matchmaking-query-filter-hangout`).

Matchmaking reuses cohort-topic `RegisterV1`/`RenewV1` unchanged; the matchmaking-specific shape lives entirely in `SubscribeAppPayloadV1.appPayload` and in a few query/aggregate message types. Per [matchmaking.md §Overview](../../docs/matchmaking.md) the walk-toward-root, willingness checks, promotion/demotion, primary/backup sharding, and TTL semantics are all inherited from the substrate; matchmaking only contributes anchor derivation, the payloads, and the query protocol.

## Wire formats

All JSON, length-prefixed UTF-8, byte fields base64url, unix-millisecond timestamps, per-message validation — matching the cohort-topic wire conventions. Cite [matchmaking.md §Wire formats L329-425](../../docs/matchmaking.md).

```ts
// appPayload variants carried inside cohort-topic SubscribeAppPayloadV1 / RegisterV1
interface ProviderAppPayloadV1 {
  kind:            "match-provider"
  capabilities:    string[]            // application-defined attribute tags
  capacityBudget:  number              // concurrent tasks accepted; 0 == "listed but full"
  serviceUntil?:   number              // unix ms, soft expiry hint to seekers
  contactHint:     string              // multiaddr or PeerId-based callback
  signature:       string              // base64url, over (topicId, capabilities, capacityBudget, correlationId)
}

interface SeekerAppPayloadV1 {
  kind:            "match-seeker"
  wantCount:       number
  filter?:         CapabilityFilter
  contactHint:     string
  signature:       string              // base64url
}

interface CapabilityFilter {
  must:        string[]                // tags that must all be present
  mustNot:     string[]                // tags that must not be present
  minBudget?:  number                  // skip providers whose capacityBudget is below this
}

// Query protocol (evaluation/sweep land in later tickets; codecs land here)
interface QueryV1 {
  v:                1
  topicId:          string
  includeProviders: boolean
  includeSeekers:   boolean
  filter?:          CapabilityFilter
  limit:            number             // <= query_limit_max (256)
  requesterId:      string             // PeerId
  timestamp:        number
  signature:        string
}

interface QueryReplyV1 {
  v:            1
  providers?:   ProviderEntryV1[]
  seekers?:     SeekerEntryV1[]
  truncated:    boolean
  cohortEpoch:  string
  topicTraffic: TopicTrafficV1         // from cohort-topic; consumed by hang-out engine (next ticket)
  signature:    string                 // cohort PRIMARY single-member signature, NOT threshold (advisory reply)
}

interface ProviderEntryV1 {
  participantId:   string             // PeerId
  capabilities:    string[]
  capacityBudget:  number
  contactHint:     string
  attachedAt:      number
  registrationSig: string             // provider's original signature, forwarded for seeker re-validation
}

interface SeekerEntryV1 {
  participantId:   string
  wantCount:       number
  contactHint:     string
  attachedAt:      number
  registrationSig: string
}

interface AggregateCountV1 {          // root-cohort multi-cohort-sweep summary (producer lands in sweep ticket)
  v:           1
  topicId:     string
  bucketCounts: { targetTier: number; prefixSlot: number; count: number }[]  // count is log-bucketed
  signature:   string
  cohortEpoch: string
}
```

Validation rules to enforce on decode: reject malformed/oversized payloads; `limit <= query_limit_max`; `capacityBudget >= 0`; `wantCount >= 1`; `kind` exactly matches the discriminant; base64url byte fidelity round-trips (encode→decode→encode is stable). `QueryReplyV1`/`AggregateCountV1` decode is included here even though their producers land later, so the seeker side can be unit-tested against fixtures.

## Stable topic anchor

Per [matchmaking.md §Anchor L44-56](../../docs/matchmaking.md), matchmaking topics do **not** rotate (contrast reactivity):

```ts
type MatchTopicKind = "task" | "capability" | "quorum" | "capacity-class"
function topicId(kind: MatchTopicKind, label: string): Uint8Array   // = H(kind ‖ label ‖ "match")
```

`kind` namespaces the topic so unrelated label spaces never collide; `label` is application-defined (capability name, proposal hash, task-type id). The resulting `topicId` is fed verbatim into cohort-topic tier addressing (`coord_d(self, topicId)`) — this ticket integrates with, but does not reimplement, `coord_d`. Use the same hash primitive cohort-topic uses for `coord_d` input so the anchor and addressing stay consistent (`cohort-topic-tier-addressing-dmax`). Long-lived `capability`/`task` topics mature a deep tree; short-lived `quorum` topics form a shallow tree that demotes once the proposal closes.

## Provider registration and self-throttling

Per [matchmaking.md §Provider registration L60-92](../../docs/matchmaking.md): a provider attaches at cohort-topic tier **T2 (functional)** with `ProviderAppPayloadV1`. TTL is the cohort-topic profile default — `provider_ttl` Core = 90 s, Edge = 60 s. Providers renew normally via cohort-topic `RenewV1`; on stopping renewal the record ages out and seekers stop seeing it. One node may provide for many topics concurrently (independent trees per `topicId`); the per-cohort topic budget bounds breadth.

Self-throttling (two options, both pure registration-level — the layer enforces correctness only at registration, the seeker chooses among current providers):
- **Withdraw** — `RenewV1` with `TTL = 0`, evicting immediately.
- **Signal full** — set `capacityBudget = 0` in subsequent renewals; stays listed as "available but at capacity."

`MatchmakingProvider` (db-core decision/state) + `provider-manager.ts` (db-p2p, wires to `CohortTopicService.register/renew/withdraw`). Track per-instance capacity so `capacityBudget` reflects live availability across renewals.

> **GROUNDING resolution — is polite withdrawal correctness or optimization?** Document in `docs/matchmaking.md`: withdrawal (`RenewV1` TTL=0) is an **optimization**, not a correctness requirement. A non-withdrawn registration is bounded by TTL eviction and worst-case yields one stale entry to a seeker, which the seeker re-validates and re-queries past. Correctness never depends on prompt withdrawal; it only lowers the seeker's lingering footprint in cohort gossip (worst-case eviction latency ≈ one TTL + one gossip round).

## Seeker registration (part 1)

Per [matchmaking.md §Seeker query L96-119](../../docs/matchmaking.md): a seeker registers **briefly** at the topic with `SeekerAppPayloadV1` so (a) other seekers can find it (collective assembly), and (b) the cohort sees active demand (biasing willingness/promotion). TTL short — `seeker_ttl` default 10 s (range 5–15 s). `MatchmakingSeeker.register` lands here; the QueryV1 issuance, filter evaluation, and hang-out decision are explicitly deferred to `matchmaking-query-filter-hangout`. This ticket must prove a seeker registration attaches and **evicts on TTL** without renewal.

## Configuration (this ticket's slice)

Surface in `db-core/src/matchmaking/config.ts` (cite [matchmaking.md §Configuration L429-449](../../docs/matchmaking.md)): `provider_ttl` (Core 90s / Edge 60s), `seeker_ttl` (10s), `query_limit_max` (256), `seeker_renew_grace` (5s), `aggregate_count_minimum_tier` (1). The seeker hang-out tuning rows (`patience_*`, `filter_accept_ratio_initial`, `contention_factor_cap`, `requery_interval_ms`) are owned by the next ticket but may be stubbed with the documented defaults to keep one config surface. **Simulator dependency:** these are wire/TTL constants not in the simulator's tuning set, so they are stable; the hang-out tuning rows in the next ticket DO depend on simulator findings folded via `fold-simulator-findings-into-design-docs` (transitively a prereq of `cohort-topic-core-module-fret-integration`).

## New package surface

- `packages/db-core/src/matchmaking/` — `wire.ts` (codecs + validation), `topic-anchor.ts`, `provider.ts` (provider state/decision), `seeker.ts` (registration only this ticket), `config.ts`, `index.ts` (exports).
- `packages/db-p2p/src/matchmaking/` — `provider-manager.ts`, `seeker-manager.ts` (cohort-topic wiring). Export from package index.

Repo rules: ES modules, no inline `import()`, no `any`, tabs, small single-purpose functions, cross-platform (browser/node/RN — the codecs and anchor must run in all three), don't break existing tests.

## TODO

### Phase 1 — wire + anchor (db-core)
- Add `packages/db-core/src/matchmaking/wire.ts`: TS interfaces above + JSON encode/decode with base64url byte handling and per-message validation; reuse cohort-topic base64url helpers.
- Add `topic-anchor.ts`: `topicId(kind,label)` using the cohort-topic `coord_d` input hash primitive; export `MatchTopicKind`.
- Add `config.ts` with the matchmaking defaults; export from `index.ts`. Add exports to `packages/db-core/src/index.ts`.

### Phase 2 — provider (db-core + db-p2p)
- `provider.ts`: `MatchmakingProvider` with `register/renew/withdraw`, capacity tracking, signal-full (`capacityBudget=0`), withdraw (TTL=0).
- `db-p2p/src/matchmaking/provider-manager.ts`: wire to `CohortTopicService` register/renew at T2, profile-based TTL.

### Phase 3 — seeker registration (db-core + db-p2p)
- `seeker.ts`: `MatchmakingSeeker.register` (short TTL) only; leave query/decision stubs annotated `// implemented in matchmaking-query-filter-hangout`.
- `db-p2p/src/matchmaking/seeker-manager.ts`: attach with `seeker_ttl`, no renewal-by-default so TTL eviction is observable.

### Phase 4 — tests + doc sync
- Unit tests (db-core): wire round-trips for every type incl. byte fidelity; reject malformed/oversized; `topicId` deterministic and distinct per `(kind,label)`; provider TTL renewal keeps record alive; seeker brief registration evicts on TTL.
- Update `docs/matchmaking.md`: mark provider/seeker registration and wire formats as **implemented (mock-tier e2e pending)**; add the resolved note that polite withdrawal is an optimization not correctness; confirm wire JSON matches the implemented codecs (timestamps unix-ms, bytes base64url).

## Done when
- `yarn build` passes for `db-core` and `db-p2p`.
- `yarn test` green in `db-core` for the new matchmaking wire/anchor/registration suites; existing tests unaffected.
- `docs/matchmaking.md` updated as above; no other docs touched in this ticket.
