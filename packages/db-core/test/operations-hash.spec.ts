import { expect } from 'chai';
import {
	collectOperations,
	hashOperations,
	canonicalStringify,
	type Transforms,
	type IBlock,
} from '../src/index.js';

/**
 * Build the b1 IBlock two ways with the SAME content but DIFFERENT object-key
 * insertion order (both at the header level and in a nested object). A canonical
 * encoder must hash these identically; plain JSON.stringify would not.
 */
function makeBlockB1(order: 'forward' | 'reverse'): IBlock {
	if (order === 'forward') {
		const header = { id: 'b1', type: 'data', collectionId: 'users' };
		const nested = { alpha: 1, beta: 2 };
		return { header, name: 'Alice', nested, tags: [3, 1, 2] } as unknown as IBlock;
	}
	// Reverse key-insertion order everywhere; identical logical content.
	const header = { collectionId: 'users', type: 'data', id: 'b1' };
	const nested = { beta: 2, alpha: 1 };
	const block: Record<string, unknown> = {};
	block['tags'] = [3, 1, 2];      // array order preserved (must match forward)
	block['nested'] = nested;
	block['name'] = 'Alice';
	block['header'] = header;
	return block as unknown as IBlock;
}

function simpleBlock(id: string, collectionId: string): IBlock {
	return { header: { id, type: 'data', collectionId } } as IBlock;
}

describe('operations-hash', () => {
	describe('hashOperations order-independence', () => {
		// The same logical set of operations, assembled two different ways.
		const sharedUpdateOps = [
			['entity1', 0, 0, [10, 20]] as const,
			['entity2', 1, 1, { k: 'v' }] as const,
		];

		function buildMapA(): Map<string, Transforms> {
			const map = new Map<string, Transforms>();
			// Collections inserted users-then-posts; block keys b1-then-b2.
			map.set('users', {
				inserts: { b1: makeBlockB1('forward'), b2: simpleBlock('b2', 'users') },
				updates: { b3: sharedUpdateOps.map(o => [...o]) as any },
				deletes: ['d1', 'd2'],
			});
			map.set('posts', {
				inserts: { p1: simpleBlock('p1', 'posts') },
			});
			return map;
		}

		function buildMapB(): Map<string, Transforms> {
			const map = new Map<string, Transforms>();
			// Collections inserted posts-then-users; block keys b2-then-b1; deletes reversed;
			// b1 built with reversed object-key insertion order.
			map.set('posts', {
				inserts: { p1: simpleBlock('p1', 'posts') },
			});
			map.set('users', {
				inserts: { b2: simpleBlock('b2', 'users'), b1: makeBlockB1('reverse') },
				updates: { b3: sharedUpdateOps.map(o => [...o]) as any },
				deletes: ['d2', 'd1'],
			});
			return map;
		}

		it('computes the same hash regardless of Map/object insertion order', async () => {
			const hashA = await hashOperations(collectOperations(buildMapA()));
			const hashB = await hashOperations(collectOperations(buildMapB()));
			expect(hashA).to.equal(hashB);
		});

		it('keeps the ops: prefix on the wire format', async () => {
			const hashA = await hashOperations(collectOperations(buildMapA()));
			expect(hashA).to.match(/^ops:/);
		});

		it('produces a DIFFERENT hash when a block value changes (canonicalizer is not degenerate)', async () => {
			const base = await hashOperations(collectOperations(buildMapA()));

			const changed = buildMapA();
			// Mutate one block's content.
			(changed.get('users')!.inserts!['b2'] as any).header.type = 'CHANGED';
			const changedHash = await hashOperations(collectOperations(changed));

			expect(changedHash).to.not.equal(base);
		});

		it('produces a DIFFERENT hash when a BlockOperations array is reordered (array order preserved)', async () => {
			const base = await hashOperations(collectOperations(buildMapA()));

			const reordered = buildMapA();
			// Reverse the ordered BlockOperations list — array order is semantically meaningful.
			reordered.get('users')!.updates!['b3'] = [...sharedUpdateOps].reverse().map(o => [...o]) as any;
			const reorderedHash = await hashOperations(collectOperations(reordered));

			expect(reorderedHash).to.not.equal(base);
		});
	});

	describe('canonicalStringify', () => {
		it('sorts object keys but preserves array element order', () => {
			const forward = canonicalStringify({ b: 1, a: [3, 1, 2], c: { z: 1, y: 2 } });
			const reverse = canonicalStringify({ c: { y: 2, z: 1 }, a: [3, 1, 2], b: 1 });
			expect(forward).to.equal(reverse);
			// Sorted keys, array order untouched.
			expect(forward).to.equal('{"a":[3,1,2],"b":1,"c":{"y":2,"z":1}}');
		});

		it('changes when array element order changes', () => {
			expect(canonicalStringify([1, 2, 3])).to.not.equal(canonicalStringify([3, 2, 1]));
		});

		it('matches JSON.stringify leaf semantics for undefined/null', () => {
			// undefined object-values dropped; null kept.
			expect(canonicalStringify({ a: undefined, b: null })).to.equal('{"b":null}');
			// undefined array elements become null.
			expect(canonicalStringify([undefined, null, 1])).to.equal('[null,null,1]');
			// non-finite numbers become null.
			expect(canonicalStringify(NaN)).to.equal('null');
			expect(canonicalStringify(Infinity)).to.equal('null');
		});
	});
});
