import { expect } from 'chai';
import { RingHash, RING_BITS } from '@optimystic/db-core';
import { hashKey } from 'p2p-fret';

/**
 * Coord byte-compatibility assertion (deferred from `cohort-topic-package-layering`).
 *
 * db-core cannot import FRET, so the guarantee that its ring coords line up byte-for-byte with FRET's
 * on the wire has no home until this package — the only one allowed to import both. Coords agreeing on
 * the wire (`coord_d` routing keys vs FRET's routing ring) depends entirely on this; without the test
 * it is asserted only by design (both are SHA-256 at 256-bit ring width), never by code.
 */
describe('cohort-topic: FRET coord byte-compat', () => {
	it('db-core RingHash().H(x) equals FRET hashKey(x) byte-for-byte at RING_BITS=256', async () => {
		// FRET pins its ring to 256 bits (RING_BITS in its ring/hash module); db-core mirrors it.
		expect(RING_BITS).to.equal(256);
		const hash = new RingHash(); // default 256-bit ring → full SHA-256 digest

		const inputs: Uint8Array[] = [
			new Uint8Array(0),
			new Uint8Array([0x00]),
			new Uint8Array([0x00, 0x01, 0x02, 0x03]),
			Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) & 0xff),
			new TextEncoder().encode('optimystic/cohort-topic'),
		];

		for (const input of inputs) {
			const core = hash.H(input);
			const fret = await hashKey(input);
			expect(core.length, 'digest length').to.equal(32);
			expect(fret.length, 'fret digest length').to.equal(32);
			expect(Array.from(core), `coord mismatch for input length ${input.length}`).to.deep.equal(Array.from(fret));
		}
	});
});
