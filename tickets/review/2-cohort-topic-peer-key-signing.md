description: Review the participant peer-key signing seam (gap 2) + the shared Ed25519 sign/verify primitive. The interim empty-string ParticipantSigner is replaced with real libp2p peer-key signatures over the Register/Renew bodies, verified cohort-side; the sync verify primitive is the seam the threshold-assembly ticket (gap 1) will reuse.
files:
  - packages/db-core/src/cohort-topic/wire/payloads.ts (NEW — registerSigningPayload / renewSigningPayload)
  - packages/db-core/src/cohort-topic/wire/index.ts (export payloads)
  - packages/db-core/src/cohort-topic/service.ts (ParticipantSigner → async; participantId = self)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (async sign hook + buildRenew; verifyReattachSig gate)
  - packages/db-core/src/cohort-topic/member-engine.ts (verifyRegisterSig gate in runGuards)
  - packages/db-p2p/src/cohort-topic/peer-sig.ts (NEW — signPeer / verifyPeerSig)
  - packages/db-p2p/src/cohort-topic/host.ts (privateKey option; real signer; verify predicates; self = peer-id bytes)
  - packages/db-p2p/src/cohort-topic/index.ts (export peer-sig)
  - packages/db-p2p/test/cohort-topic/peer-sig.spec.ts (NEW)
  - packages/db-p2p/test/cohort-topic/peer-key-signing.spec.ts (NEW)
  - packages/db-core/test/cohort-topic/registration.spec.ts (async sign hook in test deps)
  - docs/cohort-topic.md (§Register wire format — participant-signature note)
----

# Review: cohort-topic participant peer-key signing + shared Ed25519 primitive

## What landed

`host.ts` previously wired `participantSigner.signRegister/signRenew → ""`. That left the
`participantCoord` on a `RegisterV1` untrustworthy and let a `RenewV1{reattach:true}` attestation be
forged (a stray/MITM'd ping usurping a live primary). This change:

- **Shared primitive** `peer-sig.ts`: `signPeer(privateKey, payload): Promise<Uint8Array>` (libp2p
  `PrivateKey.sign`) and `verifyPeerSig(signer, payload, sig): boolean` — **synchronous**, using
  `@noble/curves/ed25519` `ed25519.verify` over the raw 32-byte key extracted from the signer's
  peer-id (`peerIdFromString(str).publicKey.raw`). Total: any non-Ed25519 id, missing key, or
  malformed input returns `false`, never throws. This is the seam the gap-1 threshold work reuses for
  per-member partial signatures and for `ICohortThresholdCrypto.verify` (which is sync — hence the
  sync verify here).
- **Canonical payloads** `wire/payloads.ts`: `registerSigningPayload` / `renewSigningPayload` —
  ordered-array UTF-8 (sibling of `sig/payloads.ts`), covering every body field except `signature`,
  with optional fields normalized (`bootstrap`→false, `appPayload`→null, `reattach`→false) so signer
  and verifier agree byte-for-byte across the wire round-trip.
- **Async ParticipantSigner**: `signRegister`/`signRenew` now return `Promise<string>` (peer-key
  signing is async). Rippled through `service.ts` (`messageFactory.build`, the `startRenewal` sign
  hook) and `registration/renewal.ts` (`sign` dep + `buildRenew` → async; `trySend`/`reattach` await).
- **Cohort-side verification** (db-core stays FRET/libp2p-free via injected predicates):
  - `member-engine` `runGuards`: `verifyRegisterSig?(reg)` — checked **first** (before the replay/rate
    guards, so a forged frame can't pollute their state); failure → `no_state` (serve nothing).
  - `renewal` `onRenew`: `verifyReattachSig?(renew)` — checked **only** on `reattach:true`; failure →
    `primary_moved` redirect (never promotes a backup).
- **Host wiring** (`host.ts`): new `options.privateKey: PrivateKey`. When present → live peer-key
  signer + inbound verification enforced. When absent → interim empty-string signer (one-time warn)
  and verification **not** wired, so key-less mock/unit hosts still compose.

## Use cases to validate (tests are a floor — extend them)

Tests: `cd packages/db-p2p && yarn test` (527 pass / 9 pending) and `cd packages/db-core && yarn test`
(534 pass). New focused specs: `yarn test -- --grep "peer-key"` / `--grep "reattach forgery"`.

- **Cross-key round-trip** (`peer-sig.spec.ts`): a `signPeer` signature verifies under `verifyPeerSig`
  by both the string and peer-codec-bytes signer forms. **This is the libp2p-RFC8032 ↔ noble-ZIP215
  compatibility proof** — libp2p signs with Node/WebCrypto Ed25519 (RFC8032); noble's default ZIP215
  verify is a strict superset, so it accepts them. Worth re-confirming on the CI Node version.
- **Forgery / tamper / totality** (`peer-sig.spec.ts`): wrong-key sig, tampered payload, garbage id,
  non-Ed25519 (secp256k1) id, empty/short sig all → `false` with no throw.
- **Register admission** (`peer-key-signing.spec.ts`): a properly-signed register admits; an unsigned
  (`signature:""`) or forged (signed by a different key, claiming the participant's id) register →
  `no_state`. A key-less host still admits unsigned (interim mode).
- **Reattach non-usurpation** (`peer-key-signing.spec.ts`): with the deterministic slots putting a
  different member as primary and `self` as a backup, a correctly-signed `reattach` promotes `self`
  (`ok`, store re-stamped); a forged or unsigned `reattach` is redirected (`primary_moved`) and the
  stored primary is untouched.

## Known gaps / things to scrutinize (this is a starting point, not a finish line)

1. **Participant identity is now the peer-id, not a ring coord (the biggest design call — verify the
   trade-off).** To make the signature verifiable with **no new wire field** (per the ticket scope),
   the participant's wire identity (`RegisterV1.participantCoord` == `RenewV1.participantId`, the
   record key) is now its **dialable peer-id bytes** (peer-codec), threaded as `self` into the db-core
   service (`participantId = deps.self`, dropping the prior `H(self)`). For the **tier-0 milestone**
   this is exact (`coord_0` is participant-independent) and it actually *fixes* the latent
   walk-routing-key vs host-recompute mismatch. **But for `d ≥ 1` it degrades sharding/routing
   uniformity**: `prefix(P, …)` over a peer-id string is non-uniform (all Ed25519 ids share the
   `12D3Koo…` prefix). Multi-tier is already non-functional (followOn-derivation + multi-tier-promotion
   are documented follow-ons), so nothing *working* regressed — but the multi-tier implementer must
   reconcile this (a separate signer field, or hashing `P` only for the `coord_d` input). Documented in
   `docs/cohort-topic.md` §Register. **Reviewer: confirm this is the right scoped choice vs. adding a
   dedicated signer field now.**
2. **Verification gated on `options.privateKey`.** Inbound participant-signature verification is only
   enforced when the host holds a key. The predicates themselves are pure (no key needed) — the gate
   is a deliberate coupling to keep key-less tests admitting unsigned frames, mirroring the interim
   signer fallback. In production every node has a key, so verification is always on; still, a node
   could in principle want to verify inbound without signing outbound. Reasonable, but flagged.
3. **Plain pings are not signature-verified** — only `reattach` renews are (the privilege-escalating
   path, per the ticket). A forged *fresh* plain ping could keep an abandoned record alive (it cannot
   change `primary`); the replay guard owns staleness. Scoped decision — confirm acceptable.
4. **Host not yet instantiated in `libp2p-node-base.ts`.** `createCohortTopicHost` is still only
   composed in tests; threading `nodePrivateKey` into a production instantiation is a separate wiring
   step (the option is ready for it).
5. **Determinism of the signing payload** rests on `JSON.stringify` of an ordered array with
   normalized optionals. Cross-node round-trip is tested, but a fuzz/property check over optional-field
   presence (`bootstrap`/`appPayload`) and number encodings would harden it.
6. **gap 1 (k−x threshold assembly) is unchanged** — `FretCohortThresholdCrypto` is still the interim
   single-signer digest. This ticket only delivered the *shared sync verify primitive* it will reuse.

## Build / validation run

- `cd packages/db-core && yarn build` — clean. `cd packages/db-p2p && yarn build` — clean (tsc type-check).
- `yarn test:db-core` — 534 passing. `yarn test:db-p2p` — 527 passing, 9 pending. New specs: 7 passing.
- No pre-existing failures surfaced (no `.pre-existing-error.md` filed).
