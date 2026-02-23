----
description: Implemented cryptographic signing and verification in cluster two-phase commit
dependencies: libp2p peer keys, @libp2p/crypto/keys
----

# Cluster Signature Verification - Review

## Summary

Replaced the stubbed-out signature system in the cluster two-phase commit with real Ed25519 cryptographic signatures using libp2p's key infrastructure.

## Changes

### `packages/db-p2p/src/cluster/cluster-repo.ts`
- Added `PrivateKey` as a required dependency of `ClusterMember`
- **`signVote(hash, type, rejectReason?)`**: computes a signing payload (`hash:type[:rejectReason]`) and signs with the local peer's private key; returns base64url-encoded signature
- **`verifySignature(peerId, hash, signature)`**: reconstructs the peer's public key from `record.peers[peerId].publicKey` via `publicKeyFromRaw`, decodes the base64url signature, and calls `pubKey.verify(payload, sigBytes)`
- **`computeSigningPayload(hash, type, rejectReason?)`**: deterministic payload that includes vote type and reject reason, preventing vote tampering
- **`handlePromiseNeeded`**: signs the promise hash before adding to the record
- **`handleCommitNeeded`**: signs the commit hash before adding to the record
- **`handleExpiration`**: signs rejection votes (not just placeholder strings)

### `packages/db-p2p/src/libp2p-node-base.ts`
- Generates Ed25519 key pair before `createLibp2p` and passes it as `privateKey` to both the libp2p node and `clusterMember()`

### `packages/db-p2p/src/libp2p-key-network.ts`
- Fixed: remote peers in `findCluster()` now populate `publicKey` from `peerIdFromString(idStr).publicKey.raw` instead of using an empty `Uint8Array()`

### `packages/db-p2p/docs/cluster.md`
- Updated constructor example to include `privateKey` parameter

### `docs/internals.md`
- Updated "Cluster Authentication" section to reflect implementation (removed "stubbed" note)

## Testing

- **30 tests** in `cluster-repo.spec.ts`, all passing
- Tests updated to use real key pairs, real public keys, and properly signed signatures
- New tests added:
  - `rejects forged promise signatures` - verifies that a signature signed by a different key than the claimed peer is rejected
  - `rejects forged commit signatures` - same for commit phase
  - `accepts properly signed promises and commits` - verifies signatures are real base64url strings (not placeholder text)

## Validation

- `yarn tsc --noEmit` passes (zero type errors)
- `yarn test` passes (121 tests in db-p2p)
