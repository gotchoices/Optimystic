import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { RingHash, createRingHash, RING_BITS } from '../src/cohort-topic/ring-hash.js';

describe('RingHash', () => {
	it('at the default 256-bit width returns the full SHA-256 digest (FRET-compatible)', () => {
		const h = createRingHash();
		expect(h.ringBits).to.equal(RING_BITS).and.to.equal(256);
		const input = new TextEncoder().encode('topic');
		expect([...h.H(input)]).to.deep.equal([...sha256(input)]);
	});

	it('is deterministic', () => {
		const h = new RingHash();
		const a = new TextEncoder().encode('same');
		expect([...h.H(a)]).to.deep.equal([...h.H(a)]);
	});

	it('truncates to ceil(ringBits/8) bytes for byte-aligned widths', () => {
		const h = new RingHash(64);
		const out = h.H(new TextEncoder().encode('x'));
		expect(out.length).to.equal(8);
		expect([...out]).to.deep.equal([...sha256(new TextEncoder().encode('x')).slice(0, 8)]);
	});

	it('zeroes the unused low bits of the trailing partial byte', () => {
		const h = new RingHash(12); // 2 bytes, low 4 bits of byte 1 masked off
		const out = h.H(new TextEncoder().encode('y'));
		expect(out.length).to.equal(2);
		expect(out[1]! & 0x0f).to.equal(0);
		// coords sharing the first 12 bits collapse to identical bytes
		const full = sha256(new TextEncoder().encode('y'));
		expect(out[0]).to.equal(full[0]);
		expect(out[1]).to.equal(full[1]! & 0xf0);
	});

	it('rejects out-of-range ring widths', () => {
		expect(() => new RingHash(0)).to.throw(RangeError);
		expect(() => new RingHash(257)).to.throw(RangeError);
		expect(() => new RingHash(1.5)).to.throw(RangeError);
	});
});
