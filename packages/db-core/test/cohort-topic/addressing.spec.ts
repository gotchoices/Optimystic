import { expect } from 'chai';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import {
	createTierAddressing,
	HashTierAddressing,
	prefixBits,
	DEFAULT_FANOUT,
} from '../../src/cohort-topic/addressing.js';
import { bytesToB64url, b64urlToBytes } from '../../src/cohort-topic/wire/codec.js';

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

	it('sibling convergence: peers sharing the first d·log2F bits of H(P) get identical coordD', () => {
		// coord_d uses prefix(H(P), d·log₂F) as the shard input. Two peers whose H(P) values share
		// the same first d·log₂F bits land in the same shard → same coord at that tier.
		// d=1, log₂F=4 → 4-bit shard (16 buckets). Find two seeded peers with matching first nibble of H(P).
		const d = 1;
		const sharedBits = d * Math.log2(DEFAULT_FANOUT); // 4
		const seen = new Map<string, Uint8Array>();
		let p1: Uint8Array | undefined, p2: Uint8Array | undefined;
		for (let s = 0; s < 200 && p2 === undefined; s++) {
			const p = seededBytes(32, s);
			const pfx = hex(prefixBits(hash.H(p), sharedBits));
			const prior = seen.get(pfx);
			if (prior !== undefined) { p1 = prior; p2 = p; }
			else seen.set(pfx, p);
		}
		expect(p1, 'found a converging pair in range').to.not.be.undefined;
		// Same H(P) prefix → same tier-d coord.
		const c1 = addr.coordD(d, p1!, topicA);
		expect(hex(addr.coordD(d, p2!, topicA))).to.equal(hex(c1));

		// A peer with a different H(P) prefix → different coord.
		const pfx1 = hex(prefixBits(hash.H(p1!), sharedBits));
		let pOther: Uint8Array | undefined;
		for (let s = 200; s < 400; s++) {
			const p = seededBytes(32, s);
			if (hex(prefixBits(hash.H(p), sharedBits)) !== pfx1) { pOther = p; break; }
		}
		expect(pOther, 'found a non-matching peer in range').to.not.be.undefined;
		expect(hex(addr.coordD(d, pOther!, topicA))).to.not.equal(hex(c1));
	});

	it('deeper tiers require a longer shared H(P) prefix to converge', () => {
		// At tier d, the shard is prefix(H(P), d·log₂F). Peers sharing the same first 8 bits of H(P)
		// converge at d=2 (2·4=8 bits) but diverge at d=3 (3·4=12 bits) if bits 8-11 of H(P) differ.
		const d2Bits = 2 * Math.log2(DEFAULT_FANOUT); // 8
		const d3Bits = 3 * Math.log2(DEFAULT_FANOUT); // 12
		// Find two seeds sharing d2Bits of H(P) but differing at d3Bits.
		const byPrefix8 = new Map<string, Array<{ seed: number; hp: Uint8Array }>>();
		let p1: Uint8Array | undefined, p2: Uint8Array | undefined;
		outer: for (let s = 0; s < 2000; s++) {
			const peer = seededBytes(32, s);
			const hp = hash.H(peer);
			const pfx8 = hex(prefixBits(hp, d2Bits));
			const pfx12 = hex(prefixBits(hp, d3Bits));
			const group = byPrefix8.get(pfx8) ?? [];
			for (const { seed, hp: chp } of group) {
				if (hex(prefixBits(chp, d3Bits)) !== pfx12) {
					p1 = seededBytes(32, seed);
					p2 = peer;
					break outer;
				}
			}
			group.push({ seed: s, hp });
			byPrefix8.set(pfx8, group);
		}
		expect(p1, 'found a pair sharing 8 bits but not 12 of H(P)').to.not.be.undefined;
		expect(hex(addr.coordD(2, p1!, topicA))).to.equal(hex(addr.coordD(2, p2!, topicA)));
		expect(hex(addr.coordD(3, p1!, topicA))).to.not.equal(hex(addr.coordD(3, p2!, topicA)));
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

	it('coord_d collision rate: distinct (tier, H(P)-shard, topic) triples never alias', () => {
		// Mirrors the simulator-validated finding (docs §Tier addressing, "coord_d collision rate"):
		// across many distinct ring positions × topics × tiers the substrate produces 0 collisions
		// (256-bit birthday bound is negligible). Convergence (same H(P) shard → same coord at a
		// given tier) is expected, so we key by the *canonical* (d, H(P)-shard, topic) triple and
		// only count a collision when two distinct triples land on the same coord.
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
					// Shard key is the H(P) prefix (matches the actual convergence criterion after the fix).
					const shard = d === 0 ? '' : hex(prefixBits(hash.H(peer), d * log2F));
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

	it('routing-vs-recompute equality: coord(d, self, topic) equals coord(d, b64urlToBytes(bytesToB64url(self)), topic)', () => {
		// The walk routes on coord(d, self, topicId); the host recomputes from the wire field
		// participantCoord = bytesToB64url(self). The b64url round-trip must be lossless so both
		// parties agree on the same coord at every tier.
		const self = seededBytes(32, 42);
		const participantCoord = bytesToB64url(self);
		const recovered = b64urlToBytes(participantCoord);
		for (const d of [0, 1, 2] as const) {
			expect(hex(addr.coord(d, self, topicA))).to.equal(
				hex(addr.coord(d, recovered, topicA)),
				`d=${d}`,
			);
		}
	});

	it('parent/child recompute equality: parent recomputes the child-participant coord identically at d=1 and d=2', () => {
		// A promoted child's self-routed coord(d, childSelf, topicId) must equal the parent's
		// recompute from the wire: coord(d, b64urlToBytes(childParticipantCoord), topicId).
		// Both parentCoord derivations and the child-link recompute flow through coordD, so a single
		// b64url-round-trip check covers all call sites.
		const childSelf = seededBytes(32, 77);
		const childParticipantCoord = bytesToB64url(childSelf);
		const childSelfRecovered = b64urlToBytes(childParticipantCoord);
		expect(hex(addr.coord(1, childSelf, topicA))).to.equal(
			hex(addr.coord(1, childSelfRecovered, topicA)),
			'd=1 child self-route == parent recompute',
		);
		expect(hex(addr.coord(2, childSelf, topicA))).to.equal(
			hex(addr.coord(2, childSelfRecovered, topicA)),
			'd=2 child self-route == parent recompute',
		);
	});

	it('H(P) shard is uniform across participants; raw peer-id-string prefix collapses (negative control)', () => {
		// Simulate peer ids whose leading byte is the constant ASCII '1' — matching the "12D3Koo…"
		// prefix shared by every Ed25519 libp2p peer-id string.  With d=1, log₂F=4: 4-bit shard →
		// 16 possible buckets.
		const LIBP2P_PEER_ID_PREFIX_BYTE = 0x31; // ASCII '1'
		const d = 1;
		const shardBits = d * Math.log2(DEFAULT_FANOUT); // 4

		const uniformShards = new Set<string>();
		const rawShards = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const peer = seededBytes(32, 2000 + i);
			peer[0] = LIBP2P_PEER_ID_PREFIX_BYTE;
			uniformShards.add(hex(prefixBits(hash.H(peer), shardBits)));
			rawShards.add(hex(prefixBits(peer, shardBits)));
		}

		// H(P) shard fans across the available buckets (at least 12 of 16 with 100 samples).
		expect(uniformShards.size).to.be.greaterThan(12);
		// Raw peer-id-string prefix collapses to exactly 1 bucket (the bug this fix resolves).
		expect(rawShards.size).to.equal(1);
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
			// F=4 → log₂F=2; tier d uses the first 2d bits of H(P) as the shard.
			const a4 = createTierAddressing(hash, 4);
			expect(a4.F).to.equal(4);
			// Find two peers whose H(P) shares the first 4 bits (tier 2, 2·2=4 bits) → same coord.
			const seen = new Map<string, Uint8Array>();
			let p1: Uint8Array | undefined, p2: Uint8Array | undefined;
			for (let s = 0; s < 200 && p2 === undefined; s++) {
				const p = seededBytes(32, s);
				const pfx = hex(prefixBits(hash.H(p), 4));
				const prior = seen.get(pfx);
				if (prior !== undefined) { p1 = prior; p2 = p; }
				else seen.set(pfx, p);
			}
			expect(p1, 'found a converging pair').to.not.be.undefined;
			expect(hex(a4.coordD(2, p1!, topicA))).to.equal(hex(a4.coordD(2, p2!, topicA)));
		});

		it('coordD rejects d < 1', () => {
			expect(() => addr.coordD(0, seededBytes(32, 1), topicA)).to.throw(RangeError);
		});
	});
});
