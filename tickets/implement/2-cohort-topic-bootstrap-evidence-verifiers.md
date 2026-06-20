description: Make a node actually check the proof-of-work and reputation evidence on a cold-start topic-bootstrap request (instead of waving it through), and have a participant mint that proof, so an attacker can't spin up topics for free.
prereq: cohort-topic-bootstrap-evidence-envelope
files:
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts (NEW — real verifyPoW + verifyReputation)
  - packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts (NEW — participant-side PoW minting)
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy — wire real verifiers when configured; thread builder into participant composition)
  - packages/db-p2p/src/libp2p-node-base.ts (~line 487 reputation service; ~line 787 createCohortTopicHost call — pass the reputation view)
  - packages/db-p2p/src/reputation/peer-reputation.ts / types.ts (IPeerReputation — reputation view source)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (extend: real PoW + reputation cases)
  - packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts (NEW)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 / Implementation note)
difficulty: hard
----

# Cohort-topic: real PoW + reputation bootstrap-evidence verifiers (db-p2p)

Replace the **permissive-but-logged** `verifyPoW` / `verifyReputation` defaults in the host with real,
self-contained checks against the envelope from `cohort-topic-bootstrap-evidence-envelope`, mint the PoW
on the participant side, and wire the node's reputation service in as the production backing — so a
configured node genuinely gates cold-root `bootstrap: true`. The parent-reference verifier (the
committed-state path) is the separate follow-on `cohort-topic-bootstrap-parent-reference`.

## Context

- The tier policy (`db-core/.../antidos/bootstrap-evidence.ts`) calls three synchronous verifiers
  `(reg: RegisterV1) => boolean`; T0/T1 → `verifyParentReference`; T2/T3 →
  `verifyPoW || verifyReputation || verifyParentReference`. **Verifiers must stay synchronous** — they
  run inside `member-engine.ts` `runGuards` on every register; no network I/O (that would itself be a
  DoS amplifier).
- The host builds the policy in `host.ts` `createBootstrapEvidencePolicy(antiDos, log)`. Today: an
  injected `antiDos.bootstrapEvidence` override wins; else a `reputation` view makes a *non-banned
  participant* the stand-in for every kind; else permissive-but-logged. The `configured` flag already
  flips unfilled verifiers to fail-closed once any gating is set.
- `libp2p-node-base.ts` constructs a `PeerReputationService` (`reputation`, ~line 487) but **does not
  pass it** to `createCohortTopicHost` (~line 787) — so production currently runs permissive. Closing
  that is a core deliverable.
- Evidence envelope, `bootstrapBoundImage`, `powPreimage`, `meetsDifficulty`,
  `DEFAULT_POW_DIFFICULTY_BITS`, `parseBootstrapEvidenceEnvelope` are all from the prereq (db-core).
- Reuse `peer-sig.ts` `verifyPeerSig` / `signPeerSig` and `RingHash` (db-core `new RingHash().H(bytes)`,
  SHA-256) — the same hash the addressing uses; no new crypto dependency.

## verifyPoW(reg)

```
env = parseBootstrapEvidenceEnvelope(reg); if (!env?.pow) return false
nonce = b64urlToBytes(env.pow.nonce)
h = ringHash.H(powPreimage(reg, nonce))
return meetsDifficulty(h, powDifficultyBits)     // default DEFAULT_POW_DIFFICULTY_BITS
```

Self-contained (no subsystem). Bound to `(topicId, tier, participantCoord, timestamp)` via the preimage
⇒ a PoW minted for one topic/peer/time cannot bootstrap another. `powDifficultyBits` is a host knob
(`CohortTopicAntiDosOptions.bootstrapEvidence` config or a new `powDifficultyBits`) defaulting to the
db-core default. Total: any parse/decode failure → `false`.

## verifyReputation(reg)

The real "signature from a peer with sufficient reputation". Resolved semantics (decided here):

```
env = parseBootstrapEvidenceEnvelope(reg); if (!env?.reputation) return false
refereeBytes = b64urlToBytes(env.reputation.referee)
if (!verifyPeerSig(refereeBytes, bootstrapBoundImage(reg), b64urlToBytes(env.reputation.sig))) return false
refereeId = bytesToPeerIdString(refereeBytes)
return !reputation.isBanned(refereeId) && reputation.getScore(refereeId) < deprioritizeThreshold
```

- A *referee* peer endorses the bootstrap by peer-key-signing the bound image; the cohort checks the
  signature **and** that the referee is sufficiently reputable in the **local** `IPeerReputation` view
  (not banned **and** below the deprioritize threshold — "sufficient reputation", stronger than mere
  non-ban). `referee` MAY equal the participant (a reputable participant self-vouches with its own peer
  key over the bound image).
- "Sufficient" = `getScore(referee) < thresholds.deprioritize` (default 20). Expose the threshold via
  the reputation view or a host knob; default to the service's `deprioritize`.
- This **supersedes the interim** "non-banned *participant*" stand-in. Update the existing
  `host-antidos-coldstart.spec.ts` reputation cases accordingly (they currently pass
  `reputation: { isBanned }` and rely on the participant-ban stand-in — see "Host wiring" for how the
  view shape changes).

## Participant-side PoW builder (`bootstrap-evidence-builder.ts`)

Implements the db-core `buildBootstrapEvidence` seam for the node's participant role:

```
buildBootstrapEvidence({ topicId, tier, participantCoord, timestamp }): Promise<Uint8Array | undefined>
```

- Construct the partial reg image needed by `bootstrapBoundImage`/`powPreimage` (the bound tuple is all
  it needs).
- **Tier ≤ maxNoPowTier (T0/T1):** PoW is not the expected evidence; return `undefined` here
  (parent-reference origination is application-coupled and lives in the follow-on ticket — document the
  deferral; a T0/T1 bootstrap from this builder carries no evidence, which a configured cohort denies
  until the parent-ref path lands. The single-tier-0 milestone's *cohort-side* tests construct evidence
  directly, so this does not block them).
- **Tier ≥ maxNoPowTier+1 (T2/T3):** mint a PoW — loop nonces (CSPRNG or counter) until
  `meetsDifficulty(ringHash.H(powPreimage(reg, nonce)), bits)`; serialize `{ v:1, pow:{ nonce } }`.
  Bound work ≈ `2^bits` hashes (default 20 ≈ ~1 M, sub-second). Cap iterations defensively and return
  `undefined` if not solved within the cap (never hang the register path).
- Thread the builder into `host.ts` participant composition: pass it as
  `createCohortTopicService({ …, buildBootstrapEvidence })`. Key-less hosts: still mintable (PoW needs
  no key); but a key-less participant's register is unsigned — the reputation path is unavailable, PoW
  works. (A reputation *endorsement* builder — signing the bound image with the node key — is optional
  here; the minimal deliverable is PoW minting + the verifier reading a supplied endorsement. If cheap,
  add a self-vouch endorsement builder for a key-ful node; otherwise document as a follow-on.)

## Host wiring (`createBootstrapEvidencePolicy`)

Rework so that **when configured, the real verifiers run** (and the permissive fallback is reserved for
the *entirely unconfigured* host, preserving every existing db-core/mock-tier test that bootstraps
tier-0 without evidence):

- `verifyPoW`: when `configured`, use the **real PoW verifier** (was fail-closed `deny`). This is the
  key change — a configured host now has a working PoW path, not deny.
- `verifyReputation`: when an `IPeerReputation`-shaped view is supplied, use the **real referee
  verifier**; else (configured but no view) fail closed.
- `verifyParentReference`: unchanged in this ticket (still the reputation stand-in / fail-closed); the
  follow-on ticket replaces it.
- Explicit `antiDos.bootstrapEvidence` overrides still win (test seam).
- Fully-unconfigured host (no view, no overrides) → permissive-but-logged for all three, exactly as
  today.

Change the reputation option type: `CohortTopicAntiDosOptions.reputation` becomes the richer view the
referee verifier needs — `{ isBanned(peerId): boolean; getScore(peerId): number }` (a subset of
`IPeerReputation`; `PeerReputationService` satisfies it directly). Keep `isBanned` so the simplest
callers/tests still work; add `getScore`. Update `BootstrapReputationView` doc + the spec's inline view.

In `libp2p-node-base.ts`, pass the node's `reputation` service into the host:
`createCohortTopicHost(node, fret, { …host, privateKey, wantK, antiDos: { ...host?.antiDos, reputation } })`
— production is now genuinely gated for PoW (always) and reputation (referee). Preserve any
caller-supplied `antiDos` overrides.

## Edge cases & interactions

- **Synchronous-only.** No `await` in any verifier — `bootstrapEvidence.verify` is sync inside
  `runGuards`. PoW verify is one hash; reputation verify is one sig + two map reads.
- **Replay across topic/peer/time** (use-case 3): the bound image differs per
  `(topicId, tier, participantCoord, timestamp)`; a captured PoW/endorsement fails `meetsDifficulty` /
  `verifyPeerSig` against a different reg. Add a test that mints evidence for reg A and feeds it to reg
  B (different topic, then different participantCoord, then different timestamp) → all `false`.
- **T2/T3 disjunction must not be slipped:** with a reputation view but no PoW offered, a banned/low-rep
  referee must yield `unwilling_cohort` — `verifyPoW` returns `false` on an absent `pow` (not
  permissive). Keep the existing regression test (`bootstrap evidence gates T2/T3 too`) green under the
  new wiring (a banned referee → denied; a valid PoW alone → admitted even with no reputation).
- **Key-less interim mode:** `verifyRegisterSig` is absent, so the referee sig still verifies on its own
  (it's inside the envelope, self-contained), but a key-less *participant* can't be the referee of a
  signed self-vouch — PoW remains the usable T2/T3 path. Document.
- **Unconfigured host stays permissive:** assert a bare host (no `antiDos`) still admits a tier-0
  bootstrap with no evidence (so `service.spec.ts` / `live-tier.spec.ts` / scale suites don't regress) —
  the permissive fallback fires with its one-time warning.
- **Difficulty `bits = 0`** (test config): every nonce solves; verify admits any well-formed PoW
  envelope. Use a low `bits` in unit tests to keep minting fast and deterministic.
- **Builder cap / unsolved:** the nonce loop must terminate; on cap-exceeded return `undefined`
  (register proceeds without evidence → denied by a configured cohort, never hangs).
- **`getScore` boundary:** referee exactly at `deprioritize` (20) → not sufficient (use strict `<`);
  unknown referee → `getScore` returns 0 → sufficient (a clean, unseen reputable peer passes). Confirm
  that is the intended semantics and test it.

## Key tests

`bootstrap-evidence-verifiers.spec.ts` (unit, construct envelopes directly via the db-core serializer):
- `verifyPoW`: a correctly-minted nonce at `bits` admits; a wrong/short nonce, absent `pow`, malformed
  envelope → `false`; a PoW minted for a different bound tuple → `false`.
- `verifyReputation`: valid referee sig + reputable referee → `true`; bad sig → `false`; banned referee
  → `false`; referee at/over deprioritize → `false`; self-vouch (referee == participant) → `true`;
  endorsement bound to a different reg → `false`.
- Builder: mints a PoW (low `bits`) that the verifier accepts for the same reg; returns `undefined` for
  T0/T1.

Extend `host-antidos-coldstart.spec.ts`:
- A configured host (reputation view with `getScore`) admits a T2 bootstrap carrying a valid PoW (no
  reputation) and denies one with no evidence.
- A T0 bootstrap with a reputable referee endorsement is admitted; a banned referee → `unwilling_cohort`
  (until the parent-ref ticket, T0 PoW is not expected; the referee path covers T0 here).
- Bare host (no `antiDos`) still admits a tier-0 bootstrap with no evidence (permissive preserved).
- Update the existing reputation-view stubs to the `{ isBanned, getScore }` shape.

## TODO

- `bootstrap-evidence-verifiers.spec`-driven: create `bootstrap-evidence-verifiers.ts`
  (`createPoWVerifier({ hash, bits })`, `createReputationVerifier({ reputation, deprioritizeThreshold })`)
  and `bootstrap-evidence-builder.ts` (`createBootstrapEvidenceBuilder({ hash, bits, maxNoPowTier, maxIterations })`).
- Rework `host.ts` `createBootstrapEvidencePolicy`: real PoW when configured; real reputation when a view
  is supplied; widen `CohortTopicAntiDosOptions.reputation` to `{ isBanned, getScore }`; thread
  `buildBootstrapEvidence` into `createCohortTopicService`.
- Wire `reputation` from `libp2p-node-base.ts` into the host `antiDos`.
- Update `docs/cohort-topic.md` §Anti-DoS Implementation note (PoW + reputation now real; parent-ref
  still deferred to the follow-on).
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p.log` and `yarn workspace @optimystic/db-p2p build`. If a pre-existing, unrelated failure surfaces, follow the pre-existing-error protocol; otherwise green the cohort-topic suites.
