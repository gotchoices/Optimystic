/**
 * Ticket: a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it.
 *
 * The lost update the rule closes, driven on the in-process mesh at the production-shaped FOUR-machine
 * configuration (`util/node-count-mesh.ts`). From four members up the pend promise bar (a super-majority)
 * lets one member miss a pend entirely, and that member can then serve a block one change short:
 *
 *  1. **Seed.** A writes a row; every machine holds it.
 *  2. **R pends past D, and its data-block commit is held.** A writes a second row (the rival, R). D never
 *     receives R's pend (its deliveries of that pend fail); A, B and C store R's pending record on the data
 *     block. R's TAIL commit lands everywhere — D reconciles it, since it holds no pend — and R's data-block
 *     commit is held on the writer's side, so the log names R while no member's data block holds R's row.
 *  3. **N reads through D and writes.** A fresh handle driven by D opens the tree: the log (current on D)
 *     names R, but D holds no record to promote, so it serves the data block without R's row, and the handle
 *     — which has walked no entry and so holds no floor for the block — accepts it. N pends past R's slot,
 *     declaring the stale revision as its base. A, B and C still hold R's record; under the revision rule
 *     they approved, because N's revision was past R's slot, and N's commit then applied over the stale base
 *     and swept R's record. With the base rule they HOLD: N's base is below R's claim.
 *  4. **R's commit is released.** R lands on every machine. N's write is either saved with both rows or
 *     refused — today it is refused: its handle never re-reads the block it was served short, so every
 *     retry re-pends on the stale base and the fork guard refuses the data-block commit (backlog
 *     `bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`). Never acknowledged over R.
 *  5. **The application retries N** from a fresh handle through D, which now holds R's change: it lands,
 *     and every machine reads both rows.
 *
 * Negative control (run by hand when this was written): with the base comparison in `isReservationAgainst`
 * removed, phase 3 fails — N's write is acknowledged, fully durable, while R's data-block commit is still
 * held. With phase 3 reduced to an observation, phase 4 then shows the loss: R's released data-block commit
 * is refused as stale (the block is already at N's revision) and R's write ends in `TornActionError`, its
 * log entry stored and its row on no machine.
 */

import { expect } from 'chai';
import { Tree, type ActionId, type BlockId, type ClusterRecord, type CommitRequest, type CommitResult, type IRepo, type ITransactor, type PendRequest, type WriteDurability } from '@optimystic/db-core';
import type { Mesh, MeshNode } from '../src/testing/mesh-harness.js';
import { createProductionShapedMesh, transactorDrivenBy, recording, type Attempt } from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const MACHINES = 4;
const TREE_ID = 'rival-superseded-only-by-a-writer-that-built-on-it';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

/** Whether `record` carries a pend for `actionId`. */
const pendsFor = (record: ClusterRecord, actionId: ActionId | undefined): boolean =>
	actionId !== undefined && record.message.operations.some(op => 'pend' in op && (op as { pend: PendRequest }).pend.actionId === actionId);

describe('A rival pend is superseded only by a writer that built on it (four machines)', function () {
	this.timeout(120_000);
	sequentialPhases();

	let mesh: Mesh;
	let a: MeshNode;
	let b: MeshNode;
	let c: MeshNode;
	let d: MeshNode;
	const attempts: Attempt[] = [];
	const acknowledged = new Map<string, string>();

	/** R — the rival write whose data-block commit is held. */
	let rivalAction: ActionId | undefined;
	let rivalDataBlocks: BlockId[] = [];
	let rivalWrite: Promise<WriteDurability | undefined> | undefined;
	let releaseRival: () => void = () => { /* set in phase 2 */ };
	/** N — the newcomer, reading through D. */
	let newcomerAttempts: Attempt[] = [];
	let newcomerWrite: Promise<WriteDurability | undefined> | undefined;

	const label = (node: MeshNode): string => 'ABCD'[mesh.nodes.indexOf(node)]!;

	const writeWith = async (transactor: ITransactor, key: string, value: string): Promise<WriteDurability | undefined> => {
		const tree = await Tree.createOrOpen<string, Row>(transactor, TREE_ID, keyOf);
		return await tree.replace([[key, { key, value }]]);
	};

	async function read(reader: MeshNode, key: string): Promise<string | undefined> {
		const tree = await Tree.open<string, Row>(recording(transactorDrivenBy(mesh, reader), attempts), TREE_ID, keyOf);
		expect(tree, `${label(reader)} opens the shared tree`).to.not.equal(undefined);
		return (await tree!.get(key))?.value;
	}

	/** What `node`'s own storage says about `blockId` — no cluster consult, no read repair. */
	async function stateOn(node: MeshNode, blockId: BlockId): Promise<{ latestRev: number | undefined; pendings: ActionId[] }> {
		const entry = (await node.storageRepo.get({ blockIds: [blockId] }))[blockId];
		return { latestRev: entry?.state?.latest?.rev, pendings: entry?.state?.pendings ?? [] };
	}

	const waitFor = async (what: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};

	before(async () => {
		mesh = await createProductionShapedMesh(MACHINES);
		[a, b, c, d] = mesh.nodes as [MeshNode, MeshNode, MeshNode, MeshNode];
	});

	after(() => {
		mesh.failures.onClusterDelivery = undefined;
		releaseRival();
	});

	it('phase 1 — seed: A writes a row and every machine reads it', async () => {
		await writeWith(recording(transactorDrivenBy(mesh, a), attempts), 'row-seed', 'seeded-by-A');
		acknowledged.set('row-seed', 'seeded-by-A');
		for (const reader of mesh.nodes) {
			expect(await read(reader, 'row-seed'), `${label(reader)} reads the seed`).to.equal('seeded-by-A');
		}
	});

	it('phase 2 — R pends without D, commits its tail everywhere, and its data-block commit is held', async () => {
		const dId = d.peerId.toString();
		let gateReached = false;
		const gate = new Promise<void>(resolve => { releaseRival = resolve; });

		// D misses R's pend: every delivery of it to D fails, including the coordinator's scheduled retries.
		mesh.failures.onClusterDelivery = (target, record) => {
			if (target === dId && pendsFor(record, rivalAction)) {
				throw new Error(`D (${dId}) misses the rival's pend`);
			}
		};
		// On the writer's side: learn R's action from its pend, and hold its data-block stage — the second
		// commit call, the one that does not carry the tail.
		const wrapRepo = (_peer: string, repo: IRepo): IRepo => ({
			get: gets => repo.get(gets),
			cancel: ref => repo.cancel(ref),
			pend: async (request: PendRequest) => {
				rivalAction ??= request.actionId;
				return await repo.pend(request);
			},
			commit: async (request: CommitRequest): Promise<CommitResult> => {
				if (request.actionId === rivalAction && !request.blockIds.includes(request.tailId)) {
					rivalDataBlocks = [...request.blockIds];
					gateReached = true;
					await gate;
				}
				return await repo.commit(request);
			}
		});
		rivalWrite = writeWith(recording(transactorDrivenBy(mesh, a, { wrapRepo }), attempts), 'row-R', 'written-by-R');
		rivalWrite.catch(() => { /* observed in phase 4 */ });
		await waitFor('the rival\'s data-block commit to reach the gate', () => gateReached);

		expect(rivalAction, 'the rival\'s action was seen').to.not.equal(undefined);
		expect(rivalDataBlocks.length, 'the rival touches at least one block beyond the tail').to.be.greaterThan(0);
		for (const blockId of rivalDataBlocks) {
			for (const holder of [a, b, c]) {
				expect((await stateOn(holder, blockId)).pendings, `${label(holder)} holds R's record on ${blockId}`).to.include(rivalAction);
			}
			expect((await stateOn(d, blockId)).pendings, `D never received R's pend (${blockId})`).to.not.include(rivalAction);
		}
	});

	it('phase 3 — N reads through D and writes past R\'s slot: it is held, not landed over R\'s change', async () => {
		newcomerAttempts = [];
		newcomerWrite = writeWith(recording(transactorDrivenBy(mesh, d), newcomerAttempts), 'row-N', 'written-by-N');
		newcomerWrite.catch(() => { /* observed in phase 4 */ });

		const refusedPend = () => newcomerAttempts.some(at => at.kind === 'pend' && (at.thrown !== undefined || at.result?.success === false));
		const committedData = () => newcomerAttempts.some(at => at.kind === 'commit' && at.result?.success === true);
		await waitFor('N\'s first pend to be refused, or its write to commit', () => refusedPend() || committedData());

		expect(committedData(), 'N committed while R\'s data-block commit was still held — the lost update').to.equal(false);
		expect(refusedPend(), 'N\'s pend was refused while R\'s record reserved the block').to.equal(true);
		for (const blockId of rivalDataBlocks) {
			for (const holder of [a, b, c]) {
				expect((await stateOn(holder, blockId)).pendings, `R's record still stands on ${label(holder)} (${blockId})`).to.include(rivalAction);
			}
		}
	});

	it('phase 4 — R\'s commit is released: R lands everywhere, and N is saved with both rows or refused, never acknowledged over R', async () => {
		releaseRival();
		mesh.failures.onClusterDelivery = undefined;
		await rivalWrite;
		acknowledged.set('row-R', 'written-by-R');

		// N's handle never re-reads the data block after the held refusal: it read it once through D, one
		// change short, and every retry re-pends on that base. With R's record promoted the pend is
		// admitted, and the fork guard (`StorageRepo.internalCommit`) refuses its data-block commit on
		// every member, so the write ends torn — refused, not acknowledged. That is the gap backlog
		// `bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy` owns; what this phase pins
		// is the safety half: whatever N's write reports, R's row is on every machine.
		let newcomerOutcome: string;
		try {
			await newcomerWrite;
			acknowledged.set('row-N', 'written-by-N');
			newcomerOutcome = 'acknowledged';
		} catch (err) {
			newcomerOutcome = `refused (${(err as Error).name})`;
		}
		console.log(`    phase 4: N's first write was ${newcomerOutcome}`);

		const wrong: string[] = [];
		for (const reader of mesh.nodes) {
			for (const [key, value] of acknowledged) {
				const seen = await read(reader, key);
				if (seen !== value) wrong.push(`${label(reader)} read ${key} as ${seen ?? 'absent'}, expected ${value}`);
			}
			if (!acknowledged.has('row-N')) {
				const seen = await read(reader, 'row-N');
				if (seen !== undefined) wrong.push(`${label(reader)} read the refused row-N as ${seen}`);
			}
		}
		expect(wrong, 'rows that did not read back as acknowledged').to.deep.equal([]);
	});

	it('phase 5 — the application writes N again through D from a fresh handle: it lands, and every machine reads both rows', async () => {
		if (!acknowledged.has('row-N')) {
			await writeWith(recording(transactorDrivenBy(mesh, d), attempts), 'row-N', 'written-by-N');
			acknowledged.set('row-N', 'written-by-N');
		}
		const wrong: string[] = [];
		for (const reader of mesh.nodes) {
			for (const [key, value] of acknowledged) {
				const seen = await read(reader, key);
				if (seen !== value) wrong.push(`${label(reader)} read ${key} as ${seen ?? 'absent'}, expected ${value}`);
			}
		}
		expect(wrong, 'rows that did not read back').to.deep.equal([]);
		expect([...acknowledged.keys()].sort()).to.deep.equal(['row-N', 'row-R', 'row-seed']);
	});
});
