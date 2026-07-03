/**
 * Unit tests for serializeIndexValue — the single shared per-value encoder for
 * secondary-index keys (consolidated from three byte-identical copies).
 *
 * These import the function directly from source (ts-node resolves the .ts) rather
 * than the compiled plugin bundle, because the invariant under test is a pure
 * property of the encoder, independent of the SQL/vtab layer.
 *
 * The parity assertions below are the DIRECT reproduction of the type-sensitive
 * orphan bug: the same logical integer is serialized as a `bigint` on INSERT (raw
 * Quereus row) but as a `number` when recomputed from a decoded stored row on
 * UPDATE/DELETE (RowCodec normalizes small bigints to Number). Before the fix the
 * bigint branch emitted `.toString()` ("5") while the number branch emitted
 * `.toExponential(15)` ("5.000000000000000e+0") — so the two keys differed and the
 * delete-of-old-key missed, orphaning a stale entry. This spec fails on that old
 * code and passes on the unified encoder.
 */

import { expect } from 'chai';
import { serializeIndexValue } from '../src/schema/index-manager.js';

describe('serializeIndexValue', () => {
	it('serializes a bigint identically to the equal number (the orphan-causing mismatch)', () => {
		expect(serializeIndexValue(5n)).to.equal(serializeIndexValue(5));
		expect(serializeIndexValue(20n)).to.equal(serializeIndexValue(20));
		expect(serializeIndexValue(0n)).to.equal(serializeIndexValue(0));
		expect(serializeIndexValue(-42n)).to.equal(serializeIndexValue(-42));
	});

	it('keeps the number branch on the toExponential(15) form (range-bound behavior unchanged)', () => {
		// Range scans against REAL columns rely on this lexicographic form; a plain
		// integer string would sort wrong against a stored fractional value.
		expect(serializeIndexValue(20)).to.equal((20).toExponential(15));
		expect(serializeIndexValue(20n)).to.equal((20).toExponential(15));
		expect(serializeIndexValue(29.99)).to.equal((29.99).toExponential(15));
	});

	it('maps NULL and undefined to the same NULL marker', () => {
		expect(serializeIndexValue(null)).to.equal('\x01');
		expect(serializeIndexValue(undefined as unknown as null)).to.equal('\x01');
	});

	it('passes strings through verbatim', () => {
		expect(serializeIndexValue('Tools')).to.equal('Tools');
		expect(serializeIndexValue('')).to.equal('');
	});

	it('stays self-consistent for a small bigint round-tripped through Number', () => {
		// The exact insert-vs-decoded-old shape: insert sees 20n, the decoded stored
		// row sees Number(20n) === 20. Both must key identically.
		const inserted = 20n;
		const decodedOld = Number(inserted);
		expect(serializeIndexValue(inserted)).to.equal(serializeIndexValue(decodedOld));
	});
});
