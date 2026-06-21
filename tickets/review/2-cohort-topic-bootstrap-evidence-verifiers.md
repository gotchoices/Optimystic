description: Review the new cold-start anti-DoS code that makes a node really check (and a participant really produce) the proof attached to a request to spin up a brand-new topic, instead of waving it through.
prereq: cohort-topic-bootstrap-evidence-envelope
files:
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (NEW — createPoWVerifier, createReputationVerifier, BootstrapReputationView)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts (NEW — createBootstrapEvidenceBuilder: PoW minting + optional endorse seam)
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy reworked; CohortTopicAntiDosOptions widened; builder threaded into createCohortTopicService)
  - packages/db-p2p/src/libp2p-node-base.ts (~line 787 — reputation service passed into host antiDos)
  - packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts (NEW — 15 unit cases)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (rewritten reputation/PoW cases + bare-host permissive case)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (reputation stub widened to {isBanned,getScore})
  - docs/cohort-topic.md (§Anti-DoS Implementation note)
difficulty: medium
----

# Review: real PoW + reputation bootstrap-evidence verifiers (db-p2p)

## What landed

The host's **permissive-but-logged** `verifyPoW` / `verifyReputation` defaults are replaced with real,
self-contained checks against the `BootstrapEvidenceEnvelopeV1` from the prereq, the participant mints a
PoW, and the node's reputation service is wired in as the production backing. A *configured* node now
genuinely gates cold-root `bootstrap: true`.

### New verifiers — `bootstrap-evidence-verifiers.ts`
- `createPoWVerifier({ hash, bits })` → `(reg) => boolean`. Parses the envelope, hashes
  `RingHash.H(powPreimage(reg, nonce))`, checks `meetsDifficulty(·, bits)`. One hash, synchronous, total
  (any decode failure → `false`). Bound to `(topicId, tier, participantCoord, timestamp)` ⇒ no
  cross-topic/peer/time replay. `bits` defaults to db-core `DEFAULT_POW_DIFFICULTY_BITS` (20).
- `createReputationVerifier({ reputation, deprioritizeThreshold })` → `(reg) => boolean`. Verifies a
  *referee* peer-key signature over `bootstrapBoundImage(reg)` via `verifyPeerSig`, then requires the
  referee be **not banned AND `getScore < deprioritizeThreshold`** (strict `<`; default 20). Referee MAY
  equal the participant (self-vouch). Unknown referee scores 0 → sufficient.
- `BootstrapReputationView = { isBanned(id): boolean; getScore(id): number }` — widened from the old
  `{ isBanned }`; `PeerReputationService` satisfies it directly. Re-exported from `host.ts` for back-compat.

### Participant minter — `bootstrap-evidence-builder.ts`
- `createBootstrapEvidenceBuilder({ hash, bits, maxNoPowTier, maxIterations, endorse? })` implements the
  db-core `buildBootstrapEvidence` seam. **T2/T3:** CSPRNG nonce search until `meetsDifficulty`, capped at
  `DEFAULT_POW_MAX_ITERATIONS` (2^24) → returns `undefined` on cap-exceeded (never hangs the register).
  **T0/T1:** returns `undefined` unless an `endorse` self-vouch capability is supplied. Returns the **raw**
  envelope JSON bytes (`b64urlToBytes(serialize(env))`) — the service base64url-encodes them, so no
  double-encoding.

### Host wiring — `host.ts createBootstrapEvidencePolicy(antiDos, hash, log)`
- `configured = (bootstrapEvidence override || reputation view)`. Explicit `bootstrapEvidence` overrides
  always win (test seam).
- `verifyPoW`: configured → **real** `createPoWVerifier`; unconfigured → permissive.
- `verifyReputation`: reputation view supplied → **real** `createReputationVerifier`; else fail-closed (configured).
- `verifyParentReference`: the **referee verifier as interim stand-in** when a view is supplied, else fail-closed.
- Unfilled verifiers fail **closed** once configured (so a banned/low-rep referee can't slip the T2/T3 `||`).
- Entirely-unconfigured host stays permissive-but-logged (one warning), preserving every bare-host tier-0 flow.
- New knobs on `CohortTopicAntiDosOptions`: `powDifficultyBits`, `deprioritizeThreshold`.
- The PoW builder is threaded into `createCohortTopicService({ …, buildBootstrapEvidence })`.

### Production backing — `libp2p-node-base.ts`
- `createCohortTopicHost(node, fret, { …host, privateKey, wantK, antiDos: { …host?.antiDos, reputation } })`
  — the node's `PeerReputationService` is the referee verifier's view. Caller `antiDos` overrides preserved.

## Validation / test use cases (the floor, not the ceiling)

- `bootstrap-evidence-verifiers.spec.ts` (15 unit cases, all green): PoW admit at difficulty / admit at
  bits=0 / reject absent-pow, malformed, wrong nonce / reject cross-tuple replay (topic, peer, time).
  Reputation admit valid+reputable / reject bad-sig / banned / at-threshold (strict) / below-threshold /
  self-vouch / cross-register / absent. Builder mint→verify round-trip / undefined for T0/T1 / self-vouch
  via endorse / undefined on cap-exceeded.
- `host-antidos-coldstart.spec.ts` (rewritten): configured host denies T2 no-evidence + admits T2 valid PoW;
  T0 reputable-referee admit + banned-referee deny; T2/T3 disjunction not slipped (banned referee denied,
  valid PoW alone admits); **bare host stays permissive** (tier-0 no-evidence admitted).
- `cohort-topic` directory: **131 passing, 5 pending, 0 failing**. `yarn workspace @optimystic/db-p2p build`
  clean; db-core build clean.

## Honest gaps / decisions for the reviewer to probe

1. **Self-vouch minting is implemented but NOT wired into the production host.** The builder has a working
   `endorse` seam (unit-tested), but `host.ts` constructs the builder *without* it. Rationale: the ticket
   marked it optional ("if cheap… otherwise document as a follow-on"); wiring it added a per-bootstrap
   `signPeer` that risked tipping the already-flaky real-crypto mesh suites (see #4). **Consequence:** a
   *configured* production cohort denies a T0/T1 cold bootstrap (no evidence minted) until the
   parent-reference follow-on lands. The single-tier-0 milestone's cohort-side tests construct evidence
   directly, so this does not block them — but a reviewer should confirm this deferral is acceptable, or
   re-enable `selfEndorse` (the closure is trivial: `referee = self, sig = signPeer(key, boundImage)`).
2. **`verifyParentReference` is the referee reputation verifier as a stand-in.** The real
   committed-parent-topic reference verifier is the explicit follow-on `cohort-topic-bootstrap-parent-reference`.
   So today T0/T1 is gated by reputation, not by an actual committed-parent existence check.
3. **`deprioritizeThreshold` is a host knob defaulting to `DEFAULT_THRESHOLDS.deprioritize` (20); it does
   NOT read the live `PeerReputationService`'s configured threshold** (the service doesn't expose it). If a
   node is constructed with a non-default deprioritize threshold, the gate would drift. Consider exposing
   the threshold off `IPeerReputation` if that matters.
4. **Pre-existing flaky mesh timeouts** in `matchmaking/mesh` + `reactivity/mesh` (12 in the full suite).
   Documented in `tickets/.pre-existing-error.md` with evidence: non-deterministic failing set across runs,
   tests at 4–9.7 s vs the 10 s mocha default, and my diff proven a runtime no-op for the tier-0 unconfigured
   path these suites exercise (re-ran with the no-op builder → still flaky, different subset). Not chased
   here per protocol.
5. **Production PoW path is unexercised at runtime in this milestone.** Cold bootstrap is op-tier-0, so the
   builder never mints a real 20-bit PoW in the current mesh; the PoW path is covered only by unit tests
   (low bits) and the host-antidos T2 cases (bits=0). A reviewer may want a higher-`bits` timing sanity
   check, and to confirm 2^24 is a safe cap for the production default.
6. **Self-referee reputation semantics (interim):** when self-vouch minting is eventually wired, a node's
   local reputation view scores *itself* as 0 → always "sufficient", i.e. any non-self-penalized node can
   self-vouch to originate. That is the documented interim posture (matching the superseded non-banned
   stand-in), tightened later by reputation/parent-ref evolution.

## Suggested review focus

- The fail-closed/permissive matrix in `createBootstrapEvidencePolicy` — confirm no configuration leaves a
  cold-root gate effectively open, and that the bare-host permissive fallback is preserved.
- The raw-bytes contract in the builder (`b64urlToBytes(serialize(env))`) vs the service's
  base64url-encode-before-sign — confirm no double-encoding and that the signed image matches what the
  verifier reconstructs.
- Whether deferral #1 (no T0/T1 minting in production) should instead ship the trivial `selfEndorse` now.
