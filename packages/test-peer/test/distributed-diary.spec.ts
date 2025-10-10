import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
	createLibp2pNode,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	Libp2pKeyPeerNetwork,
	RepoClient
} from '@optimystic/db-p2p';
import { Diary, NetworkTransactor } from '@optimystic/db-core';

interface TestNode {
	node: any;
	storageRepo: StorageRepo;
	transactor: NetworkTransactor;
	peerId: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Distributed Diary Operations', () => {
	const nodes: TestNode[] = [];
	const MESH_SIZE = 3;
	const BASE_PORT = 9000;
	const NETWORK_NAME = 'test-distributed-diary';

	before(async () => {
		console.log(`\n🚀 Starting ${MESH_SIZE}-node mesh for testing...\n`);

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

	it('should create diary on one node and access from another', async () => {
		const diaryName = 'test-diary-' + Date.now();

		console.log(`\n📝 Test: Create diary "${diaryName}" on Node 1`);

		// Create diary on node 1
		const diary1 = await Diary.create(nodes[0]!.transactor, diaryName);
		console.log('✅ Diary created on Node 1');

		// Wait for distribution
		await delay(1000);

		// Open same diary on node 2
		console.log('📖 Opening diary on Node 2...');
		const diary2 = await Diary.create(nodes[1]!.transactor, diaryName);
		console.log('✅ Diary opened on Node 2');

		assert.ok(diary1, 'Diary should be created on Node 1');
		assert.ok(diary2, 'Diary should be accessible from Node 2');
	});

	it('should distribute diary entries across all nodes', async () => {
		const diaryName = 'shared-diary-' + Date.now();

		console.log(`\n📝 Test: Distribute entries for "${diaryName}"`);

		// Create diary on node 1
		console.log('Creating diary on Node 1...');
		const diary1 = await Diary.create(nodes[0]!.transactor, diaryName);

		// Add entries from different nodes
		const entries = [
			{ content: 'Entry from Node 1', author: nodes[0]!.peerId },
			{ content: 'Entry from Node 2', author: nodes[1]!.peerId },
			{ content: 'Entry from Node 3', author: nodes[2]!.peerId }
		];

		console.log('Adding entry from Node 1...');
		await diary1.append(entries[0]!);
		await delay(500);

		// Open diary on node 2 and add entry
		console.log('Opening diary on Node 2 and adding entry...');
		const diary2 = await Diary.create(nodes[1]!.transactor, diaryName);
		await diary2.append(entries[1]!);
		await delay(500);

		// Open diary on node 3 and add entry
		console.log('Opening diary on Node 3 and adding entry...');
		const diary3 = await Diary.create(nodes[2]!.transactor, diaryName);
		await diary3.append(entries[2]!);
		await delay(1000);

		// Read from node 1 to verify all entries are visible
		console.log('Reading all entries from Node 1...');
		const readEntries: any[] = [];
		for await (const entry of diary1.select()) {
			const typedEntry = entry as any;
			readEntries.push(typedEntry);
			console.log(`   - ${typedEntry.content}`);
		}

		assert.strictEqual(readEntries.length, 3, 'Should have 3 entries');
		assert.strictEqual(readEntries[0]!.content, 'Entry from Node 1');
		assert.strictEqual(readEntries[1]!.content, 'Entry from Node 2');
		assert.strictEqual(readEntries[2]!.content, 'Entry from Node 3');

		console.log('✅ All entries distributed correctly');
	});

	it('should verify storage consistency across nodes', async () => {
		const diaryName = 'consistency-test-' + Date.now();

		console.log(`\n📝 Test: Verify storage consistency for "${diaryName}"`);

		// Create and populate diary
		const diary = await Diary.create(nodes[0]!.transactor, diaryName);
		await diary.append({ content: 'Test entry', timestamp: new Date().toISOString() });

		// Wait for distribution
		await delay(1500);

		// Read from all nodes and verify
		console.log('Verifying entries on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const testNode = nodes[i]!;
			const nodeDiary = await Diary.create(testNode.transactor, diaryName);

			const entries: any[] = [];
			for await (const entry of nodeDiary.select()) {
				entries.push(entry);
			}

			console.log(`   Node ${i + 1}: ${entries.length} entries`);
			assert.strictEqual(entries.length, 1, `Node ${i + 1} should have 1 entry`);
			assert.strictEqual(entries[0]!.content, 'Test entry');
		}

		console.log('✅ Storage consistent across all nodes');
	});

	it('should handle concurrent writes from multiple nodes', async () => {
		const diaryName = 'concurrent-test-' + Date.now();

		console.log(`\n📝 Test: Concurrent writes to "${diaryName}"`);

		// Create diary on all nodes
		const diaries = await Promise.all(
			nodes.map(n => Diary.create(n.transactor, diaryName))
		);

		console.log('Creating diary on all nodes...');
		await delay(500);

		// Write concurrently from all nodes
		console.log('Writing concurrently from all nodes...');
		await Promise.all(
			diaries.map((diary, i) =>
				diary.append({
					content: `Concurrent entry from Node ${i + 1}`,
					timestamp: new Date().toISOString()
				})
			)
		);

		// Wait for convergence
		await delay(2000);

		// Verify all writes succeeded
		console.log('Verifying all writes succeeded...');
		const finalEntries: any[] = [];
		for await (const entry of diaries[0]!.select()) {
			const typedEntry = entry as any;
			finalEntries.push(typedEntry);
			console.log(`   - ${typedEntry.content}`);
		}

		assert.strictEqual(
			finalEntries.length,
			MESH_SIZE,
			`Should have ${MESH_SIZE} entries from concurrent writes`
		);

		console.log('✅ Concurrent writes handled correctly');
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

		const transactor = new NetworkTransactor({
			timeoutMs: 30000,
			abortOrCancelTimeoutMs: 10000,
			keyNetwork,
			getRepo: (peerId) => {
				return peerId.toString() === node.peerId.toString()
					? storageRepo
					: RepoClient.create(peerId, keyNetwork);
			}
		});

		return {
			node,
			storageRepo,
			transactor,
			peerId: node.peerId.toString()
		};
	}
});

