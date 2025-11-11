# Testing Guide

This guide explains how to test the Optimystic Quereus plugin.

## Quick Start

```bash
# Run all tests
yarn workspace @optimystic/quereus-plugin-optimystic test

# Run only distributed tests
yarn workspace @optimystic/quereus-plugin-optimystic exec aegir test -t node -- --grep "Distributed"

# Run manual mesh test
yarn workspace @optimystic/quereus-plugin-optimystic build
node packages/quereus-plugin-optimystic/dist/test/manual-mesh-test.js
```

## Test Suites

### Unit Tests

- **`transaction-id.spec.ts`** - TransactionId() function tests (11 tests)
- **`schema-support.spec.ts`** - Schema and table creation tests
- **`index-support.spec.ts`** - Index support tests

### Distributed Tests

- **`distributed-quereus.spec.ts`** - Automated distributed operations tests (4 tests)
- **`manual-mesh-test.ts`** - Interactive manual testing script

## Distributed Testing

The distributed tests create a mesh of N nodes, perform DML operations (INSERT, UPDATE, DELETE), and verify data replication across all nodes.

## Automated Test Suite

### Running the Tests

```bash
# Build the plugin first
yarn workspace @optimystic/quereus-plugin-optimystic build

# Run the distributed tests
yarn workspace @optimystic/quereus-plugin-optimystic exec aegir test -t node -- --grep "Distributed Quereus"
```

### What It Tests

The automated suite includes 4 test cases:

1. **Table Creation** - Creates a table on one node, verifies it's accessible from another
2. **INSERT Distribution** - Inserts data from different nodes, verifies all nodes see all data
3. **UPDATE Replication** - Updates data on one node, verifies the update propagates to all nodes
4. **DELETE Replication** - Deletes data on one node, verifies the deletion propagates to all nodes

### Configuration

Edit `distributed-quereus.spec.ts` to change:

```typescript
const MESH_SIZE = 3;        // Number of nodes in the mesh
const BASE_PORT = 9100;     // Starting port number
const NETWORK_NAME = 'test-distributed-quereus';  // Network identifier
```

## Manual Interactive Test

### Running the Manual Test

```bash
# Build first
yarn workspace @optimystic/quereus-plugin-optimystic build

# Run with default settings (3 nodes)
node packages/quereus-plugin-optimystic/dist/test/manual-mesh-test.js

# Run with custom mesh size
MESH_SIZE=5 node packages/quereus-plugin-optimystic/dist/test/manual-mesh-test.js

# Run with custom port and network name
MESH_SIZE=4 BASE_PORT=9300 NETWORK_NAME=my-test node packages/quereus-plugin-optimystic/dist/test/manual-mesh-test.js
```

### Environment Variables

- `MESH_SIZE` - Number of nodes to create (default: 3)
- `BASE_PORT` - Starting port number (default: 9200)
- `NETWORK_NAME` - Network identifier (default: 'manual-test-mesh')

### What It Does

The manual test runs a complete scenario:

1. **Creates mesh** - Starts N nodes and connects them
2. **Creates tables** - Creates the same table on all nodes
3. **Inserts data** - Inserts different rows from different nodes
4. **Verifies replication** - Checks all nodes see all data
5. **Updates data** - Updates a row from one node
6. **Verifies update** - Checks all nodes see the update
7. **Deletes data** - Deletes a row from another node
8. **Verifies deletion** - Checks all nodes see the deletion
9. **Tests TransactionId()** - Verifies the TransactionId() function works on all nodes

### Example Output

```
🚀 Starting 3-node Quereus mesh

   Network: manual-test-mesh
   Base Port: 9200

🔧 Creating node on port 9200...
✅ Node created: 12D3KooWAbc...
🔧 Creating node on port 9201...
✅ Node created: 12D3KooWDef...
🔧 Creating node on port 9202...
✅ Node created: 12D3KooWGhi...

⏳ Waiting for network convergence...

📊 Network Status:
   Node 1 (12D3KooWAbc...): 2 connections
   Node 2 (12D3KooWDef...): 2 connections
   Node 3 (12D3KooWGhi...): 2 connections

✅ Mesh ready!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Test Scenario: Distributed DML Operations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1: Creating table on all nodes...
   ✓ Node 1: Table created
   ✓ Node 2: Table created
   ✓ Node 3: Table created

Step 2: Inserting data from different nodes...
   ✓ Node 1: Inserted Alice
   ✓ Node 2: Inserted Bob
   ✓ Node 3: Inserted Charlie

Step 3: Verifying data replication...
   ✓ Node 1: 3 rows
      Alice, Bob, Charlie
   ✓ Node 2: 3 rows
      Alice, Bob, Charlie
   ✓ Node 3: 3 rows
      Alice, Bob, Charlie

Step 4: Updating data from Node 1...
   ✓ Updated Alice's email

Step 5: Verifying update replication...
   ✓ Node 1: alice.updated@example.com
   ✓ Node 2: alice.updated@example.com
   ✓ Node 3: alice.updated@example.com

Step 6: Deleting data from Node 2...
   ✓ Deleted Bob

Step 7: Verifying deletion replication...
   ✓ Node 1: 2 rows remaining
      Alice, Charlie
   ✓ Node 2: 2 rows remaining
      Alice, Charlie
   ✓ Node 3: 2 rows remaining
      Alice, Charlie

Step 8: Testing TransactionId() function...
   ✓ Node 1: abc123def456...
   ✓ Node 2: ghi789jkl012...
   ✓ Node 3: mno345pqr678...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All operations completed successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🛑 Stopping all nodes...
✅ All nodes stopped
```

## How It Works

### Node Creation

Each node is created with:

1. **libp2p node** - P2P networking layer
2. **Storage** - In-memory storage (MemoryRawStorage)
3. **NetworkTransactor** - Optimystic transaction coordinator
4. **Quereus Database** - SQL database engine
5. **Optimystic Plugin** - Registered with the database

### Network Topology

- **Bootstrap Node** (Node 1) - Started first, provides addresses for other nodes
- **Peer Nodes** (Nodes 2-N) - Connect to bootstrap node and discover each other
- **Mesh Network** - All nodes eventually connect to each other

### Data Replication

When a DML operation is performed:

1. **Local Write** - Data is written to the local Optimystic tree
2. **Network Sync** - Changes are synced to the distributed network via libp2p
3. **Cluster Coordination** - FRET (Flexible Routing and Efficient Topology) ensures data reaches all nodes
4. **Eventual Consistency** - All nodes eventually see the same data

### Timing Considerations

The tests include delays to allow for:

- **Network convergence** (3000ms) - Nodes discovering each other
- **Data propagation** (500-1500ms) - Changes replicating across the network

These delays may need adjustment based on:
- Network latency
- Number of nodes
- System performance

## Troubleshooting

### Nodes Not Connecting

If nodes aren't connecting:

1. Check firewall settings
2. Verify ports are available
3. Increase convergence delay
4. Check bootstrap addresses are correct

### Data Not Replicating

If data isn't replicating:

1. Increase propagation delays
2. Check network connections (connection count)
3. Verify all nodes use the same `collectionUri`
4. Check for errors in node logs

### Tests Timing Out

If tests timeout:

1. Increase mocha timeout in `.aegir.js`
2. Reduce `MESH_SIZE`
3. Increase delays between operations

## Advanced Usage

### Testing with More Nodes

```typescript
const MESH_SIZE = 10;  // Test with 10 nodes
```

Note: More nodes require:
- More time for convergence
- More memory
- Longer propagation delays

### Testing Different Operations

Add custom test scenarios:

```typescript
it('should handle concurrent transactions', async () => {
  // Your test code here
});
```

### Using Different Storage

Replace `MemoryRawStorage` with `FileRawStorage`:

```typescript
import { FileRawStorage } from '@optimystic/db-p2p';

const rawStorage = new FileRawStorage('./test-data/node-' + port);
```

## Related Files

- `packages/test-peer/test/distributed-diary.spec.ts` - Similar tests for Diary (lower-level)
- `packages/quereus-plugin-optimystic/examples/` - Example configs for manual testing
- `TEST-SETUP-SUMMARY.md` - Overview of test infrastructure

## Next Steps

After running these tests, you can:

1. **Add more test cases** - Test complex queries, transactions, constraints
2. **Test failure scenarios** - Network partitions, node failures
3. **Performance testing** - Measure replication latency, throughput
4. **Integration testing** - Test with real applications

