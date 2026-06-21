description: Replaced the placeholder cold-start anti-DoS checks with real proof-of-work and reputation verifiers (and a participant-side proof minter), so a configured node genuinely gates the creation of brand-new topics.
files:
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (NEW)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts (NEW)
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy reworked)
  - packages/db-p2p/src/libp2p-node-base.ts (~line 787 — reputation wired; comment/ordering fixed this pass)
  - packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts (NEW)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (rewritten)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (reputation stub widened)
  - docs/cohort-topic.md (§Anti-DoS Implementation note)
----

# Review complete: real PoW + reputation bootstrap-evidence verifiers (db-p2p)

The implementation replaces the host's permissive `verifyPoW` / `verifyReputation` defaults with real,
self-contained checks (`createPoWVerifier` — one hash over the bound preimage; `createReputationVerifier`
— referee peer-sig + local reputation), adds a participant-side `createBootstrapEvidenceBuilder` (PoW
minting for T2/T3; an `endorse` self-vouch seam for T0/T1), and wires the node's `PeerReputationService`
as the production referee backing. The fail-closed/permissive matrix in `createBootstrapEvidencePolicy`
is sound and the bare-host permissive fallback is preserved.

## Review findings

### Verified correct (checked, no action)

- **Raw-bytes / no-double-encoding contract** — the builder returns `b64urlToBytes(serialize(env))` (raw
  JSON bytes) and `service.ts messageFactory` re-`bytesToB64url`s them into `RegisterV1.bootstrapEvidence`,
  so the signed image is exactly `serialize(env)`. The verifier reconstructs the same bound image. The
  builder is bound to `body`'s own canonical fields (the exact `(topicId, tier, participantCoord,
  timestamp)` tuple the verifier reads). No double-encoding. Confirmed against `db-core/service.ts:329-360`.
- **Fail-closed/permissive matrix** — `configured = (override || reputation)`. Configured ⇒ `verifyPoW`
  is the real verifier, unfilled verifiers `deny`; unconfigured ⇒ one-time permissive warning. A banned/
  low-rep referee cannot slip the T2/T3 `||` (an absent-pow envelope returns `false`, not permissive).
  Verified by `host-antidos-coldstart.spec.ts` (banned referee denied; valid PoW alone admits; bare host
  admits tier-0 no-evidence).
- **Replay binding** — PoW and the referee endorsement both bind `(topicId, tier, participantCoord,
  timestamp)`; cross-topic/peer/time replay rejected (unit-tested). `verifyPeerSig` rebinds the referee
  key; bad-sig / banned / at-threshold (strict `<`) / self-vouch / cross-register all behave as specified.
- **Reputation-id round-trip** — the verifier keys reputation on `bytesToPeerIdString(referee)` (UTF-8 of
  the peer-id string, matching `peer-codec.ts`); the test view's `TextDecoder().decode` ids coincide.
  Malformed referee bytes hit the fatal decoder → caught → `false` (fail closed).
- **`BootstrapReputationView` widening + re-export** — moved to the verifier module, re-exported from
  `host.ts`; `PeerReputationService` satisfies `{ isBanned, getScore }` directly. No stale importers.
- **Builds + tests** — `@optimystic/db-core` and `@optimystic/db-p2p` `tsc` clean. The cohort-topic suite
  is **131 passing / 5 pending / 0 failing** (re-run this pass). New unit spec: 15 cases green. (No real
  lint is configured repo-wide; `tsc` is the type gate.)

### Major — filed as a new ticket

- **Production cold-start origination regression** → `tickets/fix/cohort-topic-bootstrap-coldstart-origination-regression`.
  Wiring `antiDos: { reputation }` into **every** production node (`libp2p-node-base.ts`) flips the gate to
  *configured*, but the builder is wired **without** its `endorse` seam — so a real node mints **no**
  T0/T1 evidence and a configured cohort then denies every cold tier-0/tier-1 `bootstrap: true` register
  (`unwilling_cohort`). This breaks the core cold-start path at the single-tier-0 milestone while adding
  **no** real T0/T1 protection (self-vouch / parent-ref are the actual gates). It also breaks the
  `OPTIMYSTIC_INTEGRATION`-gated `substrate-real-libp2p.integration.spec.ts` (lines 454-455 tier-0 and
  533-535 T3 hand-roll evidence-less bootstrap registers and assert `accepted`; both now fail) — a suite
  not run in the verifiers ticket's validation nor in this review, and not touched by the commit. The
  implementer explicitly punted this deferral to review; the verdict is that it needs a design call
  (wire `selfEndorse` / scope the gate to T2/T3 / defer the wiring) plus an integration-spec fix. Details
  and options are in the new ticket. It is filed without a prereq (the regression must be fixed now, not
  after `cohort-topic-bootstrap-parent-reference`, which is the eventual real T0/T1 gate, not a blocker
  for restoring origination).

### Minor — fixed inline this pass

- **`libp2p-node-base.ts` antiDos spread order** — the comment claimed "caller-supplied `antiDos`
  overrides are preserved," but `{ ...antiDos, reputation }` *clobbered* a caller's `reputation`. Reordered
  to `{ reputation, ...antiDos }` so the node service is the *default* backing and an explicit caller
  override wins, matching the stated contract. `tsc` clean after the change.

### Minor — noted, not actioned (cold/unexercised path)

- **PoW minter uses `randomBytes(16)` per nonce iteration** (`bootstrap-evidence-builder.ts`). A CSPRNG
  call per hash roughly doubles per-iteration cost on the (synchronous, event-loop-blocking) mint loop; a
  counter or single random base + counter would be cheaper and equally valid (the preimage already binds
  the register tuple). Not changed: the T2/T3 minting path is cold and currently unexercised at runtime
  (cold bootstrap is op-tier-0 this milestone), and a real 20-bit search still completes well within the
  2^24 cap. Worth tidying when the production PoW path is first exercised.

### Documented interim postures — confirmed acceptable (no action)

- `verifyParentReference` is the referee verifier as an interim stand-in until
  `cohort-topic-bootstrap-parent-reference` lands (that ticket exists in `implement/`).
- `deprioritizeThreshold` defaults to `DEFAULT_THRESHOLDS.deprioritize` (20) and does not read the live
  service's configured threshold (the service exposes none). Drift only if a node sets a non-default
  threshold; acceptable interim, noted in the implement handoff.
- Self-referee reputation scores self as 0 ⇒ self-vouch is always "sufficient" — the documented interim
  posture, tightened later by reputation/parent-ref evolution.

### Pre-existing (not chased, per protocol)

- Flaky `matchmaking/mesh` + `reactivity/mesh` timeouts (non-deterministic, 4-9.7 s vs the 10 s default),
  triaged in the prior `tess: triage pre-existing test failure` commit (HEAD). The cohort-topic suite this
  ticket touches is fully green and deterministic.
