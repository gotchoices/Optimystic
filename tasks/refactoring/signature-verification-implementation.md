# Signature Verification Implementation

## Summary

The cluster consensus protocol has stub implementations for cryptographic signatures. This is a **critical security gap** that allows any peer to forge signatures and manipulate consensus.

## Current State

### Stub Implementations

1. **`cluster-repo.ts:338-341`** - `verifySignature()` always returns `true`:
   ```typescript
   private async verifySignature(peerId: string, hash: string, signature: Signature): Promise<boolean> {
       // TODO: Implement actual signature verification
       return true;
   }
   ```

2. **`cluster-repo.ts:388-390`** - `handlePromiseNeeded()` creates placeholder signatures:
   ```typescript
   const signature: Signature = validationResult.valid
       ? { type: 'approve', signature: 'approved' }
       : { type: 'reject', signature: 'rejected', rejectReason: validationResult.reason };
   ```

3. **`cluster-repo.ts:438-441`** - `handleCommitNeeded()` creates placeholder signatures:
   ```typescript
   const signature: Signature = {
       type: 'approve',
       signature: 'committed' // TODO: Actually sign the commit hash
   };
   ```

### Missing Public Keys

In `libp2p-key-network.ts:325`, remote peers get empty public key arrays:
```typescript
peers[idStr] = { multiaddrs: addrs, publicKey: new Uint8Array() }
```

## Required Changes

### 1. Add Dependency
Add `@noble/curves` to `db-p2p/package.json` (or use `@libp2p/crypto` which is already available in db-core).

### 2. Fetch Public Keys
Update `findCluster()` in `libp2p-key-network.ts` to fetch public keys for remote peers from libp2p's peer store.

### 3. Implement Signing
Update `handlePromiseNeeded()` and `handleCommitNeeded()` to:
- Get the local peer's private key
- Sign the promise/commit hash using Ed25519
- Store the actual signature in the `Signature.signature` field

### 4. Implement Verification
Update `verifySignature()` to:
- Look up the peer's public key from `ClusterPeers`
- Verify the signature using Ed25519
- Return false if verification fails

### 5. Key Management
Consider how private keys are accessed:
- libp2p nodes have private keys for their peer ID
- Need to expose signing capability without exposing raw private key

## Available Resources

- `@libp2p/crypto/keys` - Already used in tests for Ed25519 key generation
- `quereus-plugin-crypto` - Has full `sign()` and `verify()` using `@noble/curves`
- libp2p peer store - Can store/retrieve peer public keys

## Security Implications

Without proper signature verification:
- Any peer can forge promises/commits from other peers
- Byzantine nodes can manipulate consensus outcomes
- Transaction integrity cannot be guaranteed

## Priority

**CRITICAL** - This must be implemented before production use.

## Related Tasks

- SEC-9.2.1, HUNT-5.1.2 (this document)
- THEORY-10.4.1 (Byzantine fault model incomplete)

