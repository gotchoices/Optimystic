description: Participant peer-key signing seam (gap 2) + the shared Ed25519 sign/verify primitive. The interim empty-string ParticipantSigner is replaced with real libp2p peer-key signatures over the Register/Renew bodies, verified cohort-side; the sync verify primitive is the seam the threshold-assembly ticket (gap 1) will reuse. Implemented, reviewed, and landed.
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
  - packages/db-p2p/test/cohort-topic/peer-key-signing.spec.ts (NEW; +codec round-trip determinism test added in review)
  - packages/db-core/test/cohort-topic/registration.spec.ts (async sign hook in test deps)
  - docs/cohort-topic.md (§Register + §Renew — participant-signature notes)
----

# Complete: cohort-topic participant peer-key signing + shared Ed25519 primitive

## What landed

The interim `participantSigner.signRegister/signRenew → ""` is replaced with real libp2p peer-key
signatures over the `RegisterV1` / `RenewV1` bodies, verified cohort-side via injected predicates:

- **Shared primitive** `peer-sig.ts`: `signPeer(privateKey, payload): Promise<Uint8Array>` (libp2p
  `PrivateKey.sign`) and `verifyPeerSig(signer, payload, sig): boolean` — **synchronous**, using
  `@noble/curves/ed25519` over the raw 32-byte key extracted from the signer's peer-id. Total: any
  non-Ed25519 id, missing key, or malformed input returns `false`, never throws. This is the seam the
  gap-1 threshold work reuses for `ICohortThresholdCrypto.verify` (which is sync — hence sync verify).
- **Canonical payloads** `wire/payloads.ts`: `registerSigningPayload` / `renewSigningPayload` —
  ordered-array UTF-8 (sibling of `sig/payloads.ts`), covering every body field except `signature`,
  with optional fields normalized (`bootstrap`→false, `appPayload`→null, `reattach`→false).
- **Async `ParticipantSigner`** rippled through `service.ts` and `registration/renewal.ts`.
- **Cohort-side verification** (db-core stays FRET/libp2p-free via injected predicates):
  `verifyRegisterSig?` in `member-engine.runGuards` (checked **first**; failure → `no_state`) and
  `verifyReattachSig?` in `renewal.onRenew` (checked only on `reattach:true`; failure → `primary_moved`).
- **Host wiring** `host.ts`: new `options.privateKey`. Present → live signer + inbound verification.
  Absent → interim empty-string signer (one-time warn), verification not wired (key-less tests compose).
- **Participant identity is now the peer-id** (`participantCoord`/`participantId` = dialable peer-id
  bytes), so the signature is verifiable with no new wire field — adopting "Option A" from
  `cohort-topic-participant-coord-routing-key-mismatch`.

## Review findings

Reviewed the full implement diff (`16aaa21`) with fresh eyes against the surrounding code (service,
member-engine, renewal, addressing, sharding, validate, codec, peer-codec, walk, host), then the
handoff. Builds clean; `db-core` 534 passing, `db-p2p` 528 passing (was 527 + 1 added in review) / 9
pending. No lint configured (`yarn lint` is a documented no-op echo).

**Checked and correct (no action):**
- **Forgery property is sound.** The signer id is read from the *body's own* `participantCoord` /
  `participantId`, so a register/reattach can only be admitted under an identity the sender holds the
  key for. Signing-with-a-different-key-while-claiming-the-victim's-id → `false`. Verified in tests.
- **Per-hop re-signing.** `walk.register` calls `factory.build` (async, re-signs) once per hop, so the
  `treeTier` field — which changes per hop and is covered by the signature — is always signed for the
  frame actually sent. No "sign once, resend with mutated field" bug.
- **Interim unsigned mode survives validation.** `b64urlToBytes("")` returns empty bytes (no throw),
  so `validateRegisterV1`/`validateRenewV1` accept `signature: ""`; the key-less host then admits it
  (verification not wired). Confirmed by the key-less host test.
- **No throw escapes the verify path.** `verifyPeerSig` is total; the host's `b64urlToBytes(...)`
  wrappers operate on fields that `validateRegisterV1` already proved decode as base64url
  (`participantCoord`, `signature`), and `resolveRenew` decodes `participantId` before `onRenew` runs.
- **Slot/sharding uniformity unaffected by the longer participant id.** `assignSlots` hashes
  `H(participantId ‖ cohortEpoch)`, so the peer-id-bytes participantId distributes fine.
- **ZIP215 ↔ RFC8032 compatibility** (noble verify accepting libp2p signatures) is proven by the
  round-trip test; re-confirm on the CI Node version as the handoff flags.
- **Async ripple type-safety:** build (tsc) is clean across both packages; all sync→async `sign`
  call-sites updated (service, renewal, test deps).

**Minor — fixed inline this pass:**
- *Test gap (handoff #5): codec round-trip determinism was untested.* The existing register tests pass
  the in-memory object straight to `handleRegister`, never exercising the JSON encode→decode→validate
  path the host's verifier actually recomputes from. Added a focused test to
  `peer-key-signing.spec.ts` that signs a body **with `appPayload` present and `bootstrap` absent**,
  round-trips it through `encodeCohortMessage`/`decodeCohortMessage`/`validateRegisterV1`, asserts the
  signature still verifies, and asserts a post-signing `appPayload` tamper fails. (528th passing test.)
- *Docs.* `docs/cohort-topic.md` §Register had a stray blank line inside the reopened code fence (the
  block was split to insert the signature note) — removed. §Renew's `signature` field was undocumented
  despite now being a real, verified-on-reattach signature — added a participant-signature note
  mirroring §Register (what it covers, that `participantId` is the dialable peer id, and that plain
  pings are not signature-gated).

**Major — routed to an existing ticket (updated, not newly filed):**
- *`P = self` (peer-id string) is non-uniform for `prefix(P, …)` at `d ≥ 1`* (handoff #1). This is the
  one design call worth tracking. The implementer chose `participantCoord = self` so the signature is
  verifiable with no new wire field; for tier-0 (the milestone) this is exact and it **resolves** the
  pre-existing `coord_d(self)` vs `coord_d(H(self))` routing/recompute mismatch. The residual is a
  sharding *distribution* concern for multi-tier only. The pre-existing backlog ticket
  `cohort-topic-participant-coord-routing-key-mismatch` described that mismatch as unresolved — it is
  now stale, so I **rewrote it**: marked the core mismatch RESOLVED (Option A landed), reframed the
  remaining work as the prefix-uniformity residual (hash `P` for the `coord_d` input only, or add a
  dedicated signer field — applied in both walk + host), refreshed file/line refs, and updated the
  acceptance criteria. Multi-tier is already non-functional (`cohort-topic-followon-derivation` +
  multi-tier promotion open), so nothing working regresses; that ticket is the gate before any
  `d ≥ 1` cohort is served.

**Known gaps confirmed (documented, scoped — no action, owned elsewhere):**
- *Verification gated on `options.privateKey`* (handoff #2). Deliberate interim toggle: a node runs
  fully in crypto mode or fully in key-less mode, consistently. Decoupling to "verify whenever a
  signature is present" would make key-less cohorts reject the interim empty-signature registers
  outright (breaking the key-less flow), so the coupling is justified for the interim. The mixed-mode
  asymmetry is a transient migration concern only.
- *Plain pings are not signature-verified* (handoff #3). By design — only the privilege-escalating
  `reattach` path is gated. A forged fresh plain ping can keep an abandoned record's `lastPing` warm
  (it cannot change `primary`); the TTL/replay machinery owns staleness. Low severity, accepted.
- *Host not yet instantiated in `libp2p-node-base.ts`* (handoff #4). Confirmed: `createCohortTopicHost`
  is only composed in tests + the `cohort-topic-live-tier-e2e` implement ticket. Threading
  `nodePrivateKey` into a production instantiation is owned by that e2e ticket; the option is ready.
- *gap 1 (`k − x` threshold assembly) unchanged* — `FretCohortThresholdCrypto` is still the interim
  single-signer digest; this ticket only delivered the shared sync verify primitive it will reuse.
  Owned by `cohort-topic-threshold-assembly` (implement #3).

**Minor — noted, not changed (out of tight scope, pre-existing, guarded):**
- `validateRenewV1` validates `participantId` with `reqString` (not `b64urlField`), unlike
  `RegisterV1.participantCoord`. It is base64url on the wire (`bytesKey`), and `resolveRenew` decodes
  it at the handler boundary inside a try/catch, so a malformed value aborts the stream rather than
  crashing — no new failure mode. Tightening it to `b64urlField` for contract consistency is a safe
  future hardening but belongs to a wire-validation pass, not this signing ticket.

## Build / validation run

- `cd packages/db-core && yarn build` — clean. `cd packages/db-p2p && yarn build` — clean.
- `yarn test` (db-core) — 534 passing. `yarn test` (db-p2p) — 528 passing, 9 pending.
- No `.pre-existing-error.md` filed (no unrelated failures surfaced).
