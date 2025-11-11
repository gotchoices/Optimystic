/**
 * Distributed Quereus Test
 * 
 * Creates a mesh of N nodes, creates Quereus tables with Optimystic backend,
 * performs DML operations, and verifies data replication across all nodes.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Database } from '@quereus/quereus';
import {
	createLibp2pNode,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	Libp2pKeyPeerNetwork,
	RepoClient
} from '@optimystic/db-p2p';
import { NetworkTransactor } from '@optimystic/db-core';
import { register } from '../src/plugin.js';

interface TestNode {
	node: any;
	db: Database;
	storageRepo: StorageRepo;
	transactor: NetworkTransactor;
	peerId: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Distributed Quereus Operations', () => {
	const nodes: TestNode[] = [];
	const MESH_SIZE = 3;
	const BASE_PORT = 9100;
	const NETWORK_NAME = 'test-distributed-quereus';

	before(async () => {
		console.log(`\n🚀 Starting ${MESH_SIZE}-node mesh for Quereus testing...\n`);

		// Start first node (bootstrap node)
		const node1 = await createNode(BASE_PORT, []);
		nodes.push(node1);
		console.log(`✅ Node 1 started: ${node1.peerId}`);

		// Build bootstrap list from first node
		const bootstrapAddrs = node1.node.getMultiaddrs().map((ma: any) => ma.toString());

		// Start remaining nodes
		for (let i = 1; i < MESH_SIZE; i++) {
			const port = BASE_PORT + i;
			const node = await createNode(port, bootstrapAddrs);
			nodes.push(node);
			console.log(`✅ Node ${i + 1} started: ${node.peerId}`);
		}

		// Give nodes time to discover each other
		console.log('\n⏳ Waiting for network convergence...');
		await delay(3000);

		// Log connection status
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const connections = node.node.getConnections();
			console.log(`   Node ${i + 1} (${node.peerId.slice(0, 8)}): ${connections.length} connections`);
		}

		console.log('\n✅ Mesh ready for testing\n');
	});

	after(async () => {
		console.log('\n🛑 Stopping all nodes...');
		for (const testNode of nodes) {
			await testNode.node.stop();
		}
		console.log('✅ All nodes stopped\n');
	});

	it('should create table on one node and access from another', async () => {
		const tableName = 'users_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Create table "${tableName}" on Node 1`);

		// Create table on node 1
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT
			) USING optimystic('${collectionUri}')
		`);
		console.log('✅ Table created on Node 1');

		// Wait for distribution
		await delay(1000);

		// Create same table on node 2 (should connect to same collection)
		console.log('📖 Creating table on Node 2...');
		await nodes[1]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT
			) USING optimystic('${collectionUri}')
		`);
		console.log('✅ Table created on Node 2');

		// Both nodes should have the table
		const schema1 = nodes[0]!.db.schemaManager.getTable('main', tableName);
		const schema2 = nodes[1]!.db.schemaManager.getTable('main', tableName);

		assert.ok(schema1, 'Table should exist on Node 1');
		assert.ok(schema2, 'Table should exist on Node 2');
	});

	it('should distribute INSERT operations across all nodes', async () => {
		const tableName = 'products_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Distribute INSERTs for "${tableName}"`);

		// Create table on all nodes
		for (let i = 0; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					price REAL
				) USING optimystic('${collectionUri}')
			`);
			console.log(`✅ Table created on Node ${i + 1}`);
		}

		await delay(500);

		// Insert data from different nodes
		console.log('\nInserting data from different nodes...');
		
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('1', 'Widget', 19.99)`);
		console.log('   Node 1: Inserted Widget');
		await delay(500);

		await nodes[1]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('2', 'Gadget', 49.99)`);
		console.log('   Node 2: Inserted Gadget');
		await delay(500);

		await nodes[2]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('3', 'Doohickey', 29.99)`);
		console.log('   Node 3: Inserted Doohickey');
		await delay(1500);

		// Verify all nodes see all data
		console.log('\nVerifying data on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const results = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} ORDER BY id`).all();
			console.log(`   Node ${i + 1}: ${results.length} rows`);
			
			assert.strictEqual(results.length, 3, `Node ${i + 1} should have 3 rows`);
			assert.strictEqual(results[0]!.name, 'Widget');
			assert.strictEqual(results[1]!.name, 'Gadget');
			assert.strictEqual(results[2]!.name, 'Doohickey');
		}

		console.log('✅ Data consistent across all nodes');
	});

	it('should handle UPDATE operations across nodes', async () => {
		const tableName = 'inventory_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: UPDATE operations for "${tableName}"`);

		// Create table and insert initial data on node 1
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				sku TEXT PRIMARY KEY,
				quantity INTEGER,
				location TEXT
			) USING optimystic('${collectionUri}')
		`);
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} VALUES ('SKU001', 100, 'Warehouse A')`);
		console.log('✅ Table created and data inserted on Node 1');

		await delay(1000);

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					sku TEXT PRIMARY KEY,
					quantity INTEGER,
					location TEXT
				) USING optimystic('${collectionUri}')
			`);
		}

		await delay(1000);

		// Verify initial data on all nodes
		for (let i = 0; i < nodes.length; i++) {
			const result = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} WHERE sku = 'SKU001'`).get();
			assert.strictEqual(result?.quantity, 100, `Node ${i + 1} should see initial quantity`);
		}

		// Update from node 2
		console.log('\nUpdating quantity from Node 2...');
		await nodes[1]!.db.exec(`UPDATE ${tableName} SET quantity = 75 WHERE sku = 'SKU001'`);
		await delay(1500);

		// Verify update on all nodes
		console.log('Verifying update on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const result = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} WHERE sku = 'SKU001'`).get();
			console.log(`   Node ${i + 1}: quantity = ${result?.quantity}`);
			assert.strictEqual(result?.quantity, 75, `Node ${i + 1} should see updated quantity`);
		}

		console.log('✅ UPDATE replicated across all nodes');
	});

	it('should handle DELETE operations across nodes', async () => {
		const tableName = 'temp_data_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: DELETE operations for "${tableName}"`);

		// Create table and insert data on node 1
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				data TEXT
			) USING optimystic('${collectionUri}')
		`);
		await nodes[0]!.db.exec(`
			INSERT INTO ${tableName} VALUES ('1', 'Keep'), ('2', 'Delete'), ('3', 'Keep')
		`);

		await delay(1000);

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					data TEXT
				) USING optimystic('${collectionUri}')
			`);
		}

		await delay(1000);

		// Delete from node 3
		console.log('\nDeleting row from Node 3...');
		await nodes[2]!.db.exec(`DELETE FROM ${tableName} WHERE id = '2'`);
		await delay(1500);

		// Verify deletion on all nodes
		console.log('Verifying deletion on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const results = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} ORDER BY id`).all();
			console.log(`   Node ${i + 1}: ${results.length} rows`);
			
			assert.strictEqual(results.length, 2, `Node ${i + 1} should have 2 rows`);
			assert.strictEqual(results[0]!.id, '1');
			assert.strictEqual(results[1]!.id, '3');
		}

		console.log('✅ DELETE replicated across all nodes');
	});

	async function createNode(port: number, bootstrapNodes: string[]): Promise<TestNode> {
		const node = await createLibp2pNode({
			port,
			bootstrapNodes,
			networkName: NETWORK_NAME,
			storageType: 'memory',
			fretProfile: 'edge',
			arachnode: {
				enableRingZulu: true
			}
		});

		const rawStorage = new MemoryRawStorage();
		const storageRepo = new StorageRepo((blockId: string) =>
			new BlockStorage(blockId, rawStorage)
		);

		const keyNetwork = new Libp2pKeyPeerNetwork(node);
		const coordinatedRepo = (node as any).coordinatedRepo;

		if (!coordinatedRepo) {
			throw new Error('coordinatedRepo not available on node');
		}

		const repoClient = new RepoClient(coordinatedRepo);
		const transactor = new NetworkTransactor(repoClient, keyNetwork, node.peerId);

		// Create Quereus database
		const db = new Database();

		// Register Optimystic plugin with this node's transactor
		const plugin = await register(db, {
			transactor,
			keyNetwork,
			node
		});

		// Register the plugin's virtual tables and functions
		if (plugin.vtables) {
			for (const [name, vtable] of Object.entries(plugin.vtables)) {
				db.registerVirtualTableModule(name, vtable);
			}
		}

		if (plugin.functions) {
			for (const [name, func] of Object.entries(plugin.functions)) {
				db.registerFunction(name, func);
			}
		}

		return {
			node,
			db,
			storageRepo,
			transactor,
			peerId: node.peerId.toString()
		};
	}
});

