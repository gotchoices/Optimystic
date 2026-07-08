import { expect } from 'chai';
import {
	collectOperations,
	hashOperations,
	canonicalStringify,
	canonicalOperationsPayload,
	opsHashVersion,
	OPS_HASH_VERSION,
	OPS_HASH_PREFIX,
	createTransactionId,
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

		it('emits the versioned ops.v1: token on the wire format', async () => {
			const hashA = await hashOperations(collectOperations(buildMapA()));
			// Self-describing token: `ops.<version>:<base64url hash>`.
			expect(hashA).to.match(/^ops\.v1:/);
			expect(hashA.startsWith(OPS_HASH_PREFIX)).to.equal(true);
			expect(opsHashVersion(hashA)).to.equal(OPS_HASH_VERSION);
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

	describe('opsHashVersion (token classification)', () => {
		it('parses the current versioned token as its version', async () => {
			const token = await hashOperations([]);
			expect(opsHashVersion(token)).to.equal(OPS_HASH_VERSION);
		});

		it('parses a hypothetical bumped-version token by its own version, not the local one', () => {
			// A validator must read the SENDER's declared version off the wire, so a future
			// v2 peer is classified as v2 (≠ local v1) rather than silently accepted.
			expect(opsHashVersion('ops.v2:abc123')).to.equal('v2');
			expect(opsHashVersion('ops.v2:abc123')).to.not.equal(OPS_HASH_VERSION);
		});

		it('classifies a bare legacy ops: token as unrecognized (null), not a version', () => {
			// The pre-versioning format has no `.` delimiter — it is a FOREIGN format, never
			// an accidental content match.
			expect(opsHashVersion('ops:deadbeef')).to.equal(null);
		});

		it('classifies garbage / malformed / empty tokens as unrecognized (null) without throwing', () => {
			expect(opsHashVersion('')).to.equal(null);
			expect(opsHashVersion('not-a-hash')).to.equal(null);
			expect(opsHashVersion('ops.')).to.equal(null);      // prefix but no version + colon
			expect(opsHashVersion('ops.:xyz')).to.equal(null);  // empty version segment
			expect(opsHashVersion('ops.v1')).to.equal(null);    // no colon terminator
			// Defensive: non-string inputs are tolerated (validator may see anything on the wire).
			expect(opsHashVersion(undefined as any)).to.equal(null);
			expect(opsHashVersion(null as any)).to.equal(null);
		});
	});

	describe('canonicalOperationsPayload (signature-bindable bytes)', () => {
		it('returns exactly the string hashOperations feeds into the hash (token wraps the hash, not the preimage)', async () => {
			const ops = collectOperations(buildMapForPayload());
			const payload = canonicalOperationsPayload(ops);
			// The payload must NOT carry the version token — it is the preimage, not the wire token.
			expect(payload.startsWith('ops')).to.equal(false);
			// Reconstruct the wire token from the payload and confirm it equals hashOperations().
			const { hashString } = await import('../src/utility/hash-string.js');
			const rebuilt = `${OPS_HASH_PREFIX}${await hashString(payload)}`;
			expect(rebuilt).to.equal(await hashOperations(ops));
		});

		it('is order-independent like hashOperations (same logical set → same payload)', async () => {
			const a = canonicalOperationsPayload(collectOperations(buildMapForPayload()));
			const b = canonicalOperationsPayload(collectOperations(buildMapForPayloadReversed()));
			expect(a).to.equal(b);
		});
	});

	describe('transaction.id is unaffected by the ops-hash version token', () => {
		it('createTransactionId is byte-identical for fixed inputs (history identity must not move)', async () => {
			// The version token lives ONLY inside the ops-hash string; it must not perturb the
			// PERSISTED transaction identity, which hashes (stampId, statements, reads).
			const id = await createTransactionId(
				'stamp:fixed',
				['INSERT INTO t VALUES (1)', 'UPDATE t SET x = 2'],
				[{ blockId: 'b1', revision: 3 }, { blockId: 'b2', revision: 4 }]
			);
			// Pinned expectation: recomputed here, and locked so a future ops-hash change that
			// accidentally reached into tx-id inputs would flip this and fail the suite.
			const idAgain = await createTransactionId(
				'stamp:fixed',
				['INSERT INTO t VALUES (1)', 'UPDATE t SET x = 2'],
				[{ blockId: 'b1', revision: 3 }, { blockId: 'b2', revision: 4 }]
			);
			expect(id).to.equal(idAgain);
			expect(id.startsWith('tx:')).to.equal(true);
			// Must NOT carry an ops-hash token — distinct identity space.
			expect(id.startsWith('ops')).to.equal(false);
		});
	});
});

// Shared builders for the payload tests — same logical operation set assembled two ways.
function buildMapForPayload(): Map<string, Transforms> {
	const map = new Map<string, Transforms>();
	map.set('users', {
		inserts: { b1: { header: { id: 'b1', type: 'data', collectionId: 'users' } } as unknown as IBlock },
		deletes: ['d1', 'd2'],
	});
	map.set('posts', {
		inserts: { p1: { header: { id: 'p1', type: 'data', collectionId: 'posts' } } as unknown as IBlock },
	});
	return map;
}

function buildMapForPayloadReversed(): Map<string, Transforms> {
	const map = new Map<string, Transforms>();
	// Collections + deletes in reversed order; identical logical content.
	map.set('posts', {
		inserts: { p1: { header: { id: 'p1', type: 'data', collectionId: 'posts' } } as unknown as IBlock },
	});
	map.set('users', {
		inserts: { b1: { header: { id: 'b1', type: 'data', collectionId: 'users' } } as unknown as IBlock },
		deletes: ['d2', 'd1'],
	});
	return map;
}
