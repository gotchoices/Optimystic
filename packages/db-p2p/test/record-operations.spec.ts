import { expect } from 'chai';
import { getActionId, getAffectedBlockIds } from '../src/cluster/record-operations.js';
import type { ActionId, BlockId, DisputeResolutionProof, IBlock, RepoMessage, Transforms } from '@optimystic/db-core';

/**
 * Direct unit tests for the two message-introspection helpers. Both feed decisions that are hard to
 * observe from the outside — `getAffectedBlockIds` decides both which writes serialize against each
 * other AND which block ids the membership admission gate will accept as coordinating, and
 * `getActionId` decides when `operationsConflict` short-circuits — so each operation arm is pinned
 * here rather than only reached transitively through `findConflict`.
 */

const block = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId }
});

const ops = (op: RepoMessage['operations'][number]): RepoMessage['operations'] => [op];

/** Neither function under test reads the certificate, so an opaque stub keeps the arm honest. */
const stubResolution = {} as unknown as DisputeResolutionProof;

describe('record-operations', () => {
	describe('getAffectedBlockIds', () => {
		it('reads a get operation\'s block ids', () => {
			expect(getAffectedBlockIds(ops({ get: { blockIds: ['b1' as BlockId, 'b2' as BlockId] } })))
				.to.have.members(['b1', 'b2']);
		});

		it('unions a pend\'s inserts, updates and deletes', () => {
			const transforms: Transforms = {
				inserts: { 'ins-1': block('ins-1') },
				updates: { 'upd-1': [] },
				deletes: ['del-1' as BlockId]
			};
			expect(getAffectedBlockIds(ops({ pend: { actionId: 'a1' as ActionId, transforms, policy: 'c' } })))
				.to.have.members(['ins-1', 'upd-1', 'del-1']);
		});

		it('reads a commit operation\'s block ids', () => {
			expect(getAffectedBlockIds(ops({
				commit: { actionId: 'a1' as ActionId, blockIds: ['b1' as BlockId], tailId: 'tail' as BlockId, rev: 1 }
			}))).to.deep.equal(['b1']);
		});

		it('reads a cancel operation\'s block ids through its action ref', () => {
			expect(getAffectedBlockIds(ops({
				cancel: { actionRef: { actionId: 'a1' as ActionId, blockIds: ['b1' as BlockId, 'b2' as BlockId] } }
			}))).to.have.members(['b1', 'b2']);
		});

		it('surfaces an invalidate operation\'s blocks, so a concurrent commit serializes against the reversal', () => {
			expect(getAffectedBlockIds(ops({
				invalidate: {
					invalidatedActionId: 'a-bad' as ActionId,
					invalidatedRev: 3,
					blockIds: ['b1' as BlockId, 'b2' as BlockId],
					collectionId: 'collection-1' as BlockId,
					resolution: stubResolution
				}
			}))).to.have.members(['b1', 'b2']);
		});

		it('de-duplicates a block named more than once', () => {
			const transforms: Transforms = {
				inserts: { 'b1': block('b1') },
				updates: { 'b1': [] },
				deletes: ['b1' as BlockId]
			};
			expect(getAffectedBlockIds(ops({ pend: { actionId: 'a1' as ActionId, transforms, policy: 'c' } })))
				.to.deep.equal(['b1']);
		});

		it('returns an empty list for a pend carrying empty transforms', () => {
			expect(getAffectedBlockIds(ops({
				pend: { actionId: 'a1' as ActionId, transforms: {}, policy: 'c' }
			}))).to.deep.equal([]);
		});
	});

	describe('getActionId', () => {
		it('reads a pend\'s action id', () => {
			expect(getActionId(ops({
				pend: { actionId: 'a-pend' as ActionId, transforms: {}, policy: 'c' }
			}))).to.equal('a-pend');
		});

		it('reads a commit\'s action id', () => {
			expect(getActionId(ops({
				commit: { actionId: 'a-commit' as ActionId, blockIds: [], tailId: 'tail' as BlockId, rev: 1 }
			}))).to.equal('a-commit');
		});

		it('reads a cancel\'s action id through its action ref', () => {
			expect(getActionId(ops({
				cancel: { actionRef: { actionId: 'a-cancel' as ActionId, blockIds: [] } }
			}))).to.equal('a-cancel');
		});

		it('has no action id for a get', () => {
			expect(getActionId(ops({ get: { blockIds: ['b1' as BlockId] } }))).to.be.undefined;
		});

		it('has no action id for an invalidate — so an invalidation never short-circuits conflict detection', () => {
			// `invalidate` carries `invalidatedActionId`, deliberately NOT surfaced here: that id names the
			// action being REVERSED, not this message's own action, so matching it against a live pend's id
			// would declare "same action, no conflict" for exactly the pair that must serialize.
			expect(getActionId(ops({
				invalidate: {
					invalidatedActionId: 'a-bad' as ActionId,
					invalidatedRev: 3,
					blockIds: ['b1' as BlockId],
					collectionId: 'collection-1' as BlockId,
					resolution: stubResolution
				}
			}))).to.be.undefined;
		});
	});
});
