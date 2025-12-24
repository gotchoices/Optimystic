/**
 * Distributed Quereus Test
 *
 * Creates a mesh of N nodes, creates Quereus tables with Optimystic backend,
 * performs DML operations, and verifies data replication across all nodes.
 */

import { expect } from 'aegir/chai';
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
import register from '../dist/plugin.js';

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

		// Ensure full mesh connectivity - dial all known peers
		console.log('🔗 Ensuring full mesh connectivity...');
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			for (let j = 0; j < nodes.length; j++) {
				if (i === j) continue;
				const targetNode = nodes[j]!;
				const targetPeerId = targetNode.node.peerId;
				const existingConns = node.node.getConnections(targetPeerId);
				if (existingConns.length === 0) {
					try {
						const targetAddrs = targetNode.node.getMultiaddrs();
						if (targetAddrs.length > 0) {
							await node.node.dial(targetAddrs[0]!);
							console.log(`   Node ${i + 1} -> Node ${j + 1}: Connected`);
						}
					} catch (_err) {
						// Connection may already exist or fail - that's ok
					}
				}
			}
		}

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

		// Create table on node 1 with network transactor (uses pre-registered libp2p node)
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
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
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('✅ Table created on Node 2');

		// Both nodes should have the table
		const schema1 = nodes[0]!.db.schemaManager.getTable('main', tableName);
		const schema2 = nodes[1]!.db.schemaManager.getTable('main', tableName);

		expect(schema1, 'Table should exist on Node 1').to.exist;
		expect(schema2, 'Table should exist on Node 2').to.exist;
	});

	it('should distribute INSERT operations across all nodes', async () => {
		const tableName = 'products_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Distribute INSERTs for "${tableName}"`);

		// Create table on node 1 first
		console.log('Creating table on Node 1...');
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				price REAL
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('✅ Table created on Node 1');

		await delay(2000); // Wait for collection to be available

		// Insert data from node 1
		console.log('\nInserting data from Node 1...');

		console.log('   Inserting Widget...');
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('1', 'Widget', 19.99)`);
		console.log('   Inserted Widget');
		await delay(1000);

		console.log('   Inserting Gadget...');
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('2', 'Gadget', 49.99)`);
		console.log('   Inserted Gadget');
		await delay(1000);

		console.log('   Inserting Doohickey...');
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} (id, name, price) VALUES ('3', 'Doohickey', 29.99)`);
		console.log('   Inserted Doohickey');
		await delay(2000);

		// Create table on other nodes (they connect to the same collection)
		for (let i = 1; i < nodes.length; i++) {
			console.log(`Creating table on Node ${i + 1}...`);
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					price REAL
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`✅ Table created on Node ${i + 1}`);
			await delay(1000);
		}

		await delay(2000); // Wait for all transactions to settle

		// Verify all nodes see all data
		console.log('\nVerifying data on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const stmt = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} ORDER BY id`);
			const results = [];
			for await (const row of stmt.all()) {
				results.push(row);
			}
			await stmt.finalize();
			console.log(`   Node ${i + 1}: ${results.length} rows`);

			expect(results.length, `Node ${i + 1} should have 3 rows`).to.equal(3);
			expect(results[0]!.name).to.equal('Widget');
			expect(results[1]!.name).to.equal('Gadget');
			expect(results[2]!.name).to.equal('Doohickey');
		}

		console.log('✅ Data consistent across all nodes');
	});

	it('should handle UPDATE operations across nodes', async () => {
		const tableName = 'inventory_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: UPDATE operations for "${tableName}"`);

		// Create table and insert initial data on node 1
		console.log('Creating table on Node 1...');
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				sku TEXT PRIMARY KEY,
				quantity INTEGER,
				location TEXT
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('Inserting data on Node 1...');
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} VALUES ('SKU001', 100, 'Warehouse A')`);
		console.log('✅ Table created and data inserted on Node 1');

		// Wait for collection to be available on the network
		await delay(3000);

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			console.log(`Creating table on Node ${i + 1}...`);
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					sku TEXT PRIMARY KEY,
					quantity INTEGER,
					location TEXT
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`✅ Table created on Node ${i + 1}`);
			await delay(1000);
		}

		await delay(2000);

		// Verify initial data on all nodes
		console.log('Verifying initial data on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			console.log(`   Querying Node ${i + 1}...`);
			const result = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} WHERE sku = 'SKU001'`).get();
			console.log(`   Node ${i + 1}: quantity = ${result?.quantity}`);
			expect(result?.quantity, `Node ${i + 1} should see initial quantity`).to.equal(100);
		}

		await delay(1000); // Extra delay to ensure all replication is complete

		// Update from node 2
		console.log('\nUpdating quantity from Node 2...');
		await nodes[1]!.db.exec(`UPDATE ${tableName} SET quantity = 75 WHERE sku = 'SKU001'`);
		console.log('UPDATE executed');

		// Verify update on Node 2 immediately
		const node2Result = await nodes[1]!.db.prepare(`SELECT * FROM ${tableName} WHERE sku = 'SKU001'`).get();
		console.log(`   Node 2 (source) after UPDATE: quantity = ${node2Result?.quantity}`);

		console.log('Waiting for replication...');
		await delay(5000); // Increased delay for replication

		// Verify update on all nodes
		console.log('Verifying update on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const result = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} WHERE sku = 'SKU001'`).get();
			console.log(`   Node ${i + 1}: quantity = ${result?.quantity}`);
			expect(result?.quantity, `Node ${i + 1} should see updated quantity`).to.equal(75);
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
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
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
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
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
			const stmt = await nodes[i]!.db.prepare(`SELECT * FROM ${tableName} ORDER BY id`);
			const results = [];
			for await (const row of stmt.all()) {
				results.push(row);
			}
			await stmt.finalize();
			console.log(`   Node ${i + 1}: ${results.length} rows`);

			expect(results.length, `Node ${i + 1} should have 2 rows`).to.equal(2);
			expect(results[0]!.id).to.equal('1');
			expect(results[1]!.id).to.equal('3');
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
			clusterSize: MESH_SIZE,  // Match cluster size to actual network size
			clusterPolicy: {
				superMajorityThreshold: 0.51  // 2/3 for 3-node cluster
			},
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

		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const transactor = new NetworkTransactor({
			timeoutMs: 30_000,
			abortOrCancelTimeoutMs: 5_000,
			keyNetwork,
			getRepo: (peerId) => {
				// If it's the local peer, return the coordinated repo
				if (peerId.toString() === node.peerId.toString()) {
					return coordinatedRepo;
				}
				// For remote peers, create a RepoClient
				return RepoClient.create(peerId, keyNetwork, protocolPrefix);
			}
		});

		// Create Quereus database
		const db = new Database();

		// Register Optimystic plugin
		const plugin = register(db, {
			enable_cache: false
		});

		// Register the pre-created libp2p node and transactor with the collection factory
		// This allows tables using transactor='network' to use our pre-created nodes
		plugin.collectionFactory.registerLibp2pNode(NETWORK_NAME, node, coordinatedRepo);
		plugin.collectionFactory.registerTransactor(`network:libp2p`, transactor);

		// Register the plugin's virtual tables and functions
		for (const vtable of plugin.vtables) {
			db.registerVtabModule(vtable.name, vtable.module, vtable.auxData);
		}

		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
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

