/**
 * Ticket: torn-commit-must-cancel-the-blocks-it-abandoned.
 *
 * The invariant under test: when `NetworkTransactor.commit` returns, every block in
 * `request.blockIds` is either COMMITTED or has had its pending record CANCELLED. No block is left
 * holding a pending record that no future call will ever promote or remove.
 *
 * Why it matters: a pending record's only removers are a client cancel, a divergence-shaped commit
 * refusal, and a forward write of the SAME action id (see docs/repository.md, "a pending record's
 * lifetime is bounded by its writer"). A record none of those can reach is permanent, and while it
 * stands `ClusterMember.validatePendOperations` votes reject on every later pend touching the
 * block — from any writer, on any machine. The block is wedged forever.
 *
 * The arms:
 *  - MECHANISM: pend two blocks through consensus, then commit only the tail (a client that walks
 *    away from the sibling). Every member keeps the sibling's pending record, later writes to it
 *    are refused, and an explicit cancel is exactly the repair. Independent of HOW the tear was
 *    produced — this is the durable state itself.
 *  - PRODUCTION PATH: the only thing injected is a failing sweep RPC (a transport-shaped throw out
 *    of the non-tail commit, after the tail committed durably). Before the fix, commit reported
 *    success and stranded the sweep's pending records on every member. With the fix, commit cancels
 *    the abandoned blocks before acknowledging, so later writes succeed.
 *  - CONFIRMED CONFLICT: a returned `success:false` still surfaces as a stale failure.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, IBlock, Transforms, IRepo, RepoCommitRequest, MessageOptions, ActionId, BlockActionState, ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: 'torn-commit-collection' as BlockId });
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id), entries: [] } as unknown as IBlock);
const insertsFor = (...ids: string[]): Transforms => ({ inserts: Object.fromEntries(ids.map(id => [id, makeBlock(id)])), updates: {}, deletes: [] });
const updatesFor = (tag: string, ...ids: string[]): Transforms => ({ inserts: {}, updates: Object.fromEntries(ids.map(id => [id, [['entries', 0, 0, [tag]]]])), deletes: [] }) as unknown as Transforms;

/** One member's local view of a block — read straight off its StorageRepo, no cluster consult. */
const memberState = async (node: MeshNode, id: string): Promise<BlockActionState> => {
	const result = await node.storageRepo.get({ blockIds: [id as BlockId] });
	return result[id as BlockId]!.state;
};

/**
 * The invariant, asserted as stated (not the mechanism): after a `NetworkTransactor.commit`
 * return, no member holds a pending record for `actionId` on any of the action's blocks unless
 * that block committed there under `actionId`.
 */
const assertPendingLifetimeInvariant = async (mesh: Mesh, actionId: ActionId, blockIds: string[]): Promise<void> => {
	for (const [i, node] of mesh.nodes.entries()) {
		for (const bid of blockIds) {
			const state = await memberState(node, bid);
			if (state.latest?.actionId !== actionId) {
				expect(state.pendings ?? [], `node ${i} block ${bid}: pending record for ${actionId} must not outlive its commit`)
					.to.not.include(actionId);
			}
		}
	}
};

/** A commit request is the SWEEP stage iff it names a tail it is not itself committing. */
const isSweep = (request: RepoCommitRequest): boolean =>
	request.tailId !== undefined && !request.blockIds.includes(request.tailId);

interface SweepInjection {
	transactor: ITransactor;
	arm: () => void;
	disarm: () => void;
	sweepFailures: () => number;
	/** Every block id the transactor asked any peer to cancel, in call order. */
	cancelledBlocks: () => BlockId[];
}

/**
 * A NetworkTransactor over the mesh whose per-peer repo lets the test fail the SWEEP commit — the
 * non-tail second stage of a multi-block commit — with a transport-shaped throw, and records the
 * cancels the transactor issues. `cancel`, `pend`, `get`, and tail commits pass through untouched,
 * so everything after the injected failure is the production code under test.
 */
const buildSweepDroppingTransactor = (mesh: Mesh): SweepInjection => {
	let dropSweeps = false;
	let failures = 0;
	const cancelled: BlockId[] = [];
	const transactor = buildNetworkTransactor(mesh, {
		wrapRepo: (inner: IRepo): IRepo => ({
			get: (g, o) => inner.get(g, o),
			pend: (r, o) => inner.pend(r, o),
			cancel: (r, o) => {
				cancelled.push(...r.blockIds);
				return inner.cancel(r, o);
			},
			commit: (r: RepoCommitRequest, o?: MessageOptions) => {
				if (dropSweeps && isSweep(r)) {
					failures++;
					return Promise.reject(new Error('injected: sweep RPC failed'));
				}
				return inner.commit(r, o);
			}
		})
	});
	return {
		transactor,
		arm: () => { dropSweeps = true; },
		disarm: () => { dropSweeps = false; },
		sweepFailures: () => failures,
		cancelledBlocks: () => [...cancelled]
	};
};

describe('Torn commit — the blocks a sweep abandons are cancelled, never stranded', function () {
	this.timeout(30_000);

	let mesh: Mesh;

	beforeEach(async () => {
		mesh = await createMesh(3, {
			responsibilityK: 3,
			clusterSize: 3,
			superMajorityThreshold: 0.67
		});
	});

	it('mechanism: a pend whose block is never committed or cancelled wedges it on every member; cancel is exactly the repair', async () => {
		// No injection at all here — the wedge is produced by a client that pends two blocks and then
		// commits only the tail, which is what any tear reduces to at the storage layer. This arm pins
		// the durable state itself, independent of how production tears.
		const { transactor } = buildSweepDroppingTransactor(mesh);

		// rev 1: both blocks exist and are committed.
		const pend1 = await transactor.pend({ actionId: 'a1', transforms: insertsFor('T', 'S'), rev: 1, policy: 'c' });
		expect(pend1.success, 'seed pend must succeed').to.equal(true);
		const commit1 = await transactor.commit({ actionId: 'a1', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 1 });
		expect(commit1.success, 'seed commit must succeed').to.equal(true);

		// rev 2: pend both through consensus, then commit ONLY the tail — S is walked away from.
		const pend2 = await transactor.pend({ actionId: 'a2', transforms: updatesFor('x', 'T', 'S'), rev: 2, policy: 'c' });
		expect(pend2.success, 'torn pend must succeed').to.equal(true);
		const commit2 = await transactor.commit({ actionId: 'a2', blockIds: ['T'] as BlockId[], tailId: 'T' as BlockId, rev: 2 });
		expect(commit2.success, 'tail-only commit must succeed').to.equal(true);

		// Every member: T advanced under a2; S still at rev 1 and holding a2's pending record.
		for (const [i, node] of mesh.nodes.entries()) {
			const tState = await memberState(node, 'T');
			expect(tState.latest, `node ${i} T latest`).to.deep.include({ actionId: 'a2', rev: 2 });
			const sState = await memberState(node, 'S');
			expect(sState.latest, `node ${i} S latest`).to.deep.include({ actionId: 'a1', rev: 1 });
			expect(sState.pendings ?? [], `node ${i} S must still hold a2's pending record`).to.include('a2');
		}

		// While the record stands, every later write to S is refused — from any writer, as a real
		// signed rejection, not a transient.
		const later = await transactor.pend({ actionId: 'a3', transforms: updatesFor('y', 'S'), rev: 2, policy: 'c' });
		expect(later.success, 'a later write to the wedged block must be refused').to.equal(false);
		expect(String((later as { reason?: string }).reason ?? ''), 'the refusal must name the pending conflict').to.match(/pending/i);

		// The repair: an explicit cancel routes through consensus and every member drops the record …
		await transactor.cancel({ actionId: 'a2', blockIds: ['S'] as BlockId[] });
		for (const [i, node] of mesh.nodes.entries()) {
			const sState = await memberState(node, 'S');
			expect(sState.pendings ?? [], `node ${i} S must drop a2's record after cancel`).to.not.include('a2');
		}

		// … after which the block writes normally again.
		const retry = await transactor.pend({ actionId: 'a4', transforms: updatesFor('z', 'S'), rev: 2, policy: 'c' });
		expect(retry.success, 'after the cancel, a write to S must pend cleanly').to.equal(true);
		const retryCommit = await transactor.commit({ actionId: 'a4', blockIds: ['S'] as BlockId[], tailId: 'S' as BlockId, rev: 2 });
		expect(retryCommit.success, 'after the cancel, a write to S must commit').to.equal(true);
		for (const [i, node] of mesh.nodes.entries()) {
			const sState = await memberState(node, 'S');
			expect(sState.latest, `node ${i} S must advance under a4`).to.deep.include({ actionId: 'a4', rev: 2 });
		}
	});

	it('production path: a transport-failed sweep is tolerated for the result but cancels the blocks it abandoned', async () => {
		const { transactor, arm, disarm, sweepFailures, cancelledBlocks } = buildSweepDroppingTransactor(mesh);

		// rev 1: both blocks exist and are committed.
		const pend1 = await transactor.pend({ actionId: 'a1', transforms: insertsFor('T', 'S'), rev: 1, policy: 'c' });
		expect(pend1.success, 'seed pend must succeed').to.equal(true);
		const commit1 = await transactor.commit({ actionId: 'a1', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 1 });
		expect(commit1.success, 'seed commit must succeed').to.equal(true);
		await assertPendingLifetimeInvariant(mesh, 'a1', ['T', 'S']);

		// rev 2: touch both, and let every sweep RPC (the non-tail commit stage) fail in the
		// transport-shaped way — a throw, not a returned refusal.
		arm();
		const pend2 = await transactor.pend({ actionId: 'a2', transforms: updatesFor('x', 'T', 'S'), rev: 2, policy: 'c' });
		expect(pend2.success, 'torn pend must succeed').to.equal(true);
		const commit2 = await transactor.commit({ actionId: 'a2', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 2 });
		disarm();

		// The injection must actually have fired, and the tolerance must hold for the RESULT: the
		// tail committed durably before the sweep failed, so the commit is still acknowledged.
		expect(sweepFailures(), 'the sweep injection must have fired').to.be.at.least(1);
		expect(commit2.success, 'a transport-failed sweep must not disown the durably committed tail').to.equal(true);

		// The cancel is scoped to the sweep. The TAIL must never appear in it: its commit is durable,
		// and it is the block the acknowledgement is owed on.
		expect(cancelledBlocks(), 'the abandoned sweep block must be cancelled').to.include('S');
		expect(cancelledBlocks(), 'the durably committed tail must never be cancelled').to.not.include('T');

		// THE FIX: the acknowledged return must not have stranded S's pending record. Tail advanced;
		// S did not (its commit never ran) — but its record is cancelled, not wedged, on every member.
		await assertPendingLifetimeInvariant(mesh, 'a2', ['T', 'S']);
		for (const [i, node] of mesh.nodes.entries()) {
			const tState = await memberState(node, 'T');
			expect(tState.latest, `node ${i} T latest`).to.deep.include({ actionId: 'a2', rev: 2 });
			const sState = await memberState(node, 'S');
			expect(sState.pendings ?? [], `node ${i} S must not hold a2's abandoned pending record`).to.not.include('a2');
		}

		// And the block accepts later writes — the wedge the old tolerance created is gone.
		const later = await transactor.pend({ actionId: 'a3', transforms: updatesFor('y', 'S'), rev: 2, policy: 'c' });
		expect(later.success, 'a later write to S must pend cleanly after the torn commit').to.equal(true);
		const laterCommit = await transactor.commit({ actionId: 'a3', blockIds: ['S'] as BlockId[], tailId: 'S' as BlockId, rev: 2 });
		expect(laterCommit.success, 'a later write to S must commit after the torn commit').to.equal(true);
		await assertPendingLifetimeInvariant(mesh, 'a3', ['S']);
		for (const [i, node] of mesh.nodes.entries()) {
			const sState = await memberState(node, 'S');
			expect(sState.latest, `node ${i} S must advance under a3`).to.deep.include({ actionId: 'a3', rev: 2 });
		}
	});

	it('a confirmed conflict on the sweep still returns the stale failure (cancellation stays with the caller)', async () => {
		// Guard the neighbouring arm: a RETURNED success:false from a cohort coordinator is a
		// confirmed conflict and must still surface as a stale failure — TransactorSource.transact
		// owns the cancel on that path, and the tolerated arm must not have swallowed it.
		const { transactor } = buildSweepDroppingTransactor(mesh);

		const pend1 = await transactor.pend({ actionId: 'a1', transforms: insertsFor('T', 'S'), rev: 1, policy: 'c' });
		expect(pend1.success).to.equal(true);
		const commit1 = await transactor.commit({ actionId: 'a1', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 1 });
		expect(commit1.success).to.equal(true);

		// A rival (a2) takes S at rev 2 outright, then a3 pends only T at rev 2 (its own view of S is
		// stale) — the commit's sweep of S must come back as a confirmed conflict, not a throw.
		const rivalPend = await transactor.pend({ actionId: 'a2', transforms: updatesFor('rival', 'S'), rev: 2, policy: 'c' });
		expect(rivalPend.success, 'rival pend must succeed').to.equal(true);
		const rivalCommit = await transactor.commit({ actionId: 'a2', blockIds: ['S'] as BlockId[], tailId: 'S' as BlockId, rev: 2 });
		expect(rivalCommit.success, 'rival commit must succeed').to.equal(true);

		const pend3 = await transactor.pend({ actionId: 'a3', transforms: updatesFor('loser', 'T'), rev: 2, policy: 'c' });
		expect(pend3.success, 'the losing action pends T cleanly').to.equal(true);
		// Commit claims both blocks; the sweep meets S already committed at rev 2 under a2.
		const commit3 = await transactor.commit({ actionId: 'a3', blockIds: ['T', 'S'] as BlockId[], tailId: 'T' as BlockId, rev: 2 });
		expect(commit3.success, 'a confirmed sweep conflict must surface as a stale failure').to.equal(false);
	});
});
