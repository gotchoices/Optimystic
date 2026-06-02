description: Design the voting-quorum-assembly use case on matchmaking — proposal-hash anchor, eligibility-proof provider capabilities, coordinator quorum selection, and reliance on existing rate-limit / tree-promotion / TTL / Sybil-resistance defenses. Discovery only; no ballot/tally/dispute logic.
prereq: matchmaking-sweep-adversarial-module
files:
  - docs/matchmaking.md (§Voting-quorum assembly L158-176, §Worked scenario "Voting on a popular proposal" L463-471, §Configuration L429-449)
effort: high
----

Specifies how the voting subsystem assembles a quorum **on top of** the implemented matchmaking module (`matchmaking-sweep-adversarial-module`). Matchmaking provides "find the peers"; this ticket designs the voting-discovery flow only. The voting protocol itself — ballot privacy, tally aggregation, dispute escalation — is explicitly **out of scope** and will be specified in a separate (forthcoming) voting doc.

This is a **plan** ticket because genuine open design questions remain even after the simulator settles substrate/hang-out parameters (see Open questions). Per tess rules, no implementation TODO list and no getting ahead of the design.

## Flow (design, from [matchmaking.md §Voting-quorum assembly L158-176](../../docs/matchmaking.md))

1. A proposal `P` defines `topicId = H("quorum" ‖ proposalHash(P) ‖ "match")` via the matchmaking stable anchor (`kind = "quorum"`, `label = proposalHash`).
2. Eligible voters (or vote-counters, per the voting protocol) register as **providers** at this topic. Their `ProviderAppPayloadV1.capabilities` carry proof-of-eligibility tags — e.g. a signature over the proposal from a stake-bearing key. The provider `signature` field still covers `(topicId, capabilities, capacityBudget, correlationId)` so the eligibility proof is bound to the registration.
3. The voting coordinator (or a delegated quorum-assembler peer) registers as a **seeker**, then discovers the eligible registered voters — via single-cohort query for small votes, or the **multi-cohort sweep** (`AggregateCountV1` at root → selected tier-1/tier-3 cohorts) for popular votes.
4. The coordinator selects a quorum from the returned set using whatever rule the voting protocol specifies (random sample, stake-weighted, geographic distribution, …). Selection rule is voting-layer, not matchmaking.
5. The coordinator dials the selected providers directly and runs protocol-specific vote-collection RPCs — **not** part of matchmaking.
6. When voting concludes, the topic's tree demotes naturally as providers stop renewing.

## Why this works (no new matchmaking mechanism required)

Reuses existing substrate/matchmaking guarantees rather than adding protocol:
- **Anti-flood under heavy participation** — a high-profile vote produces a deep tree as registrations exceed `cap_promote`; the root fast-promotes (`cap_promote_fast`) and bounces with `Promoted(1)`; queries shard across the tree without overloading any one cohort. Per-peer `register_rate_per_peer = 4/min` slows pathological storms structurally.
- **Verifiable eligibility** — provider registrations are signed; eligibility evidence is in `capabilities`; the coordinator (or reputation subsystem) re-validates `registrationSig` and the eligibility proof per entry.
- **Bounded membership** — TTL ages out dead voters; the cohort never reports staler-than-TTL registrations.
- **Sybil resistance at the matchmaking layer** — the cohort does not validate eligibility (application's job), but per-peer rate limits + signature requirements raise the cost of mass forged registrations.

## Open questions (must be resolved before an implement ticket)

- **Eligibility filtering placement.** Filter eligible voters client-side via the reputation subsystem *before* querying, or rely on per-entry `registrationSig`/eligibility-proof verification on the query reply (both are supported by the matchmaking module per `matchmaking-sweep-adversarial-module`)? Trade-off: client-side reputation cuts bandwidth but couples voting to reputation availability; reply-side verification is self-contained but returns ineligible entries the coordinator must discard.
- **Flash-vote fairness among competing coordinators.** When multiple coordinators (or quorum-assemblers) race to assemble overlapping quorums from the same provider pool, how is fairness/non-collision decided — FCFS, random sample with rejection, or broadcast-and-race? Does this need any matchmaking signal, or is it entirely a voting-layer concern?
- **Does voting need any matchmaking protocol additions at all?** Working hypothesis: no — discovery is fully covered by the existing register/query/sweep surface. Confirm there is no gap (e.g. a need for the cohort to attest aggregate eligible-voter counts beyond `AggregateCountV1`'s advisory single-member signature).
- **Quorum-assembler delegation.** Is the seeker always the coordinator, or can a delegated assembler peer hold the seeker registration and hand the assembled set back? Affects who holds `patienceMs` and who re-validates.

## Key tests (TDD bullets for the future implement ticket)

- *Flash vote does not overload the root.* 200 000 eligible voters register on one proposal; tree promotion absorbs the storm — the root sees only the bootstrap wave (bounded by `cap_promote` then `Promoted(1)`), the `AggregateCountV1` sweep query, and the demote tail; no cohort exceeds its cap. (Mirrors §Worked scenario "Voting on a popular proposal" — depth `⌈log_16(200000/64)⌉ = 3`.)
- *Eligibility signature verified per provider entry.* A registration whose eligibility proof fails verification is excluded from the assembled quorum; a valid one is included.
- *Coordinator assembles quorum within patience.* For a popular proposal, the coordinator's multi-cohort sweep returns ≥ the target quorum size within the voting-window `patienceMs` (30–300 s range per §Patience budgeting).
- *Natural demotion after close.* Once providers stop renewing, the tree demotes back toward a single root cohort within TTL + demotion hysteresis.
- *Sybil cost.* Forging N mass registrations is rate-limited to `register_rate_per_peer` per cohort per peer; the cost scales with distinct peer identities, not free registrations.

## Out of scope
- All voting-protocol logic: ballots, tally, dispute escalation, ballot privacy. Forthcoming separate voting doc.
- Any change to the matchmaking wire protocol (working hypothesis is none needed; confirm in the open questions above before promoting to implement).
