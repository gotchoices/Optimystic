description: Review the discovery-only voting-quorum assembler (db-core) — VotingQuorumAssembler composing the matchmaking surface into quorum discovery (anchor, eligibility-proof-bearing voter registration, discover→verify→select). Built against an injected QuorumDiscovery seam because the prereq (matchmaking-sweep-adversarial-module) had not yet landed; no matchmaking wire-protocol change.
prereq: matchmaking-sweep-adversarial-module
files:
  - packages/db-core/src/matchmaking/voting-quorum.ts (NEW — the module under review)
  - packages/db-core/src/matchmaking/index.ts (exports voting-quorum.js)
  - packages/db-core/test/matchmaking/voting-quorum.spec.ts (NEW — 24 specs)
  - packages/db-core/src/matchmaking/wire.ts (reused: verifyProviderEntry, providerSigningPayload, ProviderEntryV1, EntrySigVerifier)
  - packages/db-core/src/matchmaking/provider.ts (reused: MatchmakingProvider)
  - packages/db-core/src/matchmaking/topic-anchor.ts (reused: createMatchTopicAnchor, matchTopicId)
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts (the real single-cohort walk the seam will bind to)
  - docs/matchmaking.md (§Voting-quorum assembly — updated)
  - docs/internals.md (§Matchmaking subsystem → Voting-quorum assembly — added)
----

The discovery side of voting, built as a thin composition over the matchmaking module. The genuinely voting-layer pieces (eligibility-proof minting, the quorum selection rule, ballots/tally/dispute) are injected as caller hooks or out of scope. **No matchmaking wire-protocol change.** `yarn build` + `yarn test` are green in db-core (719 passing, incl. the 24 new specs).

## What landed

`packages/db-core/src/matchmaking/voting-quorum.ts` — `VotingQuorumAssembler`:

- **`static quorumTopic(proposalHash)`** → `{ kind: "quorum", label: proposalHash }`; `topicIdFor` resolves `H("quorum" ‖ proposalHash ‖ "match")` via the existing anchor.
- **`registerEligibleVoter(req)`** (voter role) — binds the caller-minted opaque proof into provider `capabilities` under the reserved `voter-eligibility:` tag prefix, builds a `MatchmakingProvider` (default `capacityBudget = 1`), and registers via the injected `registerProvider` port. The provider `signature` covers `(topicId, capabilities, capacityBudget)`, so the proof is bound to the registration and survives forwarding as a self-checkable `ProviderEntryV1`.
- **`assembleQuorum(req)`** (coordinator / delegated-assembler role) — the discover→verify→select pipeline:
  1. single-cohort `walk`;
  2. escalate to multi-cohort `sweep` when `childCohortCount > 0` (hot) or `preferSweep`;
  3. dedup unioned candidates by `participantId`;
  4. optional, additive `reputationPrefilter` (before verification);
  5. reply-side `verifyProviderEntry` (registrationSig) **AND** injected `verifyEligibility` — both must pass;
  6. injected `select` (default first-`targetSize`), deduped.
  Returns `{ quorum, candidates, eligible, metTarget, swept }`. Never blocks past `patienceMs`; partial result ⇒ `metTarget = false`.

Injected voting-layer / transport hooks (never implemented here): `verifyEligibility`, `select`, `reputationPrefilter`, `QuorumDiscovery` (walk + sweep), `EntrySigVerifier`, `sign`, `registerProvider`.

Exported via `matchmaking/index.ts` → propagates through `db-core/src/index.ts`.

## How to validate / use

```ts
// Coordinator side
const assembler = new VotingQuorumAssembler({ discovery, verifyEntrySig });
const result = await assembler.assembleQuorum({
  proposalHash, targetSize: 64, patienceMs: 120_000,
  verifyEligibility: (e) => stakeLayer.verify(eligibilityProofOf(e), proposalHash),
  select: (eligible, n) => stakeWeightedSample(eligible, n),   // optional
});
// result.quorum: selected, eligibility-verified, deduped ProviderEntryV1[]

// Voter side
const voter = new VotingQuorumAssembler({ sign, registerProvider });
await voter.registerEligibleVoter({ proposalHash, eligibilityProof, contactHint });
```

Run: `cd packages/db-core && yarn build && yarn test`. Targeted: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/matchmaking/voting-quorum.spec.ts" --reporter spec`.

## Test coverage (24 specs, mock-tier discovery fixture — no real libp2p)

Eligibility-per-entry (both `registrationSig` + `verifyEligibility` required; `&&` short-circuits so a forged sig never reaches `verifyEligibility`); single-vs-sweep selection (cold ⇒ `swept=false`, hot/`preferSweep` ⇒ `swept=true`, call-count asserted); reply-side discard (ineligible dropped, no extra hop, `candidates` vs `eligible` split surfaced); sweep dedup (voter in two slices counted once); patience/partial (`metTarget` true/false; remaining-patience budget passed walk→sweep, sweep strictly smaller); flash-vote (depth law `⌈log₁₆(200000/64)⌉ = 3`, leaf load ≤ `cap_promote`, sweep assembles ≥ `targetSize`); delegated self-check (a separate coordinator re-runs verify→select over the handed-back set and reaches the same quorum; independently rejects a tampered entry); Sybil eligibility gate (50 valid-sig but unproven registrations all rejected); voter registration (proof bound into capabilities, default budget 1, extra tags merged, explicit budget honoured, payload forwards as a self-checkable entry); selection rule + validation (default first-N, injected stake-weighted rule, reputation pre-filter, invalid `targetSize`/`patienceMs` throw, missing role-dep throws a clear error).

## KNOWN GAPS — review these adversarially (work is a starting point, not a finish line)

1. **The prereq `matchmaking-sweep-adversarial-module` (11.8) had NOT landed.** It provides `MatchmakingSeeker.walk`, `db-core/.../multi-cohort-seeker.ts`, the `AggregateCountV1` producer, and `traffic-validation.ts` — none exist yet. Per the workflow rules ("design as if the prereq lands; do not block on an upstream ticket not being done"), and because db-core is transport-free by architecture (the real walk I/O already lives in db-p2p `seeker-walk-client.ts`), the assembler composes against an **injected `QuorumDiscovery` port (walk + sweep)** rather than importing those concrete pieces. The db-core code therefore builds and tests green in isolation. **This is the central thing to scrutinise: is the seam the right shape, and does it line up with what 11.8 actually produces?**
2. **The db-p2p `QuorumDiscovery` adapter is NOT written** (it can't compile until 11.8 exists). Binding `QuorumDiscovery.walk → MatchmakingSeeker.walk` and `QuorumDiscovery.sweep → multi-cohort-seeker` is a follow-on, naturally folded into `13-matchmaking-e2e-mock-tier` (or 11.8's public module). The reviewer should decide where that adapter lands and whether a dedicated ticket is warranted; this handoff carries `prereq: matchmaking-sweep-adversarial-module` so the runner reviews the integration with full context.
3. **`childCohortCount` surfacing is an integration requirement.** The assembler's single-vs-sweep decision reads `QuorumDiscoverySlice.childCohortCount`, but the real `SeekerWalkClient.run()` returns `{ providers, metWantCount, terminalTier, hops }` — it does **not** currently surface the max observed `topicTraffic.childCohortCount`. The adapter (or 11.8's `MatchmakingSeeker.walk`) must expose it, or the assembler will never auto-escalate to the sweep (only `preferSweep` would). Verify this is addressed when 11.8 lands.
4. **Flash-vote test asserts the law, not real promotion dynamics.** Depth-3 + cap bounds are checked numerically/by-formula and the sweep is exercised over materialized *selected* shards (~108 entries), not 200 000 real registrations through a real promotion simulator (11.8's harness doesn't exist yet). "Tree promotion absorbs the storm" is asserted as a fixture/formula property. A real-tier e2e is the proper home for the dynamic assertion.
5. **Sybil rate-limit assertion is partial.** Only the independent eligibility-gate rejection is asserted here. The `register_rate_per_peer = 4/min` per-cohort-per-peer enforcement is a cohort-topic substrate property tested in that subsystem; this ticket does not re-run a rate-limit harness.
6. **`candidates` semantics = deduped distinct count** (after dedup, before eligibility filtering), a deliberate choice so the dedup test is observable. If the reviewer prefers the raw pre-dedup count surfaced too, that's a small additive change.
7. **`select` trust.** The injected `select` is trusted to return a subset of its `eligible` input; the assembler only dedups its output (does not intersect back against `eligible`). A misbehaving `select` that fabricated entries could inject them — judged acceptable since `select` is a trusted voting-layer hook, but flag if you disagree.
8. **internals.md §Matchmaking subsystem** was created by THIS ticket (11.8 was meant to add it first). Kept lean so 11.8 can expand it (anchor/registration/walk/sweep/adversarial detail) with minimal merge friction; the Voting-quorum subsection nests under it. Watch for duplication when 11.8 lands.

## Out of scope (correctly absent — confirm none crept in)
Ballots, tally, dispute, ballot privacy; the concrete quorum selection rule; eligibility-proof minting / stake-key semantics; any matchmaking wire-protocol change; an attested *eligible*-voter count; the assembler→coordinator hand-back RPC.

## Done-when (met)
- `yarn build` green for db-core (db-p2p untouched).
- `yarn test` green in db-core (719 passing, incl. 24 new voting-quorum specs); existing tests unaffected.
- `docs/matchmaking.md` §Voting-quorum assembly + `docs/internals.md` §Matchmaking subsystem updated; voting-quorum discovery flow marked **implemented (mock-tier e2e pending)**; ballot/tally/dispute kept as forthcoming separate doc; no voting-protocol logic added; no matchmaking wire change.
