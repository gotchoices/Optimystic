/**
 * A reproducible FRET ring, and the production key network over it with libp2p stubbed out — for specs
 * that compare some cohort rule against the one `Libp2pKeyPeerNetwork` applies, over one fixed geometry
 * rather than a fresh random sample.
 *
 * Peer keys are derived from the seed `(n, i)` exactly as the mesh harness derives `createMesh(n, { keySeed: n })`'s,
 * so a ring of `n` here and that mesh hold the same peers in the same order.
 */
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection, Libp2p, PeerId } from '@libp2p/interface';
import { DigitreeStore, assembleCohort, hashPeerId } from 'p2p-fret';
import { Libp2pKeyPeerNetwork } from '../../src/libp2p-key-network.js';

/** The protocol prefix the stubbed key networks scope membership to. */
export const RING_PROTOCOL_PREFIX = '/optimystic/convention';
/** The protocols a serving ring member advertises under {@link RING_PROTOCOL_PREFIX}. */
export const RING_SERVES = [`${RING_PROTOCOL_PREFIX}/cluster/1.0.0`, `${RING_PROTOCOL_PREFIX}/repo/1.0.0`];

const addrOf = (pid: { toString(): string }): string => `/ip4/10.0.0.1/tcp/4001/p2p/${pid.toString()}`;

/** The `n` peers of the seeded ring `ringOf(n)` holds, in index order. */
export async function ringPeersOf(n: number): Promise<PeerId[]> {
	const peers: PeerId[] = [];
	for (let i = 0; i < n; i++) {
		const seed = new Uint8Array(32);
		const view = new DataView(seed.buffer);
		view.setUint32(0, n);
		view.setUint32(4, i);
		peers.push(peerIdFromPrivateKey(await generateKeyPairFromSeed('Ed25519', seed)));
	}
	return peers;
}

/** A FRET ring store holding `ringPeersOf(n)` at their real ring coordinates. */
export async function ringOf(n: number): Promise<DigitreeStore> {
	const store = new DigitreeStore();
	for (const pid of await ringPeersOf(n)) store.upsert(pid.toString(), await hashPeerId(pid));
	return store;
}

export interface RingKeyNetworkOptions {
	/** The cohort width the key network is built with (`clusterSize`). */
	clusterSize: number;
	/** Scope membership to {@link RING_PROTOCOL_PREFIX} (production), or leave it unscoped. */
	scoped: boolean;
	/** What this node itself registers. Default {@link RING_SERVES}. */
	ownProtocols?: string[];
	/** Ring members that advertise no storage protocol. */
	notServing?: Set<string>;
}

/**
 * `self`'s production key network over `store`, with only libp2p stubbed: every other peer in `peers` is
 * connected and identified, advertising {@link RING_SERVES} unless listed in `notServing`, so the cohort
 * tier always has a reachable candidate and every peer's reputation is equal.
 */
export function ringKeyNetworkOf(self: PeerId, peers: PeerId[], store: DigitreeStore, options: RingKeyNetworkOptions): Libp2pKeyPeerNetwork {
	const notServing = options.notServing ?? new Set<string>();
	const connections = peers
		.filter(p => !p.equals(self))
		.map(p => ({ remotePeer: p, status: 'open', direction: 'outbound', remoteAddr: { toString: () => addrOf(p) } }) as unknown as Connection);
	const libp2p = {
		peerId: self,
		getConnections: () => connections,
		getDialQueue: () => [],
		getMultiaddrs: () => [],
		getProtocols: () => options.ownProtocols ?? RING_SERVES,
		addEventListener: () => { },
		removeEventListener: () => { },
		peerStore: {
			all: async () => [],
			get: async (pid: PeerId) => ({
				protocols: notServing.has(pid.toString()) ? ['/ipfs/id/1.0.0'] : RING_SERVES,
				addresses: [{ multiaddr: multiaddr(addrOf(pid)) }]
			})
		},
		services: {
			fret: {
				assembleCohort: (coord: Uint8Array, wants: number, exclude?: Set<string>) => assembleCohort(store, coord, wants, exclude),
				getNetworkSizeEstimate: () => ({ size_estimate: peers.length, confidence: 1 }),
				detectPartition: () => false,
				exportTable: () => undefined
			}
		}
	} as unknown as Libp2p;
	return new Libp2pKeyPeerNetwork(libp2p, options.clusterSize, undefined, 'forming', undefined, undefined, options.scoped ? RING_PROTOCOL_PREFIX : undefined);
}
