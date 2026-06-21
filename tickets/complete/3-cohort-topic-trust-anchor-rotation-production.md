description: When a cohort's membership changes, the outgoing members now co-sign the new membership list so peers can confirm the change is a legitimate hand-off rather than an impostor takeover. This ticket built the producing side; the verifying side already existed.
prereq: cohort-topic-trust-anchor-fret-binding
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (SignKind += "rotation")
  - packages/db-core/src/cohort-topic/wire/validate.ts (SIGN_KINDS += "rotation")
  - packages/db-core/src/cohort-topic/membership/publisher.ts (extracted+exported membershipCertSignable; RotationAttestation)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (selfEligible option on FretCohortThresholdCrypto.assemble)
  - packages/db-p2p/src/cohort-topic/host.ts (RotationState, produceRotation, publishMembership, handleSignRequest "rotation" branch, registry.findByCoord, CoordEngine.cohortIdentityAt)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (excludeFromAssembly / includeInAssembly)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (tests 8–11)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (rotation endorsement-gate unit tests — added in review)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (the chain check this feeds — UNCHANGED)
  - docs/cohort-topic.md (§Bootstrapping trust — item 3 production note)
----

# Produce rotation attestations on epoch change (db-p2p) — COMPLETE

## What shipped

The db-core verifier already **accepted** a successor membership cert through the attestation chain
(`chainGrantsTrust`): a cert carrying `prevEpoch` / `rotationSig` / `rotationSigners` inherits trust when
the node holds a *trusted* predecessor at `prevEpoch` whose members form a `≥ minSigs` quorum over the
successor's signing payload. Nothing **produced** that `rotationSig`, so the chain was verify-only. This
ticket closes the loop in db-p2p:

On a publish that changes the first `k − x` members, the served `CoordEngine` builds the new cert's
canonical `membershipCertSignable` image (the same helper the publisher signs — now extracted to db-core
and shared), threshold-signs it under the **predecessor** cohort identity via a new `"rotation"` `/sign`
round (`cohortEpoch = prevEpoch`, dialing the outgoing members), and attaches
`{ prevEpoch, rotationSig, rotationSigners }`. The `/sign` endorsement gate for `"rotation"` checks
**prior**-epoch membership (a two-deep observed-epoch history per coord); self contributes only when it was
itself a prior member (`selfEligible`), so the quorum is genuinely the outgoing cohort. Quorum-unavailable
falls back cleanly to a no-attestation publish.

## Review findings

### Scope of the review
Read the full implement diff (commit `239e9cf`) before the handoff summary: db-core `types.ts` / `validate.ts`
/ `publisher.ts`, db-p2p `host.ts` / `threshold-crypto.ts` / mesh harness, the live-tier tests, and the docs.
Re-read the **unchanged** verifier (`membership/verifier.ts`) to confirm the producer output matches what the
chain check consumes. Traced: producer ↔ publisher ↔ verifier signature-image agreement; the
producer/endorser `RotationState` split and observed-history freshness; `minSigs` consistency across the
publisher, the firstKx republish key, and the rotation signer; production driver wiring; and `SignKind`
exhaustiveness.

### Correctness — checked, no defects found
- **Signature-image agreement.** Producer and publisher both sign `membershipCertSigningPayload(
  membershipCertSignable(snapshot))` over the **same single snapshot** (`publishMembership` builds it once and
  passes it to both `produceRotation` and `onStabilized`), and the verifier checks `rotationSig` over
  `membershipCertSigningPayload(cert)` of the published successor — the three images match exactly. Test 8
  round-trips a produced cert through the real verifier and confirms this.
- **Producer/publisher state never desync.** `rotationState.recordPublished(current)` fires iff the publisher
  returned a cert, and the publisher advances its `lastFirstKx` on exactly the same publishes, both keyed off
  the same snapshot and `ctx.minSigs` — so the host's rotation trigger and the publisher's republish gate
  always agree on what is a rotation. `rotating ⇒ publisher publishes` (firstKx changed), and the
  quorum-unavailable / non-rotation paths route correctly (verified by tests 10/11).
- **`selfEligible` quorum scoping.** When self ∉ predecessor, the assembler skips the self-chunk and collects
  purely from the outgoing cohort; peer-id encoding is consistent on both sides (`bytesToPeerIdString`). The
  verifier independently re-checks `rotationSigners ⊆ predecessor.members`, so a stray self-chunk could not
  launder trust anyway.
- **`SignKind` += `"rotation"`** does not break any exhaustive switch — the only consumer special-cases it
  with an early `if` in `handleSignRequest`; the notice-path `inbound.kind` is a separate union, unaffected.
- **Fallback / error handling.** `produceRotation` catches a quorum failure, logs, and returns `undefined`;
  the cert still publishes without attestation. No resource leaks (per-rotation crypto object, `withTimeout`
  clears its timer).

### Findings dispositioned

**MINOR — fixed in this pass.** The security-critical `"rotation"` endorsement gate in `handleSignRequest`
(the prior-epoch membership decision — accept + three refusal branches) had **no direct unit coverage**: the
live-tier mesh tests exercise the producer and the db-core verifier ends, but never isolate the endorser's
accept/refuse decision (test 8's outgoing cohort all endorse; test 9 forges *outside* the mesh; test 10
fails on transport, not the gate). Added a `describe('cohort-topic: /sign rotation endorsement gate ...')`
block to `threshold-assembly.spec.ts` (5 tests) covering: endorse when self + requester are prior members
(and asserting the gate ignores the **current** cohort — `cohortMembersAround` returns `[]` yet it still
endorses); refuse on no prior-epoch history (cold restart); refuse when self ∉ prior; refuse when requester
∉ prior; refuse a key-less node. All pass.

**MAJOR — new ticket filed.** `tickets/backlog/cohort-topic-rotation-non-firstkx-epoch-change.md`. The
rotation boundary is a *firstKx* change (mirroring the publisher's pre-existing firstKx republish gate), but
`cohortEpoch = H(all members)`, so a membership change *beyond* position `minSigs` (15th/16th member under
production `minSigs = 14`, `wantK = 16`) changes the epoch yet produces **no** attestation. For an
un-anchored, already-trusted coord reached only via the chain, a message whose `signers` include the
swapped-in member then fails against the stale cached cert and is rejected. Masked on served coords by the
FRET direct anchor; filed as backlog because the remedy (attest on *any* epoch change vs. accept the limit)
is a design decision entangled with the direct-anchor backlog work, not a fix this ticket's scope warrants.

### Observations (no change needed)
- The implementer's flagged gap "`onStabilized` not wired in production" is largely a **non-issue**: the
  production driver (`driveTick`) calls `pumpMembership` every gossip tick, and `publishMembership` routes any
  `firstKxChanged` through `onStabilized` regardless of the `refresh` flag — **bypassing** the 5-min refresh
  time gate. So a real membership change *does* rotate promptly (within one gossip interval) via the live
  production path; `onStabilized` need not be separately wired for rotation to fire.
- Endorser history freshness depends on the driver assembling each round (it does, via `pumpMembership →
  snapshotAt → cohort() → observe`); a cold-restart member that has not re-assembled degrades to the safe
  quorum-unavailable fallback. Documented and acceptable.
- Minor DRY: `sameStringOrder` (host.ts) duplicates `sameOrder` (publisher.ts). Different packages, trivial,
  left as-is.

### Docs
`docs/cohort-topic.md` §Bootstrapping trust item 3 gained an accurate production note (the producer, the
prior-epoch endorsement gate, and all three fallbacks). Verified against the code as shipped.

### Validation run (review)
- `yarn build:db-core` + `yarn build:db-p2p` (tsc) — clean.
- `db-core` full suite — **963 passing**.
- `db-p2p` `test/cohort-topic/*.spec.ts` — **163 passing, 5 pending** (no failures); `live-tier.spec.ts`
  **11 passing**; `threshold-assembly.spec.ts` **15 passing** (10 prior + 5 new rotation-gate tests).
- Full `db-p2p` suite not re-run here: the only known full-suite failures are the `reactivity` mesh
  60s-timeouts under CPU contention, already triaged (commit `da5954a`,
  `tickets/backlog/mock-tier-mesh-fullsuite-timeout-flakiness.md`) and outside this diff.

## Out of scope (correctly deferred)
- Multi-hop attestations across a rapid double rotation (N→N+1→N+2): each publish attests only its immediate
  predecessor; a participant cached at N receiving N+2 re-anchors. Documented.
- The `promotion` / `demotion` per-topic endorsement refinement remains deferred; `"rotation"` reuses the
  cohort+epoch gate shape scoped to the prior epoch.
- The non-firstKx epoch-change chain gap — filed to backlog (above).
