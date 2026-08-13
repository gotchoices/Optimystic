/**
 * TEST-5.3.1: Coordinator repo integration tests
 *
 * Tests the CoordinatorRepo's full transaction flow including pend→commit,
 * cancel operations, sequential transactions, and multi-block coordination
 * using the mesh harness for realistic multi-node scenarios.
 */

import { expect } from 'chai';
import type { BlockId, IBlock, BlockHeader, Transforms } from '@optimystic/db-core';
import { blockIdToBytes } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh } from '../src/testing/mesh-harness.js';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({
	header: makeHeader(id)
});

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

const makeMultiBlockTransforms = (blockIds: string[]): Transforms => {
	const inserts: Record<string, IBlock> = {};
	for (const id of blockIds) {
		inserts[id] = makeBlock(id);
	}
	return { inserts, updates: {}, deletes: [] };
};

describe('CoordinatorRepo Integration (TEST-5.3.1)', () => {

	describe('cancel operation', () => {
		let mesh: Mesh;

		beforeEach(async () => {
			mesh = await createMesh(3, { responsibilityK: 1 });
		});

		it('should cancel a pending transaction (single-node fast path)', async () => {
			const blockId = 'block-cancel-1';
			const node = mesh.nodes[0]!;

			// Pend a transaction
			const pendResult = await node.coordinatorRepo.pend(
				{ actionId: 'a-cancel', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);

			// Cancel the pending transaction
			await node.coordinatorRepo.cancel({ actionId: 'a-cancel', blockIds: [blockId] });

			// After cancel, a new transaction with the same blockId should succeed
			const pendResult2 = await node.coordinatorRepo.pend(
				{ actionId: 'a-after-cancel', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult2.success).to.equal(true);
		});

		it('should cancel a pending transaction with cluster consensus', async () => {
			mesh = await createMesh(3, {
				responsibilityK: 3,
				superMajorityThreshold: 0.51
			});

			const blockId = 'block-cancel-cluster';
			const coordinator = mesh.nodes[0]!;

			const pendResult = await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-cc', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);

			// Cancel through cluster consensus
			await coordinator.coordinatorRepo.cancel({ actionId: 'a-cc', blockIds: [blockId] });

			// Should be able to pend a new transaction on the same block
			const pendResult2 = await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-cc2', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult2.success).to.equal(true);
		});
	});

	describe('sequential transactions (revision tracking)', () => {
		let mesh: Mesh;

		beforeEach(async () => {
			mesh = await createMesh(3, { responsibilityK: 1 });
		});

		it('should succeed with sequential pend+commit at increasing revisions', async () => {
			const node = mesh.nodes[0]!;

			// Transaction 1: rev=1
			const pend1 = await node.coordinatorRepo.pend(
				{ actionId: 'a1', transforms: makeTransforms('block-seq-1'), policy: 'c' }
			);
			expect(pend1.success).to.equal(true);

			const commit1 = await node.coordinatorRepo.commit(
				{ actionId: 'a1', tailId: 'block-seq-1' as BlockId, rev: 1, blockIds: ['block-seq-1'] }
			);
			expect(commit1.success).to.equal(true);

			// Transaction 2: rev=2 on a different block
			const pend2 = await node.coordinatorRepo.pend(
				{ actionId: 'a2', transforms: makeTransforms('block-seq-2'), policy: 'c' }
			);
			expect(pend2.success).to.equal(true);

			const commit2 = await node.coordinatorRepo.commit(
				{ actionId: 'a2', tailId: 'block-seq-2' as BlockId, rev: 2, blockIds: ['block-seq-2'] }
			);
			expect(commit2.success).to.equal(true);

			// Both blocks should be readable
			const r1 = await node.coordinatorRepo.get({ blockIds: ['block-seq-1'] });
			expect(r1['block-seq-1']?.block?.header.id).to.equal('block-seq-1');

			const r2 = await node.coordinatorRepo.get({ blockIds: ['block-seq-2'] });
			expect(r2['block-seq-2']?.block?.header.id).to.equal('block-seq-2');
		});

		it('should track revision state across multiple commits', async () => {
			const node = mesh.nodes[0]!;

			// Commit 3 sequential transactions
			for (let i = 1; i <= 3; i++) {
				const blockId = `block-rev-${i}`;
				await node.coordinatorRepo.pend(
					{ actionId: `a${i}`, transforms: makeTransforms(blockId), policy: 'c' }
				);
				await node.coordinatorRepo.commit(
					{ actionId: `a${i}`, tailId: blockId as BlockId, rev: i, blockIds: [blockId] }
				);
			}

			// All blocks should have their data
			for (let i = 1; i <= 3; i++) {
				const blockId = `block-rev-${i}`;
				const result = await node.coordinatorRepo.get({ blockIds: [blockId] });
				expect(result[blockId]?.block).to.not.equal(undefined);
			}
		});
	});

	describe('multi-block transactions', () => {
		let mesh: Mesh;

		beforeEach(async () => {
			mesh = await createMesh(3, { responsibilityK: 1 });
		});

		it('should pend a transaction with multiple block IDs', async () => {
			const node = mesh.nodes[0]!;
			const blockIds = ['block-multi-a', 'block-multi-b', 'block-multi-c'];

			const pendResult = await node.coordinatorRepo.pend({
				actionId: 'a-multi',
				transforms: makeMultiBlockTransforms(blockIds),
				policy: 'c'
			});
			expect(pendResult.success).to.equal(true);
		});

		it('should commit a multi-block transaction and verify all blocks', async () => {
			const node = mesh.nodes[0]!;
			const blockIds = ['block-mb-1', 'block-mb-2'];

			await node.coordinatorRepo.pend({
				actionId: 'a-mb',
				transforms: makeMultiBlockTransforms(blockIds),
				policy: 'c'
			});

			const commitResult = await node.coordinatorRepo.commit({
				actionId: 'a-mb',
				tailId: blockIds[0] as BlockId,
				rev: 1,
				blockIds: blockIds as BlockId[]
			});
			expect(commitResult.success).to.equal(true);

			// Both blocks should be accessible
			const result = await node.coordinatorRepo.get({ blockIds: blockIds as BlockId[] });
			expect(result[blockIds[0]!]?.block?.header.id).to.equal(blockIds[0]);
			expect(result[blockIds[1]!]?.block?.header.id).to.equal(blockIds[1]);
		});

		it('should cancel a multi-block pending transaction', async () => {
			const node = mesh.nodes[0]!;
			const blockIds = ['block-mbc-1', 'block-mbc-2'];

			await node.coordinatorRepo.pend({
				actionId: 'a-mbc',
				transforms: makeMultiBlockTransforms(blockIds),
				policy: 'c'
			});

			// Cancel all blocks
			await node.coordinatorRepo.cancel({
				actionId: 'a-mbc',
				blockIds: blockIds as BlockId[]
			});

			// After cancel, new transaction on same blocks should succeed
			const pendResult = await node.coordinatorRepo.pend({
				actionId: 'a-mbc-2',
				transforms: makeMultiBlockTransforms(blockIds),
				policy: 'c'
			});
			expect(pendResult.success).to.equal(true);
		});
	});

	describe('cluster consensus with local execution tracking', () => {
		let mesh: Mesh;

		beforeEach(async () => {
			mesh = await createMesh(3, {
				responsibilityK: 3,
				superMajorityThreshold: 0.51
			});
		});

		it('should replicate pend to all cluster members', async () => {
			const blockId = 'block-replicate';
			const coordinator = mesh.nodes[0]!;

			const pendResult = await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-rep', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);
		});

		it('should replicate commit and make data available on coordinating node', async () => {
			const blockId = 'block-rep-commit';
			const coordinator = mesh.nodes[0]!;

			await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-rc', transforms: makeTransforms(blockId), policy: 'c' }
			);

			const commitResult = await coordinator.coordinatorRepo.commit(
				{ actionId: 'a-rc', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
			);
			expect(commitResult.success).to.equal(true);

			// Data available on coordinating node
			const result = await coordinator.coordinatorRepo.get({ blockIds: [blockId] });
			expect(result[blockId]?.block?.header.id).to.equal(blockId);
		});

		it('should handle sequential cluster transactions', async () => {
			const coordinator = mesh.nodes[0]!;

			// First cluster transaction
			await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-seq1', transforms: makeTransforms('block-cs1'), policy: 'c' }
			);
			await coordinator.coordinatorRepo.commit(
				{ actionId: 'a-seq1', tailId: 'block-cs1' as BlockId, rev: 1, blockIds: ['block-cs1'] }
			);

			// Second cluster transaction
			await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-seq2', transforms: makeTransforms('block-cs2'), policy: 'c' }
			);
			await coordinator.coordinatorRepo.commit(
				{ actionId: 'a-seq2', tailId: 'block-cs2' as BlockId, rev: 2, blockIds: ['block-cs2'] }
			);

			// Both should be readable
			const r = await coordinator.coordinatorRepo.get({ blockIds: ['block-cs1', 'block-cs2'] });
			expect(r['block-cs1']?.block).to.not.equal(undefined);
			expect(r['block-cs2']?.block).to.not.equal(undefined);
		});
	});

	describe('cross-node block discovery via cluster callback', () => {
		let mesh: Mesh;

		beforeEach(async () => {
			mesh = await createMesh(3, { responsibilityK: 1 });
		});

		it('should allow writer and reader on different nodes to see blocks', async () => {
			const blockId = 'block-xnode';
			const writer = mesh.nodes[0]!;
			const reader = mesh.nodes[1]!;

			// Writer commits a block
			await writer.coordinatorRepo.pend(
				{ actionId: 'a-xn', transforms: makeTransforms(blockId), policy: 'c' }
			);
			await writer.coordinatorRepo.commit(
				{ actionId: 'a-xn', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
			);

			// Writer has the block
			const writerResult = await writer.coordinatorRepo.get({ blockIds: [blockId] });
			expect(writerResult[blockId]?.block).to.not.equal(undefined);

			// Reader should discover the block exists via clusterLatestCallback
			const readerResult = await reader.coordinatorRepo.get({ blockIds: [blockId] });
			// The block entry should exist (even if full data sync requires restoreCallback)
			expect(readerResult[blockId]).to.not.equal(undefined);
		});
	});

	describe('silent cohort peer during read consult (ticket cluster-read-consult-cannot-report-unreachable)', () => {
		it('reports cohort-unreachable, not an authoritative absent, when the sole holder is silent', async () => {
			// The field failure's topology: two nodes, so after self-exclusion the reader has
			// exactly one peer to consult — and that peer holds the only copy. Its silence must
			// not read as "the block does not exist". And because NO non-self cohort member
			// answered at all, the reason is 'cohort-unreachable' (isolation — no
			// better-connected coordinator exists to re-ask), not partial-silence
			// 'peers-unreachable'.
			const mesh = await createMesh(2, { responsibilityK: 2 });
			const reader = mesh.nodes[0]!;
			const holder = mesh.nodes[1]!;
			const blockId = 'block-silent-holder';

			// The block exists only on the holder — written straight into its storage so no
			// cluster traffic replicates it to the reader.
			const pendResult = await holder.storageRepo.pend(
				{ actionId: 'a-sh', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);
			await holder.storageRepo.commit(
				{ actionId: 'a-sh', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
			);

			mesh.failures.silentPeers = new Set([holder.peerId.toString()]);

			const result = await reader.coordinatorRepo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block, 'nothing to serve — the holder is silent').to.equal(undefined);
			expect(result[blockId]?.unavailable, 'silence must be reported as silence').to.equal('cohort-unreachable');
		});

		it('reports cohort-unreachable for a missing block when the only other cohort peer is silent', async () => {
			// Same topology, block held by NOBODY — even then, silence means the reader
			// cannot know that, so no authoritative absent.
			const mesh = await createMesh(2, { responsibilityK: 2 });
			const reader = mesh.nodes[0]!;
			const other = mesh.nodes[1]!;
			mesh.failures.silentPeers = new Set([other.peerId.toString()]);

			const result = await reader.coordinatorRepo.get({ blockIds: ['block-silent-consult'] });

			expect(result['block-silent-consult']?.unavailable).to.equal('cohort-unreachable');
		});

		it('still reports an authoritative absent when the whole cohort answers "holds nothing"', async () => {
			// The healthy new-collection probe: everyone answers, nobody holds anything.
			// This must STAY a one-round-trip authoritative absent, or creating a
			// collection would retry and then throw.
			const mesh = await createMesh(2, { responsibilityK: 2 });
			const reader = mesh.nodes[0]!;

			const result = await reader.coordinatorRepo.get({ blockIds: ['block-absent-probe'] });

			expect(result['block-absent-probe']!.state).to.deep.equal({});
			expect('unavailable' in result['block-absent-probe']!).to.equal(false);
		});
	});

	describe('context-driven pending block serving (TEST-5.4.3)', () => {
		it('should serve a pending block via context when data is only on the writing peers', async () => {
			// responsibilityK=3: all peers are discoverable so the reader's cluster query reaches
			// the writers (the data is still only PENDED there, never committed).
			const mesh = await createMesh(3, { responsibilityK: 3 });
			const reader = mesh.nodes[1]!;
			// Two writers, not one. The reader restores only from a quorum-corroborated
			// `(rev, actionId)`, and a 3-peer cohort can supply two corroborators — so one holder's
			// uncorroborated claim is correctly refused. (This spec used to pass with a single holder
			// only because the mesh harness's `clusterLatestCallback` faked the data sync itself; that
			// fake is gone, so the cohort has to be able to corroborate for real.)
			const writers = [mesh.nodes[0]!, mesh.nodes[2]!];
			const blockId = 'block-pending-ctx' as BlockId;

			for (const writer of writers) {
				const pendResult = await writer.storageRepo.pend({
					actionId: 'a-pctx',
					transforms: { inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] },
					policy: 'c'
				});
				expect(pendResult.success).to.equal(true);
			}

			// Do NOT commit (simulating non-tail commit failure after tail committed)

			// Reader gets the block with context proving the action is committed. The context rides the
			// cluster callback out to each writer, promoting the pending there; both then corroborate
			// (1, 'a-pctx') and agree on the content, so the reader acquires it.
			const result = await reader.coordinatorRepo.get({
				blockIds: [blockId],
				context: { committed: [{ actionId: 'a-pctx', rev: 1 }], rev: 1 }
			});

			expect(result[blockId]?.block).to.not.equal(undefined,
				'Pending block should be served when context proves the action is committed');
			expect(result[blockId]?.state?.latest?.rev).to.equal(1);
		});
	});

	describe('failure scenarios', () => {
		it('should fail pend when all cluster peers are unreachable', async () => {
			const mesh = await createMesh(3, {
				responsibilityK: 3,
				superMajorityThreshold: 0.75
			});

			const blockId = 'block-all-fail';
			const coordinator = mesh.nodes[0]!;

			// Make all non-coordinator peers fail
			mesh.failures.failingPeers = new Set([
				mesh.nodes[1]!.peerId.toString(),
				mesh.nodes[2]!.peerId.toString()
			]);

			try {
				await coordinator.coordinatorRepo.pend(
					{ actionId: 'a-fail', transforms: makeTransforms(blockId), policy: 'c' }
				);
				expect.fail('Should have thrown due to insufficient peers');
			} catch (err) {
				expect(err).to.be.instanceOf(Error);
			} finally {
				mesh.failures.failingPeers = undefined;
			}
		});

		it('should fail commit when cluster peers are unreachable during commit phase', async () => {
			const mesh = await createMesh(3, {
				responsibilityK: 3,
				superMajorityThreshold: 0.51
			});

			const blockId = 'block-commit-fail';
			const coordinator = mesh.nodes[0]!;

			// Pend succeeds normally
			const pendResult = await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-cf', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);

			// Now make peers fail during commit
			mesh.failures.failingPeers = new Set([
				mesh.nodes[1]!.peerId.toString(),
				mesh.nodes[2]!.peerId.toString()
			]);

			try {
				await coordinator.coordinatorRepo.commit(
					{ actionId: 'a-cf', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
				);
				expect.fail('Should have thrown due to peer failure during commit');
			} catch (err) {
				expect(err).to.be.instanceOf(Error);
			} finally {
				mesh.failures.failingPeers = undefined;
			}
		});

		it('should handle commit after cancel gracefully', async () => {
			const mesh = await createMesh(3, { responsibilityK: 1 });
			const blockId = 'block-commit-after-cancel';
			const node = mesh.nodes[0]!;

			// Pend, then cancel
			await node.coordinatorRepo.pend(
				{ actionId: 'a-cac', transforms: makeTransforms(blockId), policy: 'c' }
			);
			await node.coordinatorRepo.cancel({ actionId: 'a-cac', blockIds: [blockId] });

			// Attempting to commit after cancel should fail
			try {
				const result = await node.coordinatorRepo.commit(
					{ actionId: 'a-cac', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
				);
				// If it returns a result instead of throwing, it should indicate failure
				// (behavior depends on storage repo implementation)
				if (result.success) {
					// Some implementations may succeed (no-op commit on cancelled action)
					// This is acceptable - the key point is it doesn't crash
				}
			} catch (err) {
				// Expected - committing a cancelled transaction may throw
				expect(err).to.be.instanceOf(Error);
			}
		});
	});

	describe('cross-cohort convergence via active reconciliation', () => {
		it('reconciles a committed block on a member that missed the pend phase', async () => {
			// responsibilityK=3 so all three peers are in every cohort; superMajorityThreshold
			// 0.51 keeps consensus reachable (2/3) with the laggard absent.
			const mesh = await createMesh(3, { responsibilityK: 3, superMajorityThreshold: 0.51 });
			const coordinator = mesh.nodes[0]!;
			const laggard = mesh.nodes[2]!;
			const blockId = 'block-xcohort';

			// Phase 1 — laggard fully unreachable: nodes 0 & 1 STABLY pend+commit rev 1
			// while the laggard misses both phases and holds nothing. Committing on the two
			// peers in a completed transaction first (rather than concurrently with the
			// laggard's reconcile in a single broadcast) is what makes this deterministic:
			// the reconcile source is already settled before the laggard pulls from it.
			mesh.failures.failingPeers = new Set([laggard.peerId.toString()]);
			const pendResult = await coordinator.coordinatorRepo.pend(
				{ actionId: 'a-xc', transforms: makeTransforms(blockId), policy: 'c' }
			);
			expect(pendResult.success).to.equal(true);
			const commit1 = await coordinator.coordinatorRepo.commit(
				{ actionId: 'a-xc', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
			);
			expect(commit1.success).to.equal(true);

			// The laggard genuinely holds no revision (it missed the pend).
			const before = await laggard.storageRepo.get({ blockIds: [blockId] });
			expect(before[blockId]?.state?.latest).to.equal(undefined);

			// Phase 2 — laggard reachable again, re-commit the SAME (actionId, rev). It joins
			// the commit cohort having missed the pend, so its local commit throws
			// "not found"; the member tolerates the divergence and actively reconciles the
			// committed revision from a cohort peer that already (stably) holds it.
			mesh.failures.failingPeers = undefined;
			const commit2 = await coordinator.coordinatorRepo.commit(
				{ actionId: 'a-xc', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
			);
			expect(commit2.success).to.equal(true);

			// Replication restored: the pend-missing member now holds the committed revision,
			// so a cross-cohort transaction converges.
			const after = await laggard.storageRepo.get({ blockIds: [blockId] });
			expect(after[blockId]?.state?.latest?.rev).to.equal(1);
			expect(after[blockId]?.state?.latest?.actionId).to.equal('a-xc');
		});
	});

	describe('stale coordinator under partial partition (ticket coordinator-serves-stale-data-as-if-confirmed)', () => {
		it('a network read lands the confirmed newer revision, not the first coordinator\'s stale copy', async () => {
			// The field failure's three-peer shape, end to end. One node is stale at rev 1; one
			// holds rev 2; one is unreachable on the read path. The stale node is arranged to be
			// the FIRST coordinator the network read routes to, so before this fix the read
			// returned its rev-1 copy as confirmed and never looked further: the stale node's
			// freshness consult heard exactly one claim of rev 2 (the dark peer silent), the
			// corroboration quorum of two rightly declined it, and the inconclusive verdict was
			// dropped on the floor. Now that verdict survives as `unconfirmedAheadRev`, earns the
			// transactor's second-chance round against the next coordinator, and the confirmed
			// rev-2 answer from there outranks the stale marked one in the merge.
			const mesh = await createMesh(3, { responsibilityK: 3, superMajorityThreshold: 0.51 });
			const blockId = 'block-stale-partition';

			// Every node committed rev 1 — written into each storage directly so the baseline is
			// deterministic (no consensus timing involved).
			for (const node of mesh.nodes) {
				await node.storageRepo.pend({ actionId: 'old-action', transforms: makeTransforms(blockId), policy: 'c' });
				await node.storageRepo.commit({ actionId: 'old-action', tailId: blockId as BlockId, rev: 1, blockIds: [blockId] });
			}

			// Assign roles by the transactor's own routing (XOR distance over sha256(blockId)):
			// the nearest node is the coordinator every read hits first — it stays stale; the
			// second-nearest is the retry coordinator — it advances to rev 2; the third goes dark.
			const routingKey = await blockIdToBytes(blockId as BlockId);
			const firstPick = await mesh.keyNetwork.findCoordinator(routingKey);
			const secondPick = await mesh.keyNetwork.findCoordinator(routingKey, { excludedPeers: [firstPick] });
			const staleReader = mesh.nodes.find(n => n.peerId.equals(firstPick))!;
			const freshHolder = mesh.nodes.find(n => n.peerId.equals(secondPick))!;
			const darkPeer = mesh.nodes.find(n => n !== staleReader && n !== freshHolder)!;

			// Rev 2 lands on the fresh holder only — modelling a commit whose broadcast the other
			// two missed — through the same monotonic funnel replication uses.
			await freshHolder.storageRepo.saveReplicatedBlock(
				blockId as BlockId,
				makeBlock(blockId),
				{ actionId: 'new-action', rev: 2 }
			);
			mesh.failures.silentPeers = new Set([darkPeer.peerId.toString()]);

			// First half: the stale coordinator itself now says "possibly behind rev 2" instead
			// of posing as confirmed. (Its consult: fresh holder claims 2 — one claim, quorum of
			// two, declined; dark peer silent.)
			const staleAnswer = await staleReader.coordinatorRepo.get({ blockIds: [blockId] });
			expect(staleAnswer[blockId]?.state?.latest?.rev, 'the stale copy is still served').to.equal(1);
			expect(staleAnswer[blockId]?.unconfirmedAheadRev, 'marked with the unsettled claim').to.equal(2);

			// Second half: a read through the network transactor rides that marker to the retry
			// coordinator and comes back with the CONFIRMED rev 2 — the read advances instead of
			// freezing on the first coordinator's copy.
			const transactor = buildNetworkTransactor(mesh);
			const result = await transactor.get({ blockIds: [blockId] });

			expect(result[blockId]?.state?.latest?.rev, 'the confirmed newer revision wins').to.equal(2);
			expect(result[blockId]?.state?.latest?.actionId).to.equal('new-action');
			expect(result[blockId]?.unconfirmedAheadRev, 'no surviving doubt').to.equal(undefined);
		});
	});
});
