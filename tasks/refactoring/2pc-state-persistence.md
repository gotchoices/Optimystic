# 2PC State Persistence Implementation

## Summary

The two-phase commit (2PC) protocol state is stored only in memory. If a node crashes during a transaction, the state is lost and recovery is not possible.

## Current State

### ClusterCoordinator (cluster-coordinator.ts:36-37)
```typescript
// TODO: move this into a state management interface so that transaction state can be persisted
private transactions: Map<string, ClusterTransactionState> = new Map();
```

### ClusterMember (cluster-repo.ts:62)
```typescript
private activeTransactions: Map<string, TransactionState> = new Map();
```

## Problem

If a node crashes during a 2PC transaction:

1. **Coordinator crash**: 
   - Loses track of in-flight transactions
   - Participants may be left in "promised" state indefinitely
   - No way to resume or abort the transaction

2. **Participant crash**:
   - Loses promise/commit state
   - May re-promise or re-commit on recovery (idempotency issues)
   - Pending transactions in storage may be orphaned

3. **Recovery scenarios not handled**:
   - Node restart during promise phase
   - Node restart during commit phase
   - Network partition followed by recovery

## Proposed Design

### State Management Interface

```typescript
interface ITransactionStateStore {
    // Coordinator state
    saveCoordinatorState(messageHash: string, state: ClusterTransactionState): Promise<void>;
    getCoordinatorState(messageHash: string): Promise<ClusterTransactionState | undefined>;
    deleteCoordinatorState(messageHash: string): Promise<void>;
    listCoordinatorStates(): AsyncIterable<ClusterTransactionState>;
    
    // Participant state
    saveParticipantState(messageHash: string, state: TransactionState): Promise<void>;
    getParticipantState(messageHash: string): Promise<TransactionState | undefined>;
    deleteParticipantState(messageHash: string): Promise<void>;
    listParticipantStates(): AsyncIterable<TransactionState>;
}
```

### Recovery Protocol

1. **On startup**: Load all persisted transaction states
2. **For coordinator states**: 
   - Resume retry logic for incomplete transactions
   - Abort transactions that have exceeded timeout
3. **For participant states**:
   - Re-query coordinator for transaction status
   - Complete or abort based on coordinator response

### Write-Ahead Logging

For durability, state changes should be logged before being applied:
1. Log promise before sending promise response
2. Log commit before executing operations
3. Log completion after successful commit

## Implementation Steps

1. **Define ITransactionStateStore interface**
2. **Implement FileTransactionStateStore** using existing file storage patterns
3. **Inject state store into ClusterCoordinator and ClusterMember**
4. **Add state persistence calls** at critical points:
   - Before sending promise
   - Before sending commit
   - After consensus reached
   - After transaction cleanup
5. **Implement recovery logic** in constructors/init methods
6. **Add recovery tests** for crash scenarios

## Related Tasks

- THEORY-10.2.4: 2PC recovery protocol not persisted
- HUNT-5.2.1: Transaction state not persisted (Medium priority)
- THEORY-10.2.3: Blocking scenarios (coordinator failure leaving participants pending)

## Priority

**HIGH** - Without state persistence, crash recovery is impossible and transactions may be left in inconsistent states.

