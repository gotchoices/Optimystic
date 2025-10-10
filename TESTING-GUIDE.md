# Optimystic Testing Guide

This guide explains how to use the automated test suite for debugging distributed operations in the Optimystic peer-to-peer database system.

## Quick Start

The fastest way to test distributed diary operations:

```bash
# 1. Build the packages
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/test-peer build

# 2. Run the quick test
yarn workspace @optimystic/test-peer test:quick
```

This will:
- Create a 3-node mesh (ports 9100-9102)
- Create a diary on Node 1
- Add entries from each node
- Verify all entries are visible on all nodes
- Show detailed output at each step

## Debugging with VS Code

### Option 1: Quick Test (Recommended for debugging)

1. Build the packages (if not already built)
2. Open VS Code debug panel
3. Select **"Debug Quick Test (3-node mesh)"**
4. Set breakpoints in your code
5. Press F5 to start debugging

**Best for**: Step-by-step debugging with clear console output

### Option 2: Automated Test Suite

1. Build the packages
2. Open VS Code debug panel
3. Select **"Debug Test Peer Tests"**
4. Press F5 to start debugging

**Best for**: Running multiple test scenarios

### Option 3: Interactive Mesh

1. Open VS Code debug panel
2. Select **"Optimystic: Mesh + Debug Peer"**
3. Press F5 to start both mesh and interactive peer
4. Type commands in the interactive prompt

**Best for**: Manual testing and exploration

## Test Files

### Quick Test Script
- **Location**: `packages/test-peer/test/quick-test.ts`
- **Purpose**: Standalone script with detailed output
- **Run**: `yarn workspace @optimystic/test-peer test:quick`
- **Debug**: `yarn workspace @optimystic/test-peer test:quick:debug`

### Automated Test Suite
- **Location**: `packages/test-peer/test/distributed-diary.spec.ts`
- **Purpose**: Comprehensive test cases using Node.js test runner
- **Run**: `yarn workspace @optimystic/test-peer test:node`

## What the Tests Verify

The test suite verifies that distributed diary operations work correctly:

✅ **Basic Distribution**
- Diary created on one node is accessible from others
- Entries propagate across all nodes

✅ **Sequential Writes**
- Each node can add entries
- Entries maintain consistent order across nodes

✅ **Storage Consistency**
- All nodes have the same view of data
- No data loss during distribution

✅ **Concurrent Writes**
- Multiple nodes writing simultaneously
- All concurrent writes succeed
- No conflicts or lost updates

## Setting Breakpoints

Common debugging locations:

### Test Peer CLI
- `packages/test-peer/src/cli.ts`
  - Line ~365: `createDiary()` - Diary creation
  - Line ~380: `addEntry()` - Adding entries

### Database Core
- `packages/db-core/src/collections/diary.ts`
  - `append()` - Adding entries to diary
  - `select()` - Reading entries
  
- `packages/db-core/src/transactor/network-transactor.ts`
  - `pend()` - Pending transaction phase
  - `commit()` - Committing transactions

### Database P2P
- `packages/db-p2p/src/storage/storage-repo.ts`
  - `pend()` - Storage-level pending
  - `commit()` - Storage-level commit
  
- `packages/db-p2p/src/cluster/cluster-member.ts`
  - `update()` - Cluster consensus operations

## Debug Logging

Enable detailed logging with the `DEBUG` environment variable:

```bash
# All Optimystic logs
DEBUG=optimystic:*,db-p2p:* yarn workspace @optimystic/test-peer test:quick

# Specific subsystems
DEBUG=db-p2p:repo-service,db-p2p:cluster-service yarn workspace @optimystic/test-peer test:quick

# Include libp2p networking
DEBUG=optimystic:*,libp2p:connection-manager yarn workspace @optimystic/test-peer test:quick
```

On Windows (cmd.exe):
```cmd
set DEBUG=optimystic:*,db-p2p:* && yarn workspace @optimystic/test-peer test:quick
```

On Windows (PowerShell):
```powershell
$env:DEBUG="optimystic:*,db-p2p:*"; yarn workspace @optimystic/test-peer test:quick
```

## Understanding Test Output

### Quick Test Output

The quick test shows detailed progress:

```
🚀 Starting Quick Test: Distributed Diary Operations
================================================

📡 Step 1: Starting 3-node mesh

🔧 Creating node on port 9100...
✅ Node created: 12D3KooW... on port 9100

[... network setup ...]

📊 Network Status:
   Node 1 (port 9100): 2 connections
   Node 2 (port 9101): 2 connections
   Node 3 (port 9102): 2 connections

📝 Step 2: Creating diary on Node 1
   ✅ Diary created on Node 1

[... operations ...]

📖 Step 6: Verifying entries on all nodes

   📚 Node 1 (port 9100):
      1. First entry from Node 1 (from 12D3KooW...)
      2. Second entry from Node 2 (from 12D3KooW...)
      3. Third entry from Node 3 (from 12D3KooW...)
      ✅ All entries present
```

### Test Suite Output

The test suite shows pass/fail status:

```
✔ should create diary on one node and access from another
✔ should distribute diary entries across all nodes
✔ should verify storage consistency across nodes
✔ should handle concurrent writes from multiple nodes
```

## Troubleshooting

### Tests timeout or hang
**Problem**: Tests don't complete or hang indefinitely

**Solutions**:
- Check if ports 9000-9102 are already in use
- Increase delay times in tests (network may be slow)
- Verify libp2p services are properly initialized
- Check DEBUG logs for errors

### Entries not appearing on all nodes
**Problem**: Entries created on one node don't show up on others

**Solutions**:
- Increase delay after writes (allow time for propagation)
- Verify NetworkTransactor is being used (not LocalTransactor)
- Check that nodes are connected to each other
- Look for transaction errors in DEBUG logs

### Build errors
**Problem**: `yarn build` fails with errors

**Solutions**:
```bash
# Clean and rebuild
yarn workspace @optimystic/test-peer clean
yarn workspace @optimystic/db-core build
yarn workspace @optimystic/db-p2p build
yarn workspace @optimystic/test-peer build
```

### Port conflicts
**Problem**: Error binding to ports

**Solutions**:
- Change BASE_PORT in test files
- Kill processes using the ports:
  - Windows: `netstat -ano | findstr :9100` then `taskkill /PID <pid> /F`
  - macOS/Linux: `lsof -ti:9100 | xargs kill`

## Test Architecture

```
Quick Test Script
  └── Creates 3 TestNode instances
      ├── libp2p node (networking)
      ├── StorageRepo (local storage)
      │   └── BlockStorage (versioned blocks)
      │       └── MemoryRawStorage (in-memory)
      └── NetworkTransactor (distributed coordination)
          ├── Libp2pKeyPeerNetwork (peer discovery)
          └── RepoClient (remote repo access)

Test Flow:
  1. Start bootstrap node
  2. Start additional nodes (connect to bootstrap)
  3. Wait for network convergence
  4. Create diary on Node 1
  5. Add entries from each node
  6. Verify entries visible on all nodes
  7. Cleanup and stop nodes
```

## Development Workflow

When iterating on code:

1. **Make changes** in `packages/db-core` or `packages/db-p2p`

2. **Build affected packages**:
   ```bash
   yarn workspace @optimystic/db-core build
   yarn workspace @optimystic/db-p2p build
   yarn workspace @optimystic/test-peer build
   ```

3. **Run tests**:
   ```bash
   yarn workspace @optimystic/test-peer test:quick
   ```

4. **Debug in VS Code**:
   - Set breakpoints
   - Run "Debug Quick Test (3-node mesh)"
   - Step through code

5. **Iterate**: Repeat steps 1-4

## Advanced: Custom Test Scenarios

You can create custom test scenarios by modifying the test files or creating new ones:

```typescript
// Create custom number of nodes
const MESH_SIZE = 5;  // Change to 5 nodes

// Use different ports
const BASE_PORT = 10000;  // Avoid conflicts

// Add custom operations
const diary = await Diary.create(node.transactor, 'my-diary');
await diary.append({ custom: 'data' });

// Verify custom conditions
for await (const entry of diary.select()) {
  assert(entry.custom === 'data');
}
```

## Performance Testing

To test with larger meshes or more operations:

1. Increase `MESH_SIZE` in test files
2. Add more entries in loops
3. Test concurrent operations from all nodes
4. Monitor memory usage and timing

## Getting Help

If tests fail consistently:

1. **Check the README**: `packages/test-peer/test/README.md`
2. **Review docs**: `packages/db-core/README.md`, `packages/db-p2p/readme.md`
3. **Enable DEBUG logs**: See debug logging section above
4. **Set breakpoints**: Debug step-by-step in VS Code

## Summary

- ✅ **Quick test**: Fast iteration with detailed output
- ✅ **Test suite**: Comprehensive automated testing
- ✅ **VS Code integration**: Easy debugging with breakpoints
- ✅ **Clear output**: Understand what's happening at each step
- ✅ **Isolated**: In-memory storage, doesn't affect other data

The automated test loop allows you to iterate quickly without manual interactive testing!




