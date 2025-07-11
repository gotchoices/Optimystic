# Optimystic DB-P2P Storage System

The storage system in the `db-p2p` package provides a sophisticated, versioned block storage layer that supports distributed operations, transaction management, and efficient file-based persistence. This document describes the architecture, components, and usage patterns of this storage system.

## Architecture Overview

The storage system follows a layered architecture:

```
StorageRepo (High-level repository operations)
    ↓
BlockStorage (Block-level operations with versioning)
    ↓
IRawStorage (Low-level storage interface)
    ↓
FileRawStorage (File-based implementation)
```

## Core Components

### 1. Storage Repository (`StorageRepo`)

The `StorageRepo` class provides the main interface for database operations, implementing the `IRepo` interface from `@optimystic/db-core`. It orchestrates block-level operations and handles distributed consistency.

**Key Features:**
- **Transaction Management**: Handles pending, committing, and cancelling transactions
- **Conflict Resolution**: Manages revision conflicts and missing transaction detection
- **Distributed Coordination**: Supports distributed commits with proper locking
- **Context-aware Operations**: Handles operation contexts for consistent reads

**Primary Operations:**
- `get()`: Retrieves blocks with optional transaction context
- `pend()`: Creates pending transactions with conflict detection
- `commit()`: Atomically commits transactions across multiple blocks
- `cancel()`: Cancels pending transactions

### 2. Block Storage (`BlockStorage`)

The `BlockStorage` class manages individual block operations, providing versioning, materialization, and transaction lifecycle management.

**Key Features:**
- **Version Management**: Tracks block revisions and ensures availability
- **Block Materialization**: Reconstructs blocks by applying transforms
- **Transaction Lifecycle**: Manages pending → committed transaction flow
- **Restoration Support**: Integrates with external restoration callbacks
- **Concurrency Control**: Uses latches for thread-safe operations

**Core Operations:**
- `getBlock()`: Retrieves and materializes blocks at specific revisions
- `savePendingTransaction()`: Stores uncommitted transactions
- `promotePendingTransaction()`: Converts pending to committed transactions
- `ensureRevision()`: Ensures revision availability through restoration

### 3. Raw Storage Interface (`IRawStorage`)

The `IRawStorage` interface defines low-level storage operations, abstracting the physical storage mechanism.

**Responsibilities:**
- **Metadata Management**: Block metadata and revision tracking
- **Transaction Storage**: Both pending and committed transactions
- **Block Materialization**: Storing and retrieving materialized blocks
- **Revision Management**: Mapping revisions to transaction IDs

### 4. File-based Storage (`FileRawStorage`)

The `FileRawStorage` class implements `IRawStorage` using a file system backend with JSON serialization.

**File System Structure:**
```
{basePath}/
├── {blockId}/
│   ├── meta.json           # Block metadata
│   ├── revs/
│   │   ├── {rev}.json      # Revision → TrxId mapping
│   │   └── ...
│   ├── pend/
│   │   ├── {trxId}.json    # Pending transactions
│   │   └── ...
│   ├── trx/
│   │   ├── {trxId}.json    # Committed transactions
│   │   └── ...
│   └── blocks/
│       ├── {trxId}.json    # Materialized blocks
│       └── ...
└── ...
```

## Data Structures

### Block Metadata
```typescript
export type BlockMetadata = {
  ranges: RevisionRange[];    // Available revision ranges
  latest?: TrxRev;           // Latest revision info
};
```

### Revision Ranges
```typescript
export type RevisionRange = [
  startRev: number,          // Inclusive start
  endRev?: number           // Exclusive end (undefined = open)
];
```

### Block Archive
```typescript
export type BlockArchive = {
  blockId: BlockId;
  revisions: ArchiveRevisions;
  range: RevisionRange;
  pending?: Record<TrxId, TrxTransforms>;
};
```

## Key Features

### 1. Versioned Storage

The system maintains complete revision history for blocks:

- **Revision Tracking**: Each block change gets a unique revision number
- **Transform Storage**: Stores the actual changes (transforms) rather than full snapshots
- **Materialization**: Reconstructs blocks by applying transforms to base versions
- **Sparse Revisions**: Efficiently handles missing revisions through restoration

### 2. Transaction Management

Supports a two-phase transaction model:

1. **Pending Phase**: Transactions are stored as pending with conflict detection
2. **Commit Phase**: Atomic promotion of pending transactions to committed state

**Transaction Lifecycle:**
```
[Create] → [Pend] → [Commit] → [Materialized]
     ↓         ↓         ↓
   [Cancel] [Cancel] [Permanent]
```

### 3. Conflict Resolution

The system provides sophisticated conflict detection and resolution:

- **Revision Conflicts**: Detects when operations target stale revisions
- **Pending Conflicts**: Handles concurrent pending transactions
- **Policy-based Handling**: Supports different conflict resolution policies

### 4. Restoration System

Supports external restoration for missing data:

- **Restore Callbacks**: Pluggable restoration mechanism
- **Range-based Restoration**: Restores entire revision ranges
- **Lazy Loading**: Restores data only when needed

### 5. Concurrency Control

Implements proper locking mechanisms:

- **Block-level Locking**: Prevents concurrent modifications to the same block
- **Ordered Locking**: Prevents deadlocks through consistent lock ordering
- **Atomic Operations**: Ensures consistency during complex operations

## Usage Examples

### Basic Block Operations

```typescript
// Create a storage repository
const repo = new StorageRepo(blockId => 
  new BlockStorage(blockId, rawStorage, restoreCallback)
);

// Get blocks with context
const result = await repo.get({
  blockIds: ['block1', 'block2'],
  context: { rev: 10, trxId: 'trx123' }
});

// Create pending transaction
const pendResult = await repo.pend({
  trxId: 'trx124',
  transforms: { /* ... */ },
  rev: 11,
  policy: 'w'  // Wait for pending transactions
});

// Commit transaction
const commitResult = await repo.commit({
  trxId: 'trx124',
  blockIds: ['block1', 'block2'],
  rev: 11
});
```

### File Storage Setup

```typescript
// Create file-based storage
const fileStorage = new FileRawStorage('/path/to/storage');

// Create block storage with restoration
const blockStorage = new BlockStorage(
  'block123',
  fileStorage,
  async (blockId, rev) => {
    // Restore block from network or backup
    return await restoreFromNetwork(blockId, rev);
  }
);
```

## Performance Considerations

### 1. Materialization Strategy

- **Selective Materialization**: Only materializes blocks when needed
- **Cached Materialization**: Stores materialized blocks to avoid recomputation
- **Incremental Updates**: Applies minimal transforms for efficiency

### 2. File System Optimization

- **Directory Structure**: Organizes files for efficient access
- **JSON Serialization**: Uses JSON for cross-platform compatibility
- **Atomic Operations**: Uses file system atomicity for consistency

### 3. Memory Management

- **Lazy Loading**: Loads data only when accessed
- **Structured Cloning**: Uses efficient deep cloning for immutability
- **Resource Cleanup**: Properly manages file handles and locks

## Error Handling

The system provides comprehensive error handling:

- **Missing Data**: Graceful handling of missing blocks and transactions
- **Corruption Detection**: Validates data integrity during operations
- **Partial Failures**: Handles partial commit failures with proper rollback
- **Network Errors**: Integrates with restoration mechanisms for network issues

## Integration with Optimystic Core

The storage system integrates seamlessly with the core Optimystic components:

- **Block System**: Uses core block types and operations
- **Transform System**: Stores and applies transforms from core
- **Transaction System**: Implements core transaction interfaces
- **Network Layer**: Supports distributed operations through restoration

## Security Considerations

- **File System Access**: Requires appropriate file system permissions
- **Data Integrity**: Validates data consistency during operations
- **Atomic Operations**: Ensures no partial writes leave corrupted state
- **Locking**: Prevents concurrent access corruption

## Future Enhancements

- **Compression**: Add compression for stored blocks and transactions
- **Encryption**: Support for encrypted storage
- **Backup Integration**: Built-in backup and restore mechanisms
- **Monitoring**: Performance and health monitoring capabilities
- **Sharding**: Support for horizontal scaling across multiple storage backends

## Conclusion

The db-p2p storage system provides a robust, scalable foundation for distributed database operations. Its layered architecture, comprehensive transaction support, and efficient file-based implementation make it suitable for production deployment while maintaining the flexibility needed for distributed peer-to-peer operations.

The system's design prioritizes:
- **Consistency**: Strong consistency guarantees across distributed operations
- **Performance**: Efficient storage and retrieval mechanisms
- **Reliability**: Comprehensive error handling and recovery
- **Extensibility**: Clean interfaces for custom storage backends
- **Maintainability**: Clear separation of concerns and well-documented APIs 
