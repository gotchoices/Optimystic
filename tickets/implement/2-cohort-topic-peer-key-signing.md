description: Bind the participant peer-key signing seam (gap 2) and introduce the shared Ed25519 sign/verify primitive the threshold-signature work (gap 1) will reuse. Replaces the interim empty-string ParticipantSigner with real libp2p peer-key signatures over the RegisterV1/RenewV1 bodies.
prereq: cohort-topic-per-coord-scoping
files:
  - packages/db-p2p/src/cohort-topic/host.ts (participantSigner; accept the node PrivateKey)
  - packages/db-p2p/src/cohort-topic/peer-sig.ts (NEW — sign/verify primitive)
  - packages/db-p2p/src/cohort-topic/peer-codec.ts (peerIdToBytes / bytesToPeerIdString)
  - packages/db-core/src/cohort-topic/service.ts (ParticipantSigner interface; signing payload shape)
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.signature / RenewV1.signature fields)
  - packages/db-p2p/src/cluster/cluster-repo.ts (REFERENCE — existing privateKey.sign / publicKeyFromRaw.verify pattern)
  - packages/db-p2p/src/dispute/dispute-service.ts (REFERENCE — same pattern)
effort: xhigh
----

# Cohort-topic: participant peer-key signing + shared Ed25519 primitive

`host.ts` wires `participantSigner.signRegister` / `signRenew` to return `""`. A cohort member
therefore cannot trust the `participantCoord` on a `RegisterV1`, and a `reattach` attestation on a
`RenewV1` could be forged (a stray/MITM'd ping silently usurping a live primary — the very thing the
signed `reattach` flag exists to prevent, §TTL and renewal). This ticket signs those bodies with the
node's libp2p peer key, and factors out the Ed25519 sign/verify helper that the threshold-assembly
ticket reuses for per-member partial signatures.

## Design

### Shared primitive — `peer-sig.ts`

The codebase already signs with libp2p peer keys in `cluster-repo.ts` (`privateKey.sign` →
base64url; verify via `publicKeyFromRaw(raw).verify`) and `dispute-service.ts`. Mirror that exact
pattern in a small cohort-topic helper:

```ts
// signing (async — libp2p PrivateKey.sign is async)
signPeer(privateKey: PrivateKey, payload: Uint8Array): Promise<Uint8Array>

// verification (SYNCHRONOUS — see note below)
verifyPeerSig(signerPeerId: string | Uint8Array, payload: Uint8Array, sig: Uint8Array): boolean
```

**Verification must be synchronous** because the db-core `ICohortThresholdCrypto.verify` port (which
the threshold ticket implements over this helper) is synchronous and is called from
`CohortSigner.verifyThreshold`. Use `@noble/curves/ed25519` `ed25519.verify(sig, payload, rawPub)`
directly (noble is already a dependency via `@noble/hashes`), extracting the raw 32-byte Ed25519
public key from the signer. The signer id on the cohort wire is the **UTF-8 bytes of the peer-id
string** (`peer-codec.ts`); decode it to a string, `peerIdFromString(str)`, and read
`peerId.publicKey` — for Ed25519 the public key is embedded in the identity multihash, so no network
lookup is needed. Extract the raw key (`publicKey.raw`, 32 bytes for Ed25519). On any non-Ed25519 id,
missing key, or malformed input, return `false` (do not throw).

Signing uses the node's libp2p `PrivateKey.sign` (async) — fine on the participant outbound path.

### Threading the node private key into the host

`createCohortTopicHost(node, fret, options)` cannot read the private key off `node.peerId` (libp2p
does not expose it). Follow the established pattern (`clusterMember`/`DisputeService` receive
`privateKey` explicitly, sourced from `options.privateKey ?? generateKeyPair('Ed25519')` in
`libp2p-node-base.ts`). Add `privateKey: PrivateKey` to `CohortTopicHostOptions` (required for the
live signer; if omitted, fall back to the interim empty-string signer with a one-time warn so the
mock handshake test keeps composing without a key).

### Real ParticipantSigner

`ParticipantSigner.signRegister(body)` / `signRenew(body)` are **synchronous** in the db-core
interface (`service.ts`), but `PrivateKey.sign` is async. Resolve this cleanly:

- **Preferred:** change the db-core `ParticipantSigner` methods to return `Promise<string>` and make
  `service.ts` `await` them in `messageFactory.build` (already async) and in the renewal `sign`
  hook (`createRenewalParticipant` `sign(body)`; verify the renewal path can await — make it async
  if needed). This keeps signing truly key-based. Document the signature change.
- The signing payload is the deterministic byte image of the body **minus** its `signature` field.
  Reuse the canonical-JSON approach already in `cluster-repo.ts` (`canonicalJson`, sorted keys) or a
  fixed ordered-array encoding (preferred, matching `sig/payloads.ts` style) so signer and verifier
  agree byte-for-byte. Define `registerSigningPayload(body: Omit<RegisterV1,"signature">)` and
  `renewSigningPayload(body: UnsignedRenew)` in a db-core `wire/` helper (so the cohort-member
  verification side can recompute them).

### Cohort-member-side verification (where it plugs in)

The cohort member that receives a `RegisterV1`/`RenewV1` should verify the participant signature
before admitting (anti-DoS surface). The db-core `member-engine` runGuards / renewal `onRenew` are
the natural check points, but the **verification primitive is db-p2p** (peer-key crypto). Inject a
`verifyParticipantSig?` predicate into the engine/renewal deps (db-core stays FRET/libp2p-free) and
wire it in the host to `peer-sig.verifyPeerSig` over `registerSigningPayload`/`renewSigningPayload`.
A missing/invalid signature → `no_state` for register (serve nothing) and `primary_moved`/reject for
a `reattach` renew. Keep the predicate optional so unit tests run without it.

## Edge cases & interactions

- **Async signer ripple:** making `ParticipantSigner` async touches `service.ts` `messageFactory`,
  `startRenewal`'s `sign` hook, and `createRenewalParticipant`. Confirm the renewal ping loop awaits
  the signature; the participant `RenewV1` `reattach` path must be signed too.
- **Sign/verify payload determinism:** the verifier recomputes the payload from the decoded body;
  field order, number encoding, and optional-field presence (`bootstrap`, `appPayload`) must match
  the signer exactly. Test round-trip: sign on node A, verify on node B.
- **reattach forgery:** a `RenewV1{reattach:true}` whose signature does not verify against the
  claimed `participantId` must be rejected by the backup (no primary usurpation). Add a test.
- **Non-Ed25519 / missing key:** `verifyPeerSig` returns `false` (never throws); document that the
  cohort-topic substrate assumes Ed25519 identities (the libp2p default; `generateKeyPair('Ed25519')`).
- **Empty-key fallback:** when `options.privateKey` is absent the host keeps the interim empty
  signer; the existing four-protocol handshake test (no key) must still pass.
- **Replay-guard interaction:** signing does not replace the `correlationId` replay guard; both run.
  The signed body includes `timestamp` + `correlationId`, so a replay is both stale (guard) and a
  valid signature over an old correlation — the guard, not the signature, drops replays.
- **Clock skew on signed timestamp:** signature does not gate freshness; the replay guard's
  `maxAge`/`futureSkew` still owns that.

## TODO

- Add `peer-sig.ts`: `signPeer(privateKey, payload): Promise<Uint8Array>` and
  `verifyPeerSig(signer, payload, sig): boolean` (noble Ed25519 verify; raw-key extraction from the
  peer id; total/no-throw).
- Add `privateKey?: PrivateKey` to `CohortTopicHostOptions`; pass it through; fall back to the
  interim empty signer (with warn) when absent.
- Add `registerSigningPayload` / `renewSigningPayload` to a db-core `wire/` helper (ordered-array
  UTF-8, matching `sig/payloads.ts`).
- Change `ParticipantSigner.signRegister`/`signRenew` to `Promise<string>`; update `service.ts`
  (`messageFactory.build`, `startRenewal` sign hook) and `createRenewalParticipant` to await.
- Implement the host's real `participantSigner` over `peer-sig.signPeer` + the payload helpers.
- Inject an optional `verifyParticipantSig` predicate into the member-engine/renewal deps; wire it
  in the host; reject unsigned/invalid register (`no_state`) and `reattach` (reject).
- Tests: cross-node sign→verify round-trip for register and renew; reattach forgery rejected;
  unsigned register served `no_state`; `verifyPeerSig` returns false on non-Ed25519/garbage.
- Run `yarn test:db-core`, `yarn test:db-p2p` (stream with `tee`), and the type-check before handoff.
