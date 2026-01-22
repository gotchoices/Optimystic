# Read Dependency Validation Implementation

## Summary

The transaction validator has a TODO for read dependency validation. This is required for proper optimistic concurrency control (OCC) to prevent write-skew anomalies.

## Current State

### Stub in validator.ts:72-74
```typescript
// 3. Verify read dependencies (optimistic concurrency)
// TODO: Implement read dependency validation
// For now, we skip this check - will be implemented with proper block versioning
```

### ReadDependency Type (transaction.ts:58-62)
```typescript
export type ReadDependency = {
    blockId: BlockId;
    /** Expected revision number at time of read */
    revision: number;
};
```

### TransactionContext.addRead() (context.ts:58-60)
```typescript
addRead(read: ReadDependency): void {
    this.reads.push(read);
}
```

## Design Gap

The validation requires knowing the current revision of each block, but:

1. **BlockHeader has no revision** - Blocks are immutable; revisions are tracked at the log level
2. **Revisions are log-scoped** - `LogEntry.rev` is per-collection, not per-block
3. **No block-to-revision mapping** - There's no direct way to get "current revision" for a block

## Proposed Design

### Option 1: Log-based Revision Tracking
- Each block's "revision" is the log revision when it was last modified
- Validator queries the log to get the latest revision affecting each block
- Pros: Uses existing log infrastructure
- Cons: Requires log queries during validation

### Option 2: Block Metadata Extension
- Add revision tracking to BlockMetadata in db-p2p
- Store last-modified revision for each block
- Pros: Fast lookup
- Cons: Requires schema change, migration

### Option 3: Content-Addressable Versioning
- Use block content hash as version identifier
- ReadDependency stores expected content hash instead of revision
- Pros: Immutable, no separate tracking needed
- Cons: Requires re-hashing blocks, larger dependency records

## Implementation Steps

1. **Choose versioning strategy** - Decide between log-based, metadata, or content-addressable
2. **Update ReadDependency** - May need to change from `revision: number` to different identifier
3. **Populate reads during execution** - Ensure TransactionContext.addRead() is called for all reads
4. **Implement validation** - Add version check in TransactionValidator.validate()
5. **Handle conflicts** - Define behavior when read dependency fails (reject transaction)

## Related Tasks

- HUNT-2.1.3 (this document)
- THEORY-10.5.1: Optimistic concurrency control incomplete (write-skew possible)

## Priority

**HIGH** - Without read dependency validation, write-skew anomalies are possible, violating serializability.

