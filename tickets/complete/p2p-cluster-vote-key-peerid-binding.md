description: Reviewed and accepted the fix that stops a malicious cluster coordinator from forging approval votes for other members; votes must now be signed by a key provably tied to the voting member's identity, and honest peers can no longer be framed for reputation penalties on votes they never cast.
files: packages/db-p2p/src/cluster/peer-key-binding.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/byzantine-fault-injection.spec.ts, packages/db-p2p/test/dispute.spec.ts, packages/db-p2p/test/peer-key-binding.spec.ts (new), packages/db-p2p/docs/cluster.md
----

# Complete: bind cluster-vote public keys to the peer id

## What landed

The cluster two-phase-commit vote path (and the parallel dispute path) used to verify a
vote's signature against whatever public key the record self-asserted for a peer id —
**without checking the key belonged to that id.** For a libp2p Ed25519 identity the peer
id *is* the multihash of its public key, so a coordinator could attribute a vote to any
peer id `X` while signing with a key it controlled (stored under `peers[X].publicKey`);
verification passed and the honest member applied the operation as if `X` approved it. The
reputation paths then penalized attacker-chosen ids.

The fix adds a shared binding predicate `peerIdBindsPublicKey` and rewrites
`ClusterMember.verifySignature` to return a `VerifyOutcome`
(`{valid:true} | {valid:false, penalize:boolean}`), total on hostile input:
- unproven identity (no/empty key, non-Ed25519 id, key not bound, malformed bytes) →
  reject, **no** penalty (id may be attacker-chosen);
- bound key but signature fails → reject **and** penalize (genuine bad vote).

The dispute path gained parity: `verifyDisputeSignature` binds to the challenger's id, and
`resolveDispute` (now async) re-verifies each approval's promise signature against the
`originalRecord` before adding a `false-approval` penalty, closing the fabricated-record
framing vector.

## Review findings

**Scope checked:** implement-stage diff (commit `82b735b`) read first, then handoff. Binding
logic, `VerifyOutcome` penalty semantics, dispute-path parity, cross-path preimage
reconstruction, callers, tests, and docs.

### Correctness — CONFIRMED SOUND
- **Dispute↔cluster preimage parity verified by hand.** `dispute-service.computePromiseHash`
  (`messageHash + canonicalJson(message)` → sha256 → base64url) and its `canonicalJson`
  (sort-keys) reproduce `ClusterMember.computePromiseHash`/`canonicalJson`
  (`cluster-repo.ts:564-576`) exactly. `verifyPromiseSignature`'s payload
  (`hash + ':' + type + (rejectReason ? ':' + reason : '')`) matches
  `computeSigningPayload` (`cluster-repo.ts:584-587`). A drift here would have silently
  skipped honest approvers or framed victims; it does not.
- **Binding order is binding-then-verify** in both paths — mismatched-key votes never reach
  `pubKey.verify`, so they can never yield a `penalize:true` outcome. Framing narrows to the
  documented residual only.
- **`resolveDispute` async fan-out safe.** Only callers are `initiateDispute` (awaited) and
  the specs (updated). Whole-repo grep confirms no synchronous external caller.

### Minor — FIXED IN THIS PASS
- **Predicate had no direct test.** `peerIdBindsPublicKey` was exercised only transitively;
  the implementer explicitly flagged the missing non-Ed25519 positive path. Added
  `test/peer-key-binding.spec.ts` (5 tests): Ed25519 match, Ed25519 mismatch, **secp256k1
  id rejected against its own key** (pins the `type !== 'Ed25519'` branch), malformed
  peer-id string, and wrong-length key — all assert `false`/no-throw.
- **Docs described pre-fix behavior.** `docs/cluster.md` *Signature Verification* pseudocode
  still showed `verifySignature` returning a bare boolean with no binding, and the
  *Security Considerations* bullet claimed keys are "verified against the public key
  registered in `ClusterPeers`" with no mention of id-binding — i.e. it documented the
  vulnerability. Rewrote both to describe the binding gate and the `VerifyOutcome`
  reject/penalize split.

### Residual (public-key framing) — ACCEPTED AS DOCUMENTED, no ticket
An Ed25519 peer's public key is derivable from its public id, so an attacker can attach a
victim's *real* key with a garbage signature: binding passes, verify fails, victim takes one
`InvalidSignature` penalty (record still rejected). Binding narrows framing (attacker must
use the victim's own key, not an arbitrary one) but cannot eliminate it at this layer — a
single signature can't distinguish "victim signed badly" from "someone pasted the victim's
key + junk." Fully closing it needs an authenticated membership/channel layer (out of
scope). Parked as `NOTE:` at `cluster-repo.ts:631` (verifySignature `penalize:true` site).
**Decision: accept** — strictly better than the pre-fix state where *any* key framed the
victim, and the real fix belongs with the membership layer. Not filed as a ticket.

### Tripwires (conditional; recorded, not ticketed)
- **DRY: promise-hash/signing-payload/`canonicalJson` duplicated** across `dispute-service.ts`
  and `cluster-repo.ts` (and the test files). Fine now; if the promise-vote scheme ever
  changes, all sites must move together. Home: the existing "must match" doc-comments at
  `dispute-service.ts:28` and `computePromiseHash`. Judged not worth a shared `db-core`
  helper yet — the churn exceeds the risk while the scheme is stable.
- **Equivocation ordering dependency.** `detectEquivocation`'s penalty assumes
  `validateSignatures` (key-binding) already ran. It does today (`processUpdate` →
  `validateRecord`/`validateSignatures` before `mergeRecords`/`detectEquivocation`). Home:
  `NOTE:` at `cluster-repo.ts:471`. Re-confirm if the update flow is refactored.

### Major — NONE
No correctness, security, or resource defects surviving verification. No new fix/plan/backlog
tickets filed.

## Validation performed (this review)

From `packages/db-p2p`:
- `yarn build` (tsc) — exit 0, clean.
- Targeted specs (`byzantine-fault-injection`, `dispute`) — 57 passing, incl. all 3 new
  reproduction tests.
- New `peer-key-binding.spec.ts` — 5 passing.
- Full suite — **1111 passing, 36 pending, 0 failing** (55s). No pre-existing failures.
