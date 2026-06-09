description: Real k − x cohort threshold-signature assembly. The interim single-signer sha256 ICohortThresholdCrypto was replaced by a collected per-member Ed25519 multisig assembled over a new intra-cohort /sign RPC; each CoordEngine owns a real threshold signer + a MembershipCertPublisher, producing a verifiable MembershipCertV1. Reviewed, build + tests green (db-core 534, db-p2p 538 / 9 pending).
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (SignKind/SignRequestV1/SignReplyV1)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateSignRequestV1/validateSignReplyV1)
  - packages/db-core/src/cohort-topic/wire/codec.ts (decodeSignRequestV1/decodeSignReplyV1)
  - packages/db-core/src/cohort-topic/wire/index.ts
  - packages/db-p2p/src/cohort-topic/protocols.ts (5th protocol: sign)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (real assemble + sync verify; verifyCollectedMultisig; createVerifyOnlyThresholdCrypto)
  - packages/db-p2p/src/cohort-topic/host.ts (sign handler + handleSignRequest; dialSign; per-coord signers + publisher; pumpMembership/onStabilized hooks)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (10 tests)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (handshake 4→5 protocols)
  - docs/cohort-topic.md
----

# Complete: cohort-topic real k − x threshold-signature assembly + membership-cert publishing

Closes **gap 1** (the spine gap). `FretCohortThresholdCrypto.assemble` no longer returns
`{ thresholdSig: sha256(payload), signers: [self] }` (a single signer that can never satisfy
`CohortSigner.verifyThreshold`'s `≥ minSigs` distinct-member rule). It now assembles a **real collected
Ed25519 multi-signature** by collecting per-member signatures over a new intra-cohort `/sign` RPC, and
each `CoordEngine` drives a real `MembershipCertPublisher` so a verifiable `MembershipCertV1` is produced
and served.

## What landed

### Scheme — collected Ed25519 multisig (db-p2p `threshold-crypto.ts`)
- `thresholdSig` = concatenation of fixed-width **64-byte** Ed25519 signatures, one per `signers[i]`,
  each over the **exact** canonical payload. `verify` (sync) splits the blob into `signers.length`
  64-byte chunks and `verifyPeerSig`-checks each. Exported as `verifyCollectedMultisig` + `ED25519_SIG_BYTES`.
- `assemble(payload, minSigs)`: signs locally (self always a signer), concurrently `dialSign`s the rest
  of the cohort with a per-round deadline, verifies each returned sig before counting (drops
  bad/forged/duplicate), orders `signers` ascending and builds the aligned concatenation. If `< minSigs`
  gathered it **throws** — never fabricates a single-signer sig.
- `createVerifyOnlyThresholdCrypto()` — verify-only adapter (assemble rejects) for the participant-side
  verifier and for key-less per-coord signers.

### Intra-cohort `/sign` RPC (new 5th protocol)
- `PROTOCOL_COHORT_SIGN` added to `protocols.ts`; handshake test updated 4→5.
- Wire: `SignKind` + `SignRequestV1` and `SignReplyV1 = SignReplyOkV1 | SignReplyRefusedV1`, with
  validators + codec decoders + exports.
- Endorsement policy (`handleSignRequest`): a member signs the exact request payload iff it has a key,
  self ∈ cohort(coord), the requester ∈ cohort(coord), and the request epoch equals the member's current
  epoch — otherwise refuses with a reason.

### Host wiring (`host.ts`)
- Per `CoordEngine`: a `membership`-kind signer drives a `createMembershipCertPublisher`; a
  `promotion`-kind signer feeds the `PromotionLifecycle`. `CoordEngine.onStabilized(now)` /
  `pumpMembership(now)` hooks publish the cert.
- Node-wide `dialSign` over `/sign`; node-wide verify-only signer for the `MembershipVerifier`.
- Key-less interim mode preserved: without `options.privateKey` the per-coord signer is verify-only and
  the publish hooks no-op (see Review findings — hardened during review).

## Review findings

Adversarial pass over commit `7f2c97a`. Reviewed the diff with fresh eyes against the db-core contracts
(`CohortSigner.verifyThreshold`, `MembershipCertPublisher`, `MembershipVerifier`, `peer-sig`,
`peer-codec`) before reading the handoff.

### Checked — and found correct
- **Signer ↔ blob alignment end-to-end.** `assemble` sorts signers ascending, concatenates sig chunks in
  that order, and returns the aligned `signers`. `MembershipCertPublisher.publish` stores `cert.signers`
  preserving that order; `verifyCollectedMultisig` and `MembershipVerifier.certIsSelfConsistent` both
  re-read `cert.signers` in stored order. No re-sort anywhere desyncs `signers[i] ↔ chunk i`. Verified
  the message-verify path (`verifyThreshold` builds `memberSet` from `cert.members` as an
  order-independent `Set`) also holds.
- **Verify-before-count.** Poisoned (bad-sig), forged (signed-with-wrong-key-claiming-another-id), and
  duplicate replies are all dropped before counting; the existing test exercises all three. Malformed
  (non-64-byte) chunks are dropped so the fixed-stride concatenation can't desync. Confirmed a relayed
  signature can only be a *valid* signature by the claimed signer (can't forge), so cross-member relay
  is harmless.
- **Quorum-shortfall throws** (no single-signer fabrication); `minSigs > cohort size` throws. Tested.
- **`withTimeout`** handles late rejection of the dialed promise (both `.then` handlers present →
  no unhandled rejection); all timers settle before `Promise.all` resolves.
- **Epoch consistency.** `assemble`'s `cohortEpoch` dep, the `/sign` request gate, and the published
  cert's payload epoch all derive from the same `cohort().cohortEpoch` — internally consistent.
- **db-core exports** (`bytesEqual`, `compareBytes`, `SignRequestV1`/`validateSignRequestV1`, etc.)
  resolve through the cohort-topic barrel; both packages `tsc`-build clean.

### Found and fixed inline (minor)
- **Key-less host publish hooks rejected instead of no-op'ing.** In key-less interim mode the per-coord
  signer is verify-only (its `assemble` rejects), but `CoordEngine.onStabilized` / `pumpMembership`
  called it unconditionally — so a future gossip-cadence driver iterating `registry.all()` would get a
  rejected promise from every key-less engine, contradicting the documented "publisher paths are simply
  not driven without a key" contract. Guarded both hooks with `canPublish = ctx.privateKey !== undefined`
  → they resolve `undefined` when key-less. Added a regression test
  (`a key-less host no-ops the publish hooks instead of rejecting`). db-p2p now 538 passing.

### Found and filed as new ticket (major)
- **`/sign` endorser signs payloads blind** → `tickets/backlog/cohort-topic-sign-endorsement-payload-binding.md`.
  `handleSignRequest` signs the requester's opaque `payload` bytes without confirming they reflect its
  own view of the cohort, nor that they match the declared `kind`. A single cohort insider can collect
  `k − x` honest endorsements over a falsified `MembershipCertV1` (arbitrary `members`/`stabilizedAt`) or
  a kind-mismatched notice. Distinct from the existing `cohort-topic-membership-cert-trust-anchoring`
  ticket (verifier-side, unknown key sets); this is the intra-cohort payload-binding gap the assembly
  ticket explicitly deferred. Low impact for the single-tier-0 / k = 1 milestone; matters at live tier.

### Pre-existing / out-of-scope deviations (re-confirmed from the handoff, not regressions)
- Promotion/demotion endorsement is common-gate only (hot/cold refinement deferred — folded into the new
  payload-binding ticket).
- `void`-ed promotion (`member-engine.accept`) can now reject if a real-key sub-quorum `assemble` throws;
  dead path this milestone (single tier-0 cohort, no-op promote handler, production host not
  instantiated). Owner: promotion-notice-broadcast ticket.
- One-rotation-stale epoch tolerance not implemented (strict current-epoch equality); documented low-impact
  availability tradeoff.
- `publishSink` is node-wide (last-publish-wins) and the `/membership` handler caches under `selfCoord`;
  pre-existing, harmless for single-tier-0.

### Not exercised here (correctly deferred to the live-tier e2e ticket)
- Multi-signer collection uses an **in-memory `dialSign`**, not real libp2p `/sign` streams. The dial
  wiring (`dialSign` → `requestResponse` → `/sign` handler) reads correctly but the real-network path
  (≥ `minSigs` nodes dialing each other) is `cohort-topic-live-tier-e2e`'s job. Noted, not blocking.

### Empty categories
- No `.pre-existing-error.md` filed: both suites were green at HEAD and after the inline fix; no unrelated
  failures surfaced.

## Build / validation run
- `packages/db-core` `yarn build` — clean; `packages/db-p2p` `yarn build` — clean (after the inline fix).
- `yarn test` (db-core) — **534 passing**. `yarn test` (db-p2p) — **538 passing, 9 pending** (+1 new
  regression test on top of the implementer's 9). No lint configured (`tsc` is the type/lint gate).
