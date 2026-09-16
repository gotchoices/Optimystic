/**
 * `structuralEquals` — the comparison behind the tree's `unchanged` entry guard.
 *
 * The cases that matter are the ones where one side has crossed an encoding boundary and the
 * other has not: reordered object keys, a dropped `undefined` property, and `Uint8Array` leaves
 * that are byte-identical but not the same object. A guard that refuses on any of those would
 * refuse every honest write, so each is pinned here rather than left to the guard's own specs.
 */

import { expect } from 'chai';
import { structuralEquals } from '../src/index.js';

describe('structuralEquals', () => {
	describe('primitives', () => {
		it('compares by value, and distinguishes types', () => {
			expect(structuralEquals(1, 1)).to.be.true;
			expect(structuralEquals('a', 'a')).to.be.true;
			expect(structuralEquals(true, true)).to.be.true;
			expect(structuralEquals(null, null)).to.be.true;
			expect(structuralEquals(undefined, undefined)).to.be.true;
			expect(structuralEquals(1, 2)).to.be.false;
			expect(structuralEquals(1, '1')).to.be.false;
			expect(structuralEquals(0, false)).to.be.false;
			expect(structuralEquals(null, undefined)).to.be.false;
			expect(structuralEquals(null, {})).to.be.false;
		});

		it('treats NaN as equal to itself — a guard that can never accept its own value is a trap', () => {
			expect(structuralEquals(NaN, NaN)).to.be.true;
			expect(structuralEquals(NaN, 0)).to.be.false;
		});
	});

	describe('objects', () => {
		it('ignores key order (an encoder may sort keys; the value did not change)', () => {
			expect(structuralEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).to.be.true;
		});

		it('compares nested structure recursively', () => {
			expect(structuralEquals({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x' }] } })).to.be.true;
			expect(structuralEquals({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'y' }] } })).to.be.false;
		});

		it('treats an undefined-valued key as absent, matching what JSON does to it', () => {
			expect(structuralEquals({ a: 1, b: undefined }, { a: 1 })).to.be.true;
			expect(structuralEquals({ a: 1 }, { a: 1, b: undefined })).to.be.true;
			// A key defined on one side and undefined on the other is still a difference in VALUE.
			expect(structuralEquals({ a: 1, b: 2 }, { a: 1, b: undefined })).to.be.false;
		});

		it('detects extra, missing and differing keys', () => {
			expect(structuralEquals({ a: 1 }, { a: 1, b: 2 })).to.be.false;
			expect(structuralEquals({ a: 1, b: 2 }, { a: 1 })).to.be.false;
			expect(structuralEquals({ a: 1 }, { b: 1 })).to.be.false;
		});
	});

	describe('arrays', () => {
		it('compares element-wise, in order', () => {
			expect(structuralEquals([1, 'a', null], [1, 'a', null])).to.be.true;
			expect(structuralEquals([1, 2], [2, 1])).to.be.false;
			expect(structuralEquals([1, 2], [1, 2, 3])).to.be.false;
		});

		it('is not interchangeable with an object of numeric keys', () => {
			expect(structuralEquals([1, 2], { 0: 1, 1: 2 })).to.be.false;
		});
	});

	describe('Uint8Array', () => {
		it('compares by bytes, not identity', () => {
			expect(structuralEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).to.be.true;
			expect(structuralEquals(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).to.be.false;
			expect(structuralEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).to.be.false;
			expect(structuralEquals(new Uint8Array(), new Uint8Array())).to.be.true;
		});

		it('is never equal to a plain array or object carrying the same indices', () => {
			// A different ENCODING of the same value is a real difference — accepting it would let
			// an encoding change slip past a guard unnoticed.
			expect(structuralEquals(new Uint8Array([1, 2]), [1, 2])).to.be.false;
			expect(structuralEquals(new Uint8Array([1, 2]), { 0: 1, 1: 2 })).to.be.false;
		});

		it('compares nested inside an entry-shaped value', () => {
			const left = { key: 1, blob: new Uint8Array([7, 8, 9]) };
			const right = { blob: new Uint8Array([7, 8, 9]), key: 1 };
			expect(structuralEquals(left, right)).to.be.true;
			expect(structuralEquals(left, { key: 1, blob: new Uint8Array([7, 8, 0]) })).to.be.false;
		});
	});

	// NOTE: `structuredClone` is the IN-PROCESS transport (what the test transactors do), not the
	// real one — the p2p repo protocol is JSON, which does not preserve a `Uint8Array`. See the
	// second NOTE on `structuralEquals` for why no entry type reaches that gap today.
	it('survives a structuredClone round trip (the in-process transport the test transactors use)', () => {
		const entry = { key: 1, name: 'a', tags: ['x', 'y'], blob: new Uint8Array([1, 2, 3]) };
		expect(structuralEquals(entry, structuredClone(entry))).to.be.true;
	});
});
