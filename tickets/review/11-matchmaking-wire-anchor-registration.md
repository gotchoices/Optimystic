description: Review the matchmaking foundation layer — wire codecs, stable topic anchor, and provider/seeker registration (decision/state + db-p2p cohort-topic wiring). Query/filter eval and the seeker hang-out engine are explicitly out of scope (next ticket).
prereq: cohort-topic-core-module-fret-integration
files:
  - packages/db-core/src/matchmaking/wire.ts (codecs + validation + signing payloads)
  - packages/db-core/src/matchmaking/topic-anchor.ts (topicId derivation)
  - packages/db-core/src/matchmaking/config.ts (TTL/limit defaults + providerTtlForProfile; hang-out rows stubbed)
  - packages/db-core/src/matchmaking/provider.ts (MatchmakingProvider state/decision)
  - packages/db-core/src/matchmaking/seeker.ts (MatchmakingSeeker registration; query() stub)
  - packages/db-core/src/matchmaking/index.ts + packages/db-core/src/index.ts (exports)
  - packages/db-p2p/src/matchmaking/provider-manager.ts, seeker-manager.ts, index.ts + packages/db-p2p/src/index.ts
  - packages/db-core/test/matchmaking/{wire,topic-anchor,registration}.spec.ts
  - docs/matchmaking.md (implemented callouts in §Anchor, §Provider registration, §Seeker query, §Wire formats; §Test expectations status line)
effort: high
----

# What landed

Foundation layer for the matchmaking **directory application** of the cohort-topic substrate. This ticket implemented, end-to-end at the unit/typecheck level (mock-tier e2e pending):

- **Wire codecs + validation** (`db-core/src/matchmaking/wire.ts`). All matchmaking V1 types: `ProviderAppPayloadV1`, `SeekerAppPayloadV1`, `CapabilityFilter`, `QueryV1`, `QueryReplyV1`, `ProviderEntryV1`, `SeekerEntryV1`, `AggregateCountV1`. Provider/seeker payloads serialize to opaque UTF-8 JSON bytes for the cohort-topic `RegisterV1.appPayload` slot; query-protocol messages ride the cohort-topic length-prefixed framing (`encodeCohortMessage`). Reuses cohort-topic `bytesToB64url`/`b64urlToBytes` and throws `CohortWireError`. Also exports `providerSigningPayload`/`seekerSigningPayload` (deterministic ordered-array images).
- **Stable anchor** (`topic-anchor.ts`). `topicId(kind,label) = H(kind ‖ label ‖ "match")` over the same db-core `IRingHash` (256-bit SHA-256) cohort-topic uses for `coord_d` input. `MatchTopicKind` is the closed set `task|capability|quorum|capacity-class`.
- **Config** (`config.ts`). `provider_ttl` (Core 90s/Edge 60s), `seeker_ttl` 10s, `query_limit_max` 256, `seeker_renew_grace` 5s, `aggregate_count_minimum_tier` 1, plus `providerTtlForProfile`. Hang-out tuning rows (`patience_*`, `contention_factor_cap`, `requery_interval_ms`, `push_*`) are stubbed with documented defaults (owned/consumed by the next ticket).
- **Provider state/decision** (`provider.ts`) + **db-p2p manager** (`provider-manager.ts`): register/renew/withdraw against `CohortTopicService` at tier **T2**, capacity tracking, `signalFull` (`capacityBudget=0`), `markWithdrawn`.
- **Seeker registration** (`seeker.ts`) + **db-p2p manager** (`seeker-manager.ts`): short-TTL register at T2, no renewal by default so TTL eviction is observable. `query()` is a documented stub.

## Verification done

- `yarn build` passes for **db-core** and **db-p2p**.
- `yarn test` in db-core: **590 passing** (49 new matchmaking tests across `wire`/`topic-anchor`/`registration` specs); existing suites unaffected.
- docs/matchmaking.md updated with `Implemented` callouts and the resolved "withdrawal is an optimization not correctness" note; no other docs touched.

# Use cases to validate (reviewer focus)

- **Wire round-trips + byte fidelity.** Every type encode→decode→encode is stable; base64url byte fields round-trip; malformed/oversized rejected (`kind` mismatch, `capacityBudget<0`, `wantCount<1`, `limit>256`, bad base64url, oversized app payload, non-JSON). See `wire.spec.ts`.
- **Anchor determinism + distinctness.** Same `(kind,label)` → identical 32-byte id; distinct per label and per kind (incl. shared-label-across-kinds). `topic-anchor.spec.ts`.
- **Provider self-throttle.** `signalFull` → `capacityBudget=0` and re-signs; `setCapacity` rejects negatives; withdrawal intent recorded. `registration.spec.ts`.
- **TTL semantics.** A brief seeker registration evicts at `seeker_ttl` while a renewed provider survives; an un-renewed provider ages out at `provider_ttl`. Tested over the real cohort-topic `RegistrationStore` with matchmaking payloads as `appState`.

# Known gaps / honest flags (treat tests as a floor)

1. **Signature scope vs. forwarded entries — REAL TENSION, resolve in `matchmaking-query-filter-hangout`.** `providerSigningPayload` binds `(topicId, capabilities, capacityBudget, correlationId)` per the doc, but `ProviderEntryV1`/`SeekerEntryV1` forwarded to seekers carry **no `correlationId`**. So a seeker **cannot recompute the exact signing image** to re-validate `registrationSig`. The cohort-topic `RegisterV1` also generates its *own* per-probe correlationId internally (not the matchmaking one), so the two correlation ids are unrelated. Options for the next ticket: (a) add `correlationId` to `ProviderEntryV1`/`SeekerEntryV1`, or (b) drop `correlationId` from the matchmaking signing scope. Nothing verifies these signatures yet (the seeker-side verifier lands next ticket), so this is not yet a correctness bug — but it must be settled before re-validation is built. `seekerSigningPayload` field scope is likewise a documented refinement (the doc leaves seeker signing fields unspecified).
2. **Self-throttle ↔ substrate mapping.** The matchmaking doc's "set `capacityBudget=0` in subsequent renewals" and "`RenewV1` TTL=0" do **not** map onto cohort-topic `RenewV1` (which has neither an `appPayload` nor a `ttl` field). Realized as: capacity change → **re-register** (updates `appState`); immediate withdraw → **passive TTL expiry** (`withdraw` stops renewing). Acceptable because withdrawal is an optimization, but reviewers should confirm the re-register-on-capacity-change semantics are what downstream expects. An immediate-tombstone renew is a cohort-topic follow-on.
3. **No db-p2p manager tests.** Managers are thin wrappers over `CohortTopicService`; covered only by db-p2p `tsc` typecheck + the db-core unit tests of the underlying state. Consider an integration test against a mock `CohortTopicService` (assert T2 tier, profile TTL, no seeker renewal, re-register on `signalFull`).
4. **TTL eviction tested at the store level, not full member-engine e2e.** The mock-tier/live-tier e2e (mirroring cohort-topic's `live-tier.spec.ts`) is pending — the doc callouts say "mock-tier e2e pending".
5. **`DEFAULT_MAX_APP_PAYLOAD_BYTES = 64 KiB`** is a conservative guess, not a derived bound.
6. **Query/QueryReply/Aggregate producers not implemented** — decoders only (intentional; `seeker.query()` throws a stub error pointing at the next ticket).

# Out of scope (do not chase here)

Query issuance, capability-filter evaluation, hang-out-vs-continue, arrival push, and the multi-cohort sweep / aggregate producer — all owned by `matchmaking-query-filter-hangout` (which also folds the simulator-dependent hang-out tuning rows). No cohort-topic substrate files were modified; matchmaking rides the existing `appPayload` extension point unchanged.
