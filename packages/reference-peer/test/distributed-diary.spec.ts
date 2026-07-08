import { expect } from 'chai';
import {
	createLibp2pNode,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	RepoClient
} from '@optimystic/db-p2p';
import { Diary, NetworkTransactor } from '@optimystic/db-core';
import { waitForValue, delay } from '@optimystic/db-core/test';

interface TestNode {
	node: any;
	storageRepo: StorageRepo;
	transactor: NetworkTransactor;
	peerId: string;
}

/**
 * Poll `diary`, refreshing it from the network each round, until it holds at least
 * `count` entries; return them. Bounded so stalled replication fails fast with a
 * descriptive message instead of a fixed sleep that asserts on stale state.
 */
async function waitForEntries(diary: any, count: number, description: string): Promise<any[]> {
	return waitForValue(async () => {
		await diary.update();
		const entries: any[] = [];
		for await (const entry of diary.select()) entries.push(entry);
		return entries.length >= count ? entries : undefined;
	}, { timeoutMs: 30_000, intervalMs: 200, description });
}

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

		// Wait for FRET convergence on all nodes
		console.log('\n⏳ Waiting for FRET convergence...');
		const targetPeers = MESH_SIZE - 1; // Each node should know about all other nodes
		const convergenceTimeout = 30000; // 30 seconds max

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const fret = (node.node as any).services?.fret;
			if (!fret || typeof fret.listPeers !== 'function') {
				console.log(`   Node ${i + 1}: FRET not available, skipping convergence check`);
				continue;
			}

			const start = Date.now();
			let lastCount = 0;
			while (Date.now() - start < convergenceTimeout) {
				const peers = fret.listPeers();
				const count = Array.isArray(peers) ? peers.length : 0;
				if (count !== lastCount) {
					console.log(`   Node ${i + 1}: FRET discovered ${count}/${targetPeers} peers`);
					lastCount = count;
				}
				if (count >= targetPeers) {
					break;
				}
				await delay(500);
			}
		}

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
					} catch (err) {
						console.log(`   Node ${i + 1} -> Node ${j + 1}: Failed to connect - ${(err as Error).message}`);
					}
				}
			}
		}

		// Wait for connections to stabilize
		await delay(1000);

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

		expect(diary1).to.exist;
		expect(diary2).to.exist;
	});

	it('should distribute diary entries across all nodes', async () => {
		const diaryName = 'shared-diary-' + Date.now();

		console.log(`\n📝 Test: Distribute entries for "${diaryName}"`);

		// Create diary on node 1
		console.log('Creating diary on Node 1...');
		const diary1 = await Diary.create(nodes[0]!.transactor, diaryName);

		// Add entries from different nodes with timestamps for uniqueness
		const entries = [
			{ content: 'Entry from Node 1', author: nodes[0]!.peerId, timestamp: Date.now() },
			{ content: 'Entry from Node 2', author: nodes[1]!.peerId, timestamp: Date.now() + 1 },
			{ content: 'Entry from Node 3', author: nodes[2]!.peerId, timestamp: Date.now() + 2 }
		];

		console.log('Adding entry from Node 1...');
		await diary1.append(entries[0]!);

		// Open diary on node 2; wait until Node 1's entry has propagated before appending,
		// so the three entries land in a deterministic (Node 1, 2, 3) order.
		console.log('Opening diary on Node 2 and adding entry...');
		const diary2 = await Diary.create(nodes[1]!.transactor, diaryName);
		await waitForEntries(diary2, 1, "Node 2 should see Node 1's entry before appending");
		await diary2.append(entries[1]!);

		// Open diary on node 3; wait until both prior entries have propagated before appending.
		console.log('Opening diary on Node 3 and adding entry...');
		const diary3 = await Diary.create(nodes[2]!.transactor, diaryName);
		await waitForEntries(diary3, 2, 'Node 3 should see the first two entries before appending');
		await diary3.append(entries[2]!);

		// Re-open diary on node 1 to get fresh state from the network; poll until all 3 land.
		console.log('Reading all entries from Node 1...');
		const diary1Fresh = await Diary.create(nodes[0]!.transactor, diaryName);
		const readEntries = await waitForEntries(diary1Fresh, 3, 'Node 1 should read all three distributed entries');
		for (const typedEntry of readEntries as any[]) {
			console.log(`   - ${typedEntry.content} (ts: ${typedEntry.timestamp})`);
		}

		expect(readEntries).to.have.lengthOf(3);
		expect(readEntries[0]!.content).to.equal('Entry from Node 1');
		expect(readEntries[1]!.content).to.equal('Entry from Node 2');
		expect(readEntries[2]!.content).to.equal('Entry from Node 3');

		console.log('✅ All entries distributed correctly');
	});

	it('should verify storage consistency across nodes', async () => {
		const diaryName = 'consistency-test-' + Date.now();

		console.log(`\n📝 Test: Verify storage consistency for "${diaryName}"`);

		// Create and populate diary
		const diary = await Diary.create(nodes[0]!.transactor, diaryName);
		await diary.append({ content: 'Test entry', timestamp: new Date().toISOString() });

		// Read from all nodes and verify — poll each node until the entry replicates.
		console.log('Verifying entries on all nodes...');
		for (let i = 0; i < nodes.length; i++) {
			const nodeDiary = await Diary.create(nodes[i]!.transactor, diaryName);
			const entries = await waitForEntries(nodeDiary, 1, `Node ${i + 1} should replicate the entry`);
			console.log(`   Node ${i + 1}: ${entries.length} entries`);
			expect(entries).to.have.lengthOf(1);
			expect(entries[0]!.content).to.equal('Test entry');
		}

		console.log('✅ Storage consistent across all nodes');
	});

	it('should handle concurrent writes from multiple nodes', async () => {
		const diaryName = 'concurrent-test-' + Date.now();

		console.log(`\n📝 Test: Concurrent writes to "${diaryName}"`);

		// Create diary on Node 1 first, then have other nodes open it
		// This ensures all nodes work with the SAME header block
		console.log('Creating diary on Node 1...');
		const diary1 = await Diary.create(nodes[0]!.transactor, diaryName);

		// Wait for the diary header to be available to cluster peers
		console.log('Waiting for diary to propagate...');
		await delay(500);

		// Other nodes open the diary (should fetch header from cluster)
		console.log('Opening diary on other nodes...');
		const diary2 = await Diary.create(nodes[1]!.transactor, diaryName);
		const diary3 = await Diary.create(nodes[2]!.transactor, diaryName);
		const diaries = [diary1, diary2, diary3];

		// Write concurrently from all nodes - track errors
		console.log('Writing concurrently from all nodes...');
		const results = await Promise.allSettled(
			diaries.map((diary, i) =>
				diary.append({
					content: `Concurrent entry from Node ${i + 1}`,
					timestamp: new Date().toISOString()
				})
			)
		);

		// Log any failures
		results.forEach((result, i) => {
			if (result.status === 'rejected') {
				console.log(`   ⚠️ Node ${i + 1} write failed: ${result.reason?.message || result.reason}`);
			} else {
				console.log(`   ✅ Node ${i + 1} write succeeded`);
			}
		});

		// Count successful writes, then wait for convergence — poll Node 1 (refreshing
		// from the network) until every successful write appears in its log. Only
		// successful appends add entries, so the count converges upward to this bound.
		console.log('Verifying all writes succeeded...');
		const successfulWrites = results.filter(r => r.status === 'fulfilled').length;
		const finalEntries = await waitForValue(async () => {
			await diaries[0]!.update();  // Fetch latest state from network
			const entries: any[] = [];
			for await (const entry of diaries[0]!.select()) entries.push(entry);
			return entries.length >= successfulWrites ? entries : undefined;
		}, { timeoutMs: 30_000, intervalMs: 200, description: 'Node 1 should converge on all successful concurrent writes' });
		for (const typedEntry of finalEntries as any[]) {
			console.log(`   - ${typedEntry.content}`);
		}
		console.log(`   Total entries: ${finalEntries.length}, Expected: ${successfulWrites} concurrent writes`);

		// At minimum, at least one concurrent write should succeed
		expect(finalEntries.length).to.be.at.least(1, 'At least one write should succeed');
		expect(finalEntries.length).to.equal(successfulWrites, 'All successful writes should appear in log');

		console.log('✅ Concurrent writes handled correctly');
	});

	async function createNode(port: number, bootstrapNodes: string[]): Promise<TestNode> {
		const node = await createLibp2pNode({
			port,
			bootstrapNodes,
			networkName: NETWORK_NAME,
			storage: () => new MemoryRawStorage(),
			fretProfile: 'edge',
			clusterSize: MESH_SIZE,
			clusterPolicy: {
				superMajorityThreshold: 0.51  // Simple majority for small test clusters
			},
			arachnode: {
				enableRingZulu: true
			}
		});

		const rawStorage = new MemoryRawStorage();
		const storageRepo = new StorageRepo((blockId: string) =>
			new BlockStorage(blockId, rawStorage)
		);

		const keyNetwork = (node as any).keyNetwork;
		const coordinatedRepo = (node as any).coordinatedRepo;

		if (!coordinatedRepo) {
			throw new Error('coordinatedRepo not available on node');
		}

		const transactor = new NetworkTransactor({
			timeoutMs: 30000,
			abortOrCancelTimeoutMs: 10000,
			keyNetwork,
			getRepo: (peerId) => {
				return peerId.toString() === node.peerId.toString()
					? coordinatedRepo  // Use coordinated repo for self to enable cluster consensus
					: RepoClient.create(peerId, keyNetwork, `/optimystic/${NETWORK_NAME}`);
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

