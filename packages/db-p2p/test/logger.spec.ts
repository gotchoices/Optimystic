/**
 * Ticket: debug-logs-cannot-say-which-node-they-came-from
 *
 * Debug log lines from routing (`Libp2pKeyPeerNetwork`) and cluster-repair (`CoordinatorRepo`)
 * decisions carried no indication of which node produced them, which made a shared-process
 * integration test's interleaved log stream unusable for anything node-specific. `createLogger`
 * now accepts an optional peer id suffix; these specs pin that two differently-keyed instances
 * end up on distinct `debug` namespaces, and that omitting the peer id (the single-node/test
 * construction `CoordinatorRepo` has always tolerated) degrades to exactly today's namespace
 * rather than something like `…:undefined`.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId, Libp2p } from '@libp2p/interface';
import type { IRepo, IKeyNetwork, ClusterPeers, ClusterRecord, RepoMessage, FindCoordinatorOptions } from '@optimystic/db-core';
import { createLogger } from '../src/logger.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { captureLog, formatCaptured, hasTag, hasTagAtRev } from './support/capture-log.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** Reach past the private `log` field the same way the rest of this package's specs reach private members. */
const namespaceOf = (instance: unknown): string => (instance as { log: { namespace: string } }).log.namespace;

function createMockLibp2p(peerId: PeerId): Libp2p {
	return {
		peerId,
		getConnections: () => [],
		getDialQueue: () => [],
		getMultiaddrs: () => [],
		addEventListener: () => { },
		removeEventListener: () => { },
		services: {}
	} as unknown as Libp2p;
}

const noopKeyNetwork: IKeyNetwork = {
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return {};
	}
};

const noopStorageRepo: IRepo = {
	async get() { return {}; },
	async pend() { return { success: true, pending: [], blockIds: [] }; },
	async cancel() { },
	async commit() { return { success: true }; }
};

const makeClusterClient = (() => ({})) as unknown as (peerId: PeerId) => ClusterClient;

describe('createLogger peer-id namespacing', () => {
	it('degrades to the bare namespace when no peer id is given', () => {
		expect(createLogger('some-namespace').namespace).to.equal('optimystic:db-p2p:some-namespace');
	});

	it('suffixes the namespace with a truncated peer id', async () => {
		const peerId = await makePeerId();
		const log = createLogger('some-namespace', peerId.toString());
		expect(log.namespace).to.equal(`optimystic:db-p2p:some-namespace:${peerId.toString().substring(0, 12)}`);
	});

	it('Libp2pKeyPeerNetwork instances with different peer ids log under different namespaces', async () => {
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const networkA = new Libp2pKeyPeerNetwork(createMockLibp2p(peerA), 16, undefined, 'forming');
		const networkB = new Libp2pKeyPeerNetwork(createMockLibp2p(peerB), 16, undefined, 'forming');

		expect(namespaceOf(networkA)).to.not.equal(namespaceOf(networkB));
		expect(namespaceOf(networkA)).to.equal(`optimystic:db-p2p:libp2p-key-network:${peerA.toString().substring(0, 12)}`);
		expect(namespaceOf(networkB)).to.equal(`optimystic:db-p2p:libp2p-key-network:${peerB.toString().substring(0, 12)}`);
	});

	it('CoordinatorRepo with a localPeerId logs under a suffixed namespace', async () => {
		const localPeerId = await makePeerId();
		const repo = new CoordinatorRepo(noopKeyNetwork, makeClusterClient, noopStorageRepo, undefined, undefined, localPeerId);
		expect(namespaceOf(repo)).to.equal(`optimystic:db-p2p:coordinator-repo:${localPeerId.toString().substring(0, 12)}`);
	});

	it('CoordinatorRepo with no localPeerId logs under the original un-suffixed namespace', () => {
		const repo = new CoordinatorRepo(noopKeyNetwork, makeClusterClient, noopStorageRepo);
		expect(namespaceOf(repo)).to.equal('optimystic:db-p2p:coordinator-repo');
	});
});

/**
 * `captureLog` enables a namespace by name, and `debug.enable` without a wildcard matches EXACTLY —
 * so peer-id suffixing silently emptied every capture until the helper was widened to enable both
 * shapes. These pin that seam directly, rather than leaving it to be re-discovered as a wall of
 * "expected false to equal true" in the read-repair specs.
 */
describe('captureLog vs peer-id-suffixed namespaces', () => {
	it('captures both the bare and the peer-id-suffixed form of the namespace', async () => {
		const peerId = await makePeerId();
		const bare = createLogger('capture-probe');
		const suffixed = createLogger('capture-probe', peerId.toString());

		const captured = await captureLog('capture-probe', async () => {
			bare('bare-tag', { rev: 1 });
			suffixed('suffixed-tag', { rev: 2 });
		});

		expect(hasTag(captured, 'bare-tag')).to.equal(true);
		expect(hasTagAtRev(captured, 'suffixed-tag', 2)).to.equal(true);
	});

	it('does not capture a sibling namespace that merely shares a prefix', async () => {
		const sibling = createLogger('capture-probe-sibling');

		const captured = await captureLog('capture-probe', async () => {
			sibling('sibling-tag', { rev: 1 });
		});

		expect(hasTag(captured, 'sibling-tag')).to.equal(false);
	});
});

/**
 * Ticket: address-book-merge-logs-under-two-namespaces (gotchoices/Optimystic#12).
 *
 * `mergePeerAddresses` (`peer-address-book.ts`) is reached from two unrelated ingress points, each
 * historically wired to a DIFFERENT logger factory — the inbound (`ClusterService`) sink came from
 * libp2p's own `components.logger.forComponent(...)`, landing under a bare `db-p2p:*` namespace
 * that `DEBUG=optimystic:db-p2p:*` (what this package's docs tell people to set) never matches. A
 * reporter armed only the outbound half, saw zero inbound merge lines, and concluded the mechanism
 * never ran. These specs pin both ingress paths under the same `optimystic:db-p2p:*` tree so that
 * regression is structurally impossible to reintroduce one call site at a time.
 */
describe('peer-address-book:merge is visible from both ingress paths under one DEBUG filter', () => {
	let node: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = node;
		node = undefined;
		if (toStop) await toStop.stop();
	});

	/** A bare single node: no relay, no peers — just enough wiring to exercise both ingress points. */
	async function spawnNode(): Promise<OptimysticNode> {
		return await createLibp2pNode({
			port: 0,
			networkName: 'logger-address-book-merge-namespaces',
			bootstrapNodes: [],
			relay: false,
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false }
		});
	}

	/** The record ingress point a cluster service exposes — same narrow cast the relay specs use. */
	interface ClusterIngress {
		processOperation(op: { operation: 'update', record: ClusterRecord }): Promise<unknown>;
	}
	const clusterIngressOf = (n: Libp2p): ClusterIngress =>
		(n as unknown as { services: { cluster: ClusterIngress } }).services.cluster;

	const recordWithPeers = (peers: ClusterPeers): ClusterRecord => ({
		messageHash: 'logger-spec-inbound-merge',
		peers,
		message: { operations: [] } as unknown as RepoMessage,
		promises: {},
		commits: {}
	});

	const ADDR = '/ip4/10.0.0.5/tcp/4001';

	/** One row per ingress point `mergePeerAddresses` is reachable from. */
	const rows: Array<{ what: string, namespace: string, trigger: (n: OptimysticNode, other: PeerId) => Promise<void> }> = [
		{
			what: 'inbound (ClusterService, from the coordinator)',
			namespace: 'optimystic:db-p2p:peer-address-book',
			trigger: async (n, other) => {
				await clusterIngressOf(n).processOperation({
					operation: 'update',
					record: recordWithPeers({ [other.toString()]: { multiaddrs: [ADDR], publicKey: '' } })
				});
			}
		},
		{
			what: 'outbound (Libp2pKeyPeerNetwork.recordPeerAddresses, from ClusterClient/RepoClient)',
			namespace: 'optimystic:db-p2p:libp2p-key-network',
			trigger: async (n, other) => {
				n.keyNetwork.recordPeerAddresses(other, [ADDR]);
			}
		}
	];

	for (const row of rows) {
		it(`${row.what} logs peer-address-book:merge under ${row.namespace}`, async () => {
			node = await spawnNode();
			const other = await makePeerId();

			const captured = await captureLog('*', async () => {
				await row.trigger(node!, other);
			});

			const mergeLine = captured.find(args => hasTag([args], 'peer-address-book:merge'));
			expect(mergeLine, `${row.what} must emit a peer-address-book:merge line`).to.not.equal(undefined);
			// `optimystic:db-p2p:*` is the filter this package's docs tell people to set — asserting the
			// namespace prefix, not merely that SOME line was captured, is what pins the fix: without it
			// this line would sit under the bare `db-p2p:*` tree that filter never matches.
			expect(formatCaptured(mergeLine!), `${row.what} must log under ${row.namespace}`).to.include(row.namespace);
		});
	}
});
