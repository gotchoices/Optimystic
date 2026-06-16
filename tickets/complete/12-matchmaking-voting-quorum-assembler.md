description: Reviewed and accepted the discovery-only voting-quorum assembler (db-core) — VotingQuorumAssembler that composes the matchmaking surface into quorum discovery (anchor → eligibility-proof-bearing voter registration → discover/verify/select). The injected QuorumDiscovery seam now lines up with the real walk/sweep that landed with the prereq; one real seam gap (sweep ignores its patience budget) filed as a follow-up fix.
prereq: matchmaking-sweep-adversarial-module
files:
  - packages/db-core/src/matchmaking/voting-quorum.ts (reviewed; docstring corrected inline)
  - packages/db-core/src/matchmaking/index.ts (exports voting-quorum.js)
  - packages/db-core/test/matchmaking/voting-quorum.spec.ts (24 specs — all pass)
  - packages/db-core/src/matchmaking/wire.ts (reused: verifyProviderEntry, providerSigningPayload, ProviderEntryV1)
  - packages/db-core/src/matchmaking/multi-cohort-seeker.ts (sweep — reviewed; patience-budget gap found)
  - packages/db-p2p/src/matchmaking/module.ts (createMatchmakingQuorumDiscovery — the real adapter; reviewed)
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts (walk — surfaces maxChildCohortCount, reviewed)
  - docs/matchmaking.md (§Voting-quorum assembly), docs/internals.md (§Matchmaking → Voting-quorum)
----

The discovery side of voting, built as a thin composition over the matchmaking module. The genuinely
voting-layer pieces (eligibility-proof minting, the quorum selection rule, ballots/tally/dispute) are
injected caller hooks or out of scope. No matchmaking wire-protocol change. Reviewed adversarially against
the now-landed prereq (`matchmaking-sweep-adversarial-module`).

## What landed (unchanged by review)

`VotingQuorumAssembler` in `packages/db-core/src/matchmaking/voting-quorum.ts`:

- `static quorumTopic(proposalHash)` / `topicIdFor` → `H("quorum" ‖ proposalHash ‖ "match")` via the
  matchmaking anchor.
- `registerEligibleVoter(req)` — binds the caller-minted opaque proof into provider `capabilities` under
  the reserved `voter-eligibility:` tag prefix, builds a signed `MatchmakingProvider` (default budget 1),
  registers via the injected `registerProvider` port. The proof is covered by the provider signature, so
  it forwards as a self-checkable `ProviderEntryV1`.
- `assembleQuorum(req)` — the discover→verify→select pipeline: single-cohort walk → escalate to the
  multi-cohort sweep on a hot topic (`childCohortCount > 0`) or `preferSweep` → dedup by `participantId`
  → optional additive `reputationPrefilter` → reply-side `verifyProviderEntry` (registrationSig) **AND**
  injected `verifyEligibility` (both must pass; `&&` short-circuits) → injected `select` (default
  first-`targetSize`), deduped. Returns `{ quorum, candidates, eligible, metTarget, swept }`.

Build green (db-core), full suite 818 passing (incl. the 24 voting-quorum specs; suite grew from 719 → 818
because the prereq's own tests landed in between).

## Review findings

**Context that changed since implement.** The implement handoff was written while the prereq
(`matchmaking-sweep-adversarial-module`, 11.8) had **not** landed, so the module was built against an
injected mock `QuorumDiscovery` port and the handoff's KNOWN GAPS #1–#3 all hinged on "is the seam the
right shape vs. what 11.8 produces". The prereq has since landed (commits `4b527d0` / `ea56d28`, both
**after** this implement at `8cb4d32`). I reviewed the seam against the real, now-existing code:

- **GAP #1 (seam shape) — RESOLVED, verified.** `QuorumDiscoverySlice { entries, childCohortCount }` maps
  cleanly onto the real producers: `walk` ← `SeekerWalkClient.run()` (`providers`, `maxChildCohortCount`);
  `sweep` ← `runMultiCohortSweep()` (`providers`). The port shape is correct.
- **GAP #2 (db-p2p adapter missing) — RESOLVED, verified.** The prereq shipped
  `createMatchmakingQuorumDiscovery` in `packages/db-p2p/src/matchmaking/module.ts`, binding
  `walk → SeekerWalkClient` and `sweep → runMultiCohortSweep`. It is a thin transport adapter, as intended.
- **GAP #3 (childCohortCount surfacing) — RESOLVED, verified.** `SeekerWalkResult` now carries
  `maxChildCohortCount` (folded across every `Accepted` reply, *before* the immediate-match short-circuit,
  with an explicit comment naming the voting binding), and the adapter forwards it as the slice's
  `childCohortCount`. The auto-escalation-to-sweep path the assembler depends on is live.

**MAJOR — sweep hop ignores its patience budget (new finding, filed as `fix/matchmaking-sweep-patience-budget`).**
The `QuorumDiscoveryRequest.patienceMs` contract ("budget remaining for this hop") is honoured by the walk
leg (threaded into `SeekerWalkClient`'s wall-clock deadline) but **dropped** by the sweep leg:
`createMatchmakingQuorumDiscovery.sweep` calls `runMultiCohortSweep`, whose options have no
patience/deadline field, so it issues `fetchAggregate` + up to `maxShards` (16) sequential shard RPCs with
no deadline check. `assembleQuorum`'s "never blocks past patienceMs" is therefore not upheld on the sweep
path (bounded only by `maxShards × per-RPC timeout`). Not an infinite hang, but a real overshoot the seam
promised against. Filed a dedicated fix ticket to thread a deadline into `runMultiCohortSweep` + the
adapter. The mock-tier specs didn't catch it because the test fixture returns instantly without consuming
the budget.

**MINOR — inaccurate docstring (fixed inline this pass).** `assembleQuorum`'s docstring claimed "Never
blocks past `patienceMs`", which the sweep gap above contradicts. Softened to state it passes the draining
budget to each hop and that the sweep leg is currently bounded by its shard fan-out rather than the budget,
with a pointer to the follow-up. (The fix ticket notes the stronger wording can be restored once the sweep
honours the budget.) Comment-only; build re-verified green.

**Scrutinised and accepted as-is (documented design calls, no action):**

- *`select` trust (handoff GAP #7).* The injected `select` output is deduped but not intersected back
  against `eligible`; a misbehaving `select` could inject entries. Acceptable — `select` is a trusted
  voting-layer hook receiving only the eligible set and `n = targetSize`; intersecting would be defensive
  churn against a trusted boundary. Left as the implementer documented.
- *`candidates` = post-dedup distinct count (GAP #6).* Deliberate so the dedup test is observable;
  consistent and documented.
- *Trust-but-verify redundancy.* The walk already re-validates `registrationSig` (`collect`), and the
  assembler re-validates again. Intended for the delegated-assembler path; cheap and keeps one code path.
- *Eligibility short-circuit.* `verifyProviderEntry(...) && verifyEligibility(...)` correctly checks the
  signature first, so a forged entry never reaches the eligibility predicate (asserted by a spec).

**Tests — checked happy/edge/error/regression/interaction.** Coverage is strong: both-checks-required,
forged-sig short-circuit, single-vs-sweep (cold/hot/preferSweep with call-counts), reply-side discard,
sweep dedup, patience/partial (draining budget walk→sweep, sweep strictly smaller), flash-vote depth law,
delegated self-check + tamper rejection, Sybil eligibility gate, voter registration (proof binding, budget
defaults, tag merge), selection-rule + validation (default/injected/prefilter, invalid targetSize/patience
throw, missing-role-dep throws). Minor untested-but-trivial path: valid params with zero discovered
candidates returning an empty `metTarget=false` result — the partial-quorum spec (targetSize 5, 2 entries)
already exercises the "fewer than target" branch, so not worth a dedicated spec.

**Docs — read and confirmed accurate.** `docs/matchmaking.md` §Voting-quorum assembly and
`docs/internals.md` §Matchmaking → Voting-quorum reflect the now-landed reality (walk + sweep injected as a
`QuorumDiscovery` port, bound in db-p2p via `createMatchmakingQuorumDiscovery`; `maxChildCohortCount` as
the single-cohort-vs-sweep signal; discovery flow marked "Implemented — mock-tier e2e pending"). No
mismatch found; the implement-handoff worry that these would conflict with the prereq's own doc additions
did not materialise (the prereq authored the adapter/walk doc lines and they compose cleanly with the
voting subsection).

**Lint / build / test.** No standalone lint script; `tsc` (strict) is the gate — green for db-core.
`yarn test` green (818 passing). Targeted `voting-quorum.spec.ts` → 24 passing. No pre-existing failures
encountered.

## Out of scope (confirmed absent)

Ballots, tally, dispute, ballot privacy; the concrete quorum selection rule; eligibility-proof minting /
stake-key semantics; any matchmaking wire-protocol change; an attested *eligible*-voter count; the
assembler→coordinator hand-back RPC. None crept in.

## Follow-ups filed

- `fix/matchmaking-sweep-patience-budget` — thread the patience deadline into `runMultiCohortSweep` and
  the `createMatchmakingQuorumDiscovery.sweep` adapter so the sweep hop honours its budget; restore the
  stronger `assembleQuorum` docstring afterward.
