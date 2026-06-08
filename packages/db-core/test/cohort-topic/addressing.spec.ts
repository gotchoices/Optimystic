import { expect } from 'chai';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import {
	createTierAddressing,
	HashTierAddressing,
	prefixBits,
	DEFAULT_FANOUT,
} from '../../src/cohort-topic/addressing.js';

/** Deterministic pseudo-random bytes (no Math.random — keeps the test reproducible). */
function seededBytes(len: number, seed: number): Uint8Array {
	const out = new Uint8Array(len);
	let s = (seed * 2654435761) >>> 0;
	for (let i = 0; i < len; i++) {
		s = (s * 1664525 + 1013904223) >>> 0;
		out[i] = (s >>> 24) & 0xff;
	}
	return out;
}

const hex = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/** Force the first `n` bits of a 32-byte id to a fixed pattern, randomize the tail. */
function peerWithPrefix(prefixBitsCount: number, fillByte: number, tailSeed: number): Uint8Array {
	const id = seededBytes(32, tailSeed);
	const fullBytes = prefixBitsCount >> 3;
	for (let i = 0; i < fullBytes; i++) id[i] = fillByte;
	const rem = prefixBitsCount & 7;
	if (rem > 0) {
		const mask = (0xff << (8 - rem)) & 0xff;
		id[fullBytes] = (fillByte & mask) | (id[fullBytes]! & ~mask & 0xff);
	}
	return id;
}

describe('cohort-topic / tier addressing (coord_d)', () => {
	const hash = createRingHash();
	const addr = createTierAddressing(hash);
	const topicA = seededBytes(32, 1);
	const topicB = seededBytes(32, 2);

	it('default fan-out is 16 and coords are full ring width (32 bytes)', () => {
		expect(addr.F).to.equal(DEFAULT_FANOUT);
		expect(addr.coord0(topicA)).to.have.length(32);
		expect(addr.coordD(2, seededBytes(32, 9), topicA)).to.have.length(32);
	});

	it('coord0 = H(0x00 ‖ topicId) and is peer-independent', () => {
		const c1 = addr.coord0(topicA);
		const c2 = addr.coord0(topicA);
		expect(hex(c1)).to.equal(hex(c2));
		// coord(0, anyPeer, topic) dispatches to coord0 — peer must not matter.
		expect(hex(addr.coord(0, seededBytes(32, 11), topicA))).to.equal(hex(c1));
		expect(hex(addr.coord(0, seededBytes(32, 22), topicA))).to.equal(hex(c1));
	});

	it('sibling convergence: peers sharing the first d·log2F bits get identical coordD', () => {
		// d=2, log2F=4 → 8-bit shared prefix. Vary the tail; coords must converge.
		const d = 2;
		const sharedBits = d * Math.log2(DEFAULT_FANOUT);
		const p1 = peerWithPrefix(sharedBits, 0xab, 100);
		const p2 = peerWithPrefix(sharedBits, 0xab, 200);
		const p3 = peerWithPrefix(sharedBits, 0xab, 300);
		const c1 = addr.coordD(d, p1, topicA);
		expect(hex(addr.coordD(d, p2, topicA))).to.equal(hex(c1));
		expect(hex(addr.coordD(d, p3, topicA))).to.equal(hex(c1));

		// A peer with a different prefix lands on a different coord.
		const other = peerWithPrefix(sharedBits, 0xcd, 100);
		expect(hex(addr.coordD(d, other, topicA))).to.not.equal(hex(c1));
	});

	it('deeper tiers require a longer shared prefix to converge', () => {
		// Peers share 8 bits but differ in bits 8..12. They converge at d=2 (8-bit prefix) but
		// diverge at d=3 (12-bit prefix).
		const p1 = peerWithPrefix(12, 0x12, 1);
		const p2 = peerWithPrefix(8, 0x12, 2); // bits 8..11 randomized via tail
		// Make p2 share the first 8 bits but (very likely) differ in bits 8..11.
		p2[1] = (p2[1]! & 0x0f) | 0x30; // high nibble 0x3 vs p1's 0x2 in byte 1 → differ at bit 8..11
		expect(hex(addr.coordD(2, p1, topicA))).to.equal(hex(addr.coordD(2, p2, topicA)));
		expect(hex(addr.coordD(3, p1, topicA))).to.not.equal(hex(addr.coordD(3, p2, topicA)));
	});

	it('cross-topic decorrelation: same peer/tier, different topic → different coord', () => {
		const p = seededBytes(32, 42);
		expect(hex(addr.coordD(2, p, topicA))).to.not.equal(hex(addr.coordD(2, p, topicB)));
		expect(hex(addr.coord0(topicA))).to.not.equal(hex(addr.coord0(topicB)));
	});

	it('cross-tier decorrelation: a tier-2 coord is not the tier-1 parent coord', () => {
		const p = seededBytes(32, 77);
		expect(hex(addr.coordD(1, p, topicA))).to.not.equal(hex(addr.coordD(2, p, topicA)));
		expect(hex(addr.coord0(topicA))).to.not.equal(hex(addr.coordD(1, p, topicA)));
	});

	it('coord_d collision rate: distinct (tier, prefix-shard, topic) triples never alias', () => {
		// Mirrors the simulator-validated finding (docs §Tier addressing, "coord_d collision rate"):
		// across many distinct ring positions × topics × tiers the substrate produces 0 collisions
		// (256-bit birthday bound is negligible). Convergence (same shard → same coord at a given
		// tier) is expected, so we key by the *canonical* (d, shard, topic) triple and only count a
		// collision when two distinct triples land on the same coord.
		const log2F = Math.log2(DEFAULT_FANOUT);
		const topics = [0, 1, 2, 3].map((i) => seededBytes(32, 500 + i));
		const coordToTriple = new Map<string, string>();
		const triples = new Set<string>();
		let collisions = 0;
		for (let pfx = 0; pfx < 64; pfx++) {
			// 6-bit distinct prefix in the top byte; pad the rest deterministically.
			const peer = peerWithPrefix(6, pfx << 2, 1000 + pfx);
			for (let t = 0; t < topics.length; t++) {
				for (let d = 0; d <= 5; d++) {
					const coord = hex(addr.coord(d, peer, topics[t]!));
					const shard = d === 0 ? '' : hex(prefixBits(peer, d * log2F));
					const triple = `t=${t},d=${d},shard=${shard}`;
					triples.add(triple);
					const prior = coordToTriple.get(coord);
					if (prior !== undefined && prior !== triple) collisions++;
					else coordToTriple.set(coord, triple);
				}
			}
		}
		// Sanity: convergence really did collapse evaluations into fewer distinct triples.
		expect(triples.size).to.be.greaterThan(64);
		expect(collisions).to.equal(0);
	});

	describe('prefixBits', () => {
		it('extracts the n MSBs, packed MSB-first with trailing low bits zeroed', () => {
			const p = Uint8Array.from([0b10110011, 0b11001100]);
			expect(Array.from(prefixBits(p, 0))).to.deep.equal([]);
			expect(Array.from(prefixBits(p, 4))).to.deep.equal([0b10110000]);
			expect(Array.from(prefixBits(p, 8))).to.deep.equal([0b10110011]);
			expect(Array.from(prefixBits(p, 12))).to.deep.equal([0b10110011, 0b11000000]);
			expect(Array.from(prefixBits(p, 16))).to.deep.equal([0b10110011, 0b11001100]);
		});

		it('left-pads when the peer id is shorter than n bits', () => {
			const p = Uint8Array.from([0b11000000]); // 8 bits available
			// Request 12 bits: 4 high zero pad bits, then the 8 bits of p, in 2 bytes.
			expect(Array.from(prefixBits(p, 12))).to.deep.equal([0b00001100, 0b00000000]);
		});

		it('rejects negative bit counts', () => {
			expect(() => prefixBits(Uint8Array.from([1]), -1)).to.throw(RangeError);
		});
	});

	describe('construction guards', () => {
		it('rejects non-power-of-two fan-out', () => {
			expect(() => new HashTierAddressing(hash, 10)).to.throw(RangeError);
			expect(() => new HashTierAddressing(hash, 1)).to.throw(RangeError);
		});

		it('accepts power-of-two fan-out and adjusts the prefix width', () => {
			// F=4 → log2F=2; tier d shares 2d bits.
			const a4 = createTierAddressing(hash, 4);
			expect(a4.F).to.equal(4);
			const p1 = peerWithPrefix(4, 0x90, 1); // share 4 bits → tier 2 (2·2=4) converges
			const p2 = peerWithPrefix(4, 0x90, 2);
			expect(hex(a4.coordD(2, p1, topicA))).to.equal(hex(a4.coordD(2, p2, topicA)));
		});

		it('coordD rejects d < 1', () => {
			expect(() => addr.coordD(0, seededBytes(32, 1), topicA)).to.throw(RangeError);
		});
	});
});
