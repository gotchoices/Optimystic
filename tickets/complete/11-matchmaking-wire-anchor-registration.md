description: Matchmaking foundation layer — wire codecs, stable topic anchor, and provider/seeker registration (decision/state + db-p2p cohort-topic wiring). Query/filter eval and the seeker hang-out engine are out of scope (matchmaking-query-filter-hangout).
files:
  - packages/db-core/src/matchmaking/wire.ts (codecs + validation + signing payloads)
  - packages/db-core/src/matchmaking/topic-anchor.ts (topicId derivation)
  - packages/db-core/src/matchmaking/config.ts (TTL/limit defaults + providerTtlForProfile)
  - packages/db-core/src/matchmaking/provider.ts (MatchmakingProvider state/decision)
  - packages/db-core/src/matchmaking/seeker.ts (MatchmakingSeeker registration; query() stub)
  - packages/db-core/src/matchmaking/index.ts + packages/db-core/src/index.ts (exports)
  - packages/db-p2p/src/matchmaking/{provider-manager,seeker-manager,index}.ts + packages/db-p2p/src/index.ts
  - packages/db-core/test/matchmaking/{wire,topic-anchor,registration}.spec.ts
  - packages/db-p2p/test/matchmaking/managers.spec.ts (added in review)
  - docs/matchmaking.md (implemented callouts), docs/architecture.md (status prose corrected in review)
----

# Complete: matchmaking foundation layer (wire, anchor, registration)

Foundation layer for the matchmaking **directory application** of the cohort-topic substrate. Wire
codecs + per-message validation (`wire.ts`), the stable `topicId = H(kind ‖ label ‖ "match")` anchor
(`topic-anchor.ts`), the TTL/limit config slice (`config.ts`), and both registration roles'
decision/state — provider attach/renew/self-throttle (`provider.ts` + db-p2p `provider-manager.ts`)
and seeker short-TTL registration (`seeker.ts` + db-p2p `seeker-manager.ts`) — registering against
`CohortTopicService` at tier **T2**. Implementation summary is in the implement commit (`5bc7504`);
this file records the review disposition. Query issuance, capability-filter evaluation, the hang-out
engine, the multi-cohort sweep/aggregate producer, and mock-tier e2e are deferred to
`matchmaking-query-filter-hangout` / `matchmaking-sweep-adversarial-module` / `matchmaking-e2e-mock-tier`.

## Review findings

### Scope & method
Reviewed the implement diff (`git show 5bc7504`) with fresh eyes before the handoff: the wire codecs +
validation, the anchor derivation, the config slice, provider/seeker state, both db-p2p managers, all
three db-core specs, and the docs/matchmaking.md callouts. Cross-checked against the substrate it
rides — `cohort-topic/wire/{codec,validate}.ts`, `service.ts` (`CohortTopicService`, `RegisterRequest`,
the caller-driven renewal model), and `tiers.ts` (`NodeProfile`). Scrutinized for SPP/DRY/modularity,
type safety, byte fidelity, resource cleanup, error handling, and spec/doc fidelity. Build + tests run
green: `db-core` `yarn build` + `yarn test` (**590 passing**), `db-p2p` `yarn build`; lint is a
project-wide no-op (`"echo 'Lint not configured…'"`).

### Major — carried forward to the existing owner ticket (not fixed here)
- **Signature re-validation is unbuildable as specified (signing-scope vs. forwarded-entry tension).**
  `providerSigningPayload`/`seekerSigningPayload` bind the registration signature over a tuple that
  **includes `correlationId`**, but the forwarded `ProviderEntryV1`/`SeekerEntryV1` carry **no
  `correlationId`**, so a seeker cannot reconstruct the signed image to verify `registrationSig` — the
  whole advisory trust model (matchmaking.md §Wire formats) depends on that verification. The implement
  handoff flagged this and named `matchmaking-query-filter-hangout` as the resolver, **but that ticket
  did not actually capture it** (no signing-scope decision, and no seeker-side verifier in its TODOs —
  the re-validation would have fallen through entirely). Disposition: rather than fragment the wire/doc
  change into a new ticket, augmented the designated owner `tickets/implement/11.5-matchmaking-query-filter-hangout.md`
  with an explicit "resolve signing-scope tension first" requirement (option a: add `correlationId` to
  the entries; option b: drop it from the signing scope — recommended), plus TODO bullets for the
  pure `verifyProviderEntry`/`verifySeekerEntry` and a sign→forward→verify round-trip test. Not a
  correctness bug in *this* slice because nothing verifies these signatures yet (no producer/consumer
  landed), so no inline code change was warranted.

### Minor — fixed inline this pass
- **No db-p2p manager coverage (handoff gap #3).** The managers carry real branching — TTL precedence
  (explicit > profile > Core default), register-at-T2, capacity-change-is-a-re-register (the substrate
  `RenewV1` carries no payload), and the seeker's deliberate no-renew — covered only by `tsc`. Added
  `packages/db-p2p/test/matchmaking/managers.spec.ts` (11 tests) against a recording mock
  `CohortTopicService`, asserting all of the above. Green in isolation; the change is additive (new
  test file only, no src), so the existing db-p2p suite is unaffected.
- **Stale status prose in `docs/architecture.md`.** Line 239 said "the two applications below remain
  **specified / design-only**" — now false for matchmaking, whose foundation landed at the unit level.
  Corrected to state the foundation (wire/anchor/registration) has landed at unit/typecheck level with
  query/filter/hang-out/e2e pending, leaving reactivity as design-only. The per-subsystem status table
  (matchmaking: simulator `done`, mock-tier e2e `pending`) was already correct and untouched.

### Verified sound (checked, nothing to do)
- **Anchor injectivity.** The delimiter-free `kind ‖ label ‖ "match"` map is injective: the closed
  `MATCH_TOPIC_KINDS` set (`task`/`capability`/`quorum`/`capacity-class`) is prefix-free (notably
  `capability` vs `capacity-class` diverge at char 5), so equal concatenations force equal `(kind,label)`.
  Claim in code/doc/`topic-anchor.spec.ts` holds.
- **Anchor hash provenance.** Uses db-core's own `createRingHash()` (256-bit SHA-256), the same
  primitive cohort-topic feeds `coord_d`, never a FRET import — so the 32-byte id feeds tier addressing
  verbatim. The `no-fret-import` guard is not at risk.
- **Edge-profile T2 registration.** `edgeProfile` permanently excludes T2/T3 *membership*, but the
  managers register a *record* into the T2 cohort (the node is a client of that cohort, not a member);
  `providerTtlForProfile` correctly hands edge nodes the shorter 60 s TTL. Internally consistent.
- **Seeker no-renew property.** Confirmed `CohortTopicService.register` does **not** start a background
  ping timer — renewal is caller-driven via `service.renew(handle)` — so the seeker-manager's "don't
  call renew → ages out by TTL" claim is accurate, not contradicted by the substrate.
- **Byte fidelity.** `encode*` re-validates and rebuilds objects in fixed field order, so
  encode→decode→encode is stable regardless of input key order; `capacityBudget = 0` (listed-but-full)
  survives the round-trip. Covered by `wire.spec.ts`.
- **Type safety / error handling.** Validators narrow-or-throw `CohortWireError`; numeric ranges
  (`capacityBudget ≥ 0`, `wantCount ≥ 1`, `limit ∈ 1..256`) enforced; oversized/non-UTF-8/non-JSON
  rejected. `RangeError` guards on the state constructors. Clean.

### Noted, deliberately not changed
- **DRY: `wire.ts` re-implements ~10 cohort-topic validation helpers** (`asObject`, `reqString`,
  `b64urlField`, etc.) rather than importing them, because `cohort-topic/wire/validate.ts` keeps them
  module-private. Sharing them would mean exporting substrate internals and coupling matchmaking to
  them across a package boundary — a larger refactor touching out-of-diff files. The duplication is
  small, self-consistent, and an explicit implementer decision; left as-is.
- **Handoff gaps #2/#4/#5/#6** (self-throttle→substrate mapping via re-register, store-level vs full
  e2e TTL coverage, the 64 KiB `DEFAULT_MAX_APP_PAYLOAD_BYTES` heuristic, query/aggregate producers
  decoder-only) are accurately documented and correctly deferred to the downstream tickets that own
  them; no action needed in this slice.

### Empty categories
- **Resource cleanup:** nothing to check — this layer owns no timers, sockets, or disposables; the
  renewal driver and its lifecycle are entirely substrate-owned (`CohortTopicService`).
- **Security/crypto:** no new crypto here — signing is an injected callback (libp2p peer key supplied
  by db-p2p); signature *verification* is explicitly the next ticket's (see Major above). Nothing to
  audit in this slice.
