import { expect } from 'chai';
import { approvalCount, operationsConflict, recordPriority, resolveRace } from '../src/cluster/race-resolution.js';
import { MaxPriority } from '@optimystic/db-core';
import type { ActionId, BlockId, ClusterRecord, IBlock, RepoMessage, Signature, Transforms } from '@optimystic/db-core';

/**
 * Direct unit tests for the race arbiter's helper keys. `resolveRace` itself is covered end-to-end by
 * the `priority-aged race resolution` suite in `cluster-repo.spec.ts`; what is pinned here is each
 * comparison key on its own — the count that carries the safety argument (`approvalCount`), the
 * fairness tiebreak's carrier resolution and clamping (`recordPriority`), and the overlap test that
 * decides whether the arbiter runs at all (`operationsConflict`).
 *
 * These records are hand-built rather than signed: every function under test reads only `promises`,
 * `message` and `messageHash`, and none verifies a signature.
 */

const block = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId }
});

const pendOps = (
	actionId: string,
	blockId: string,
	opts?: { priority?: number; txPriority?: number }
): RepoMessage['operations'] => {
	const transforms: Transforms = { inserts: { [blockId]: block(blockId) }, updates: {}, deletes: [] };
	const pend: Record<string, unknown> = { actionId, transforms, policy: 'c' };
	if (opts?.priority !== undefined) pend.priority = opts.priority;
	if (opts?.txPriority !== undefined) pend.validation = { transaction: { priority: opts.txPriority } };
	return [{ pend } as RepoMessage['operations'][number]];
};

const commitOps = (actionId: string, blockId: string): RepoMessage['operations'] => [{
	commit: { actionId: actionId as ActionId, blockIds: [blockId as BlockId], tailId: 'tail' as BlockId, rev: 1 }
}];

const record = (
	messageHash: string,
	operations: RepoMessage['operations'],
	promises: Record<string, Signature> = {}
): ClusterRecord => ({ messageHash, peers: {}, message: { operations }, promises, commits: {} });

const approve: Signature = { type: 'approve', signature: 'x' };
const reject: Signature = { type: 'reject', signature: 'x' };
const conflict: Signature = { type: 'conflict', signature: 'x', conflictWith: 'other-hash' };

describe('race-resolution', () => {
	describe('approvalCount', () => {
		it('is zero for a record nobody has voted on', () => {
			expect(approvalCount(record('h', pendOps('a', 'b1')))).to.equal(0);
		});

		it('counts only approve votes, not the size of the vote map', () => {
			const voted = record('h', pendOps('a', 'b1'), { p1: approve, p2: reject, p3: approve });
			expect(approvalCount(voted)).to.equal(2);
		});

		it('does not count a conflict vote as progress', () => {
			// A `conflict` vote is a retryable "I hold a rival that won the race", not an endorsement, and
			// it occupies a `promises` key exactly as an approve does. Counting it would let a record that
			// LOST a race outrank an untouched rival and hold its blocks for the staleness window.
			expect(approvalCount(record('h', pendOps('a', 'b1'), { p1: conflict, p2: conflict }))).to.equal(0);
		});
	});

	describe('recordPriority', () => {
		it('is zero when the pend declares no priority (a legacy coordinator\'s transaction)', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1')))).to.equal(0);
		});

		it('reads the single-collection carrier (pend.priority)', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1', { priority: 3 })))).to.equal(3);
		});

		it('reads the multi-collection carrier (pend.validation.transaction.priority)', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1', { txPriority: 4 })))).to.equal(4);
		});

		it('prefers the transaction carrier when a record somehow carries both', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1', { priority: 1, txPriority: 5 })))).to.equal(5);
		});

		it('clamps a self-asserted over-cap priority down to MaxPriority', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1', { priority: MaxPriority + 100 })))).to.equal(MaxPriority);
		});

		it('collapses a negative or non-numeric priority to zero instead of throwing on the vote path', () => {
			expect(recordPriority(record('h', pendOps('a', 'b1', { priority: -5 })))).to.equal(0);
			expect(recordPriority(record('h', pendOps('a', 'b1', { priority: Number.NaN })))).to.equal(0);
		});

		it('is zero for a record whose operation is not a pend', () => {
			expect(recordPriority(record('h', commitOps('a', 'b1')))).to.equal(0);
		});
	});

	describe('operationsConflict', () => {
		it('reports a conflict when two different actions touch the same block', () => {
			expect(operationsConflict(pendOps('a1', 'shared'), pendOps('a2', 'shared'))).to.be.true;
		});

		it('reports no conflict when two actions touch disjoint blocks', () => {
			expect(operationsConflict(pendOps('a1', 'b1'), pendOps('a2', 'b2'))).to.be.false;
		});

		it('reports no conflict for a commit resolving its own pend on the same block', () => {
			// Same action id: the commit is finishing the pend, not racing it.
			expect(operationsConflict(pendOps('a1', 'shared'), commitOps('a1', 'shared'))).to.be.false;
		});

		it('is symmetric — the arbiter must see the same answer whichever record it holds', () => {
			const held = pendOps('a1', 'shared');
			const incoming = pendOps('a2', 'shared');
			expect(operationsConflict(held, incoming)).to.equal(operationsConflict(incoming, held));
		});
	});

	describe('resolveRace', () => {
		it('does not let a record holding only a conflict vote outrank a fresh rival', () => {
			// Companion to the reject-vote case in cluster-repo.spec.ts: a `conflict` is the third vote
			// variant that occupies a promises key, and it likewise must not read as progress.
			const lost = record('hash-a', pendOps('a', 'shared'), { p1: conflict });
			// Priority 1 vs 0 decides this at equal approval counts, so the assertion does not ride on the hash.
			const fresh = record('hash-b', pendOps('b', 'shared', { priority: 1 }));

			expect(resolveRace(lost, fresh)).to.equal('accept-incoming');
			expect(resolveRace(fresh, lost)).to.equal('keep-existing');
		});
	});
});
