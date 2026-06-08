description: Discovery-only voting-quorum assembler on top of the matchmaking module — quorum topic anchor, eligibility-proof-bearing voter registration, coordinator/delegated-assembler quorum assembly via single-cohort query or multi-cohort sweep with reply-side eligibility verification, plus doc sync. No ballot/tally/dispute logic; no matchmaking wire-protocol change.
prereq: matchmaking-sweep-adversarial-module
files:
  - docs/matchmaking.md (§Voting-quorum assembly L161-179, §Worked scenario "Voting on a popular proposal" L641-649, §Wire formats ProviderEntryV1/AggregateCountV1 L509-577, §Configuration L583-614)
  - docs/internals.md (§Matchmaking subsystem — added by matchmaking-sweep-adversarial-module; extend with a Voting-quorum subsection)
  - packages/db-core/src/matchmaking (index.ts public surface, multi-cohort-seeker.ts, seeker.ts walk/sweep, provider.ts, wire.ts ProviderAppPayloadV1/ProviderEntryV1, topic-anchor.ts, config.ts)
  - packages/db-p2p/src/matchmaking (traffic-validation.ts, aggregate-counts.ts, index.ts)
  - packages/db-core/src/matchmaking/voting-quorum.ts (NEW)
effort: high
----

The voting subsystem's **discovery** flow, built as a thin composition over the implemented matchmaking module (`matchmaking-sweep-adversarial-module`). Matchmaking already provides "find the peers": stable anchor, signed provider/seeker registration, the hang-out walk, the multi-cohort sweep, `AggregateCountV1`, and reply-side `registrationSig` re-validation. This ticket adds the small amount of glue that turns that surface into "assemble a quorum of eligible voters for proposal `P`," with the genuinely voting-layer pieces (eligibility-proof *minting*, the quorum *selection rule*, ballot/tally/dispute) injected as caller-supplied hooks or left entirely out of scope.

The plan stage confirmed the working hypothesis and resolved every open question; **no matchmaking wire-protocol change is introduced**. The resolutions are recorded below and must be reflected in `docs/matchmaking.md`.

## Resolved design decisions (from the plan stage — document these)

- **Eligibility filtering placement → reply-side per-entry verification is the default and required path; client-side reputation pre-filter is optional and additive.** Voting is correctness-critical and adversarial; coupling quorum-assembly *liveness* to reputation-subsystem *availability* is unacceptable, so reputation must be an optimization, never a dependency. Matchmaking already forwards each `ProviderEntryV1.registrationSig` plus the `capabilities` carrying the eligibility proof, so reply-side verification is effectively free. The bandwidth cost — the cohort returns ineligible entries the coordinator discards — is bounded by `query_limit_max` (256) per cohort × swept cohorts, which is acceptable. The assembler exposes an optional `reputationPrefilter` hook applied *before* verification to trim candidates when reputation happens to be available.

- **Flash-vote fairness among competing coordinators → entirely a voting-layer concern; no matchmaking signal added.** Matchmaking is explicitly non-authoritative (it returns an advisory *candidate set*, never an allocation — see `docs/matchmaking.md` §Goals/non-goals). Multiple coordinators sweeping the same pool all receive overlapping sets; quorum non-collision is decided by the voting protocol (e.g., providers accept the first coordinator's vote-collection RPC, or a voting-layer leader election picks the assembler). The existing **arrival-push FCFS-by-`attachedAt`, fan-out bounded by `capacityBudget`** already governs the *notification* race for scarce capacity, but that is push fan-out, not quorum allocation. Nothing to add.

- **No matchmaking protocol additions needed → confirmed.** Discovery is fully covered by register / query / sweep / arrival-push. The one candidate gap — a cohort-attested count of *eligible* voters — is out of matchmaking's remit by construction: the cohort does **not** validate eligibility (the application's job), so it can only attest *registered*-provider counts. `AggregateCountV1` is already **threshold-signed** (per `matchmaking-sweep-adversarial-module`), giving voting an attested *registered* count; an attested *eligible*-voter count, if the voting protocol needs one, is a voting-layer aggregate computed by the quorum after discovery+verification, not a matchmaking message. (Note: the plan ticket's parenthetical "AggregateCountV1's advisory single-member signature" was a mis-statement — `AggregateCountV1` is threshold-signed; only `QueryReplyV1`/`ArrivalPushV1` carry the primary's single-member signature.)

- **Quorum-assembler delegation → the seeker role may be held by the coordinator itself or by a delegated assembler peer; whoever holds it owns `patienceMs` and the reply-side re-validation duty.** The `VotingQuorumAssembler` *is* the seeker. A delegated assembler returns an already-validated `ProviderEntryV1[]`; because every entry carries `registrationSig` + the eligibility proof in `capabilities`, the set is independently checkable, so the coordinator MAY re-validate (trust-but-verify) on receipt. The hand-back transport (assembler → coordinator, when they are different peers) is a voting-layer RPC, **not** matchmaking.

## What this ticket builds

A single new discovery-side module, `packages/db-core/src/matchmaking/voting-quorum.ts`, composing the existing public surface. Voting-layer concerns are injected, never implemented here.

```ts
// All types below reuse the matchmaking module's existing exports.
interface VotingQuorumRequest {
  proposalHash:      string                 // -> topic anchor label
  targetSize:        number                 // desired quorum size (>= 1)
  patienceMs:        number                 // 30_000..300_000 per §Patience budgeting; caller-supplied
  verifyEligibility: (e: ProviderEntryV1) => boolean   // voting/stake-layer predicate over the opaque proof in capabilities
  select?:           (eligible: ProviderEntryV1[], targetSize: number) => ProviderEntryV1[]  // voting-layer rule; default = first targetSize
  reputationPrefilter?: (candidates: ProviderEntryV1[]) => ProviderEntryV1[]  // optional, additive (Q1)
  preferSweep?:      boolean                 // force multi-cohort sweep even if single-cohort query would suffice
}

interface VotingQuorumResult {
  quorum:       ProviderEntryV1[]            // selected, eligibility-verified, deduped by participantId
  candidates:   number                       // total returned by discovery before filtering
  eligible:     number                       // passed registrationSig + verifyEligibility
  metTarget:    boolean                       // quorum.length >= targetSize
  swept:        boolean                       // multi-cohort sweep was used
}

class VotingQuorumAssembler {
  // Topic anchor: kind = "quorum", label = proposalHash  =>  topicId = H("quorum" ‖ proposalHash ‖ "match")
  static quorumTopic(proposalHash: string): { kind: "quorum"; label: string }

  // Voter side: bind the (caller-minted) eligibility proof into capabilities, then register as a provider.
  // The proof is opaque bytes to matchmaking; the provider `signature` already covers
  // (topicId, capabilities, capacityBudget, correlationId), binding the proof to the registration.
  registerEligibleVoter(req: {
    proposalHash: string
    eligibilityProof: string                 // base64url, app-defined; minted by voting/stake layer
    capabilityTags?: string[]                // extra app tags merged into capabilities
    capacityBudget?: number                  // default 1 — a voter accepts one vote-collection RPC
    contactHint: string
  }): Promise<void>

  // Coordinator / delegated-assembler side: discover -> verify -> select.
  assembleQuorum(req: VotingQuorumRequest): Promise<VotingQuorumResult>
}
```

Discovery path inside `assembleQuorum`:

1. Resolve `topicId` via `quorumTopic(proposalHash)` and the existing `topic-anchor.ts`.
2. Drive `MatchmakingSeeker.walk({ wantCount: targetSize, patienceMs })` (single-cohort hang-out). If the topic is hot — `walk` observes `childCohortCount > 0`, or `preferSweep` is set — escalate to the existing **multi-cohort sweep** (`multi-cohort-seeker.ts`): query the root for `AggregateCountV1`, select high-population tier-1 shards, fan queries, and union the slices. Set `swept` accordingly.
3. Dedup the unioned candidate set by `participantId` (defensive — a provider transiently visible at two tiers during promotion/redirect must not double-count).
4. Apply `reputationPrefilter` if supplied (optional bandwidth/quality trim).
5. For each remaining entry, re-validate `registrationSig` (reuse the module's existing per-entry validation) **and** `verifyEligibility(entry)`; drop failures. This is the reply-side default path.
6. Apply `select` (default: take the first `targetSize`) and return the `VotingQuorumResult`.

The assembler never dials voters, never collects ballots, never tallies. `select`, `verifyEligibility`, and `reputationPrefilter` are the only voting-layer touch-points, and all three are injected.

## Edge cases & interactions

- **Eligibility proof fails verification.** A registration whose injected `verifyEligibility` returns false is excluded from `quorum`; a valid one is included. Counts surface in `result.eligible` vs `result.candidates`.
- **Forged `registrationSig`.** Excluded by the module's existing per-entry re-validation before `verifyEligibility` even runs. Both filters must pass.
- **Reply-side returns ineligible entries.** Expected by design (cohort does not validate eligibility). They are discarded in step 5; the bandwidth cost is bounded by `query_limit_max × swept-cohort-count`. No error, no escalation.
- **Flash vote / popular proposal (200 000 voters).** Tree promotion absorbs the storm: the root sees only the bootstrap wave (bounded by `cap_promote` then `Promoted(1)`), the `AggregateCountV1` sweep query, and the demote tail. No cohort exceeds its cap. Depth `⌈log_16(200000/64)⌉ = 3`; the assembler sweeps selected tier-3 cohorts. Per-peer `register_rate_per_peer = 4/min` structurally slows pathological registration storms.
- **`patienceMs` exhausted before `targetSize` met.** `walk`/sweep return whatever matched; `assembleQuorum` returns a partial `quorum` with `metTarget = false`. Never blocks past `patienceMs`. The voting layer decides whether a partial quorum is acceptable or whether to re-assemble.
- **Long voting window vs. TTL.** `patienceMs` (30–300 s) can exceed `provider_ttl` (60–90 s); voters MUST renew to stay listed for the whole window, and the assembled set is a TTL-bounded snapshot. A voter that stops renewing ages out and may be returned-then-dead between assembly and vote-collection — the voting layer re-validates liveness on dial. Document this snapshot semantics; do not attempt to "pin" voters in matchmaking.
- **Voter `capacityBudget` semantics.** A voter is not doing concurrent work; default `capacityBudget = 1` (accepts one vote-collection RPC). A voter that sets `capacityBudget = 0` ("listed but full") is still returned by `QueryV1`/sweep but is excluded from arrival-push fan-out — the coordinator decides whether to dial it.
- **Competing coordinators.** Overlapping advisory candidate sets are expected; non-collision is voting-layer (resolved above). The assembler makes no allocation claim. Arrival-push FCFS handles only the notification race.
- **Delegated assembler.** When the assembler peer ≠ coordinator, the assembler holds `patienceMs` and performs steps 5–6; the coordinator may re-validate the handed-back set (every entry is self-checkable via `registrationSig` + the proof in `capabilities`). The hand-back RPC is voting-layer and out of scope here.
- **Epoch rotation mid-assembly / stale `arrivalsPerMin = 0`.** Covered by the existing seeker edge-case handling (issue `QueryV1` first; do not withdraw on a single zero reading). The assembler inherits this from `walk`; add no special-casing.
- **Sybil.** Forged mass registrations are rate-limited to `register_rate_per_peer` per cohort per peer (cost scales with distinct peer identities, not free registrations); independently, `verifyEligibility` rejects any voter without a valid stake/eligibility proof regardless of how it registered.
- **Cross-platform.** `voting-quorum.ts` lives in `db-core` and must run in browser/node/RN (no node-only APIs); it only orchestrates the existing module + caller hooks.

## Key tests (TDD)

- *Eligibility verified per entry.* Given a candidate set where some entries fail `verifyEligibility` and some fail `registrationSig`, only entries passing both appear in `quorum`; `result.eligible`/`result.candidates` reflect the split.
- *Flash vote does not overload the root.* Model 200 000 eligible voters on one proposal; assert tree promotion absorbs the storm (root sees only bootstrap-wave + `AggregateCountV1` + demote tail; no cohort exceeds its cap), depth = 3, and the sweep assembles ≥ `targetSize`. (Drive via the simulator harness used by `matchmaking-sweep-adversarial-module`, or a mock-tier cohort fixture — do not require real libp2p.)
- *Assembles within patience.* For a popular proposal the multi-cohort sweep returns ≥ `targetSize` within `patienceMs`; for an under-populated proposal it returns the partial set with `metTarget = false` exactly when `patienceMs` drains.
- *Reply-side discards ineligible without escalation.* A cohort slice containing ineligible registrations yields a `quorum` of only eligible entries; bandwidth/discard counts are surfaced, no extra walk hop is triggered by ineligibility alone.
- *Sweep dedup.* A voter appearing in two swept slices (simulated promotion overlap) is counted once.
- *Single-vs-sweep selection.* A cold/shallow topic uses single-cohort `walk` (`swept = false`); a hot topic or `preferSweep` uses the sweep (`swept = true`).
- *Delegated assembler returns self-checkable set.* The returned `ProviderEntryV1[]` re-validates independently (registrationSig + proof in capabilities) so a separate coordinator instance re-running steps 5–6 reaches the same `quorum`.
- *Sybil cost.* Forging N registrations is rate-limited to `register_rate_per_peer` per cohort per peer; cost scales with distinct peer identities. (Assert against the existing rate-limit harness; eligibility verification independently rejects unproven voters.)

## Out of scope (do not implement)

- All voting-protocol logic: ballots, tally aggregation, dispute escalation, ballot privacy — forthcoming separate voting doc.
- The quorum **selection rule** (random sample, stake-weighted, geographic): injected via `select`; default is first-`targetSize` only.
- Eligibility-proof **minting** and stake-key semantics: caller supplies the opaque proof and `verifyEligibility`.
- Any change to the matchmaking wire protocol (confirmed unnecessary above).
- An attested *eligible*-voter count (voting-layer aggregate, not a matchmaking message).
- Assembler → coordinator hand-back RPC (voting-layer transport).

## TODO

### Phase 1 — assembler module (db-core)
- Add `packages/db-core/src/matchmaking/voting-quorum.ts`: `VotingQuorumAssembler` with `quorumTopic`, `registerEligibleVoter`, `assembleQuorum`, and the `VotingQuorumRequest`/`VotingQuorumResult` types. Compose the existing `MatchmakingProvider`, `MatchmakingSeeker.walk`, and `multi-cohort-seeker.ts`; reuse the module's `registrationSig` validation. Inject `verifyEligibility`/`select`/`reputationPrefilter`; never implement them.
- Single-vs-sweep decision (childCohortCount / `preferSweep`), dedup by `participantId`, partial-result/`metTarget` handling, default `capacityBudget = 1` for voters.
- Export from `packages/db-core/src/matchmaking/index.ts` (and the package `index.ts` if the matchmaking surface is re-exported there).

### Phase 2 — tests (db-core)
- Implement the Key tests above as unit/integration tests on a mock-tier cohort fixture (reuse the prereq's test harness; no real libp2p). Cover eligibility filtering, flash-vote bound, patience/partial, reply-side discard, sweep dedup, single-vs-sweep, delegated self-check, Sybil cost.

### Phase 3 — doc sync
- `docs/matchmaking.md` §Voting-quorum assembly: record the four resolved decisions (reply-side eligibility default + optional reputation pre-filter; flash-vote fairness is voting-layer; no protocol additions, with the `AggregateCountV1`-is-threshold-signed correction; delegation ownership of `patienceMs`/re-validation). Mark the voting-quorum discovery flow **implemented (mock-tier e2e pending)**; keep ballot/tally/dispute marked as forthcoming separate doc.
- `docs/internals.md` §Matchmaking subsystem (added by the prereq): add a short **Voting-quorum assembly** subsection — anchor, eligibility-proof-bearing registration, the discover→verify→select pipeline, and the snapshot/TTL semantics.

## Done when
- `yarn build` passes for `db-core` (and `db-p2p` if touched).
- `yarn test` green in `db-core` for the new voting-quorum suite; existing tests unaffected.
- `docs/matchmaking.md` and `docs/internals.md` updated as above; no voting-protocol logic added; no matchmaking wire change.
