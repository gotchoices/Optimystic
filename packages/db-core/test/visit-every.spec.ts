/**
 * `visitEveryThenThrow` — the loop a rollback restores its collections with. The contract it pins:
 * a throw from one visit stops none of the others, and the first error is what escapes.
 */

import { expect } from 'chai';
import { visitEveryThenThrow } from '../src/index.js';

describe('visitEveryThenThrow', () => {
	it('visits every item after one throws, in order, and throws the first error', async () => {
		const visited: number[] = [];
		const first = new Error('first');
		let caught: unknown;
		try {
			await visitEveryThenThrow([1, 2, 3, 4], async item => {
				visited.push(item);
				if (item === 2) throw first;
				if (item === 3) throw new Error('second');
			});
		} catch (err) {
			caught = err;
		}
		expect(visited).to.deep.equal([1, 2, 3, 4]);
		expect(caught).to.equal(first);
	});
});
