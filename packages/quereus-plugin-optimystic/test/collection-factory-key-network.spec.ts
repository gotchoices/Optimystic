import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p, PeerId } from '@libp2p/interface';
import type { IKeyNetwork, IRepo } from '@optimystic/db-core';
import { DEFAULT_CLUSTER_SIZE, Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import { CollectionFactory } from '../src/optimystic-adapter/collection-factory.js';
import type { ParsedOptimysticOptions } from '../src/types.js';

const NETWORK_NAME = 'mynet';
const PROTOCOL_PREFIX = `/optimystic/${NETWORK_NAME}`;
const CONFIGURED_CLUSTER_SIZE = 2;

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/**
 * Minimal libp2p stand-in exposing exactly the surface `Libp2pKeyPeerNetwork.findCluster`
 * touches: peerId, a FRET service whose `assembleCohort` returns a fixed nearest-first
 * band, a peerStore that reports each peer's advertised protocols, and no live connections.
 */
function createMockLibp2p(selfId: PeerId, cohort: string[], protocolsByPeer: Record<string, string[]>): Libp2p {
	const assembleCohortWants: number[] = [];
	const node = {
		peerId: selfId,
		getConnections: () => [],
		getMultiaddrs: () => [],
		addEventListener: () => { },
		removeEventListener: () => { },
		peerStore: {
			get: async (pid: PeerId) => ({
				protocols: protocolsByPeer[pid.toString()] ?? [],
				addresses: [{ multiaddr: { toString: () => '/ip4/127.0.0.1/tcp/4001' } }]
			})
		},
		services: {
			fret: {
				assembleCohort: (_coord: unknown, wants: number) => {
					assembleCohortWants.push(wants);
					return [...cohort];
				},
				getNeighbors: () => [...cohort],
				getNetworkSizeEstimate: () => ({ size_estimate: cohort.length + 1, confidence: 1 }),
				detectPartition: () => false,
				exportTable: () => undefined,
				importTable: () => { }
			}
		}
	};
	(node as unknown as { assembleCohortWants: number[] }).assembleCohortWants = assembleCohortWants;
	return node as unknown as Libp2p;
}

const networkOptions = (): ParsedOptimysticOptions => ({
	collectionUri: `tree://${NETWORK_NAME}/things`,
	transactor: 'network',
	keyNetwork: 'libp2p',
	libp2pOptions: { port: 0, networkName: NETWORK_NAME, bootstrapNodes: [] },
	cache: true,
	encoding: 'json'
});

/**
 * The transactor's key network must be the one the NODE was configured with — same
 * network scoping (protocol prefix) and same cluster size. A separately constructed
 * instance carries whatever cluster size and prefix that call site happened to state,
 * which for the sites this ticket fixed meant a wider cohort and no "does this peer
 * serve my network?" filter on every write.
 */
describe('CollectionFactory network transactor key network', () => {
	let selfId: PeerId;
	let servingA: PeerId;
	let servingB: PeerId;
	let servingC: PeerId;
	let foreign: PeerId;
	let node: Libp2p;
	let factory: CollectionFactory;

	beforeEach(async () => {
		[selfId, servingA, servingB, servingC, foreign] = await Promise.all([
			makePeerId(), makePeerId(), makePeerId(), makePeerId(), makePeerId()
		]);
		const cohort = [foreign.toString(), servingA.toString(), servingB.toString(), servingC.toString()];
		node = createMockLibp2p(selfId, cohort, {
			[foreign.toString()]: ['/optimystic/othernet/repo/1.0.0'],
			[servingA.toString()]: [`${PROTOCOL_PREFIX}/repo/1.0.0`],
			[servingB.toString()]: [`${PROTOCOL_PREFIX}/repo/1.0.0`],
			[servingC.toString()]: [`${PROTOCOL_PREFIX}/repo/1.0.0`]
		});
		// What `createLibp2pNode` attaches: a key network carrying this network's
		// configured cluster size and protocol prefix.
		(node as unknown as { keyNetwork: Libp2pKeyPeerNetwork }).keyNetwork = new Libp2pKeyPeerNetwork(
			node, CONFIGURED_CLUSTER_SIZE, undefined, 'joining', undefined, undefined, PROTOCOL_PREFIX
		);

		factory = new CollectionFactory();
		factory.registerLibp2pNode(NETWORK_NAME, node, {} as IRepo);
	});

	const transactorKeyNetwork = async (): Promise<IKeyNetwork> => {
		const transactor = await factory.createTransactor(networkOptions());
		return (transactor as unknown as { keyNetwork: IKeyNetwork }).keyNetwork;
	};

	it('scopes cohort selection to peers serving this network', async () => {
		const keyNetwork = await transactorKeyNetwork();
		const peers = await keyNetwork.findCluster(new TextEncoder().encode('block-1'));
		expect(Object.keys(peers)).to.not.include(foreign.toString());
	});

	it('assembles the cohort at the configured cluster size', async () => {
		const keyNetwork = await transactorKeyNetwork();
		const peers = await keyNetwork.findCluster(new TextEncoder().encode('block-1'));
		expect(Object.keys(peers)).to.have.lengthOf(CONFIGURED_CLUSTER_SIZE);
	});

	/**
	 * The other branch of `resolveKeyNetwork`: a host registered a node this factory did not
	 * build, so there is no attached key network to reuse and one has to be constructed. The
	 * cluster size is a stated constant rather than a constructor default (the constructor has
	 * none any more), and the network name — which this call site DOES know — is passed, so
	 * selection stays scoped to peers serving this network.
	 */
	describe('node injected without an attached key network', () => {
		it('states DEFAULT_CLUSTER_SIZE and this network prefix instead of falling back to a constructor default', async () => {
			const bare = createMockLibp2p(selfId, [servingA.toString()], {
				[servingA.toString()]: [`${PROTOCOL_PREFIX}/repo/1.0.0`]
			});
			expect((bare as unknown as { keyNetwork?: unknown }).keyNetwork, 'precondition: nothing attached')
				.to.equal(undefined);

			const bareFactory = new CollectionFactory();
			bareFactory.registerLibp2pNode(NETWORK_NAME, bare, {} as IRepo);
			const transactor = await bareFactory.createTransactor(networkOptions());
			const keyNetwork = (transactor as unknown as { keyNetwork: Libp2pKeyPeerNetwork }).keyNetwork;

			expect(keyNetwork.effectiveClusterSize).to.equal(DEFAULT_CLUSTER_SIZE);
			expect(keyNetwork.effectiveProtocolPrefix).to.equal(PROTOCOL_PREFIX);
		});
	});
});
