# Equivocation Detection in Cluster Consensus

description: Detect and penalize peers that sign conflicting promises or commits for the same transaction
dependencies: reputation system (PenaltyReason.Equivocation already defined), cluster-repo merge logic
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (mergeRecords at line 311)
  - packages/db-p2p/src/reputation/types.ts (PenaltyReason.Equivocation, weight 100)
  - packages/db-p2p/test/byzantine-fault-injection.spec.ts (equivocation test at line 337)
----

## Context

Signature verification is implemented using libp2p Ed25519. However, the merge logic in `mergeRecords()` uses last-write-wins for signatures — `{ ...existing.promises, ...incoming.promises }` — which silently overwrites a peer's prior vote without comparison. A Byzantine peer can sign conflicting promises (approve then reject, or vice versa) without detection or penalty.

The `PenaltyReason.Equivocation` is defined with weight 100 (highest severity) but is never triggered.

## Design: Detect-on-merge

Modify `mergeRecords()` to compare incoming signatures against existing ones for the same peer. When a peer's vote type changes between the existing and incoming record, that constitutes equivocation.

### Detection logic (in `mergeRecords`)

For each peerId in `incoming.promises`:
- If the peerId already exists in `existing.promises`:
  - If `existing.type !== incoming.type` → equivocation detected
  - Report via `this.reputation?.reportPeer(peerId, PenaltyReason.Equivocation, context)`
  - Log the equivocation event
  - **Keep the existing (first-seen) signature** — do not let the peer flip their vote
- If the peerId is new → accept normally

Same logic applies to `commits`.

### Why first-seen wins

Accepting the first signature prevents a Byzantine peer from strategically timing a vote flip to disrupt consensus after the threshold has been reached. The peer made a cryptographically signed commitment; changing it is a protocol violation regardless of which one we keep.

### What NOT to detect

Same type but different signature bytes: Ed25519 is deterministic, so in theory identical inputs produce identical signatures. However, legitimate retransmissions through different code paths could produce minor differences. Only flag **type changes** (approve↔reject) as equivocation to avoid false positives.

## Test plan

### Update existing gap test (`byzantine-fault-injection.spec.ts` line 338)

The test "Byzantine peer cannot promise approve and reject for the same transaction" currently documents the gap by asserting the reject overwrites the approve. After the fix:

- Pass a `PeerReputationService` instance to the `clusterMember`
- First update with approve promise → accepted
- Second update with reject promise from same peer → equivocation detected
- Assert: original 'approve' promise is preserved (not overwritten)
- Assert: `reputation.getReputation(byzantineId).penaltyCount === 1`
- Assert: penalty reason context includes the messageHash

### New test: commit-phase equivocation

- Peer sends approve commit, then sends reject commit for the same transaction
- Assert: original commit preserved, equivocation penalty applied

### New test: equivocation triggers ban

- Peer equivocates on a single transaction (weight 100, above ban threshold of 80)
- Assert: `reputation.isBanned(byzantineId) === true`

### New test: no false positive on identical re-delivery

- Same peer, same promise type, same signature delivered twice via merge
- Assert: no equivocation penalty, promise preserved correctly

## TODO

### Phase 1: Implementation
- Add `detectEquivocation` helper method to `ClusterMember` that compares existing vs incoming signatures for a set of peers, reports penalties, and returns the safe-merged result (keeping first-seen for equivocators)
- Update `mergeRecords()` to call `detectEquivocation` for both promises and commits instead of blind spread
- Ensure the reputation service reference is available in mergeRecords (it's a class field `this.reputation`, already accessible)

### Phase 2: Tests
- Update existing equivocation test to assert detection instead of documenting the gap
- Add commit-phase equivocation test
- Add equivocation-triggers-ban test
- Add no-false-positive-on-redelivery test
- Verify build passes and all tests pass
