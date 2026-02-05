/**
 * Manual Mesh Test Script
 *
 * Interactive script to create a mesh of N nodes and test distributed Quereus operations.
 *
 * Usage:
 *   MESH_SIZE=3 node dist/test/manual-mesh-test.js
 */

import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import {
	createLibp2pNode,
	Libp2pKeyPeerNetwork,
	RepoClient
} from '@optimystic/db-p2p';
import { NetworkTransactor } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import register from '../src/plugin.js';

type Row = Record<string, SqlValue>;

interface TestNode {
	node: any;
	db: Database;
	transactor: NetworkTransactor;
	peerId: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
};

async function createNode(port: number, bootstrapNodes: string[], networkName: string): Promise<TestNode> {
	console.log(`🔧 Creating node on port ${port}...`);

	const node = await createLibp2pNode({
		port,
		bootstrapNodes,
		networkName,
		fretProfile: 'edge',
		arachnode: {
			enableRingZulu: true
		}
	});

	const keyNetwork = new Libp2pKeyPeerNetwork(node);
	const coordinatedRepo = (node as any).coordinatedRepo;

	if (!coordinatedRepo) {
		throw new Error('coordinatedRepo not available on node');
	}

	const protocolPrefix = `/optimystic/${networkName}`;
	const transactor = new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 5_000,
		keyNetwork,
		getRepo: (peerId: PeerId) => {
			if (peerId.toString() === node.peerId.toString()) {
				return coordinatedRepo;
			}
			return RepoClient.create(peerId, keyNetwork, protocolPrefix);
		}
	});

	// Create Quereus database
	const db = new Database();

	// Register Optimystic plugin - this registers vtables and functions automatically
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false
	});

	// Register vtables
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}

	// Register functions
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}

	console.log(`✅ Node created: ${node.peerId.toString().slice(0, 12)}...`);

	return {
		node,
		db,
		transactor,
		peerId: node.peerId.toString()
	};
}

async function main() {
	const MESH_SIZE = parseInt(process.env.MESH_SIZE || '3', 10);
	const BASE_PORT = parseInt(process.env.BASE_PORT || '9200', 10);
	const NETWORK_NAME = process.env.NETWORK_NAME || 'manual-test-mesh';

	console.log(`\n🚀 Starting ${MESH_SIZE}-node Quereus mesh\n`);
	console.log(`   Network: ${NETWORK_NAME}`);
	console.log(`   Base Port: ${BASE_PORT}\n`);

	const nodes: TestNode[] = [];

	try {
		// Start bootstrap node
		const node1 = await createNode(BASE_PORT, [], NETWORK_NAME);
		nodes.push(node1);

		// Get bootstrap addresses
		const bootstrapAddrs = node1.node.getMultiaddrs().map((ma: any) => ma.toString());
		console.log(`\n🔗 Bootstrap addresses:`);
		bootstrapAddrs.forEach((addr: string) => console.log(`   ${addr}`));
		console.log('');

		// Start remaining nodes
		for (let i = 1; i < MESH_SIZE; i++) {
			const port = BASE_PORT + i;
			const node = await createNode(port, bootstrapAddrs, NETWORK_NAME);
			nodes.push(node);
		}

		// Wait for network convergence
		console.log('\n⏳ Waiting for network convergence...');
		await delay(3000);

		// Log connection status
		console.log('\n📊 Network Status:');
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const connections = node.node.getConnections();
			console.log(`   Node ${i + 1} (${node.peerId.slice(0, 12)}...): ${connections.length} connections`);
		}

		console.log('\n✅ Mesh ready!\n');

		// Run test scenario
		await runTestScenario(nodes);

		console.log('\n✅ All tests completed successfully!\n');

	} catch (error) {
		console.error('\n❌ Error:', error);
		process.exit(1);
	} finally {
		// Cleanup
		console.log('\n🛑 Stopping all nodes...');
		for (const node of nodes) {
			await node.node.stop();
		}
		console.log('✅ All nodes stopped\n');
	}
}

async function runTestScenario(nodes: TestNode[]) {
	const tableName = 'test_users';
	const collectionUri = `tree://manual-test/${tableName}`;

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('📝 Test Scenario: Distributed DML Operations');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

	// Step 1: Create table on all nodes
	console.log('Step 1: Creating table on all nodes...');
	for (let i = 0; i < nodes.length; i++) {
		await nodes[i]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT,
				created_by TEXT
			) USING optimystic('${collectionUri}')
		`);
		console.log(`   ✓ Node ${i + 1}: Table created`);
	}
	await delay(1000);

	// Step 2: Insert data from different nodes
	console.log('\nStep 2: Inserting data from different nodes...');

	await nodes[0]!.db.exec(`
		INSERT INTO ${tableName} (id, name, email, created_by)
		VALUES ('1', 'Alice', 'alice@example.com', 'Node 1')
	`);
	console.log('   ✓ Node 1: Inserted Alice');
	await delay(500);

	await nodes[1]!.db.exec(`
		INSERT INTO ${tableName} (id, name, email, created_by)
		VALUES ('2', 'Bob', 'bob@example.com', 'Node 2')
	`);
	console.log('   ✓ Node 2: Inserted Bob');
	await delay(500);

	if (nodes.length >= 3) {
		await nodes[2]!.db.exec(`
			INSERT INTO ${tableName} (id, name, email, created_by)
			VALUES ('3', 'Charlie', 'charlie@example.com', 'Node 3')
		`);
		console.log('   ✓ Node 3: Inserted Charlie');
		await delay(500);
	}

	// Wait for replication
	await delay(1500);

	// Step 3: Verify data on all nodes
	console.log('\nStep 3: Verifying data replication...');
	for (let i = 0; i < nodes.length; i++) {
		const results = await collectRows(nodes[i]!.db.eval(`SELECT * FROM ${tableName} ORDER BY id`));
		console.log(`   ✓ Node ${i + 1}: ${results.length} rows`);

		if (results.length > 0) {
			console.log(`      ${results.map(r => r.name).join(', ')}`);
		}
	}

	// Step 4: Update from one node
	console.log('\nStep 4: Updating data from Node 1...');
	await nodes[0]!.db.exec(`
		UPDATE ${tableName}
		SET email = 'alice.updated@example.com'
		WHERE id = '1'
	`);
	console.log('   ✓ Updated Alice\'s email');
	await delay(1500);

	// Step 5: Verify update on all nodes
	console.log('\nStep 5: Verifying update replication...');
	for (let i = 0; i < nodes.length; i++) {
		const results = await collectRows(nodes[i]!.db.eval(`SELECT email FROM ${tableName} WHERE id = '1'`));
		const result = results[0];
		console.log(`   ✓ Node ${i + 1}: ${result?.email}`);
	}

	// Step 6: Delete from another node
	console.log('\nStep 6: Deleting data from Node 2...');
	await nodes[1]!.db.exec(`DELETE FROM ${tableName} WHERE id = '2'`);
	console.log('   ✓ Deleted Bob');
	await delay(1500);

	// Step 7: Verify deletion on all nodes
	console.log('\nStep 7: Verifying deletion replication...');
	for (let i = 0; i < nodes.length; i++) {
		const results = await collectRows(nodes[i]!.db.eval(`SELECT * FROM ${tableName} ORDER BY id`));
		console.log(`   ✓ Node ${i + 1}: ${results.length} rows remaining`);
		console.log(`      ${results.map(r => r.name).join(', ')}`);
	}

	// Step 8: Test TransactionId() function
	console.log('\nStep 8: Testing TransactionId() function...');
	for (let i = 0; i < nodes.length; i++) {
		await nodes[i]!.db.exec('BEGIN');
		const results = await collectRows(nodes[i]!.db.eval('SELECT TransactionId() as txn_id'));
		await nodes[i]!.db.exec('COMMIT');
		const txnId = results[0]?.txn_id;
		const displayId = typeof txnId === 'string' ? txnId.slice(0, 16) : String(txnId);
		console.log(`   ✓ Node ${i + 1}: ${displayId}...`);
	}

	console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('✅ All operations completed successfully!');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// Run the test
void main().catch(err => {
	console.error('Fatal error:', err);
	process.exit(1);
});

