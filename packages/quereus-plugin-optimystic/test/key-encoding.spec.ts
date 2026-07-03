/**
 * Unit tests for the order-preserving, injective tuple framing (key-encoding.ts).
 *
 * Imported from source (ts-node resolves the .ts) since the invariants under test are
 * pure properties of the encoder, independent of the SQL/vtab layer. These are the
 * regression guard for the three collision classes the framing fixes:
 *   1. a payload containing the old raw \x00 separator,
 *   2. an index prefix-range that over-matches a value sharing a prefix,
 *   3. a real value equal to the old NULL sentinel colliding with SQL NULL.
 */

import { expect } from 'chai';
import {
	encodeKeyElement,
	encodeKeyTuple,
	splitKeyTuple,
	KEY_PREFIX_END,
	type DecodedKeyElement,
} from '../src/schema/key-encoding.js';

/** Re-materialize a tuple's payloads/nulls for round-trip comparison. */
const decode = (encoded: string): Array<string | null> =>
	splitKeyTuple(encoded).map((e: DecodedKeyElement) => (e.isNull ? null : e.payload));

describe('key-encoding tuple framing', () => {
	describe('round-trip (encode -> split)', () => {
		const cases: Array<{ name: string; payloads: Array<string | null> }> = [
			{ name: 'single present string', payloads: ['abc'] },
			{ name: 'empty string', payloads: [''] },
			{ name: 'single NULL', payloads: [null] },
			{ name: 'composite present', payloads: ['foo', 'bar'] },
			{ name: 'composite with NULL in the middle', payloads: ['foo', null, 'baz'] },
			{ name: 'payload containing the separator \\x00', payloads: ['foo\x00bar'] },
			{ name: 'payload of only \\x00 bytes', payloads: ['\x00\x00\x00'] },
			{ name: 'payload containing \\x00\\xff (escape look-alike)', payloads: ['a\x00\xffb'] },
			{ name: 'payload containing \\x01 and \\xff', payloads: ['\x01x\xff'] },
			{ name: 'old NULL sentinel as a real value', payloads: ['\x01NULL\x01'] },
			{ name: 'mixed NULL/empty/separator', payloads: [null, '', 'a\x00b', null] },
		];

		for (const { name, payloads } of cases) {
			it(`round-trips ${name}`, () => {
				expect(decode(encodeKeyTuple(payloads))).to.deep.equal(payloads);
			});
		}
	});

	describe('injectivity (distinct tuples -> distinct encodings)', () => {
		it('does not collide when a value contains the separator (boundary shift)', () => {
			// The original bug: ['foo\x00bar','baz'] and ['foo','bar'] both joined to
			// 'foo\x00bar' regions. Framed, they are distinct.
			expect(encodeKeyTuple(['foo\x00bar', 'baz'])).to.not.equal(encodeKeyTuple(['foo', 'bar']));
			expect(encodeKeyTuple(['a\x00', 'b'])).to.not.equal(encodeKeyTuple(['a', '\x00b']));
		});

		it('keeps NULL distinct from empty string and from the old sentinel', () => {
			const nul = encodeKeyTuple([null]);
			expect(nul).to.not.equal(encodeKeyTuple(['']));
			expect(nul).to.not.equal(encodeKeyTuple(['\x01NULL\x01']));
			expect(nul).to.not.equal(encodeKeyTuple(['\x01']));
		});
	});

	describe('order preservation (raw lexicographic comparison)', () => {
		it('sorts NULL before every present value', () => {
			expect(encodeKeyElement(null) < encodeKeyElement('')).to.equal(true);
			expect(encodeKeyElement(null) < encodeKeyElement('\x00')).to.equal(true);
			expect(encodeKeyElement(null) < encodeKeyElement('anything')).to.equal(true);
		});

		it('preserves payload ordering for present values (including prefixes and embedded NUL)', () => {
			// Values in strictly ascending payload order; their framings must match.
			const ascending = ['', '\x00', '\x00\x00', 'a', 'a\x00', 'aa', 'ab', 'b'];
			for (let i = 1; i < ascending.length; i++) {
				const lo = encodeKeyElement(ascending[i - 1]!);
				const hi = encodeKeyElement(ascending[i]!);
				expect(lo < hi, `${JSON.stringify(ascending[i - 1])} should frame below ${JSON.stringify(ascending[i])}`)
					.to.equal(true);
			}
		});

		it('preserves ordering across full tuples (first differing element wins)', () => {
			const tuples: Array<Array<string | null>> = [
				[null, 'z'],
				['a', 'a'],
				['a', 'a\x00'],
				['a', 'b'],
				['a\x00', ''],
				['aa', ''],
				['b', null],
			];
			const encoded = tuples.map(encodeKeyTuple);
			const sorted = [...encoded].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			expect(sorted).to.deep.equal(encoded);
		});
	});

	describe('framed prefix-range isolation (KEY_PREFIX_END)', () => {
		// Simulate the findByIndexIn bracket: [P, P + KEY_PREFIX_END).
		const inRange = (treeKey: string, prefix: string): boolean =>
			treeKey >= prefix && treeKey < prefix + KEY_PREFIX_END;

		// A tree key is frame(indexValue) followed by frame(primaryKey).
		const treeKey = (indexValue: string | null, pk: string): string =>
			encodeKeyElement(indexValue) + encodeKeyElement(pk);

		it("a lookup for 'b' matches only 'b' entries, not 'b\\x00' or 'bb'", () => {
			const P = encodeKeyElement('b'); // framed prefix for the point lookup on 'b'

			expect(inRange(treeKey('b', '1'), P), "'b'/pk=1 is in range").to.equal(true);
			expect(inRange(treeKey('b', '999'), P), "'b'/pk=999 is in range").to.equal(true);

			// The critical leak-in the naive `final \x00 -> \x01` successor would wrongly
			// admit: 'b\x00' frames to '\x02b\x00\xff\x00', which has frame('b') as a
			// prefix. KEY_PREFIX_END (\x03 > the \xff continuation) excludes it.
			expect(inRange(treeKey('b\x00', '1'), P), "'b\\x00' must NOT match 'b'").to.equal(false);
			expect(inRange(treeKey('bb', '1'), P), "'bb' must NOT match 'b'").to.equal(false);
			expect(inRange(treeKey('a', '1'), P), "'a' must NOT match 'b'").to.equal(false);
			expect(inRange(treeKey('c', '1'), P), "'c' must NOT match 'b'").to.equal(false);
		});

		it('a NULL lookup matches only NULL entries, not present values', () => {
			const P = encodeKeyElement(null);
			expect(inRange(treeKey(null, '1'), P), 'NULL entry in range').to.equal(true);
			expect(inRange(treeKey('', '1'), P), "empty-string entry must NOT match NULL").to.equal(false);
			expect(inRange(treeKey('x', '1'), P), "present entry must NOT match NULL").to.equal(false);
		});

		it('a partial composite prefix matches every entry sharing that leading column', () => {
			// Index (col0, col1); a seek that only specifies col0='a' frames just col0
			// and prefix-matches any col1.
			const P = encodeKeyTuple(['a']);
			const full = (c0: string, c1: string, pk: string) => encodeKeyTuple([c0, c1]) + encodeKeyElement(pk);
			expect(inRange(full('a', 'x', '1'), P)).to.equal(true);
			expect(inRange(full('a', 'y', '2'), P)).to.equal(true);
			expect(inRange(full('a\x00', 'x', '1'), P), "'a\\x00' col0 must NOT match 'a'").to.equal(false);
			expect(inRange(full('ab', 'x', '1'), P), "'ab' col0 must NOT match 'a'").to.equal(false);
		});
	});

	describe('splitKeyTuple robustness', () => {
		it('tolerates a truncated present element without looping', () => {
			// Missing terminator (corrupt input): emit accumulated payload, do not hang.
			expect(splitKeyTuple('\x02abc')).to.deep.equal([{ isNull: false, payload: 'abc' }]);
		});

		it('decodes an escaped-NUL that ends the string', () => {
			// '\x02' + escape('\x00') + terminator = '\x02\x00\xff\x00'
			expect(splitKeyTuple('\x02\x00\xff\x00')).to.deep.equal([{ isNull: false, payload: '\x00' }]);
		});
	});
});
