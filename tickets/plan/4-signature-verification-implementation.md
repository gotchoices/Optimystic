# Signature Verification Integration

## Subsystem
Cluster consensus (db-p2p) and crypto plugin (quereus-plugin-crypto)

## Status
**Partially resolved.** Signature verification is now implemented using libp2p's Ed25519 in `cluster-repo.ts:412-421`. The earlier stub that always returned `true` has been replaced with real cryptographic verification.

## Remaining Gap: Equivocation Detection

The current implementation does not detect equivocation — a Byzantine peer can sign conflicting promises (approve then reject, or promises to two conflicting transactions) without detection. The merge logic in `mergeRecords()` uses last-write-wins for signatures, overwriting previous promises without comparison.

### Involved Code
- `packages/db-p2p/src/cluster/cluster-repo.ts` — `verifySignature()` (line 412), `mergeRecords()` (line 311)
- `packages/quereus-plugin-crypto/src/signature-valid.ts` — Multi-curve verification (secp256k1, p256, ed25519)
- `packages/db-p2p/src/reputation/types.ts` — `PenaltyReason.Equivocation` (weight 100, highest severity)

### Involved Tests
- `packages/db-p2p/test/signature-validation-integration.spec.ts` — Cross-library Ed25519 compatibility, consensus signature verification
- `packages/db-p2p/test/byzantine-fault-injection.spec.ts` — Forged signatures, equivocation (documents the gap), Byzantine minority thresholds
- `packages/db-p2p/test/cluster-repo.spec.ts` — Basic signature verification (forged promise/commit rejection)

## Rationale

Without equivocation detection, a Byzantine peer could:
1. Promise "approve" to one coordinator and "reject" to another for the same transaction
2. Change their vote after initial promise, potentially disrupting consensus
3. Evade reputation penalties since the system only sees the latest signature

The `PenaltyReason.Equivocation` is defined with weight 100 (highest severity) but never triggered.

## Design Options

### Option A: Detect-on-merge (recommended)
In `mergeRecords()`, compare incoming signatures against existing ones for the same peer. If both are valid but differ in type or content, flag as equivocation and apply reputation penalty.

### Option B: Signature history log
Maintain a short-lived log of all received signatures per transaction. Before accepting a new signature from a peer, check if a different valid signature exists. This catches equivocation even if the first signature was received by a different node.

### Option C: Cross-node equivocation evidence
When a node detects equivocation, broadcast evidence (both conflicting signatures) to the cluster. Other nodes can independently verify both signatures against the peer's public key.

## Related
- SEC-9.2.1: Signature verification (now resolved)
- THEORY-10.4.1: Byzantine fault model
- THEORY-10.4.3: Equivocation prevention
