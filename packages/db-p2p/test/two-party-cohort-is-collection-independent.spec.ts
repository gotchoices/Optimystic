/**
 * Ticket: a-second-party-cannot-read-the-messages-it-just-wrote.
 *
 * A device report had two parties in one shared group over a circuit relay, where one collection
 * (`default/Member`) looked readable on the joining party while another (`default/Message`) failed
 * `cohort-unreachable`. The first question was whether the two collections resolve to different
 * cohorts. They cannot: with two serving peers and the documented two-machine configuration (default
 * `clusterSize`), FRET's ring holds fewer peers than the cohort width, so `assembleCohort` returns the
 * whole ring from ANY coordinate, and `findCluster` keeps both peers for every block id. What does vary
 * is time: while the partner is not yet identified as serving this network, every block — both
 * collections alike — collapses to a self-only cohort.
 *
 * Built over FRET's real ring store and cohort walk and the production `findCluster`, with only libp2p
 * itself stubbed. The partner is reachable only at a circuit address, as on the device.
 */
import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection, Libp2p, PeerId } from '@libp2p/interface';
import { DigitreeStore, assembleCohort, hashPeerId } from 'p2p-fret';
import { routingKeyForBlock } from '@optimystic/db-core';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { DEFAULT_CLUSTER_SIZE } from '../src/cluster/cluster-policy.js';

const PREFIX = '/optimystic/two-party-strand';
const SERVES = [`${PREFIX}/cluster/1.0.0`, `${PREFIX}/repo/1.0.0`];

/** The block ids from the report, plus enough others that a key-dependent cohort could not hide. */
const BLOCK_IDS = ['default/Member', 'default/Message', ...Array.from({ length: 50 }, (_, i) => `default/Message/block-${i}`)];

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** One party's view: a key network over a FRET ring holding both parties, the partner known at a circuit address. */
async function partyView(self: PeerId, partner: PeerId, relay: PeerId, partnerProtocols: string[]): Promise<Libp2pKeyPeerNetwork> {
	const store = new DigitreeStore();
	for (const pid of [self, partner]) store.upsert(pid.toString(), await hashPeerId(pid));
	const circuit = `/ip4/127.0.0.1/tcp/4100/ws/p2p/${relay.toString()}/p2p-circuit/p2p/${partner.toString()}`;
	const connection = {
		remotePeer: partner,
		status: 'open',
		direction: 'outbound',
		remoteAddr: { toString: () => circuit }
	} as unknown as Connection;
	const libp2p = {
		peerId: self,
		getConnections: () => [connection],
		getDialQueue: () => [],
		getMultiaddrs: () => [],
		addEventListener: () => { },
		removeEventListener: () => { },
		peerStore: {
			all: async () => [],
			get: async (pid: PeerId) => pid.equals(partner)
				? { protocols: partnerProtocols, addresses: [{ multiaddr: multiaddr(circuit) }] }
				: { protocols: [], addresses: [] }
		},
		services: {
			fret: {
				assembleCohort: (coord: Uint8Array, wants: number, exclude?: Set<string>) => assembleCohort(store, coord, wants, exclude),
				getNetworkSizeEstimate: () => ({ size_estimate: 2, confidence: 1 }),
				detectPartition: () => false,
				exportTable: () => undefined,
				getNeighbors: () => []
			}
		}
	} as unknown as Libp2p;
	return new Libp2pKeyPeerNetwork(libp2p, DEFAULT_CLUSTER_SIZE, undefined, 'forming', undefined, undefined, PREFIX);
}

async function cohortsByBlock(network: Libp2pKeyPeerNetwork): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const id of BLOCK_IDS) {
		out.set(id, Object.keys(await network.findCluster(routingKeyForBlock(id))).sort());
	}
	return out;
}

describe('two-party group: a block\'s cohort does not depend on which collection it belongs to', () => {
	let a: PeerId;
	let b: PeerId;
	let relay: PeerId;

	before(async () => {
		a = await makePeerId();
		b = await makePeerId();
		relay = await makePeerId();
	});

	it('with the partner identified, both parties put both peers in the cohort of every block of both collections', async () => {
		const both = [a.toString(), b.toString()].sort();
		for (const [self, partner, name] of [[a, b, 'A'], [b, a, 'B']] as const) {
			const cohorts = await cohortsByBlock(await partyView(self, partner, relay, SERVES));
			for (const [id, cohort] of cohorts) {
				expect(cohort, `${name}'s cohort for ${id}`).to.deep.equal(both);
			}
		}
	});

	it('with the partner not yet identified, every block of both collections is self-only — the same for both collections', async () => {
		const cohorts = await cohortsByBlock(await partyView(b, a, relay, []));
		for (const [id, cohort] of cohorts) {
			expect(cohort, `B's cohort for ${id} before identify`).to.deep.equal([b.toString()]);
		}
	});
});
