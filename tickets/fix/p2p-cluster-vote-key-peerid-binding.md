----
description: A malicious coordinator can invent fake cluster members and forge all their approval votes, because each vote is checked against a public key the coordinator supplies instead of one tied to the member's real identity.
files: packages/db-p2p/src/cluster/cluster-repo.ts (verifySignature ~578-589; reputation penalties ~483-487), packages/db-p2p/src/dispute/dispute-service.ts (~394-407)
difficulty: medium
----

# Cluster vote signatures verified against an unbound, attacker-supplied public key

## The attack

In the cluster two-phase-commit path, `ClusterMember.verifySignature`
(`cluster/cluster-repo.ts:578-589`) reads the signing key from
`record.peers[peerId].publicKey` — data carried inside the record itself — and
verifies the vote against it. It never checks that this key actually corresponds
to `peerId`.

For libp2p Ed25519 identities the peer id *is* the multihash of the public key,
so the binding is trivially checkable and is the entire basis of the signature
scheme. Without the check, a malicious coordinator can fabricate a whole cohort:
invent N peer ids, attach public keys it minted itself, and sign every
promise/commit with those keys. Every honest member's `validateSignatures`
passes and the member applies the operation as if it were consensus-approved.

The same gap enables reputation poisoning: forged equivocating records make
honest nodes penalize honest peers, because the penalty logic
(`cluster-repo.ts:483-487`, `dispute/dispute-service.ts:394-407`) acts on
self-asserted peer ids whose key binding was never verified.

## Expected behavior

A vote must only be accepted if its public key provably belongs to the peer id
it is attributed to. A key that does not derive the claimed peer id must be
rejected (not throw uncaught), and no reputation decision should be made on an
unverified identity.

## Scope note

This is the cluster 2PC vote path in `db-p2p`. It is distinct from the
already-landed cohort-topic Register/Renew peer-key signing
(complete: `2-cohort-topic-peer-key-signing`) and the invalidation-certificate
arbitrator-set binding (complete: `7.8-invalidation-cert-arbitrator-set-binding`),
which cover different subsystems. Those fixes did not touch `verifySignature`
here.

## Suggested-fix hint

Derive the expected key from `peerIdFromString(peerId)` and compare it
(raw bytes or derived multihash) to the embedded `publicKey` bytes before
verifying; reject on mismatch. A shared peer-id/key-binding helper already
exists for the cohort-topic path and may be reusable.

## TODO
- Reproduce: honest member accepts a record whose `peers[*].publicKey` are
  attacker-minted keys not matching the peer ids.
- Add the peer-id ↔ key binding check in `verifySignature`; reject on mismatch
  without throwing.
- Confirm reputation-penalty paths cannot act on unbound identities.
