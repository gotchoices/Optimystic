description: Review the real k − x cohort threshold-signature assembly. The interim single-signer sha256 ICohortThresholdCrypto is replaced by a collected per-member Ed25519 multisig assembled over a new intra-cohort /sign RPC; each CoordEngine now owns a real threshold signer + a MembershipCertPublisher, so a verifiable MembershipCertV1 is produced and served. Build + tests pass (db-core 534, db-p2p 537 / 9 pending).
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (NEW SignKind/SignRequestV1/SignReplyV1 union)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateSignRequestV1/validateSignReplyV1)
  - packages/db-core/src/cohort-topic/wire/codec.ts (decodeSignRequestV1/decodeSignReplyV1)
  - packages/db-core/src/cohort-topic/wire/index.ts (export the two validators)
  - packages/db-p2p/src/cohort-topic/protocols.ts (5th protocol: sign)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (REWRITTEN — real assemble + sync verify; verifyCollectedMultisig; createVerifyOnlyThresholdCrypto)
  - packages/db-p2p/src/cohort-topic/host.ts (sign handler + handleSignRequest endorsement policy; dialSign; per-coord signers + publisher; pumpMembership/onStabilized hooks; verify-only verifier signer)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (NEW — 9 tests)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (handshake test: 4→5 protocols)
  - docs/cohort-topic.md (protocol IDs + threshold-signature scheme note)
----

# Review: cohort-topic real k − x threshold-signature assembly + membership-cert publishing

Closes **gap 1** (the spine gap). `FretCohortThresholdCrypto.assemble` no longer returns
`{ thresholdSig: sha256(payload), signers: [self] }` (a single signer that can never satisfy
`CohortSigner.verifyThreshold`'s `≥ minSigs` distinct-member rule). It now assembles a **real collected
Ed25519 multi-signature** by collecting per-member signatures over a new intra-cohort `/sign` RPC, and
each `CoordEngine` drives a real `MembershipCertPublisher` so a verifiable `MembershipCertV1` is produced
and served.

## What landed

### Scheme — collected Ed25519 multisig (db-p2p `threshold-crypto.ts`, rewritten)
- `thresholdSig` = concatenation of fixed-width **64-byte** Ed25519 signatures, one per `signers[i]`,
  each over the **exact** canonical payload. `verify` (sync) splits the blob into `signers.length`
  64-byte chunks and `verifyPeerSig`-checks each against the corresponding signer's embedded peer key.
  Exported as the pure `verifyCollectedMultisig(payload, sig, signers)` + `ED25519_SIG_BYTES`.
- `assemble(payload, minSigs)`: (1) signs locally (self is always a signer), (2) concurrently `dialSign`s
  the rest of the cohort with a per-round deadline, (3) **verifies each returned sig before counting**
  and drops bad/forged/duplicate replies, (4) orders `signers` ascending and builds the aligned
  concatenation. If `< minSigs` are gathered it **throws** — it must *never* fabricate a single-signer
  sig (the interim bug). Coord-scoped: constructed per `CoordEngine` with `kind`/`coord`/`cohortEpoch`/
  `cohortMembers`/`dialSign`/`privateKey`/`selfMember`.
- `createVerifyOnlyThresholdCrypto()` — verify-only adapter (assemble rejects) for the participant-side
  verifier, which never assembles.

### Intra-cohort `/sign` RPC (new 5th protocol)
- `PROTOCOL_COHORT_SIGN` added to `protocols.ts` (interface, DEFAULT, `makeCohortTopicProtocols`,
  `cohortTopicProtocolList`). Handshake test updated 4→5.
- Wire: `SignKind` + `SignRequestV1 { v, kind, coord, cohortEpoch, payload }` and
  `SignReplyV1 = SignReplyOkV1 { signer, signature } | SignReplyRefusedV1 { refused, reason }`, with
  validators + codec decoders + exports in db-core `wire/`.
- Endorsement policy (`handleSignRequest`, exported from `host.ts` for testability): a member signs the
  **exact** request payload iff it has a key, self ∈ cohort(coord), the requester ∈ cohort(coord), and
  the request epoch equals the member's current epoch — otherwise it refuses with a reason. One Ed25519
  sign, nothing more (cheap; the cohort+epoch gate bounds who it signs for).

### Host wiring (`host.ts`)
- Per `CoordEngine`: a `membership`-kind signer drives a `createMembershipCertPublisher`; a
  `promotion`-kind signer feeds the `PromotionLifecycle`. New `CoordEngine.onStabilized(now)` /
  `pumpMembership(now)` hooks publish the cert (the gossip-cadence ticket calls these; it iterates
  `registry.all()`).
- Node-wide `dialSign` over `/sign`; node-wide **verify-only** signer for the `MembershipVerifier`
  (it only verifies, never assembles).
- Key-less interim mode preserved: without `options.privateKey` the per-coord signer is verify-only
  (cannot assemble), so key-less unit/mock flows still compose; the publisher/promotion paths are simply
  not driven.

## How to test / validate / use

Run: `yarn test:db-core` (534 passing) and `yarn test:db-p2p` (537 passing / 9 pre-existing pending);
both packages `yarn build` clean. New coverage in
`packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts`:

- **Real ≥minSigs assemble + verify** across 5 in-process members (real Ed25519 keys + in-memory
  `dialSign`): blob is `signers.length × 64`, self included, signers ascending, `verify` true.
- **Tampered chunk rejected** — flip one byte → `crypto.verify` and `CohortSigner.verifyThreshold` both
  false; wrong payload also false.
- **Short-quorum throws** — refusing cohort + `minSigs=3` → `assemble` throws `1 of 3` (no single-signer
  fabrication). Also `minSigs > cohort size` throws.
- **Poisoned/forged/duplicate SignReplies dropped** before counting (bad-sig bytes, signed-with-wrong-key
  while claiming another id, duplicate of self) — excluded from `signers`, the de-poisoned blob still
  verifies.
- **Published `MembershipCertV1` verifies via `MembershipVerifier`** — a real 4-member publisher cert
  pulled from a mock source is `verified`; a tampered sig is `untrusted`.
- **`/sign` endorsement policy** — endorses (verifiable sig) when self+requester share cohort+epoch;
  refuses outsider / epoch-mismatch / key-less.
- **Host-wired** — `wantK=1`/`minSigs=1` host: `CoordEngine.onStabilized` publishes a legitimate
  single-signer (k=1, not a fabrication) cert the verify-only signer accepts.

Validation focus for the reviewer (treat the tests as a floor):
- Multi-signer collection is exercised via an **in-memory `dialSign`**, not real libp2p streams. The
  real-network path (≥ `minSigs` nodes dialing each other over `/sign`) is the `cohort-topic-live-tier-e2e`
  ticket's job — confirm the dial wiring (`dialSign` → `requestResponse` → `/sign` handler) reads right.
- `verifyPeerSig` is noble (ZIP215) over libp2p (RFC8032) signatures — the assemble→verify round-trip
  proves compatibility here; re-confirm on the CI Node version.

## Known gaps / interactions (honest handoff)

- **Promotion/demotion endorsement is common-gate only.** The kind-specific hot/cold refinement (the
  endorser additionally requiring its own replicated `directParticipants(topicId)` to be hot/cold) is
  **deferred**: `SignRequestV1` carries no `topicId`, and the `(payload, minSigs)` port can't carry
  per-topic context; it also needs gossip **record replication** of `directParticipants`, which is still
  interim (`renewal.gossip.touch` is a no-op). For the **membership** cert path — this milestone's
  deliverable — the cohort+epoch gate IS the full policy (the verifier independently re-checks
  `signers ⊆ cert.members`). Owner: multi-tier-promotion + the gossip-replication work.
- **`void`-ed promotion can now reject.** `member-engine.accept` fires `void
  promotion.onParticipantCountChange(...)`; with a real key and a sub-quorum cohort, `assemble` now
  *throws*, surfacing as an **unhandled rejection** (previously the interim assemble never threw). Not
  reached in this milestone (single tier-0 cohort, `promote` handler is a no-op, count never hits
  `cap_promote=64` in tests, and the production host isn't instantiated yet), but the ticket that wires
  promotion-notice broadcast must add a `.catch`/log at that call site (db-core member-engine has no
  logger today). **Flagged, not fixed** — it sits outside this ticket's listed files and dead path.
- **One-rotation-stale epoch tolerance not implemented.** The endorser accepts only the *current* epoch
  (strict equality); a one-rotation-stale endorsement is rejected, so a churning requester retries next
  round (acceptable, slightly less available). The ticket asked to accept one-stale — doing so needs a
  per-coord epoch history the stateless endorser doesn't keep. Low impact; documented deviation.
- **Self-membership check is structurally-true in this host.** `cohortAround` prepends self to every
  served coord, so "self ∈ cohort(coord)" always holds; the meaningful gates are requester-membership +
  epoch. Fine for the trust model (a quorum of the actual cohort signs) but worth a glance.
- **`publishSink` is node-wide.** Multiple served coords share one sink (last publish wins) and the
  `/membership` handler caches under `selfCoord`, not the cert's `servedCoord` (pre-existing). Harmless
  for the single-tier-0 milestone; revisit when a node serves many cohorts.
- **minSigs > cohort size** can never assemble — the live-tier milestone requires a network of
  `≥ minSigs` nodes (the e2e ticket stands up exactly that).

## Build / validation run
- `cd packages/db-core && yarn build` — clean; `cd packages/db-p2p && yarn build` — clean.
- `yarn test` (db-core) — 534 passing. `yarn test` (db-p2p) — 537 passing, 9 pending (+9 new tests).
- No `.pre-existing-error.md` filed (no unrelated failures surfaced).
