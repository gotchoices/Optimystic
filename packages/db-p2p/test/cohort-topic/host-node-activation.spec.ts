import { expect } from 'chai';
import {
	Tree,
	NetworkTransactor,
	type ITransactor,
	type IRepo,
	type PeerId as DbPeerId,
	type CollectionChangeEvent,
	type CommitCert,
} from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { createLibp2pNode } from '../../src/libp2p-node.js';
import { Libp2pKeyPeerNetwork } from '../../src/libp2p-key-network.js';
import { RepoClient } from '../../src/repo/client.js';

interface TestEntry { key: number; value: string; }

// --- Integration: real solo libp2p node, host activation on the commit path ---

describe('cohort-topic host node activation (real libp2p, solo forming node)', function () {
	// Real libp2p boot + FRET seeding dominate; ops finish in seconds.
	this.timeout(40_000);

	// Build a NetworkTransactor over a single real node (mirrors fresh-node-ddl-libp2p). Solo, so
	// getRepo always resolves to the node's own coordinatedRepo; the RepoClient branch never fires.
	const buildSoloTransactor = (node: any, networkName: string): ITransactor => {
		const coordinatedRepo = node.coordinatedRepo as IRepo;
		if (!coordinatedRepo) throw new Error('coordinatedRepo not created');
		// The node's OWN key network (see OptimysticNodeAttachments). Building a second one from
		// constructor defaults would give selection a different cohort width and no network filter.
		const keyNetwork = node.keyNetwork as Libp2pKeyPeerNetwork;
		const protocolPrefix = `/optimystic/${networkName}`;
		const getRepo = (peerId: PeerId): IRepo => {
			if (peerId.toString() === node.peerId.toString()) return coordinatedRepo;
			return RepoClient.create(peerId, keyNetwork, protocolPrefix);
		};
		return new NetworkTransactor({
			timeoutMs: 10_000,
			abortOrCancelTimeoutMs: 5_000,
			keyNetwork: keyNetwork as any,
			getRepo: getRepo as (peerId: DbPeerId) => IRepo,
		});
	};

	it('disabled by default: blockChangeNotifier is the bare StorageRepo and no host is built', async () => {
		const node: any = await createLibp2pNode({
			port: 0,
			networkName: 'cohort-activation-off',
			bootstrapNodes: [],
			fretProfile: 'edge',
			arachnode: { enableRingZulu: false },
		});
		try {
			expect(node.cohortTopicHost, 'no host constructed when disabled').to.equal(undefined);
			const notifier = node.blockChangeNotifier;
			expect(notifier, 'a notifier is still exposed').to.not.equal(undefined);
			// The bare StorageRepo is the notifier and exposes BOTH the per-collection subscribe and the
			// catch-all feed; the origination bridge decorator (enabled path) exposes only onCollectionChange.
			expect(node.blockChangeNotifier, 'notifier is the bare StorageRepo').to.equal(node.storageRepo);
			expect(typeof notifier.onCollectionChange).to.equal('function');
			expect(typeof notifier.onAnyCollectionChange, 'bare StorageRepo exposes the catch-all feed').to.equal('function');
		} finally {
			await node.stop();
		}
	});

	it('enabled: the bridge is live on the commit path and the commit applies its tail here (solo node is cert-gated)', async () => {
		const networkName = 'cohort-activation-on';
		const node: any = await createLibp2pNode({
			port: 0,
			networkName,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			cohortTopic: { enabled: true },
		});
		try {
			const host = node.cohortTopicHost;
			expect(host, 'host constructed when enabled').to.not.equal(undefined);

			// The origination bridge decorator (not the bare StorageRepo) is now the notifier.
			expect(node.blockChangeNotifier, 'bridge replaces the bare notifier').to.not.equal(node.storageRepo);
			expect(typeof node.blockChangeNotifier.onAnyCollectionChange, 'bridge decorator hides the catch-all feed').to.equal('undefined');
			expect(typeof node.blockChangeNotifier.onCollectionChange, 'per-collection delegation preserved').to.equal('function');

			// Observe commits directly on the underlying StorageRepo (independent of the bridge gate) to
			// capture the real committed change events, and probe the origination hook the bridge would invoke.
			const observed: CollectionChangeEvent[] = [];
			node.storageRepo.onAnyCollectionChange((e: CollectionChangeEvent): void => { observed.push(e); });
			const originated: { event: CollectionChangeEvent; cert: CommitCert }[] = [];
			host.service.onLocalCommit = (event: CollectionChangeEvent, cert: CommitCert): void => { originated.push({ event, cert }); };

			// Drive a real commit through the production stack (StorageRepo + CoordinatorRepo + NetworkTransactor).
			const transactor = buildSoloTransactor(node, networkName);
			const tree = await Tree.createOrOpen<number, TestEntry>(transactor, 'reactivity-activation-tree', e => e.key);
			await tree.replace([[1, { key: 1, value: 'first' }]]);

			// 1. The commit-path change event carries a REAL collection tail id — proving the tailId now
			//    flows end-to-end (NetworkTransactor → per-block RepoCommitRequest → CoordinatorRepo →
			//    StorageRepo.commit), which the reactivity topic anchor depends on.
			expect(observed.length, 'a commit-path change event fired').to.be.greaterThan(0);
			const withTail = observed.find((e) => e.tailId !== undefined);
			expect(withTail, 'the committed change event carried a real tail id').to.not.equal(undefined);

			// 2. The event lists the tail among the blocks this node applied — the bridge's origination gate
			//    (`selfAppliedTail`): a solo node stores the tail, so it is in the announcing group and the
			//    gate passes origination through (it is not short-circuiting).
			expect(withTail!.blockIds, 'the commit applied its tail on this node').to.include(withTail!.tailId);

			// 3. A solo node never reaches cluster consensus — the coordinator commits locally when the
			//    cluster is <= 1 peer, so onCommitCertificate never fires and NO authoritative cert exists.
			//    The bridge therefore correctly cert-gates origination to a no-op (it never fabricates an
			//    unsigned cert). The cert-bearing onLocalCommit delivery itself is proven with real
			//    components in change-bridge.spec.ts, and end-to-end with real consensus in the multi-node
			//    tier (14-substrate-e2e-real-libp2p-tier).
			expect(originated.length, 'no consensus cert on a solo node → origination correctly no-ops').to.equal(0);
		} finally {
			await node.stop();
		}
	});

	it('teardown: node.stop() releases the bridge subscription and stops the host', async () => {
		const node: any = await createLibp2pNode({
			port: 0,
			networkName: 'cohort-activation-teardown',
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			cohortTopic: { enabled: true },
		});

		const host = node.cohortTopicHost;
		expect(host, 'host constructed').to.not.equal(undefined);

		// Spy host.stop — the node.stop wrapper resolves host.stop at call time, so this override is seen.
		let hostStopped = false;
		const origStop = host.stop.bind(host);
		host.stop = async (): Promise<void> => { hostStopped = true; await origStop(); };

		await node.stop();
		expect(hostStopped, 'host.stop() ran during node.stop() (gossip timer cleared, protocols unhandled)').to.equal(true);
	});
});
