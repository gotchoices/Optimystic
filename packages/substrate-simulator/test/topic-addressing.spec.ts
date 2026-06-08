import { expect } from 'chai';
import { RingModel, type RingCoord } from '../src/ring-model.js';
import { bytesToHex } from '../src/hex.js';
import {
	coordForTier,
	coord0,
	buildCoordLadder,
	prefixBits,
	log2F,
	deriveTopicId,
	DEFAULT_TIER_ADDRESS_CONFIG
} from '../src/topic-addressing.js';

const ring = new RingModel();

/** A deterministic 256-bit ring position from a seed byte. */
async function positionOf(seed: number): Promise<RingCoord> {
	return ring.coordOf(Uint8Array.of(seed));
}

describe('topic-addressing — prefixBits', () => {
	it('takes the top n bits, zeroes the partial byte, and groups shared prefixes', () => {
		const p = Uint8Array.of(0b1011_0110, 0b1111_0000, 0x42);
		// 0 bits → empty.
		expect(prefixBits(p, 0)).to.deep.equal(new Uint8Array(0));
		// 4 bits → top nibble of byte 0, low nibble zeroed.
		expect([...prefixBits(p, 4)]).to.deep.equal([0b1011_0000]);
		// 8 bits → exactly byte 0.
		expect([...prefixBits(p, 8)]).to.deep.equal([0b1011_0110]);
		// 12 bits → byte 0 + top nibble of byte 1.
		expect([...prefixBits(p, 12)]).to.deep.equal([0b1011_0110, 0b1111_0000]);
	});

	it('two coords sharing the first n bits produce identical prefix bytes', () => {
		const a = Uint8Array.of(0b1010_1111, 0b0000_1111);
		const b = Uint8Array.of(0b1010_0000, 0b1111_0000); // shares top 4 bits with a
		expect(prefixBits(a, 4)).to.deep.equal(prefixBits(b, 4));
		expect(prefixBits(a, 8)).to.not.deep.equal(prefixBits(b, 8));
	});

	it('rejects bit counts past the coord width', () => {
		expect(() => prefixBits(Uint8Array.of(1), 9)).to.throw(RangeError);
	});
});

describe('topic-addressing — log2F', () => {
	it('is log₂ for powers of two and rejects non-powers', () => {
		expect(log2F(16)).to.equal(4);
		expect(log2F(2)).to.equal(1);
		expect(() => log2F(10)).to.throw(RangeError);
		expect(() => log2F(1)).to.throw(RangeError);
	});
});

describe('topic-addressing — coord derivation', () => {
	it('coord_0 equals H(0x00 ‖ topicId) and matches the d=0 general form', async () => {
		const topicId = deriveTopicId('alpha');
		const direct = await ring.coordOf(Uint8Array.of(0, ...topicId));
		const c0 = await coord0(ring, topicId);
		expect(bytesToHex(c0)).to.equal(bytesToHex(direct));
		// d = 0 of the general form ignores P and reduces to coord_0.
		const viaTier = await coordForTier(ring, await positionOf(99), topicId, 0);
		expect(bytesToHex(viaTier)).to.equal(bytesToHex(c0));
	});

	it('is deterministic in (P-prefix, topicId, tier)', async () => {
		const topicId = deriveTopicId('beta');
		const p = await positionOf(7);
		const first = await coordForTier(ring, p, topicId, 2);
		const again = await coordForTier(ring, p, topicId, 2);
		expect(bytesToHex(first)).to.equal(bytesToHex(again));
	});

	it('peers sharing a d·log₂F-bit prefix converge on one tier-d coord; others diverge', async () => {
		const topicId = deriveTopicId('gamma');
		// Two positions identical in their top 8 bits (= tier-2 prefix, 2·log₂16 = 8) but not top 12.
		const a = Uint8Array.of(0xab, 0x10, ...new Uint8Array(30));
		const b = Uint8Array.of(0xab, 0x2f, ...new Uint8Array(30));
		const ca = await coordForTier(ring, a, topicId, 2);
		const cb = await coordForTier(ring, b, topicId, 2);
		expect(bytesToHex(ca)).to.equal(bytesToHex(cb)); // same tier-2 cohort
		// At tier 3 (12-bit prefix) the second nibble of byte 1 differs → distinct cohorts.
		const c3a = await coordForTier(ring, a, topicId, 3);
		const c3b = await coordForTier(ring, b, topicId, 3);
		expect(bytesToHex(c3a)).to.not.equal(bytesToHex(c3b));
	});
});

describe('topic-addressing — coord_d collision rate (records the fold-back measurement)', () => {
	it('produces zero collisions across many tiers, prefixes, and topics', async function () {
		this.timeout(20000);
		const cfg = DEFAULT_TIER_ADDRESS_CONFIG;
		const topics = [deriveTopicId('t0'), deriveTopicId('t1'), deriveTopicId('t2'), deriveTopicId('t3')];
		const seen = new Map<string, string>();
		let total = 0;
		let collisions = 0;
		// 64 distinct ring positions × 4 topics × tiers 0..5.
		for (let s = 0; s < 64; s++) {
			const p = await positionOf(s);
			for (let ti = 0; ti < topics.length; ti++) {
				const ladder = await buildCoordLadder(ring, p, topics[ti]!, 5, cfg);
				for (let d = 0; d < ladder.length; d++) {
					const hex = bytesToHex(ladder[d]!);
					// Expected coords coincide only when (tier, prefix, topic) coincide; tag with those.
					const tag = `${ti}:${d}:${bytesToHex(prefixBits(p, d * log2F(cfg.F)))}`;
					const prior = seen.get(hex);
					if (prior !== undefined && prior !== tag) {
						collisions++;
					}
					seen.set(hex, tag);
					total++;
				}
			}
		}
		// Documented bound: with 256-bit sha256 coords the expected collision rate is ~0
		// (birthday bound ≈ total² / 2^257, negligible). Recorded for fold-simulator-findings.
		expect(collisions, `collisions over ${total} coords`).to.equal(0);
	});
});
