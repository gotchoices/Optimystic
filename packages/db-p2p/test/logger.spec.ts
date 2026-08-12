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
import type { IRepo, IKeyNetwork, ClusterPeers, FindCoordinatorOptions } from '@optimystic/db-core';
import { createLogger } from '../src/logger.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { captureLog, hasTag, hasTagAtRev } from './support/capture-log.js';

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
