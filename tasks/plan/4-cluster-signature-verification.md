----
description: Implement cryptographic signing and verification in cluster two-phase commit
dependencies: libp2p peer keys, cluster protocol
----

# Cluster Signature Verification

## Context

The cluster two-phase commit protocol already has the scaffolding for cryptographic signatures — `validateSignatures()`, `computePromiseHash()`, `computeCommitHash()`, and `verifySignature()` in `ClusterMember` — but everything is stubbed out.  Promises use `{ type: 'approve', signature: 'approved' }` and commits use `{ signature: 'committed' }`.  `verifySignature()` returns `true` unconditionally.

`ClusterPeers` already carries `publicKey: Uint8Array` per peer, and `ClusterRecord` is keyed by peerId throughout (`promises`, `commits`, `peers`), so the key material and identity mapping are in place.

## Requirement

Each cluster member must cryptographically sign its promise and commit votes using its libp2p private key.  Every peer receiving a `ClusterRecord` must verify all signatures against the public keys in `record.peers` before accepting the record.  This ensures that a malicious or compromised coordinator cannot forge votes.

## Key files

- `packages/db-core/src/cluster/structs.ts` — `Signature`, `ClusterPeers`, `ClusterRecord` types
- `packages/db-p2p/src/cluster/cluster-repo.ts` — `ClusterMember`: `verifySignature()`, `validateSignatures()`, `handlePromiseNeeded()`, `handleCommitNeeded()`, hash computation methods
- libp2p `@libp2p/interface` — `PeerId` carries key pair; `peerIdFromString` can reconstitute from string form

## Scope

- Sign: in `handlePromiseNeeded()` and `handleCommitNeeded()`, sign the computed hash with the local peer's private key
- Verify: in `verifySignature()`, verify the signature against the public key from `record.peers[peerId].publicKey`
- The `Signature` type may need adjustment (the `signature` field should hold the actual cryptographic signature bytes, likely base64-encoded)
- Reject signatures should also be signed so peers can't forge rejections
