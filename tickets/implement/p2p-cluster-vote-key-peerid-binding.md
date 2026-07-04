----
description: Fix a hole where a malicious coordinator can forge approval votes from other cluster members, because vote signatures are checked against a public key the coordinator supplies rather than one provably tied to the member's real identity.
files: packages/db-p2p/src/cluster/cluster-repo.ts (verifySignature ~570-581; validateSignatures ~518-536; detectEquivocation ~455-490), packages/db-p2p/src/dispute/dispute-service.ts (verifyDisputeSignature ~586-597; resolveDispute ~370-375; applyReputationEffects ~394-407), packages/db-p2p/src/cohort-topic/peer-sig.ts (existing binding pattern to mirror), packages/db-p2p/test/byzantine-fault-injection.spec.ts (repro + existing helpers)
difficulty: medium
----

# Bind cluster-vote public keys to the peer id before accepting or penalizing

## Summary of the bug

In the cluster two-phase-commit path, `ClusterMember.verifySignature`
(`cluster/cluster-repo.ts:570-581`) reads the signing key from the record
itself — `record.peers[peerId].publicKey` — and verifies the vote against it.
It never checks that this key actually belongs to `peerId`.

For libp2p Ed25519 identities the peer id **is** the multihash of the public
key, so the binding is trivially checkable and is the entire basis of the
signature scheme. Without the check, a vote can be attributed to any peer id
`X` while being signed by a key the coordinator controls — the record simply
carries the coordinator's key in `peers[X].publicKey`. `verifySignature`
returns `true`, `validateSignatures` passes, and the honest member applies the
operation as though `X` approved it.

`dispute/dispute-service.ts:586-597` (`verifyDisputeSignature`) has the same
unbound-key shape for the challenger's signature, and the reputation paths make
penalty decisions on peer ids whose key binding was never verified — see below.

## What the fix does and does NOT do (read this before scoping)

The binding check proves that **a vote attributed to peer id `X` was signed by
the key that `X` names.** That closes:

- **Impersonation of a specific existing peer.** The coordinator can no longer
  forge a promise/commit "from" honest peer `X`, because `X`'s id derives from
  `X`'s real key, which the attacker does not hold.
- **Reputation framing of honest peers.** Equivocation and false-approval
  penalties currently act on self-asserted peer ids (`cluster-repo.ts:475-479`,
  `dispute-service.ts:394-407`). Once votes must be key-bound, an attacker can
  no longer attach an honest peer's id to a forged vote to get that honest peer
  penalized.

It does **NOT** stop a coordinator that mints `N` brand-new keypairs and uses
each key's *own* derived peer id — those identities are internally
self-consistent, so the binding check passes for them. Deciding *which peer ids
are legitimately in the cohort* is a separate layer (cohort-topic membership
certificates, complete: `2-cohort-topic-peer-key-signing`). This ticket does
not touch that layer. Note this boundary in the code (a `NOTE:` at the
verify site is enough) and in the review findings so the next reader does not
assume Sybil membership is solved here.

## Design

### 1. Key ↔ peer-id binding, without throwing on hostile input

Add a small, reusable predicate — the cohort path already has the equivalent
inside `verifyPeerSig` (`cohort-topic/peer-sig.ts:71-86`), which derives the raw
key from `peerIdFromString(str).publicKey.raw`. Mirror that pattern (do not
import the cohort-topic module wholesale; it is specialized for that substrate).
Suggested shape (place in a shared spot both `cluster-repo.ts` and
`dispute-service.ts` can import, e.g. a new `cluster/peer-key-binding.ts` or
similar):

```ts
/** True iff `rawKey` is the Ed25519 public key that `peerIdStr` names. Total: returns false, never throws. */
export function peerIdBindsPublicKey(peerIdStr: string, rawKey: Uint8Array): boolean {
  try {
    const peerId = peerIdFromString(peerIdStr);
    if (peerId.type !== 'Ed25519' || peerId.publicKey === undefined) return false;
    const expected = peerId.publicKey.raw;          // 32 bytes for Ed25519
    if (expected.length !== rawKey.length) return false;
    // constant-time-ish byte compare; a plain equal-length loop is fine here
    return expected.every((b, i) => b === rawKey[i]);
  } catch {
    return false;
  }
}
```

### 2. `verifySignature` must distinguish "identity unverified" from "bad signature"

This distinction is the crux of the reputation-poisoning half of the bug. If
`verifySignature` collapses both cases into a single `false`, the caller
(`validateSignatures`, `cluster-repo.ts:523/532`) reports an `InvalidSignature`
penalty against the named peer id — but for a **binding failure** that id is
attacker-chosen and may be an honest peer. So the verify result must carry
*why* it failed:

```ts
type VerifyOutcome =
  | { valid: true }
  | { valid: false; penalize: false }   // no key / not Ed25519 / unbound key / malformed key: identity NOT proven → reject, do NOT penalize
  | { valid: false; penalize: true };   // key is bound to peerId but the signature does not verify → reject, penalty allowed
```

Rewrite `verifySignature` to:
- Return `{ valid:false, penalize:false }` when `peers[peerId].publicKey` is
  missing/empty (today it **throws** `No public key for peer` — the ticket asks
  for a reject, not an uncaught throw; wrap the whole body so a malformed
  base64url key or a bad `peerIdFromString` also yields `penalize:false`, never
  a throw).
- Return `{ valid:false, penalize:false }` when
  `!peerIdBindsPublicKey(peerId, keyBytes)` — **the new check.**
- Only after binding holds, run `publicKeyFromRaw(keyBytes).verify(...)`; on a
  failed verify return `{ valid:false, penalize:true }`.

Update `validateSignatures` so it calls `reputation.reportPeer(peerId,
PenaltyReason.InvalidSignature, ...)` **only when `penalize` is true**, then
throws `Invalid promise/commit signature from ${peerId}` in every failure case
(so the record is still rejected regardless of penalize).

Because `validateRecord` → `validateSignatures` (`update()`, line 279) runs
**before** `mergeRecords` → `detectEquivocation` (line 295 → 435), every vote
reaching the equivocation/merge logic is already key-bound. So the equivocation
penalty path (`cluster-repo.ts:475-479`) needs no separate guard once the above
lands — confirm this holds, and add a one-line `NOTE:` at `detectEquivocation`
recording that it relies on `validateSignatures` having run first.

### 3. Dispute-service parity

- `verifyDisputeSignature` (`dispute-service.ts:586-597`) receives the raw
  `publicKey` string from `challenge.originalRecord.peers[challengerPeerId]`
  (call site line 238-242). Thread the `challengerPeerId` in and reject unless
  `peerIdBindsPublicKey(challengerPeerId, keyBytes)` before verifying. Keep it
  total (returns `false`, never throws).
- `resolveDispute` builds the `false-approval` affected-peer list from
  `originalRecord.promises` approvals (`dispute-service.ts:370-375`) and
  `applyReputationEffects` (394-407) penalizes them — but those promise
  signatures are **not verified at all** in the dispute path. An attacker who
  crafts a challenge carrying a fabricated `originalRecord` (forged approvals
  with unbound keys) can drive `FalseApproval` penalties against honest peers.
  Before adding a peer to `affectedPeers` with `reason:'false-approval'`,
  verify that peer's promise signature is **binding-valid** against
  `originalRecord` (reuse the same binding predicate + the promise-hash /
  signing-payload reconstruction the cluster path uses). Skip — do not penalize
  — any approval whose signature is unbound or invalid.

## Reproduction (write this test first)

`packages/db-p2p/test/byzantine-fault-injection.spec.ts` already has the
helpers: `makeKeyPair`, `createClusterRecord`, `makeSignedPromise`,
`clusterMember`, plus `ClusterPeers`. The existing test *"rejects peer with
wrong public key in cluster record"* (~705) does **not** cover this attack — it
signs with the real key but embeds a *different* key, so verification fails on
the signature. The true attack embeds the attacker's key **and signs with it**,
so the signature verifies and only the binding check catches it.

New test (must FAIL before the fix, PASS after):
- `honest = makeKeyPair()`. Pick a victim/target peer id `victimId` — e.g. a
  second real `makeKeyPair()`'s `peerId.toString()` (an honest peer the attacker
  wants to impersonate), **or** any peer id string not derived from the minted
  key.
- `minted = makeKeyPair()` — the coordinator's fabricated key.
- Build `peers` with `[victimId] = { multiaddrs, publicKey: base64url(minted.peerId.publicKey.raw) }`
  (attacker's key attached to the victim's id).
- `promise = makeSignedPromise(minted.privateKey, record)` — signed with the
  minted key, attributed to `victimId`.
- `member.update({ ...record, promises: { [victimId]: promise } })` must
  **reject** with `Invalid promise signature`.
- Assert the reputation service was **NOT** told to penalize `victimId` (inject
  a `PeerReputationService` / spy and assert no `InvalidSignature` report for
  `victimId`) — this locks in the "no reputation decision on an unverified
  identity" requirement.

Add the analogous dispute-service test: a challenge whose `originalRecord`
carries a forged approval (unbound key) must not produce a `FalseApproval`
penalty against the framed peer.

## Validation

From `packages/db-p2p`:

```
yarn build 2>&1 | tee /tmp/build.log
yarn test 2>&1 | tee /tmp/test.log
```

Run the whole `byzantine-fault-injection` and `dispute` suites; the existing
`No public key` and `wrong public key` tests must still pass (the missing-key
case still rejects — now via a returned outcome rather than a throw, so keep
those assertions matching the actual thrown message from `validateSignatures`).
If `verifySignature` no longer throws `No public key for peer` directly, the
`validateSignatures` throw (`Invalid promise/commit signature from ${peerId}`)
becomes the observed error for the empty-key test — update that assertion if
needed and confirm it is still a rejection, not an acceptance.

## TODO

- Add `peerIdBindsPublicKey` (or equivalent) shared helper; mirror
  `cohort-topic/peer-sig.ts` binding logic; total (never throws).
- Write the failing reproduction test in `byzantine-fault-injection.spec.ts`
  (mint key, embed it under a foreign/victim peer id, sign with it) + assert no
  reputation penalty on the framed id.
- Rewrite `verifySignature` to return the `{ valid, penalize }` outcome:
  no-key / non-Ed25519 / unbound / malformed → `penalize:false`; bound-but-bad
  signature → `penalize:true`. Never throw on hostile input.
- Update `validateSignatures` to report `InvalidSignature` only when
  `penalize` is true, and reject (throw) in all failure cases.
- Add binding check to `verifyDisputeSignature`; thread `challengerPeerId` to
  the call.
- Guard `resolveDispute`/`applyReputationEffects` so a `false-approval` penalty
  is only applied to peers whose `originalRecord` promise signature is
  binding-valid.
- Add dispute-service repro test (forged approval must not penalize framed peer).
- Add `NOTE:` at the verify site recording the Sybil/membership boundary, and a
  `NOTE:` at `detectEquivocation` that it relies on prior `validateSignatures`.
- `yarn build` + `yarn test` in `packages/db-p2p`, streamed with `tee`; leave an
  honest review handoff noting the residual (reputation penalties on bound-key
  bad signatures are still attacker-triggerable in principle — bound identity,
  garbage sig — call this out for the reviewer if you do not also gate it).
