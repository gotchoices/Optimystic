#!/usr/bin/env node
/**
 * Quick test script for debugging distributed diary operations
 * Run with: node --inspect-brk dist/test/quick-test.js
 * Or from VS Code with the provided launch configuration
 */

import {
	createLibp2pNode,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	Libp2pKeyPeerNetwork,
	RepoClient
} from '@optimystic/db-p2p';
import net from 'node:net';
import { Diary, NetworkTransactor } from '@optimystic/db-core';

interface TestNode {
	node: any;
	storageRepo: StorageRepo;
	transactor: NetworkTransactor;
	peerId: string;
	port: number;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const ok = await new Promise<boolean>((resolve) => {
			const server = net.createServer();
			server.once('error', () => { resolve(false); });
			server.listen({ host: '0.0.0.0', port }, () => {
				server.close(() => resolve(true));
			});
		});
		if (ok) return true;
		await delay(100);
	}
	return false;
}

async function findOpenPort(startPort: number, maxTries = 50): Promise<number> {
	let p = startPort;
	for (let i = 0; i < maxTries; i++, p++) {
		if (await waitPortFree(p, 250)) return p;
	}
	throw new Error(`No free port found starting at ${startPort}`);
}

async function createNode(port: number, bootstrapNodes: string[]): Promise<TestNode> {
	console.log(`🔧 Creating node on port ${port}...`);

	const node = await createLibp2pNode({
		port,
		bootstrapNodes,
		networkName: 'quick-test',
		storage: () => new MemoryRawStorage(),
		fretProfile: 'edge',
		clusterSize: 3,
		clusterPolicy: {
			superMajorityThreshold: 0.51  // Simple majority for small test clusters
		},
		arachnode: {
			enableRingZulu: true
		}
	});

	const coordinatedRepo = (node as any).coordinatedRepo;
	const keyNetwork = (node as any).keyNetwork;

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
				: RepoClient.create(peerId, keyNetwork, '/optimystic/quick-test');
		}
	});

	const peerId = node.peerId.toString();
	console.log(`✅ Node created: ${peerId.slice(0, 8)}... on port ${port}`);
	console.log(`   Multiaddrs:`);
	node.getMultiaddrs().forEach((ma: any) => console.log(`     ${ma.toString()}`));

	return {
		node,
		storageRepo: (node as any).storageRepo,
		transactor,
		peerId,
		port
	};
}

async function main() {
	console.log('\n🚀 Starting Quick Test: Distributed Diary Operations\n');
	console.log('================================================\n');

    const MESH_SIZE = Number(process.env.MESH_NODES ?? 3);
    const BASE_PORT = Number(process.env.MESH_BASE_PORT ?? 9100);
	const nodes: TestNode[] = [];

	try {
		// Step 1: Start the mesh
		console.log(`📡 Step 1: Starting ${MESH_SIZE}-node mesh\n`);

		// Pick free contiguous ports
		const p1 = await findOpenPort(BASE_PORT);
		const p2 = await findOpenPort(p1 + 1);
		const p3 = await findOpenPort(p2 + 1);
		const ports = [p1, p2, p3].slice(0, MESH_SIZE);

		// Start bootstrap node
		const node1 = await createNode(ports[0]!, []);
		nodes.push(node1);

		// Get bootstrap addresses
		const bootstrapAddrs = node1.node.getMultiaddrs().map((ma: any) => ma.toString());
		console.log(`\n🔗 Bootstrap addresses:`);
		bootstrapAddrs.forEach((addr: string) => console.log(`   ${addr}`));
		console.log('');

		// Start remaining nodes
		for (let i = 1; i < MESH_SIZE; i++) {
			const port = ports[i] ?? (await findOpenPort(ports[i - 1]! + 1));
			const node = await createNode(port, bootstrapAddrs);
			nodes.push(node);
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
				await delay(200);
			}
			const finalPeers = fret.listPeers();
			console.log(`   ✅ Node ${i + 1}: FRET knows ${finalPeers.length} peer(s)`);
		}

		// Ensure full mesh connectivity - dial all known peers
		console.log('\n🔗 Ensuring full mesh connectivity...');
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
		console.log('\n📊 Network Status:');
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const connections = node.node.getConnections();
			const peerIds = connections.map((c: any) => c.remotePeer.toString().slice(0, 8)).join(', ');
			console.log(`   Node ${i + 1} (port ${node.port}): ${connections.length} connections [${peerIds}]`);
		}

		// Step 2: Create diary on node 1
		console.log('\n📝 Step 2: Creating diary on Node 1\n');
		const diaryName = 'test-diary-' + Date.now();
		console.log(`   Diary name: ${diaryName}`);

		const diary1 = await Diary.create(nodes[0]!.transactor, diaryName);
		console.log(`   ✅ Diary created on Node 1`);

		// Step 3: Add entry from node 1
		console.log('\n📝 Step 3: Adding entry from Node 1\n');
		await diary1.append({
			content: 'First entry from Node 1',
			timestamp: new Date().toISOString(),
			author: nodes[0]!.peerId.slice(0, 8)
		});
		console.log(`   ✅ Entry added from Node 1`);

		// Wait for distribution
		await delay(1000);

		// Step 4: Open diary on node 2 and add entry
		console.log('\n📝 Step 4: Opening diary on Node 2 and adding entry\n');
		const diary2 = await Diary.create(nodes[1]!.transactor, diaryName);
		console.log(`   ✅ Diary opened on Node 2`);

		await diary2.append({
			content: 'Second entry from Node 2',
			timestamp: new Date().toISOString(),
			author: nodes[1]!.peerId.slice(0, 8)
		});
		console.log(`   ✅ Entry added from Node 2`);

		// Wait for distribution
		await delay(1000);

		// Step 5: Open diary on node 3 and add entry
		console.log('\n📝 Step 5: Opening diary on Node 3 and adding entry\n');
		const diary3 = await Diary.create(nodes[2]!.transactor, diaryName);
		console.log(`   ✅ Diary opened on Node 3`);

		await diary3.append({
			content: 'Third entry from Node 3',
			timestamp: new Date().toISOString(),
			author: nodes[2]!.peerId.slice(0, 8)
		});
		console.log(`   ✅ Entry added from Node 3`);

		// Wait for final distribution
		await delay(1500);

		// Step 6: Verify entries on all nodes
		console.log('\n📖 Step 6: Verifying entries on all nodes\n');

		for (let i = 0; i < nodes.length; i++) {
			const testNode = nodes[i]!;
			const nodeDiary = await Diary.create(testNode.transactor, diaryName);

			console.log(`\n   📚 Node ${i + 1} (port ${testNode.port}):`);
			const entries: any[] = [];
			for await (const entry of nodeDiary.select()) {
				const typedEntry = entry as any;
				entries.push(typedEntry);
				console.log(`      ${entries.length}. ${typedEntry.content} (from ${typedEntry.author})`);
			}

			if (entries.length === 0) {
				console.log(`      ⚠️  No entries found!`);
			} else if (entries.length !== 3) {
				console.log(`      ⚠️  Expected 3 entries, found ${entries.length}`);
			} else {
				console.log(`      ✅ All entries present`);
			}
		}

		// Step 7: Summary
		console.log('\n================================================');
		console.log('✅ Test completed successfully!');
		console.log('================================================\n');

	} catch (error) {
		console.error('\n❌ Test failed with error:');
		console.error(error);
		throw error;
	} finally {
		// Cleanup
		console.log('\n🛑 Stopping all nodes...');
		for (const node of nodes) {
			try {
				await node.node.stop();
				console.log(`   ✅ Node on port ${node.port} stopped`);
			} catch (error) {
				console.error(`   ❌ Error stopping node on port ${node.port}:`, error);
			}
		}
		console.log('\n✅ Cleanup complete\n');
	}
}

void main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

