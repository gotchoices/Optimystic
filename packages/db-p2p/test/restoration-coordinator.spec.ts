import { expect } from 'chai';
import { hashKey } from 'p2p-fret';
import { RestorationCoordinator } from '../src/storage/restoration-coordinator.js';
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../src/storage/arachnode-fret-adapter.js';
import type { IPeerNetwork } from '@optimystic/db-core';

/**
 * Canonical prefix extraction: first `bits` bits of a byte array, MSB first.
 * Identical to RingSelector.extractPrefix / RestorationCoordinator.extractPrefix.
 */
function extractPrefix(bytes: Uint8Array, bits: number): number {
	let value = 0;
	for (let i = 0; i < bits; i++) {
		const byteIndex = Math.floor(i / 8);
		const bitIndex = 7 - (i % 8);
		const bit = (bytes[byteIndex]! >> bitIndex) & 1;
		value = (value << 1) | bit;
	}
	return value;
}

/** The OLD (buggy) prefix source: raw UTF-8 bytes copied into a 32-byte buffer, no hashing. */
function rawPrefix(blockId: string, bits: number): number {
	const bytes = new TextEncoder().encode(blockId);
	const buf = new Uint8Array(32);
	for (let i = 0; i < Math.min(bytes.length, buf.length); i++) {
		buf[i] = bytes[i]!;
	}
	return extractPrefix(buf, bits);
}

/** The CORRECT prefix source: hashKey(blockId) coordinate, then extract. */
async function hashedPrefix(blockId: string, bits: number): Promise<number> {
	const coord = await hashKey(new TextEncoder().encode(blockId));
	return extractPrefix(coord, bits);
}

/**
 * Find a block id whose raw-byte prefix and hashed-coord prefix land in DIFFERENT ring
 * partitions at the given depth — the situation that exposes the coordinate-space bug.
 */
async function findDivergentBlockId(bits: number): Promise<{ blockId: string; raw: number; hashed: number }> {
	for (let i = 0; i < 1000; i++) {
		const blockId = `restore-block-${i}`;
		const raw = rawPrefix(blockId, bits);
		const hashed = await hashedPrefix(blockId, bits);
		if (raw !== hashed) return { blockId, raw, hashed };
	}
	throw new Error('no divergent block id found (unexpected)');
}

/** Stub adapter driving RestorationCoordinator's fallback (inner-ring) path. */
function makeStubAdapter(opts: {
	myRingDepth: number;
	ringPeers: Map<number, string[]>;
	infoByPeer: Map<string, ArachnodeInfo>;
}): ArachnodeFretAdapter {
	const stub = {
		// Cohort empty -> control falls through to the inner-ring fallback loop.
		getFret: () => ({ assembleCohort: (_coord: Uint8Array, _n: number) => [] as string[] }),
		getMyArachnodeInfo: () => ({ ringDepth: opts.myRingDepth } as ArachnodeInfo),
		findPeersAtRing: (ringDepth: number) => opts.ringPeers.get(ringDepth) ?? [],
		getArachnodeInfo: (peerId: string) => opts.infoByPeer.get(peerId)
	};
	return stub as unknown as ArachnodeFretAdapter;
}

function partitionInfo(prefixBits: number, prefixValue: number): ArachnodeInfo {
	return {
		ringDepth: prefixBits,
		partition: { prefixBits, prefixValue },
		capacity: { total: 1, used: 0, available: 1 },
		status: 'active'
	};
}

describe('RestorationCoordinator', () => {
	describe('filterByPartition coordinate space (inner-ring fallback)', () => {
		const RING_DEPTH = 4;

		it('queries the peer matching the hashed-coord partition, not the raw-byte one', async () => {
			const { blockId, raw, hashed } = await findDivergentBlockId(RING_DEPTH);
			// Sanity: the test is only meaningful when the two spaces disagree.
			expect(raw).to.not.equal(hashed);

			// peer-A is truly responsible (hashed prefix); peer-B is the raw-byte decoy.
			const PEER_A = 'peer-A-hashed';
			const PEER_B = 'peer-B-raw';
			const infoByPeer = new Map<string, ArachnodeInfo>([
				[PEER_A, partitionInfo(RING_DEPTH, hashed)],
				[PEER_B, partitionInfo(RING_DEPTH, raw)]
			]);

			const adapter = makeStubAdapter({
				// myRingDepth > RING_DEPTH so the fallback loop reaches RING_DEPTH.
				myRingDepth: RING_DEPTH + 1,
				ringPeers: new Map([[RING_DEPTH, [PEER_A, PEER_B]]]),
				infoByPeer
			});

			const peerNetwork = {} as IPeerNetwork;
			const coordinator = new RestorationCoordinator(adapter, peerNetwork, '/test');

			// Observe which peers get queried without touching libp2p.
			const queried: string[] = [];
			(coordinator as any).queryPeer = async (peerId: string) => {
				queried.push(peerId);
				return undefined;
			};

			const result = await coordinator.restore(blockId);

			expect(result).to.equal(undefined);
			expect(queried).to.include(PEER_A);
			expect(queried).to.not.include(PEER_B);
		});
	});

	describe('metrics', () => {
		it('getMetrics returns copies of the ring maps — a caller mutation cannot corrupt internal state', async () => {
			const adapter = makeStubAdapter({ myRingDepth: 1, ringPeers: new Map(), infoByPeer: new Map() });
			const coordinator = new RestorationCoordinator(adapter, {} as IPeerNetwork, '/test');

			// recordSuccess is internal; drive it directly to seed a metric without a live query.
			(coordinator as any).recordSuccess(1, 'block-x', 5);

			const snapshot1 = coordinator.getMetrics();
			// Mutating the returned snapshot must not reach the coordinator's own Maps.
			snapshot1.successByRing.set(1, 999);
			snapshot1.failureByRing.set(7, 42);

			const snapshot2 = coordinator.getMetrics();
			expect(snapshot2.successByRing.get(1)).to.equal(1);
			expect(snapshot2.failureByRing.has(7)).to.equal(false);
		});

		it('records one failure per ring exhausted without yielding the block', async () => {
			// No peers anywhere and myRingDepth=2 → my ring (2) plus inner rings 1 and 0 are each
			// queried and come up empty, so failureByRing should hold one count for each.
			const adapter = makeStubAdapter({ myRingDepth: 2, ringPeers: new Map(), infoByPeer: new Map() });
			const coordinator = new RestorationCoordinator(adapter, {} as IPeerNetwork, '/test');

			const result = await coordinator.restore('block-nowhere');

			expect(result).to.equal(undefined);
			const metrics = coordinator.getMetrics();
			expect(metrics.failureByRing.get(2)).to.equal(1);
			expect(metrics.failureByRing.get(1)).to.equal(1);
			expect(metrics.failureByRing.get(0)).to.equal(1);
		});
	});
});
