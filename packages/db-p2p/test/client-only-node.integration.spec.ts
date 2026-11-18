import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import { Diary, NetworkTransactor, Tree, reactivityCollectionTopicId, routingKeyForBlock, type IRepo, type PendRequest } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { FindCoordinatorError } from '../src/libp2p-key-network.js';
import type { OptimysticClientNode, OptimysticNode } from '../src/optimystic-node.js';
import { RepoClient } from '../src/repo/client.js';
import { committedTailReader } from '../src/reactivity/collection-watch.js';
import { reactivityDirectSubscribers } from '../src/reactivity/forwarder-host.js';
import type { ReactivitySubscriberRegistry } from '../src/reactivity/subscriber-registry.js';
import { reactivityCollectionIdBytes } from '../src/reactivity/topic-bytes.js';
import type { CohortTopicHost } from '../src/cohort-topic/host.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';
import { sequentialPhases, transactorFor } from './util/two-machine-lifecycle.js';

// A client node (`servesBlocks: false`) on a real two-server network, end to end over TCP
// (docs/internals.md §Client nodes):
//
//  - it writes and reads through the servers, and both servers hold what it wrote;
//  - after that traffic no server puts it in a cohort or picks it to coordinate — the end-to-end
//    reproduction of the defect `a-peer-is-judged-serving-only-by-its-own-identify` fixed, where the
//    client's own repo requests made every server it talked to classify it as serving;
//  - one write, once the collection is open, costs the requests §Client nodes states;
//  - a watch it opens through `node.reactivityWatch` is woken by a server's commit over the notify socket;
//  - alone, with no serving machine to reach, it neither founds a collection nor reports one absent.
//
// Every node runs `clusterSize: 2`, so each block's cohort is both servers.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const NETWORK_NAME = 'client-only-node-it';
const PROTOCOL_PREFIX = `/optimystic/${NETWORK_NAME}`;
const TREE_ID = 'client-only-node-rows';
const SERVERS = 2;
const CLUSTER = { clusterSize: SERVERS, clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 } };
// Every node in every cohort-topic cohort, as in `substrate-real-libp2p.integration.spec.ts`'s watch case.
const COHORT_TOPIC = { enabled: true, wantK: SERVERS + 1, host: { minSigs: SERVERS } };

interface Row { key: number; value: string }
const keyOf = (row: Row): number => row.key;
const rowAt = (key: number): Row => ({ key, value: `row-${key}` });

/** One request a transactor made of a repo: the peer, the method, and for a pend the blocks it names. */
interface RepoCall { peer: string; method: string; blockIds: string[] }

function pendedBlockIds(method: string, request: unknown): string[] {
	if (method !== 'pend') return [];
	const { transforms } = request as PendRequest;
	return [...Object.keys(transforms.inserts ?? {}), ...Object.keys(transforms.updates ?? {}), ...(transforms.deletes ?? [])];
}

/** `repo`, the repo of `peer`, recording every method called on it in `calls`. */
function recorded(repo: IRepo, peer: string, calls: RepoCall[]): IRepo {
	return new Proxy(repo, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]): unknown => {
				const method = String(property);
				calls.push({ peer, method, blockIds: pendedBlockIds(method, args[0]) });
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		}
	});
}

/**
 * A transactor over a client, built as `CollectionFactory.createNetworkTransactor` builds one for a node
 * with no coordinated repo: every repo is a remote client, nothing is co-located (no `localPeerId`, no
 * `localChangeNotifier`), and the client's own clock mints. Every request is recorded in `calls`.
 */
function clientTransactor(client: OptimysticClientNode, calls: RepoCall[]): NetworkTransactor {
	const { dialTimeoutMs, transactionTimeoutMs, retryBackoffBaseMs } = client.linkDeadlines;
	return new NetworkTransactor({
		timeoutMs: transactionTimeoutMs,
		abortOrCancelTimeoutMs: Math.max(5_000, dialTimeoutMs),
		dialTimeoutMs,
		retryBackoffBaseMs,
		keyNetwork: client.keyNetwork,
		getRepo: (peerId) => {
			if (peerId.equals(client.peerId)) throw new Error('a client was picked to coordinate');
			return recorded(RepoClient.create(peerId, client.keyNetwork, PROTOCOL_PREFIX), peerId.toString(), calls);
		},
		clock: client.hlcClock,
	});
}

describe('A client node (servesBlocks: false) over real libp2p', function () {
	this.timeout(300_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	describe('beside two serving nodes', function () {
		let servers: OptimysticNode[] = [];
		let client: OptimysticClientNode | undefined;
		/** Every block the client's first write pended. */
		let written: string[] = [];

		sequentialPhases();

		after(async () => {
			await Promise.allSettled([...servers, client].filter(n => n !== undefined).map(n => n.stop()));
			servers = [];
			client = undefined;
		});

		const running = (): OptimysticClientNode => {
			if (!client) throw new Error('the client is not running');
			return client;
		};

		it('joins: each server and the client assemble both servers, and only them, as a cohort', async () => {
			const a = await createLibp2pNode({ port: 0, networkName: NETWORK_NAME, bootstrapNodes: [], fretProfile: 'edge', ...CLUSTER, cohortTopic: COHORT_TOPIC });
			servers.push(a);
			const seed = pickLocalTcpMultiaddr(a);
			servers.push(await createLibp2pNode({ port: 0, networkName: NETWORK_NAME, bootstrapNodes: [seed], fretProfile: 'core', ...CLUSTER, cohortTopic: COHORT_TOPIC }));
			client = await createLibp2pNode({ port: 0, networkName: NETWORK_NAME, bootstrapNodes: [seed], fretProfile: 'edge', servesBlocks: false, ...CLUSTER, cohortTopic: COHORT_TOPIC });
			expect(client.servesBlocks).to.equal(false);

			const all = [...servers, client];
			const addrs = all.map(pickLocalTcpMultiaddr);
			for (const node of all) {
				for (const addr of addrs) {
					try { await node.dial(multiaddr(addr)); } catch { /* self, or a peer that already dialed us */ }
				}
			}
			await waitFor(() => all.every(n => n.getPeers().length >= all.length - 1), { timeoutMs: 60_000, intervalMs: 250, description: 'the three nodes fully connected' });

			const serverIds = servers.map(s => s.peerId.toString()).sort();
			const probe = routingKeyForBlock('client-only-node-probe');
			await waitFor(async () => {
				for (const node of all) {
					if (JSON.stringify(Object.keys(await node.keyNetwork.findCluster(probe)).sort()) !== JSON.stringify(serverIds)) return false;
				}
				return true;
			}, { timeoutMs: 90_000, intervalMs: 500, description: 'every node assembles exactly the two servers as a cohort' });
		});

		it('writes and reads through the servers; both servers hold the write and one reads it', async () => {
			const calls: RepoCall[] = [];
			const tree = await Tree.createOrOpen<number, Row>(clientTransactor(running(), calls), TREE_ID, keyOf);
			await tree.replace([[1, rowAt(1)]]);
			written = [...new Set(calls.flatMap(c => c.blockIds))];
			expect(written, 'the write pended blocks').to.not.be.empty;

			const reopened = await Tree.open<number, Row>(clientTransactor(running(), []), TREE_ID, keyOf);
			expect(await reopened?.get(1), 'the client reads its row back through a fresh handle').to.deep.equal(rowAt(1));

			const onServer = await Tree.open<number, Row>(transactorFor(servers[0]!, NETWORK_NAME), TREE_ID, keyOf);
			expect(await onServer?.get(1), 'a server reads the row the client wrote').to.deep.equal(rowAt(1));

			for (const server of servers) {
				await waitFor(async () => {
					const held = await server.storageRepo.get({ blockIds: written });
					return written.every(id => held[id]?.state.latest !== undefined);
				}, { timeoutMs: 10_000, intervalMs: 100, description: `server ${server.peerId.toString()} holds every block the client wrote` });
			}
		});

		it('after that traffic, no server puts the client in a cohort or picks it to coordinate', async () => {
			const clientId = running().peerId.toString();
			for (const server of servers) {
				for (const blockId of written) {
					const key = routingKeyForBlock(blockId);
					const cohort = Object.keys(await server.keyNetwork.findCluster(key));
					expect(cohort, `server ${server.peerId.toString()}'s cohort for ${blockId}`).to.not.include(clientId);
					expect(cohort, `server ${server.peerId.toString()}'s cohort for ${blockId}`).to.have.length(SERVERS);
					for (const intent of ['read', 'write'] as const) {
						const coordinator = await server.keyNetwork.findCoordinator(key, { intent });
						expect(coordinator.toString(), `server ${server.peerId.toString()}'s ${intent} coordinator for ${blockId}`).to.not.equal(clientId);
					}
				}
			}
		});

		it('one write costs the client a refresh, a pend and a commit once its handle has read the leaf', async () => {
			const calls: RepoCall[] = [];
			const tree = await Tree.open<number, Row>(clientTransactor(running(), calls), TREE_ID, keyOf);
			expect(tree, 'the client opens the collection').to.not.equal(undefined);
			// The first write on a fresh handle also reads the leaf it changes; the write after it does not.
			await tree!.replace([[2, rowAt(2)]]);
			calls.length = 0;
			await tree!.replace([[4, rowAt(4)]]);
			// The numbers docs/internals.md §Client nodes states. A read goes out as one request per coordinator
			// its blocks fall on, so the refresh, which reads the collection header and the log tail, is two
			// requests when the two are coordinated by different servers.
			const made = calls.map(c => c.method);
			const gets = made.filter(m => m === 'get').length;
			expect(made.filter(m => m !== 'get'), `the requests one write made: ${made.join(', ')}`).to.deep.equal(['pend', 'commit']);
			expect(gets, `the refresh requests one write made: ${made.join(', ')}`).to.be.within(1, 2);
		});

		it('a watch opened through the client wakes when a server commits, over the notify socket', async () => {
			const watch = running().reactivityWatch;
			expect(watch, 'a cohortTopic-enabled client exposes the watch service').to.not.equal(undefined);
			const clientId = running().peerId.toString();
			const topicId = reactivityCollectionTopicId(reactivityCollectionIdBytes(TREE_ID));
			// The frames the client's subscriber registry receives for the collection's topic: a client stores
			// nothing, so its watch service has no local feed, and only a delivered frame shows the commit reached
			// it over the notify socket rather than through the service's own periodic tail read.
			let delivered = 0;
			const offCount = (running() as unknown as { reactivitySubscribers: ReactivitySubscriberRegistry }).reactivitySubscribers.register(topicId, () => { delivered++; });
			let wakes = 0;
			const handle = watch!.watch({
				collectionId: TREE_ID,
				tails: committedTailReader(clientTransactor(running(), [])),
				onChange: () => { wakes++; },
			});
			try {
				await waitFor(() => wakes >= 1, { timeoutMs: 30_000, intervalMs: 100, description: 'the first remote tail read woke the watch' });
				await waitFor(() => watch!.isAttached(TREE_ID), { timeoutMs: 120_000, intervalMs: 250, description: 'the client registered with the root group through the real register walk' });
				// Either server may announce the commit, to the registrations its own root engine holds; the
				// client's reaches the one it did not register with over cohort gossip.
				for (const server of servers) {
					const host = (server as unknown as { cohortTopicHost: CohortTopicHost }).cohortTopicHost;
					await waitFor(() => {
						const engine = host.registry.findServing(topicId, 0);
						return engine !== undefined && reactivityDirectSubscribers(engine, topicId).includes(clientId);
					}, { timeoutMs: 60_000, intervalMs: 250, description: `server ${server.peerId.toString()} holds the client's registration` });
				}

				// A notification is verified against the root group's membership certificate, which a newly formed
				// group publishes on its next gossip round, so an attempt with no frame is repeated.
				let wokeByNotification = false;
				for (let attempt = 0; attempt < 4 && !wokeByNotification; attempt++) {
					const wakesBefore = wakes;
					const deliveredBefore = delivered;
					const serverTree = await Tree.open<number, Row>(transactorFor(servers[attempt % SERVERS]!, NETWORK_NAME), TREE_ID, keyOf);
					await serverTree!.replace([[10 + attempt, rowAt(10 + attempt)]]);
					try {
						await waitFor(() => wakes > wakesBefore && delivered > deliveredBefore, { timeoutMs: 10_000, intervalMs: 50, description: 'the watch woke and the notification arrived' });
						wokeByNotification = true;
					} catch {
						// Repeated, below.
					}
				}
				expect(wokeByNotification, "a server's commit reached the client over the notify socket and woke its watch").to.equal(true);
			} finally {
				offCount();
				await handle.close();
			}
		});
	});

	describe('alone, with no serving machine to reach', function () {
		let lone: OptimysticClientNode | undefined;

		after(async () => {
			await lone?.stop();
			lone = undefined;
		});

		it('neither founds a collection nor reports one absent: both fail with FindCoordinatorError', async () => {
			lone = await createLibp2pNode({ port: 0, networkName: 'client-only-node-lone-it', bootstrapNodes: [], servesBlocks: false, ...CLUSTER });
			const transactor = clientTransactor(lone, []);

			const created = await Diary.createOrOpen<string>(transactor, 'lone-client-diary').then(() => undefined, (err: unknown) => err);
			expect(created, 'createOrOpen rejects rather than inventing a collection').to.be.instanceOf(FindCoordinatorError);

			const opened = await Diary.open<string>(transactor, 'lone-client-diary').then(diary => ({ resolved: diary }), (err: unknown) => ({ rejected: err }));
			expect(opened, 'open rejects rather than resolving undefined').to.have.property('rejected').that.is.instanceOf(FindCoordinatorError);
		});
	});
});
