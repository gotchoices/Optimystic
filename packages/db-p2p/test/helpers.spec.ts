import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mergeRanges } from '../src/storage/helpers.js';

describe('mergeRanges', () => {
	it('returns empty array for empty input', () => {
		assert.deepStrictEqual(mergeRanges([]), []);
	});

	it('returns single range unchanged', () => {
		assert.deepStrictEqual(mergeRanges([[0, 10]]), [[0, 10]]);
	});

	it('returns open-ended single range unchanged', () => {
		assert.deepStrictEqual(mergeRanges([[5]]), [[5]]);
	});

	it('merges adjacent ranges', () => {
		const result = mergeRanges([[0, 5], [5, 10]]);
		assert.deepStrictEqual(result, [[0, 10]]);
	});

	it('merges overlapping ranges', () => {
		const result = mergeRanges([[0, 7], [5, 10]]);
		assert.deepStrictEqual(result, [[0, 10]]);
	});

	it('keeps non-overlapping ranges separate', () => {
		const result = mergeRanges([[0, 5], [10, 15]]);
		assert.deepStrictEqual(result, [[0, 5], [10, 15]]);
	});

	it('handles unsorted input', () => {
		const result = mergeRanges([[10, 15], [0, 5], [5, 10]]);
		assert.deepStrictEqual(result, [[0, 15]]);
	});

	it('open-ended range consumes all following ranges', () => {
		// [3] is open-ended starting at 3, merges with [0, 5] to become [0, undefined]
		// which then consumes [10, 20]
		const result = mergeRanges([[0, 5], [3], [10, 20]]);
		// After sorting: [[0, 5], [3, undefined], [10, 20]]
		// [3, undefined] starts at 3 <= 5, so [0, 5] becomes [0, undefined]
		// [10, 20] is skipped because last is open-ended
		assert.deepStrictEqual(result, [[0, undefined]]);
	});

	it('extends closed range to open when merging with open-ended', () => {
		// [5] is [5, undefined], merges with [0, 10] because 5 <= 10
		const result = mergeRanges([[0, 10], [5]]);
		assert.deepStrictEqual(result, [[0, undefined]]);
	});

	it('handles multiple disjoint ranges correctly', () => {
		const result = mergeRanges([[0, 3], [5, 8], [10, 13], [15, 18]]);
		assert.deepStrictEqual(result, [[0, 3], [5, 8], [10, 13], [15, 18]]);
	});

	it('handles complex merge scenario', () => {
		// Ranges: [0-5], [4-8], [10-12], [11-15], [20-∞]
		const result = mergeRanges([[0, 5], [4, 8], [10, 12], [11, 15], [20]]);
		assert.deepStrictEqual(result, [[0, 8], [10, 15], [20]]);
	});

	it('handles touching but not overlapping ranges (exclusive end)', () => {
		// [0, 5) and [5, 10) should merge because 5 <= 5
		const result = mergeRanges([[0, 5], [5, 10]]);
		assert.deepStrictEqual(result, [[0, 10]]);
	});

	it('handles gap of 1 between ranges', () => {
		// [0, 5) and [6, 10) have gap at position 5
		const result = mergeRanges([[0, 5], [6, 10]]);
		assert.deepStrictEqual(result, [[0, 5], [6, 10]]);
	});

	it('handles identical ranges', () => {
		const result = mergeRanges([[5, 10], [5, 10], [5, 10]]);
		assert.deepStrictEqual(result, [[5, 10]]);
	});

	it('handles contained ranges', () => {
		// [0, 20) contains [5, 10)
		const result = mergeRanges([[0, 20], [5, 10]]);
		assert.deepStrictEqual(result, [[0, 20]]);
	});

	it('extends to larger end value when merging', () => {
		const result = mergeRanges([[0, 5], [3, 15]]);
		assert.deepStrictEqual(result, [[0, 15]]);
	});
});
