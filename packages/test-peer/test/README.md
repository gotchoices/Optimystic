# Test Peer Automated Tests

This directory contains automated tests for debugging the distributed diary operations across a mesh of nodes.

## Quick Test Script

The `quick-test.ts` provides a standalone script that creates a 3-node mesh and tests distributed diary operations with clear console output for debugging.

### Running the Quick Test

```bash
# Build first
yarn workspace @optimystic/test-peer build

# Run the test
yarn workspace @optimystic/test-peer test:quick

# Run with debugging enabled
yarn workspace @optimystic/test-peer test:quick:debug
```

### What the Quick Test Does

1. **Creates a 3-node mesh** (ports 9100-9102)
2. **Creates a diary** on Node 1
3. **Adds entries** from each node sequentially
4. **Verifies** all entries are visible on all nodes
5. **Shows detailed output** at each step

Perfect for:
- Setting breakpoints and stepping through code
- Observing network convergence
- Verifying storage consistency
- Understanding the distributed transaction flow

## Automated Test Suite

The `distributed-diary.spec.ts` provides a comprehensive test suite using Node.js test runner.

### Running the Test Suite

```bash
# Build first
yarn workspace @optimystic/test-peer build

# Run all tests
yarn workspace @optimystic/test-peer test:node

# Run specific test
yarn workspace @optimystic/test-peer test:node -- --test-name-pattern "should distribute diary entries"
```

### Test Cases

1. **Create diary on one node and access from another**
   - Verifies basic distributed creation and access

2. **Distribute diary entries across all nodes**
   - Each node adds an entry
   - Verifies all entries are visible from any node

3. **Verify storage consistency across nodes**
   - Ensures all nodes have the same view of data

4. **Handle concurrent writes from multiple nodes**
   - Tests conflict resolution
   - Verifies all concurrent writes succeed

## VS Code Debugging

Three debug configurations are available in `.vscode/launch.json`:

### 1. Debug Quick Test (3-node mesh)
- **Launch**: "Debug Quick Test (3-node mesh)"
- **Usage**: Run from VS Code debug panel
- **Best for**: Step-by-step debugging with clear output

### 2. Debug Test Peer Tests
- **Launch**: "Debug Test Peer Tests"
- **Usage**: Run from VS Code debug panel
- **Best for**: Debugging specific test cases

### 3. Optimystic: Mesh + Debug Peer
- **Launch**: "Optimystic: Mesh + Debug Peer"
- **Usage**: Compound launcher - starts mesh and interactive peer
- **Best for**: Manual testing with debug support

## Debugging Tips

### Set Breakpoints

Common places to set breakpoints:
- `packages/test-peer/src/cli.ts` - `createDiary()`, `addEntry()`
- `packages/db-core/src/collections/diary.ts` - `append()`, `select()`
- `packages/db-core/src/transactor/network-transactor.ts` - `pend()`, `commit()`
- `packages/db-p2p/src/storage/storage-repo.ts` - Storage operations

### Enable Debug Logging

Set the `DEBUG` environment variable:

```bash
# All optimystic logs
DEBUG=optimystic:*,db-p2p:* yarn workspace @optimystic/test-peer test:quick

# Specific subsystems
DEBUG=db-p2p:repo-service,db-p2p:cluster-service yarn workspace @optimystic/test-peer test:quick

# Include libp2p connection logs
DEBUG=optimystic:*,libp2p:connection-manager yarn workspace @optimystic/test-peer test:quick
```

### Watch for Common Issues

1. **Network convergence**: Allow 2-3 seconds after node startup
2. **Port conflicts**: Tests use ports 9100-9102 (quick test) or 9000-9002 (test suite)
3. **Storage paths**: Using in-memory storage by default
4. **Transaction timeouts**: Set to 30 seconds in tests

## Test Architecture

```
TestNode (per node)
  ├── libp2p node (networking)
  ├── StorageRepo (local storage)
  │   └── BlockStorage (versioned blocks)
  │       └── MemoryRawStorage (in-memory)
  └── NetworkTransactor (distributed coordination)
      ├── KeyNetwork (peer discovery)
      └── getRepo() (local or remote repo access)
```

## Iterating During Development

1. Make code changes in `packages/db-core` or `packages/db-p2p`
2. Build: `yarn workspace @optimystic/db-p2p build`
3. Build test-peer: `yarn workspace @optimystic/test-peer build`
4. Run quick test: `yarn workspace @optimystic/test-peer test:quick`
5. Set breakpoints and debug in VS Code

## Verifying Storage Distribution

The tests verify that:
- Entries created on one node are visible on all other nodes
- The order of entries is consistent across nodes
- Concurrent writes from multiple nodes all succeed
- Storage remains consistent after network operations

Look for console output like:
```
📚 Node 1 (port 9100):
   1. Entry from Node 1 (from 12D3KooW...)
   2. Entry from Node 2 (from 12D3KooW...)
   3. Entry from Node 3 (from 12D3KooW...)
   ✅ All entries present
```

## Troubleshooting

### Tests timeout or hang
- Increase delay times in the test
- Check network connectivity between nodes
- Verify libp2p services are started

### Entries not appearing on all nodes
- Add more delay after writes (network propagation)
- Check DEBUG logs for transaction errors
- Verify NetworkTransactor is being used (not LocalTransactor)

### Port conflicts
- Change BASE_PORT in test files
- Kill any processes using the ports: `lsof -ti:9100 | xargs kill` (macOS/Linux)

### Build errors
- Run `yarn install` in workspace root
- Build dependencies first: `yarn workspace @optimystic/db-core build`
- Clean and rebuild: `yarn workspace @optimystic/test-peer clean && yarn workspace @optimystic/test-peer build`




