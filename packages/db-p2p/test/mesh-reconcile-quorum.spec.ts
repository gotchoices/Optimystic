/**
 * Mesh-tier coverage of the PRODUCTION block-repair acceptance rules — the quorum corroboration in
 * `createReconcileBlock` (`src/cluster/reconcile-block.ts`) and the read path's claim corroboration
 * in `CoordinatorRepo.queryClusterForLatest` — now that the mesh harness drives the real
 * implementation instead of a first-peer-wins stand-in.
 *
 * The configuration arithmetic these specs pin down (see `cluster/quorum-restore.ts`):
 *   capacity = corroboratorCapacity(cohortPeers, repairCorroborationClusterSize)
 *            = max(cohortPeers, repairCorroborationClusterSize - 1)
 *   floor    = min(CORROBORATION_FLOOR = 2, capacity)
 * A mesh that DECLARES `clusterSize: 2` gets capacity max(1, 1) = 1, so the floor relaxes to a
 * single voter and a two-node mesh self-repairs. A mesh that declares NOTHING resolves
 * `repairCorroborationClusterSize` to DEFAULT_CLUSTER_SIZE (10), capacity max(1, 9) = 9, floor 2 —
 * and a two-node cohort can never repair, permanently.
 */

import { expect } from 'chai';
import type { BlockId, IBlock, BlockHeader, Transforms } from '@optimystic/db-core';
import { createMesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { captureLog } from './support/capture-log.js';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({
	header: makeHeader(id)
});

/** A block whose bytes differ by `data` — for cohort content-split shapes. */
const makeDataBlock = (id: string, data: string): IBlock =>
	({ header: makeHeader(id), data } as unknown as IBlock);

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

/** Commit `blockId` at rev 1 straight into one node's storage — no cluster traffic replicates it. */
const commitLocally = async (node: MeshNode, blockId: string, actionId: string): Promise<void> => {
	const pendResult = await node.storageRepo.pend(
		{ actionId, transforms: makeTransforms(blockId), policy: 'c' }
	);
	expect(pendResult.success).to.equal(true);
	await node.storageRepo.commit(
		{ actionId, tailId: blockId as BlockId, rev: 1, blockIds: [blockId] }
	);
};

/** What a node's own storage holds for a block, bypassing any cluster consult. */
const localState = async (node: MeshNode, blockId: string) => {
	const result = await node.storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any);
	return result[blockId];
};

const countTag = (captured: unknown[][], tag: string): number =>
	captured.filter(args => typeof args[0] === 'string' && (args[0] as string).includes(tag)).length;

const payloadsOf = (captured: unknown[][], tag: string): Record<string, unknown>[] =>
	captured
		.filter(args => typeof args[0] === 'string' && (args[0] as string).includes(tag))
		.map(args => args[1] as Record<string, unknown>);

describe('mesh repair runs the production quorum rules', () => {

	it('two nodes converge end-to-end under a DECLARED clusterSize: 2', async () => {
		// Declared size 2 → repairCorroborationClusterSize 2 → capacity max(1, 1) = 1 → the
		// corroboration floor relaxes to one voter, so a single sibling's claim + content suffice.
		const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
		const reader = mesh.nodes[0]!;
		const holder = mesh.nodes[1]!;
		const blockId = 'block-declared-two-node';

		await commitLocally(holder, blockId, 'a-two');

		const result = await reader.coordinatorRepo.get({ blockIds: [blockId] });

		expect(result[blockId]?.block, 'read must serve the repaired block').to.not.equal(undefined);
		expect(result[blockId]?.state?.latest?.rev).to.equal(1);

		// The repair persisted: the reader now HOLDS the same content at the same revision.
		const readerLocal = await localState(reader, blockId);
		const holderLocal = await localState(holder, blockId);
		expect(readerLocal?.state?.latest?.rev).to.equal(1);
		expect(readerLocal?.state?.latest?.actionId).to.equal('a-two');
		expect(readerLocal?.block).to.deep.equal(holderLocal?.block);
	});

	it('an UNDECLARED two-node mesh can never repair: no-quorum every pass, repair-deadlock named once', async () => {
		// Nothing declared → repairCorroborationClusterSize resolves to DEFAULT_CLUSTER_SIZE (10):
		// capacity = corroboratorCapacity(1, 10) = 9, requiredEvenIfAllAnswered = quorumSize(1, 0.51, 9)
		// = 2, and cohortPeers (1) < 2 is `cohortTooSmall` in CoordinatorRepo.reportRepairDeadlock —
		// the permanent-decline shape the harness's old `clusterSize ?? nodeCount` default silently
		// excluded from every mesh test.
		const mesh = await createMesh(2, { responsibilityK: 2 });
		const reader = mesh.nodes[0]!;
		const holder = mesh.nodes[1]!;
		const blockId = 'block-undeclared-two-node';

		await commitLocally(holder, blockId, 'a-deadlock');

		const passes = 3;
		let lastResult: Awaited<ReturnType<typeof reader.coordinatorRepo.get>> | undefined;
		const captured = await captureLog('coordinator-repo', async () => {
			for (let i = 0; i < passes; i++) {
				lastResult = await reader.coordinatorRepo.get({ blockIds: [blockId] });
			}
		});

		// Every pass declines — the sole sibling's claim can never meet a floor of two.
		expect(countTag(captured, 'cluster-fetch:no-quorum'), 'one decline per read pass').to.equal(passes);
		// The block stays missing on the reader, honestly flagged: a peer positively claimed a
		// revision this node could neither corroborate nor acquire.
		expect(lastResult![blockId]?.block).to.equal(undefined);
		expect(lastResult![blockId]?.unavailable).to.equal('claimed-elsewhere');
		expect((await localState(reader, blockId))?.state?.latest).to.equal(undefined);

		// The permanence is said ONCE per episode (not once per pass), with the reason that names
		// the remedy — machines or an honest declared size.
		const deadlocks = payloadsOf(captured, 'cluster-fetch:repair-deadlock');
		expect(deadlocks.length, 'deadlock line appears once across repeated reads').to.equal(1);
		expect(deadlocks[0]!['reason']).to.equal('cohort-too-small');
	});

	it('a lone peer\'s inflated revision does not steer repair — the corroborated pair wins', async () => {
		// The ticket sketches this as a three-node shape, but with three nodes the reader has only
		// two peers: one outlier plus one honest holder is one vote per (rev, actionId) group, so
		// the pass DECLINES (outlier-resistant, but nothing is adopted). Four nodes give the reader
		// three peers — two honest corroborators outvote the outlier and repair ADOPTS the
		// corroborated pair, which is the behaviour worth pinning: capacity =
		// corroboratorCapacity(3, 4) = 3, quorum = max(min(2, 3), floor(0.51 × 3)) = 2.
		const mesh = await createMesh(4, { responsibilityK: 4, clusterSize: 4 });
		const reader = mesh.nodes[0]!;
		const honest = [mesh.nodes[1]!, mesh.nodes[2]!];
		const outlier = mesh.nodes[3]!;
		const blockId = 'block-outlier-rev';

		// Two honest holders commit identical content at (1, 'a-agree')...
		for (const node of honest) {
			await commitLocally(node, blockId, 'a-agree');
		}
		// ...and the outlier claims a higher (rev, actionId) with content of its own invention.
		await outlier.storageRepo.saveReplicatedBlock(
			blockId, makeDataBlock(blockId, 'fabricated'), { rev: 5, actionId: 'a-outlier' }
		);

		const result = await reader.coordinatorRepo.get({ blockIds: [blockId] });

		expect(result[blockId]?.state?.latest?.rev, 'corroborated revision adopted').to.equal(1);
		const readerLocal = await localState(reader, blockId);
		expect(readerLocal?.state?.latest?.rev).to.equal(1);
		expect(readerLocal?.state?.latest?.actionId).to.equal('a-agree');
		expect(readerLocal?.block).to.deep.equal((await localState(honest[0]!, blockId))?.block);
		expect((readerLocal?.block as { data?: string } | undefined)?.data,
			'the outlier\'s fabricated content must never land').to.equal(undefined);
	});

	it('a cohort split on CONTENT declines rather than picking a side — and a later pass can still succeed', async () => {
		// Both carriers agree on (1, 'a-split') — the rev quorum passes — but serve different bytes.
		// capacity = corroboratorCapacity(2, 3) = 2, so the content quorum demands two agreeing
		// carriers; two singleton hash groups meet nothing, and reconcile declines with
		// `reconcile:no-content-quorum`, persisting NOTHING. Declines are retryable: once the cohort
		// settles on agreed content, the next pass converges.
		const mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3 });
		const reader = mesh.nodes[0]!;
		const carrierA = mesh.nodes[1]!;
		const carrierB = mesh.nodes[2]!;
		const blockId = 'block-content-split';

		await carrierA.storageRepo.saveReplicatedBlock(
			blockId, makeDataBlock(blockId, 'side-A'), { rev: 1, actionId: 'a-split' }
		);
		await carrierB.storageRepo.saveReplicatedBlock(
			blockId, makeDataBlock(blockId, 'side-B'), { rev: 1, actionId: 'a-split' }
		);

		const captured = await captureLog('reconcile-block', async () => {
			const result = await reader.coordinatorRepo.get({ blockIds: [blockId] });
			expect(result[blockId]?.block, 'no side may be picked').to.equal(undefined);
		});

		expect(countTag(captured, 'reconcile:no-content-quorum'), 'the decline names itself').to.be.greaterThan(0);
		expect((await localState(reader, blockId))?.state?.latest, 'nothing persisted').to.equal(undefined);

		// The cohort settles: both carriers advance to identical content at (2, 'a-heal').
		for (const node of [carrierA, carrierB]) {
			await node.storageRepo.saveReplicatedBlock(
				blockId, makeDataBlock(blockId, 'settled'), { rev: 2, actionId: 'a-heal' }
			);
		}

		const healed = await reader.coordinatorRepo.get({ blockIds: [blockId] });
		expect(healed[blockId]?.state?.latest?.rev, 'a later pass succeeds').to.equal(2);
		expect((await localState(reader, blockId))?.state?.latest?.rev).to.equal(2);
	});
});
