/**
 * Ticket: a-pending-record-reserves-its-block-only-for-a-bounded-time (GitHub #18, and the
 * `../sereus` control-write gate).
 *
 * A write happens in two steps: every member of the block's cohort stores a pending record reserving
 * the block, and the write's commit later turns that record into a numbered revision. While a record
 * reserves, every other writer's pend for the block is refused — ordinary optimistic concurrency.
 *
 * This reproduces the one residual nothing could retire. A COORDINATED write's record is applied on
 * every member by consensus, so it carries no in-process mark and never could: `isAbandonedClaim`
 * cannot see a writer this node never ran. Its slot is one the collection has not moved past, so
 * neither `isReservationAgainst` nor the dead-claim sweep can retire it either. Before the lease, a
 * writer that went away between its pend and its commit left every later write to that block refused
 * for the life of the deployment, with the fingerprint the field reports carry:
 * `pending conflict: block(s) held by unresolved rival action(s) <id>`.
 *
 *  1. **Seed.** A writes a row through the cohort; the collection is at revision 1. The healthy
 *     pend-to-commit span of that write is logged — the figure `DEFAULT_PEND_LEASE_MS`'s comment
 *     reports as what the lease has to clear.
 *  2. **A coordinated pend is stranded.** A pends a second write at revision 2 and never commits or
 *     cancels it. Every member stores the record, and none of them stamped it with a run.
 *  3. **A write from a healthy member is refused** on the fingerprint above, which is what every
 *     later write to the block met for good.
 *  4. **The lease elapses**, driven by the mesh's own clock rather than by waiting, and the same
 *     write lands — with the stranded record still on file, so its own commit could still promote it.
 */

import { expect } from 'chai';
import {
	Tree, type ActionId, type BlockId, type CommitRequest, type ITransactor, type PendRequest, type PendResult,
	type StaleFailure
} from '@optimystic/db-core';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { productionShapedMeshOptions, transactorDrivenBy } from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const MACHINES = 3;
const TREE_ID = 'a-lapsed-pend-stops-reserving-its-block';
/** Short enough to step over in one assignment; the clock below is the spec's, so the value is arbitrary. */
const LEASE_MS = 500;

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

describe('A pending record stops reserving its block once its lease has run out (three machines)', function () {
	this.timeout(90_000);
	sequentialPhases();

	let mesh: Mesh;
	let a: MeshNode;
	let b: MeshNode;
	/** The clock every node's storage stamps and reads pending-record ages against. */
	let now: number;
	/** The log tail block every write to the collection names, read off the committed header. */
	let tailId: BlockId;
	/** The coordinated write that was never committed or cancelled. */
	const strandedAction = 'stranded-coordinated-action' as ActionId;

	/** A pend of `actionId` at revision 2 on the log tail — the shape every second write to the collection
	 *  takes. Deliberately WITHOUT `soleReservation`, so the record is delivered to every member at pend
	 *  time rather than held back for the commit: this scenario is about a record the whole cohort holds. */
	const secondWriteOf = (actionId: ActionId): PendRequest => ({
		transforms: { updates: { [tailId]: [['entries', 0, 0, []]] } },
		actionId,
		rev: 2,
		policy: 'r',
		baseRevs: { [tailId]: 1 }
	});

	async function committedTailId(): Promise<BlockId> {
		const header = (await a.storageRepo.get({ blockIds: [TREE_ID as BlockId] }))[TREE_ID as BlockId]?.block as { tailId?: BlockId } | undefined;
		expect(header?.tailId, 'the committed header names the log tail').to.be.a('string');
		return header!.tailId!;
	}

	/** The machines whose OWN storage holds a pending record for `actionId` on the tail. */
	async function holdersOf(actionId: ActionId): Promise<string[]> {
		const holders: string[] = [];
		for (const node of mesh.nodes) {
			const entry = (await node.storageRepo.get({ blockIds: [tailId] }))[tailId];
			if ((entry?.state?.pendings ?? []).includes(actionId)) holders.push('ABC'[mesh.nodes.indexOf(node)]!);
		}
		return holders;
	}

	before(async () => {
		now = 1_000_000;
		mesh = await createMesh(MACHINES, {
			...productionShapedMeshOptions(MACHINES),
			pendLeaseMs: LEASE_MS,
			now: () => now
		});
		[a, b] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
	});

	it('phase 1: A writes a row through the cohort, and the healthy pend-to-commit span is measured', async () => {
		// Measured from the writer's side — the first pend goes out, the commit comes back — which is an
		// upper bound on the span any one member holds the record for. The figure the lease has to clear.
		let pendStartedAt: number | undefined;
		let commitEndedAt: number | undefined;
		const inner = transactorDrivenBy(mesh, a);
		// Explicit delegation, not a spread: `NetworkTransactor` is a class, so a spread copies none of
		// its methods (the same reason `recording` in util/node-count-mesh.ts delegates by hand).
		const timed: ITransactor = {
			get: gets => inner.get(gets),
			getStatus: refs => inner.getStatus!(refs),
			cancel: ref => inner.cancel(ref),
			pend: async (request: PendRequest) => {
				pendStartedAt ??= Date.now();
				return await inner.pend(request);
			},
			commit: async (request: CommitRequest) => {
				const result = await inner.commit(request);
				commitEndedAt = Date.now();
				return result;
			}
		};

		const tree = await Tree.createOrOpen<string, Row>(timed, TREE_ID, keyOf);
		const durability = await tree.replace([['a', { key: 'a', value: 'first' }]]);
		expect(durability, 'the seed write is acknowledged').to.not.equal(undefined);
		tailId = await committedTailId();

		expect(pendStartedAt, 'the write pended').to.be.a('number');
		expect(commitEndedAt, 'and committed').to.be.a('number');
		console.log(`    healthy pend-to-commit span: ${commitEndedAt! - pendStartedAt!}ms (in-process mesh, ${MACHINES} machines)`);
	});

	it('phase 2: a coordinated pend is stranded — every member holds it, none of them stamped it', async () => {
		const writer: ITransactor = transactorDrivenBy(mesh, a);
		const pended = await writer.pend(secondWriteOf(strandedAction));
		expect(pended.success, `the coordinated pend lands: ${describeResult(pended)}`).to.equal(true);
		// The writer now goes away: no commit, no cancel, and this transactor is never used again.
		expect(await holdersOf(strandedAction), 'the cohort stored it by consensus').to.deep.equal(['A', 'B', 'C']);
		for (const node of mesh.nodes) {
			const claim = await node.storageRepo.pendingClaimOf(tailId, strandedAction);
			expect(claim?.localRun, 'a consensus apply stamps no run, so abandonment can never retire it').to.equal(undefined);
			expect(claim?.pendingSince, 'but every member recorded when it stored the record').to.equal(now);
		}
	});

	it('phase 3: a write from a healthy member is refused on the stranded record', async () => {
		now += LEASE_MS;	// still inside the lease: the comparison is strictly greater
		const refused = await transactorDrivenBy(mesh, b).pend(secondWriteOf('refused-action' as ActionId));
		expect(refused.success, 'a record inside its lease reserves the block').to.equal(false);
		expect((refused as StaleFailure).conflict, 'and the refusal is the retryable kind').to.equal(true);
		expect((refused as StaleFailure).reason, 'the fingerprint the field reports carry')
			.to.contain(`pending conflict: block(s) held by unresolved rival action(s) ${strandedAction}`);
	});

	it('phase 4: once the lease has run out the same write lands, and the stranded record is still on file', async () => {
		now += 1;
		const landed: PendResult = await transactorDrivenBy(mesh, b).pend(secondWriteOf('admitted-action' as ActionId));
		expect(landed.success, `the lapsed record must not refuse: ${describeResult(landed)}`).to.equal(true);

		expect(await holdersOf(strandedAction), 'nothing deleted it — a lapse costs the reservation and nothing else')
			.to.deep.equal(['A', 'B', 'C']);
		await transactorDrivenBy(mesh, b).cancel({ actionId: 'admitted-action' as ActionId, blockIds: [tailId] });
	});

	function describeResult(result: PendResult): string {
		if (result.success) return 'success';
		const pending = 'pending' in result ? (result.pending ?? []).map(p => p.actionId).join(', ') : '';
		return `conflict=${'conflict' in result ? result.conflict : '?'} pending=[${pending}] reason=${'reason' in result ? result.reason : ''}`;
	}
});
