/**
 * Network change notification for a tagged table, over REAL libp2p.
 *
 * A table declared `with tags ("optimystic.network_watch" = true)` subscribes through its node's
 * cohort-topic watch service (`node.reactivityWatch`), so its `Database.watch` consumers wake when
 * ANOTHER machine commits to it — not only when this machine's own storage applies the commit.
 *
 * Three real nodes, every one in every cohort (`clusterSize` = `wantK` = 3): the only configuration
 * in which announcements verify today (blocked
 * `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`). Each node drives its own
 * plugin over the node it was handed through `registerLibp2pNode`. The watching node's
 * `blockChangeNotifier` is replaced with an inert one before registration, so a wake there cannot
 * have come from its storage listener; and every tail read the watch service makes on the watcher
 * is counted, so a wake its fallback check produced is told apart from one a notification produced.
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1:
 *   yarn workspace @optimystic/quereus-plugin-optimystic test:integration
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { multiaddr } from '@multiformats/multiaddr';
import { Collection, reactivityCollectionTopicId, routingKeyForBlock, type IBlockChangeNotifier, type ITransactor } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import {
	createLibp2pNode,
	reactivityCollectionIdBytes,
	reactivityDirectSubscribers,
	type CohortTopicHost,
	type OptimysticNode,
} from '@optimystic/db-p2p';
import register from '../dist/plugin.js';
import type { ParsedOptimysticTreeOptions } from '../dist/index.js';

const NETWORK_NAME = 'network-change-notification-it';
const MACHINES = 3;
const WATCHED_URI = 'tree://network-watch/Watched';
const WATCHED_ID = 'network-watch/Watched';
const UNTAGGED_URI = 'tree://network-watch/Untagged';
/** How long a wake may take and still count; under the watch service's fallback tick (20 s Edge, 30 s Core). */
const WAKE_BOUND_MS = 10_000;

type Plugin = ReturnType<typeof register>;

interface Machine {
	readonly node: OptimysticNode;
	readonly db: Database;
	readonly plugin: Plugin;
}

const inertNotifier: IBlockChangeNotifier = { onCollectionChange: () => () => { } };

function pickLocalTcpMultiaddr(node: OptimysticNode): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
	return local;
}

/** The options the plugin resolves for a table on this network, which name its cached transactor. */
function networkOptions(collectionUri: string): ParsedOptimysticTreeOptions {
	return {
		collectionUri,
		transactor: 'network',
		keyNetwork: 'libp2p',
		libp2pOptions: { networkName: NETWORK_NAME, port: 0 },
		cache: false,
		encoding: 'json',
	};
}

describe('Network change notification for a tagged table over real libp2p', function () {
	this.timeout(420_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	const nodes: OptimysticNode[] = [];
	const machines: Machine[] = [];

	afterEach(async () => {
		for (const { db, plugin } of machines.splice(0, machines.length)) {
			await db.close();
			await plugin.dispose();
		}
		await Promise.allSettled(nodes.splice(0, nodes.length).map(n => n.stop()));
	});

	async function spawnNode(bootstrapNodes: string[]): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes,
			fretProfile: bootstrapNodes.length === 0 ? 'edge' : 'core',
			clusterSize: MACHINES,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			cohortTopic: { enabled: true, wantK: MACHINES, host: { minSigs: MACHINES - 1 } },
		});
		nodes.push(node);
		return node;
	}

	/** Every node connected to every other, and each assembling the whole mesh as a block's cohort. */
	async function stabilizedMesh(): Promise<void> {
		const seed = await spawnNode([]);
		const seedAddr = pickLocalTcpMultiaddr(seed);
		for (let i = 1; i < MACHINES; i++) {
			await spawnNode([seedAddr]);
		}
		const addrs = nodes.map(pickLocalTcpMultiaddr);
		for (const n of nodes) {
			for (const addr of addrs) {
				try { await n.dial(multiaddr(addr)); } catch { /* self, or a peer that already dialed us */ }
			}
		}
		await waitFor(() => nodes.every(n => n.getPeers().length >= MACHINES - 1), { timeoutMs: 60_000, intervalMs: 250, description: 'the mesh fully connected' });
		await waitFor(async () => {
			for (const n of nodes) {
				if (Object.keys(await n.keyNetwork.findCluster(routingKeyForBlock('network-watch-probe'))).length !== MACHINES) return false;
			}
			return true;
		}, { timeoutMs: 90_000, intervalMs: 500, description: 'every node assembles the whole mesh as a cohort' });
	}

	/** A Database whose plugin runs over `node`. */
	function machineOver(node: OptimysticNode): Machine {
		const db = new Database();
		const plugin = register(db, { default_network_name: NETWORK_NAME, default_key_network: 'libp2p', enable_cache: false });
		plugin.collectionFactory.registerLibp2pNode(NETWORK_NAME, node, node.coordinatedRepo);
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);
		const machine = { node, db, plugin };
		machines.push(machine);
		return machine;
	}

	/** Count the tail reads the watch service makes through `transactor`, until the returned restore runs. */
	function countTailReads(transactor: ITransactor): { reads: { started: number; finished: number }; restore: () => void } {
		const reads = { started: 0, finished: 0 };
		const original = Collection.readCommittedTail;
		Collection.readCommittedTail = async (through, id, knownTailId) => {
			const counted = through === transactor;
			if (counted) reads.started++;
			try {
				return await original.call(Collection, through, id, knownTailId);
			} finally {
				if (counted) reads.finished++;
			}
		};
		return { reads, restore: () => { Collection.readCommittedTail = original; } };
	}

	it("wakes a tagged table's watch when another machine commits, and leaves an untagged sibling asleep", async () => {
		await stabilizedMesh();
		const [writerNode, watcherNode, thirdNode] = nodes as [OptimysticNode, OptimysticNode, OptimysticNode];
		watcherNode.blockChangeNotifier = inertNotifier;
		const writer = machineOver(writerNode);
		const watcher = machineOver(watcherNode);
		const third = machineOver(thirdNode);

		for (const { db } of [writer, watcher, third]) {
			await db.exec(`create table Watched (id integer primary key, v text) using optimystic('${WATCHED_URI}') with tags ("optimystic.network_watch" = true)`);
			await db.exec(`create table Untagged (id integer primary key, v text) using optimystic('${UNTAGGED_URI}')`);
		}
		// The watch anchors on the log's tail block, so the collection has to have committed once.
		await writer.db.exec(`insert into Watched (id, v) values (1, 'before the watch attached')`);
		await writer.db.exec(`insert into Untagged (id, v) values (1, 'before the watch attached')`);

		const watchService = watcherNode.reactivityWatch!;
		// The first attach to a new topic is deferred by the cohort and lands on the service's next tick.
		await waitFor(() => watchService.isAttached(WATCHED_ID), { timeoutMs: 180_000, intervalMs: 250, description: "the watcher's table registered with its topic cohort" });

		// Only the node that coordinates a commit announces it, to the registrations its own cohort engine
		// holds; the watcher's reaches the writer over cohort gossip unless the writer is the topic's primary.
		const watcherTransactor = await watcher.plugin.collectionFactory.getOrCreateTransactor(networkOptions(WATCHED_URI));
		const topicId = reactivityCollectionTopicId(reactivityCollectionIdBytes(WATCHED_ID));
		const writerHost = (writerNode as unknown as { cohortTopicHost: CohortTopicHost }).cohortTopicHost;
		await waitFor(() => {
			const engine = writerHost.registry.findServing(topicId, 0);
			return engine !== undefined && reactivityDirectSubscribers(engine, topicId).includes(watcherNode.peerId.toString());
		}, { timeoutMs: 60_000, intervalMs: 250, description: "the watcher's registration replicated to the announcing node" });

		const wakes = { watched: 0, untagged: 0 };
		const watchedSub = watcher.db.watch(watcher.db.prepare('select * from Watched').getChangeScope(), () => { wakes.watched++; });
		const untaggedSub = watcher.db.watch(watcher.db.prepare('select * from Untagged').getChangeScope(), () => { wakes.untagged++; });
		const { reads, restore } = countTailReads(watcherTransactor);
		try {
			// A wake proves the notification path only if no tail read on the watcher can account for it, so
			// an attempt during which the service read the tail is repeated. So is one with no wake at all:
			// the announcing node verifies its notification against the topic cohort's membership
			// certificate, which a newly formed cohort publishes on its next gossip round.
			let wokeByNotification = false;
			for (let attempt = 0; attempt < 4 && !wokeByNotification; attempt++) {
				await waitFor(() => reads.started === reads.finished, { timeoutMs: 30_000, intervalMs: 50, description: 'no tail read in flight' });
				const readsBeforeCommit = reads.started;
				const wakesBeforeCommit = wakes.watched;
				await writer.db.exec(`insert into Watched (id, v) values (${attempt + 2}, 'after the watch attached')`);
				try {
					await waitFor(() => wakes.watched > wakesBeforeCommit, { timeoutMs: WAKE_BOUND_MS, intervalMs: 50, description: 'the watch woke' });
				} catch {
					continue;
				}
				wokeByNotification = reads.started === readsBeforeCommit;
			}
			expect(wokeByNotification, "a commit on another machine woke the tagged table's watch with no tail read between the commit and the wake").to.equal(true);

			await writer.db.exec(`insert into Untagged (id, v) values (2, 'after the watch attached')`);
			await new Promise(resolve => setTimeout(resolve, WAKE_BOUND_MS));
			expect(wakes.untagged, 'an untagged table has only the (inert) local listener, so nothing wakes it').to.equal(0);
		} finally {
			restore();
			watchedSub.unsubscribe();
			untaggedSub.unsubscribe();
		}
	});
});
