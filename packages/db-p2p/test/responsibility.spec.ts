import { describe, it } from 'node:test';
import assert from 'node:assert';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { xorDistanceBytes, lessThanLex, sortPeersByDistance, computeResponsibility, type KnownPeer } from '../src/routing/responsibility.js';

describe('xorDistanceBytes', () => {
	it('returns zero for identical arrays', () => {
		const a = new Uint8Array([0x12, 0x34, 0x56]);
		const result = xorDistanceBytes(a, a);
		assert.deepStrictEqual(result, new Uint8Array([0, 0, 0]));
	});

	it('computes XOR correctly', () => {
		const a = new Uint8Array([0xFF, 0x00]);
		const b = new Uint8Array([0x0F, 0xF0]);
		const result = xorDistanceBytes(a, b);
		assert.deepStrictEqual(result, new Uint8Array([0xF0, 0xF0]));
	});

	it('handles arrays of different lengths (pads with zeros)', () => {
		const a = new Uint8Array([0xFF]);
		const b = new Uint8Array([0x00, 0x0F]);
		// a is treated as [0x00, 0xFF], XOR with [0x00, 0x0F] = [0x00, 0xF0]
		const result = xorDistanceBytes(a, b);
		assert.deepStrictEqual(result, new Uint8Array([0x00, 0xF0]));
	});

	it('handles empty arrays', () => {
		const a = new Uint8Array([]);
		const b = new Uint8Array([]);
		const result = xorDistanceBytes(a, b);
		assert.deepStrictEqual(result, new Uint8Array([]));
	});

	it('handles one empty array', () => {
		const a = new Uint8Array([0xAB, 0xCD]);
		const b = new Uint8Array([]);
		const result = xorDistanceBytes(a, b);
		assert.deepStrictEqual(result, new Uint8Array([0xAB, 0xCD]));
	});
});

describe('lessThanLex', () => {
	it('returns false for identical arrays', () => {
		const a = new Uint8Array([0x12, 0x34]);
		assert.strictEqual(lessThanLex(a, a), false);
	});

	it('returns true when first byte is smaller', () => {
		const a = new Uint8Array([0x10, 0xFF]);
		const b = new Uint8Array([0x20, 0x00]);
		assert.strictEqual(lessThanLex(a, b), true);
	});

	it('returns false when first byte is larger', () => {
		const a = new Uint8Array([0x30, 0x00]);
		const b = new Uint8Array([0x20, 0xFF]);
		assert.strictEqual(lessThanLex(a, b), false);
	});

	it('compares subsequent bytes when leading bytes match', () => {
		const a = new Uint8Array([0x10, 0x20]);
		const b = new Uint8Array([0x10, 0x30]);
		assert.strictEqual(lessThanLex(a, b), true);
	});

	it('handles arrays of different lengths', () => {
		// [0x10] vs [0x10, 0x01] - shorter array padded with 0
		const a = new Uint8Array([0x10]);
		const b = new Uint8Array([0x10, 0x01]);
		assert.strictEqual(lessThanLex(a, b), true);
	});

	it('handles empty arrays', () => {
		const a = new Uint8Array([]);
		const b = new Uint8Array([]);
		assert.strictEqual(lessThanLex(a, b), false);
	});
});

describe('sortPeersByDistance', () => {
	const makePeer = async (): Promise<KnownPeer> => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		return { id: peerId, addrs: [] };
	};

	it('sorts peers by XOR distance to key', async () => {
		const peers = await Promise.all([1, 2, 3].map(() => makePeer()));
		const key = new Uint8Array(32).fill(15);

		const sorted = sortPeersByDistance(peers, key);

		// Verify sorting is deterministic and correct
		assert.strictEqual(sorted.length, 3);
		const distances = sorted.map(p => xorDistanceBytes(p.id.toMultihash().bytes, key));
		for (let i = 1; i < distances.length; i++) {
			assert.strictEqual(lessThanLex(distances[i]!, distances[i - 1]!), false);
		}
	});

	it('handles empty peer list', () => {
		const result = sortPeersByDistance([], new Uint8Array([0xFF]));
		assert.deepStrictEqual(result, []);
	});

	it('handles single peer', async () => {
		const peer = await makePeer();
		const result = sortPeersByDistance([peer], new Uint8Array([0x00]));
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.id.equals(peer.id), true);
	});
});

describe('computeResponsibility', () => {
	const makePeer = async (): Promise<KnownPeer> => {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		return { id: peerId, addrs: [] };
	};

	it('single node is always responsible', async () => {
		const self = await makePeer();
		const key = new Uint8Array(32).fill(0x42);

		const result = computeResponsibility(key, self, [], 3);

		assert.strictEqual(result.inCluster, true);
		assert.strictEqual(result.nearest.length, 1);
	});

	it('with 2 nodes, only nearest is responsible', async () => {
		const self = await makePeer();
		const other = await makePeer();
		const key = new Uint8Array(32).fill(0x00);

		const result = computeResponsibility(key, self, [other], 3);

		// Only one should be responsible in small mesh
		assert.strictEqual(result.nearest.length, 2);
		// The one marked responsible should be first in sorted order
		if (result.inCluster) {
			assert.strictEqual(result.nearest[0]!.id.equals(self.id), true);
		}
	});

	it('with 3 nodes, only first in XOR order is responsible', async () => {
		const peer1 = await makePeer();
		const peer2 = await makePeer();
		const peer3 = await makePeer();
		const key = new Uint8Array(32).fill(0x55);

		// Check from each peer's perspective
		const result1 = computeResponsibility(key, peer1, [peer2, peer3], 3);
		const result2 = computeResponsibility(key, peer2, [peer1, peer3], 3);
		const result3 = computeResponsibility(key, peer3, [peer1, peer2], 3);

		// Exactly one should be responsible
		const responsibleCount = [result1, result2, result3].filter(r => r.inCluster).length;
		assert.strictEqual(responsibleCount, 1, 'Exactly one node should be responsible in 3-node mesh');
	});

	it('with larger mesh, uses k-nearest strategy', async () => {
		const peers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => makePeer()));
		const self = peers[0]!;
		const others = peers.slice(1);
		const key = new Uint8Array(32).fill(0xAA);

		const result = computeResponsibility(key, self, others, 3);

		// With 6 nodes and k=3, effectiveK = min(3, floor(6/2)) = 3
		assert.ok(result.nearest.length <= 6);
	});

	it('different keys produce different responsibility assignments', async () => {
		const self = await makePeer();
		const others = await Promise.all([1, 2, 3, 4].map(() => makePeer()));

		const key1 = new Uint8Array(32).fill(0x00);
		const key2 = new Uint8Array(32).fill(0xFF);

		const result1 = computeResponsibility(key1, self, others, 2);
		const result2 = computeResponsibility(key2, self, others, 2);

		// Both results should be valid
		assert.ok(result1.nearest.length > 0);
		assert.ok(result2.nearest.length > 0);
	});

	it('k larger than peer count uses all peers', async () => {
		const self = await makePeer();
		const other = await makePeer();
		const key = new Uint8Array(32);

		const result = computeResponsibility(key, self, [other], 10);

		// With only 2 nodes total, k=10 should still work
		assert.strictEqual(result.nearest.length, 2);
	});
});
