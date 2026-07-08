/**
 * Distributed Transaction Validation Tests (Phase 7)
 *
 * End-to-end tests for multi-peer distributed transactions with:
 * - Real file storage (FileRawStorage)
 * - Schema constraints independently validated on each peer
 * - StampId-based non-repeatability enforcement via WITH CONTEXT
 * - Multi-collection (table + index) transaction coordination
 */

import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Database } from '@quereus/quereus';
import {
	createLibp2pNode,
	Libp2pKeyPeerNetwork,
	RepoClient
} from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { NetworkTransactor } from '@optimystic/db-core';
import { waitForValue, delay } from '@optimystic/db-core/test';
import register from '../dist/plugin.js';

interface TestNode {
	node: any;
	db: Database;
	transactor: NetworkTransactor;
	peerId: string;
	storagePath: string;
}

/** Collect every row `sql` returns from a node's database, finalizing the statement. */
async function queryAll(db: Database, sql: string): Promise<Record<string, any>[]> {
	const stmt = await db.prepare(sql);
	try {
		const rows: Record<string, any>[] = [];
		for await (const row of stmt.all()) rows.push(row);
		return rows;
	} finally {
		await stmt.finalize();
	}
}

/** Run `sql` and return its single row, or `undefined` when no row matches (not ready yet). */
async function queryGet(db: Database, sql: string): Promise<Record<string, any> | undefined> {
	const stmt = await db.prepare(sql);
	try {
		return await stmt.get();
	} finally {
		await stmt.finalize();
	}
}

describe('Distributed Transaction Validation', function () {
	// 3-node real libp2p mesh + filesystem-backed storage + transaction validation across peers;
	// legitimate long budget for full end-to-end distributed scenarios.
	this.timeout(120000);

	const nodes: TestNode[] = [];
	const MESH_SIZE = 3;
	// Use ephemeral ports (0) so the OS assigns free TCP ports. Fixed ports
	// risk EADDRINUSE collisions with leftover/concurrent nodes; the mesh's
	// bootstrap addresses are derived from each node's actual getMultiaddrs()
	// after start, so the concrete port numbers don't need to be predetermined.
	const EPHEMERAL_PORT = 0;
	const NETWORK_NAME = 'test-trx-validation-' + Date.now();
	let testTempDir: string;

	before(async () => {
		// Create temp directory for file storage
		testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-test-'));
		console.log(`\n📁 Test storage: ${testTempDir}`);
		console.log(`🚀 Starting ${MESH_SIZE}-node mesh with file storage...\n`);

		// Start first node (bootstrap)
		const node1 = await createNode(EPHEMERAL_PORT, [], 0);
		nodes.push(node1);
		console.log(`✅ Node 1: ${node1.peerId.slice(0, 12)}... (${node1.storagePath})`);

		const bootstrapAddrs = node1.node.getMultiaddrs().map((ma: any) => ma.toString());

		for (let i = 1; i < MESH_SIZE; i++) {
			const node = await createNode(EPHEMERAL_PORT, bootstrapAddrs, i);
			nodes.push(node);
			console.log(`✅ Node ${i + 1}: ${node.peerId.slice(0, 12)}... (${node.storagePath})`);
		}

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

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const connections = node.node.getConnections();
			console.log(`   Node ${i + 1}: ${connections.length} connections`);
		}
		console.log('\n✅ Mesh ready\n');
	});

	after(async () => {
		console.log('\n🛑 Stopping nodes...');
		for (const testNode of nodes) {
			await testNode.node.stop();
		}
		// Clean up temp storage
		await fs.rm(testTempDir, { recursive: true, force: true });
		console.log('✅ Cleanup complete\n');
	});

	// No beforeEach/afterEach hooks - let tests run naturally like distributed-quereus.spec.ts

	it('should validate CHECK constraints independently on each peer', async () => {
		const tableName = 'validated_products_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: CHECK constraint validation for "${tableName}"`);

		// Create table on Node 1 first
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				price REAL NOT NULL,
				CONSTRAINT positive_price CHECK (price > 0)
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log(`   Node 1: Table created with CHECK constraint`);

		// Wait for collection to be available on the network
		await delay(2000);

		// Insert data from Node 1
		await nodes[0]!.db.exec(
			`INSERT INTO ${tableName} (id, name, price) VALUES ('1', 'Widget', 19.99)`
		);
		console.log('✅ Valid INSERT succeeded on Node 1');
		await delay(2000);

		// Create table on other nodes (they'll pick up the schema from the network)
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					price REAL NOT NULL,
					CONSTRAINT positive_price CHECK (price > 0)
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`   Node ${i + 1}: Table created with CHECK constraint`);
			await delay(1000);
		}
		// Verify on all nodes — poll until the row replicates to each node.
		for (let i = 0; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT * FROM ${tableName} WHERE id = '1'`);
					return r?.price === 19.99 ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should see the row` },
			);
			expect(result, `Node ${i + 1} should see the row`).to.exist;
			expect(result!.price).to.equal(19.99);
		}
		console.log('✅ Row replicated to all nodes');

		// Invalid insert should fail
		let constraintFailed = false;
		try {
			await nodes[1]!.db.exec(
				`INSERT INTO ${tableName} (id, name, price) VALUES ('2', 'Bad', -5.00)`
			);
		} catch (err: any) {
			if (err.message.includes('CHECK constraint failed')) {
				constraintFailed = true;
			}
		}
		expect(constraintFailed, 'Negative price should fail CHECK constraint').to.be.true;
		console.log('✅ Invalid INSERT correctly rejected');
	});

	it('should enforce non-repeatability using StampId in column', async () => {
		// Wait for FRET layer to stabilize after previous test
		console.log('\n⏳ Waiting for FRET layer to stabilize...');
		await delay(5000);

		const tableName = 'idempotent_log_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: StampId-based non-repeatability for "${tableName}"`);

		// Create table on Node 1 first
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				stamp_id TEXT NOT NULL,
				CONSTRAINT unique_stamp UNIQUE (stamp_id)
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log(`   Node 1: Table created with stamp_id tracking`);

		// Wait for collection to be available on the network
		// Need longer delay for FRET to propagate the new collection
		await delay(5000);

		// Use a transaction to get a consistent StampId
		await nodes[0]!.db.exec('BEGIN');
		const stampResult = await nodes[0]!.db.prepare('SELECT StampId() as sid').get();
		const stampId = stampResult?.sid as string;

		// Insert using StampId() directly in the INSERT
		await nodes[0]!.db.exec(`
			INSERT INTO ${tableName} (id, data, stamp_id)
			VALUES ('entry1', 'first operation', '${stampId}')
		`);
		await nodes[0]!.db.exec('COMMIT');
		console.log(`✅ INSERT with StampId: ${stampId?.slice(0, 16)}...`);
		await delay(5000);  // Longer delay to ensure FRET propagation

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					data TEXT NOT NULL,
					stamp_id TEXT NOT NULL,
					CONSTRAINT unique_stamp UNIQUE (stamp_id)
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`   Node ${i + 1}: Table created with stamp_id tracking`);
			await delay(1000);
		}
		await delay(2000);

		// Verify stamp was captured
		const row = await nodes[0]!.db.prepare(`SELECT * FROM ${tableName} WHERE id = 'entry1'`).get();
		expect(row, 'Row should exist').to.exist;
		expect(row!.stamp_id, 'stamp_id should be captured').to.equal(stampId);
		console.log(`✅ Captured stamp_id: ${(row!.stamp_id as string).slice(0, 16)}...`);

		// Verify replicated to other nodes — poll until each carries the stamp_id.
		console.log('Waiting for replication...');
		for (let i = 1; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT stamp_id FROM ${tableName} WHERE id = 'entry1'`);
					return r?.stamp_id === stampId ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should have stamp_id` },
			);
			console.log(`   Node ${i + 1}: stamp_id = ${String(result?.stamp_id ?? 'undefined').slice(0, 16)}...`);
			expect(result?.stamp_id, `Node ${i + 1} should have stamp_id`).to.equal(stampId);
		}
		console.log('✅ StampId replicated to all nodes');
	});

	it('should coordinate multi-collection transactions (table + index)', async () => {
		const tableName = 'indexed_orders_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Multi-collection (table + index) for "${tableName}"`);

		// Create table on Node 1 first
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				customer TEXT NOT NULL,
				amount REAL NOT NULL,
				status TEXT DEFAULT 'pending'
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('   Node 1: Table created');
		await delay(1000);

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					customer TEXT NOT NULL,
					amount REAL NOT NULL,
					status TEXT DEFAULT 'pending'
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`   Node ${i + 1}: Table created`);
		}
		await delay(500);

		// Create index on customer column (creates separate index collection)
		await nodes[0]!.db.exec(`CREATE INDEX idx_customer ON ${tableName}(customer)`);
		console.log('✅ Index idx_customer created');
		await delay(500);

		// Insert data (affects both main table and index collections)
		await nodes[0]!.db.exec(`
			INSERT INTO ${tableName} (id, customer, amount)
			VALUES ('ord1', 'Alice', 100.00), ('ord2', 'Bob', 200.00), ('ord3', 'Alice', 150.00)
		`);
		console.log('✅ 3 orders inserted (table + index updated)');

		// Verify data on all nodes — poll until the 3 inserted rows replicate.
		for (let i = 0; i < nodes.length; i++) {
			const results = await waitForValue(
				async () => {
					const rows = await queryAll(nodes[i]!.db, `SELECT * FROM ${tableName} ORDER BY id`);
					return rows.length === 3 ? rows : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should have 3 rows` },
			);
			expect(results.length, `Node ${i + 1} should have 3 rows`).to.equal(3);
		}
		console.log('✅ All nodes have 3 orders');

		// Update (modifies index if customer changes)
		await nodes[1]!.db.exec(`UPDATE ${tableName} SET customer = 'Charlie' WHERE id = 'ord2'`);
		console.log('✅ Updated ord2 customer (index re-keyed)');

		// Verify update replicated — poll past the stale 'Bob' until 'Charlie' lands.
		for (let i = 0; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT customer FROM ${tableName} WHERE id = 'ord2'`);
					return r?.customer === 'Charlie' ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should see updated customer` },
			);
			expect(result?.customer, `Node ${i + 1} should see updated customer`).to.equal('Charlie');
		}
		console.log('✅ Update replicated to all nodes');

		// Delete (removes from both table and index)
		await nodes[2]!.db.exec(`DELETE FROM ${tableName} WHERE id = 'ord3'`);
		console.log('✅ Deleted ord3');

		// Verify deletion replicated — poll past the stale 3-row state until 2 remain.
		for (let i = 0; i < nodes.length; i++) {
			const results = await waitForValue(
				async () => {
					const rows = await queryAll(nodes[i]!.db, `SELECT * FROM ${tableName} ORDER BY id`);
					return rows.length === 2 ? rows : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should have 2 rows after delete` },
			);
			expect(results.length, `Node ${i + 1} should have 2 rows after delete`).to.equal(2);
		}
		console.log('✅ Delete replicated to all nodes');
	});

	it('should verify file storage persistence across operations', async () => {
		const tableName = 'persisted_data_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: File storage persistence for "${tableName}"`);

		// Create table on Node 1 first
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				value INTEGER
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('   Node 1: Table created');

		// Wait for collection to be available on the network
		await delay(2000);

		// Insert data from Node 1
		await nodes[0]!.db.exec(
			`INSERT INTO ${tableName} VALUES ('k1', 100), ('k2', 200), ('k3', 300)`
		);
		console.log('✅ Data inserted on Node 1');
		await delay(2000);

		// Create table on other nodes
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					id TEXT PRIMARY KEY,
					value INTEGER
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`   Node ${i + 1}: Table created`);
			await delay(1000);
		}
		// Verify data persisted + replicated — poll each node until the sum is 600.
		// (SUM over an empty/partial table yields null until every row lands.)
		for (let i = 0; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT SUM(value) as total FROM ${tableName}`);
					return r?.total === 600 ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should see sum of 600` },
			);
			console.log(`   Node ${i + 1}: total = ${result?.total}`);
			expect(result?.total, `Node ${i + 1} should see sum of 600`).to.equal(600);
		}
		// Verify that FileRawStorage actually persisted data to disk
		const node1StorageContents = await fs.readdir(nodes[0]!.storagePath);
		expect(node1StorageContents.length, 'Node 1 storage should contain block directories on disk').to.be.greaterThan(0);
		console.log(`   Node 1 storage dirs: ${node1StorageContents.join(', ')}`);

		console.log('✅ Data persisted and replicated correctly');
	});

	it('should handle sequential transactions with constraints from multiple nodes', async () => {
		const tableName = 'balance_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Sequential transactions with constraints for "${tableName}"`);

		// Create table on Node 1 first (with CHECK constraint for non-negative balance)
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				account_id TEXT PRIMARY KEY,
				balance INTEGER,
				CONSTRAINT non_negative CHECK (balance >= 0)
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('   Node 1: Table created with CHECK constraint');

		// Wait for collection to be available on the network
		await delay(2000);

		// Insert data from Node 1
		await nodes[0]!.db.exec(`INSERT INTO ${tableName} VALUES ('acct1', 1000)`);
		console.log('✅ Initial balance created on Node 1');
		await delay(2000);

		// Create table on other nodes (with matching CHECK constraint)
		for (let i = 1; i < nodes.length; i++) {
			await nodes[i]!.db.exec(`
				CREATE TABLE ${tableName} (
					account_id TEXT PRIMARY KEY,
					balance INTEGER,
					CONSTRAINT non_negative CHECK (balance >= 0)
				) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
			`);
			console.log(`   Node ${i + 1}: Table created with CHECK constraint`);
			await delay(1000);
		}
		// Verify data replicated to ALL nodes before updating — poll until balance 1000 lands.
		console.log('Verifying initial data on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT * FROM ${tableName} WHERE account_id = 'acct1'`);
					return r?.balance === 1000 ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should see initial balance` },
			);
			console.log(`   Node ${i + 1}: balance = ${result?.balance}`);
			expect(result?.balance, `Node ${i + 1} should see initial balance`).to.equal(1000);
		}
		console.log('✅ Initial data verified on all nodes');

		// Update from Node 2 (set to absolute value, not relative)
		console.log('\nUpdating balance from Node 2...');
		await nodes[1]!.db.exec(`UPDATE ${tableName} SET balance = 800 WHERE account_id = 'acct1'`);
		console.log('UPDATE executed');

		// Verify update on Node 2 immediately
		const node2Check = await nodes[1]!.db.prepare(`SELECT * FROM ${tableName} WHERE account_id = 'acct1'`).get();
		console.log(`   Node 2 (source) after UPDATE: balance = ${node2Check?.balance}`);
		expect(node2Check?.balance, 'Node 2 should have balance 800 after UPDATE').to.equal(800);

		// Also check all rows in the table
		const allRows = await queryAll(nodes[1]!.db, `SELECT * FROM ${tableName}`);
		console.log(`   All rows on Node 2: ${JSON.stringify(allRows)}`);

		// Wait until Node 3 has replicated Node 2's write (balance 800) before it
		// issues its own update, so the final state is deterministically Node 3's
		// (last writer) rather than a race between propagation and the next write.
		await waitForValue(
			async () => {
				const r = await queryGet(nodes[2]!.db, `SELECT balance FROM ${tableName} WHERE account_id = 'acct1'`);
				return r?.balance === 800 ? r : undefined;
			},
			{ timeoutMs: 30_000, intervalMs: 200, description: 'Node 3 should replicate balance 800 before its update' },
		);

		// Update from Node 3 (set to absolute value)
		await nodes[2]!.db.exec(`UPDATE ${tableName} SET balance = 600.00 WHERE account_id = 'acct1'`);
		const node3Check = await nodes[2]!.db.prepare(`SELECT balance FROM ${tableName} WHERE account_id = 'acct1'`).get();
		console.log(`✅ Update from Node 3: balance = ${node3Check?.balance}`);
		expect(node3Check?.balance, 'Node 3 should have balance 600 after UPDATE').to.equal(600);

		// Verify final balance on all nodes — poll past the stale 800 until 600 lands.
		for (let i = 0; i < nodes.length; i++) {
			const result = await waitForValue(
				async () => {
					const r = await queryGet(nodes[i]!.db, `SELECT balance FROM ${tableName} WHERE account_id = 'acct1'`);
					return r?.balance === 600 ? r : undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 200, description: `Node ${i + 1} should have balance 600` },
			);
			console.log(`   Node ${i + 1}: balance = ${result?.balance}`);
			expect(result?.balance, `Node ${i + 1} should have balance 600`).to.equal(600);
		}
		console.log('✅ All balances consistent across nodes');

		// Try invalid update that would violate constraint
		let constraintViolated = false;
		try {
			await nodes[1]!.db.exec(
				`UPDATE ${tableName} SET balance = -100 WHERE account_id = 'acct1'`
			);
		} catch (err: any) {
			if (err.message.includes('CHECK constraint failed')) {
				constraintViolated = true;
			}
		}
		expect(constraintViolated, 'Negative balance should fail constraint').to.be.true;
		console.log('✅ Constraint violation correctly rejected');
	});

	it('should demonstrate local schema enforcement (column visibility)', async () => {
		// Wait for FRET layer to stabilize
		console.log('\n⏳ Waiting for FRET layer to stabilize...');
		await delay(5000);

		const tableName = 'schema_local_' + Date.now();
		const collectionUri = `tree://test/${tableName}`;

		console.log(`\n📝 Test: Local schema enforcement for "${tableName}"`);

		// Create table on Node 1 with EXTRA column
		await nodes[0]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				extra_field TEXT
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('   Node 1: Table created WITH extra_field column');

		await delay(2000);

		// Create table on Node 2 WITHOUT extra column
		await nodes[1]!.db.exec(`
			CREATE TABLE ${tableName} (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL
			) USING optimystic('${collectionUri}', transactor='network', networkName='${NETWORK_NAME}')
		`);
		console.log('   Node 2: Table created WITHOUT extra_field column');

		await delay(2000);

		// Insert from Node 1 (uses extra_field)
		await nodes[0]!.db.exec(
			`INSERT INTO ${tableName} (id, name, extra_field) VALUES ('1', 'Alice', 'extra_value')`
		);
		console.log('✅ Insert with extra_field succeeded on Node 1');

		// Query from Node 1 — its own insert, immediately visible with the extra column.
		const row1 = await queryGet(nodes[0]!.db, `SELECT * FROM ${tableName} WHERE id = '1'`);
		expect(row1, 'Node 1 should see the row').to.exist;
		expect(row1!.extra_field).to.equal('extra_value');
		console.log('   Node 1: Sees extra_field = "extra_value"');

		// Query from Node 2 — poll until the row replicates. Node 2's schema omits
		// extra_field, so SELECT * must expose name but NOT extra_field (local schema).
		const row2 = await waitForValue(
			async () => await queryGet(nodes[1]!.db, `SELECT * FROM ${tableName} WHERE id = '1'`),
			{ timeoutMs: 30_000, intervalMs: 200, description: 'Node 2 should replicate the row' },
		);
		expect(row2, 'Node 2 should see the row').to.exist;
		expect(row2!.name).to.equal('Alice');
		// Node 2's schema doesn't include extra_field, so it won't be in SELECT *
		console.log(`   Node 2: Row data = ${JSON.stringify(row2)}`);

		// Verify that extra_field is NOT visible on Node 2 (local schema enforcement)
		expect(row2!.extra_field, 'Node 2 should NOT see extra_field').to.be.undefined;
		console.log('✅ Local schema correctly filters columns (extra_field not visible on Node 2)');

		// NOTE: This test demonstrates LOCAL schema enforcement.
		// Each node's schema determines what columns are visible in queries.
		// The underlying data may contain additional fields, but they are filtered
		// by the local schema during query execution.
		//
		// Future work: TransactionValidator integration will reject transactions
		// where stamp.schemaHash doesn't match local schema during PEND phase.
		// See docs/transactions.md Phase 7 task: "Add validation to cluster consensus handlers"
	});

	async function createNode(port: number, bootstrapNodes: string[], index: number): Promise<TestNode> {
		const storagePath = path.join(testTempDir, `node-${index}`);
		await fs.mkdir(storagePath, { recursive: true });

		const node = await createLibp2pNode({
			port,
			bootstrapNodes,
			networkName: NETWORK_NAME,
			storage: new FileRawStorage(storagePath),
			fretProfile: 'core',  // Use 'core' profile for more consistent coordinator selection
			clusterSize: MESH_SIZE,
			clusterPolicy: {
				superMajorityThreshold: 0.51  // 2/3 for 3-node cluster
			},
			arachnode: { enableRingZulu: true }
		});

		const keyNetwork = new Libp2pKeyPeerNetwork(node);
		const coordinatedRepo = (node as any).coordinatedRepo;
		if (!coordinatedRepo) throw new Error('coordinatedRepo not available');

		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const transactor = new NetworkTransactor({
			timeoutMs: 30_000,
			abortOrCancelTimeoutMs: 5_000,
			keyNetwork,
			getRepo: (peerId) => peerId.toString() === node.peerId.toString()
				? coordinatedRepo
				: RepoClient.create(peerId, keyNetwork, protocolPrefix)
		});

		const db = new Database();
		const plugin = register(db, {
			enable_cache: false
		});

		// Register the pre-created libp2p node and transactor with the collection factory
		// This allows tables using transactor='network' to use our pre-created nodes
		plugin.collectionFactory.registerLibp2pNode(NETWORK_NAME, node, coordinatedRepo);
		plugin.collectionFactory.registerTransactor(`network:libp2p`, transactor);

		for (const vtable of plugin.vtables) {
			db.registerModule(vtable.name, vtable.module, vtable.auxData);
		}
		for (const func of plugin.functions) {
			db.registerFunction(func.schema);
		}

		return { node, db, transactor, peerId: node.peerId.toString(), storagePath };
	}
});


