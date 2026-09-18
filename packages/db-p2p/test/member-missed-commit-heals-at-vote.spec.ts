/**
 * Ticket: a-member-that-missed-a-commit-refuses-every-later-write.
 *
 * A cohort member that promised a write and then missed its commit keeps that write's pending record — the
 * durable reservation a member stores at pend-apply and removes at commit or cancel. The rival committed on
 * the rest of the cohort, so nothing will ever remove that record on the member that missed it: its writer
 * believes the write succeeded, and it did. Before this ticket the member read that record as a LIVE rival
 * reservation on every later pend of the block and voted `held`; at three machines the promise bar is all
 * three, so one such vote refused every write to the block, from every machine, until the stuck member
 * happened to read the block itself (the read-driven promotion in `StorageRepo.get`) — which nothing
 * schedules.
 *
 * What this spec pins, on the in-process mesh at the production-shaped three-machine configuration
 * (`util/node-count-mesh.ts`), reusing `member-leaves-and-returns.spec.ts`'s phase-2 mechanics:
 *
 *  1. **Seed.** A writes a row; every machine holds it.
 *  2. **C misses a commit.** C promises the TAIL commit of A's next write and drops before voting on it. The
 *     tail commits on A and B (the commit phase needs a simple majority); C keeps the pending record it stored
 *     when it promised the pend, and its own storage stays behind.
 *  3. **Nobody owes C the commit.** A restarts while C is away, taking its scheduled commit retry
 *     (`ClusterCoordinator.scheduleCommitRetry`) with it — the mesh wires no transaction state store, so the
 *     restarted A recovers nothing. C returns owed nothing, still behind, still holding the record.
 *  4. **B writes, and it lands.** This is the fixed behaviour: the pend's promise round is what brings C
 *     current. C's vote finds a pending record whose claimed revision the incoming pend has already moved
 *     past, reconciles the block from the cohort, and votes on the healed state. The write is acknowledged
 *     fully durable, C's OWN storage holds the revision it missed, the stale record is gone, and no repo call
 *     was routed through C (`onRoute` is asserted, not assumed).
 *  5. **Everything reads everywhere,** and a further write from each machine is fully durable.
 *
 * Before the fix phase 4 failed with `SyncRetryExhaustedError … Pend blocks held: 1/3 member(s) …` after the
 * writer's whole retry budget (~17s measured), and phase 5's reads through C were what cleared it.
 */

import { expect } from 'chai';
import { Tree, isFullyDurable, type ActionId, type BlockId, type ClusterRecord, type CommitRequest, type ITransactor, type WriteDurability } from '@optimystic/db-core';
import type { Mesh, MeshNode } from '../src/testing/mesh-harness.js';
import {
	createProductionShapedMesh, setUnreachable, transactorDrivenBy, recording, durableHolders, type Attempt
} from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const MACHINES = 3;
const TREE_ID = 'member-missed-commit-heals-at-vote';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

/** The commit C missed: what it named, so its landing on C can be checked block by block. */
interface MissedCommit {
	actionId: ActionId;
	rev: number;
	tailId: BlockId;
	blockIds: readonly BlockId[];
}

describe('A member that missed a commit is brought current by the next pend it votes on (three machines)', function () {
	this.timeout(90_000);
	sequentialPhases();

	let mesh: Mesh;
	let a: MeshNode;
	let b: MeshNode;
	let c: MeshNode;
	/** Every pend and commit issued, across every driver. */
	const attempts: Attempt[] = [];
	/** The last acknowledged value of every row. */
	const acknowledged = new Map<string, string>();
	let missed: MissedCommit;
	/** Peer-id strings of every repo a phase's transactor reached for. */
	let routed: Set<string>;
	let healMs: number | undefined;

	after(() => {
		console.log(`\nA member that missed a commit (three machines): B's first write after C returned ${healMs === undefined ? 'did not land' : `landed in ${healMs}ms, healing C at its vote`}\n`);
	});

	const label = (node: MeshNode): string => 'ABC'[mesh.nodes.indexOf(node)]!;
	const driven = (node: MeshNode): ITransactor => recording(transactorDrivenBy(mesh, node, { onRoute: peer => routed.add(peer) }), attempts);

	async function write(writer: MeshNode, key: string, value: string): Promise<WriteDurability | undefined> {
		const tree = await Tree.createOrOpen<string, Row>(driven(writer), TREE_ID, keyOf);
		return await tree.replace([[key, { key, value }]]);
	}

	async function read(reader: MeshNode, key: string): Promise<string | undefined> {
		const tree = await Tree.open<string, Row>(driven(reader), TREE_ID, keyOf);
		expect(tree, `${label(reader)} opens the shared tree`).to.not.equal(undefined);
		return (await tree!.get(key))?.value;
	}

	async function expectReadable(readers: readonly MeshNode[], when: string): Promise<void> {
		const wrong: string[] = [];
		for (const reader of readers) {
			for (const [key, value] of acknowledged) {
				const seen = await read(reader, key);
				if (seen !== value) wrong.push(`${label(reader)} read ${key} as ${seen ?? 'absent'}, expected ${value}`);
			}
		}
		expect(wrong, `${when}: rows that did not read back`).to.deep.equal([]);
	}

	/** Which machines' OWN storage holds every block of the missed commit at its revision or later. */
	const holdersOfMissed = async (): Promise<string[]> =>
		(await durableHolders(mesh.nodes, { kind: 'commit', actionId: missed.actionId, rev: missed.rev, blockIds: missed.blockIds })).map(label);

	/** What `node`'s own storage says about the missed commit's tail — read directly, so no cluster consult
	 *  or read repair can manufacture the answer. */
	async function tailOn(node: MeshNode): Promise<{ latestRev: number | undefined; pendings: ActionId[] }> {
		const entry = (await node.storageRepo.get({ blockIds: [missed.tailId] }))[missed.tailId];
		return { latestRev: entry?.state?.latest?.rev, pendings: entry?.state?.pendings ?? [] };
	}

	before(async () => {
		mesh = await createProductionShapedMesh(MACHINES);
		[a, b, c] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		routed = new Set();
	});

	it('phase 1 — seed: A writes a row and every machine holds it', async () => {
		const durability = await write(a, 'row-A', 'written-by-A');
		expect(durability && isFullyDurable(durability), `A's seed write, with every member reachable: ${JSON.stringify(durability)}`).to.equal(true);
		acknowledged.set('row-A', 'written-by-A');
		await expectReadable(mesh.nodes, 'seeded');
	});

	it('phase 2 — C promises the tail commit of A\'s write and drops before voting on it: A and B hold the tail, C keeps only its pending record', async () => {
		const cId = c.peerId.toString();
		let leftDuring: ClusterRecord | undefined;
		mesh.failures.onClusterDelivery = (target, record) => {
			if (leftDuring !== undefined || target !== cId) return;
			const commit = (record.message.operations[0] as { commit?: CommitRequest }).commit;
			// The write's TAIL commit — the one that lands the log entry — on the delivery that would carry
			// C's commit vote: C has promised it, and has not voted to commit it.
			const isTailStep = commit !== undefined && commit.blockIds.includes(commit.tailId);
			if (isTailStep && record.promises[cId] !== undefined && record.commits[cId] === undefined) {
				leftDuring = record;
				missed = { actionId: commit.actionId, rev: commit.rev, tailId: commit.tailId, blockIds: commit.blockIds };
				setUnreachable(mesh, [c]);
			}
		};

		let outcome: string;
		try {
			const durability = await write(a, 'written-as-C-left', 'held-by-A-and-B');
			outcome = `returned ${JSON.stringify(durability)}`;
		} catch (err) {
			// The write's blocks after the tail cannot be swept with C away (the sweep needs all three
			// promises), so the writer may report the write torn. What matters here is storage, below.
			outcome = `threw ${(err as Error).message}`;
		} finally {
			mesh.failures.onClusterDelivery = undefined;
		}
		console.log(`    phase 2: A's write ${outcome}`);

		expect(leftDuring, 'C left at the intended step — the tail commit, which C had promised').to.not.equal(undefined);
		expect(await holdersOfMissed(), `whose own storage holds action ${missed.actionId} at rev ${missed.rev}`).to.deep.equal(['A', 'B']);
		const onC = await tailOn(c);
		expect(onC.pendings, 'C still holds the pending record it stored when it promised the pend').to.include(missed.actionId);
		expect(onC.latestRev ?? 0, 'C\'s tail is behind the commit it missed').to.be.below(missed.rev);
	});

	it('phase 3 — A restarts while C is away, so C returns owed nothing: still behind, still holding the record', async () => {
		mesh.restart(a);
		setUnreachable(mesh, []);
		expect(await holdersOfMissed(), 'C is still behind when it returns').to.deep.equal(['A', 'B']);
		expect((await tailOn(c)).pendings, 'the record is still there').to.include(missed.actionId);
	});

	it('phase 4 — B writes: the write lands fully durable, and C\'s own storage comes current at its vote, without any repo call through C', async () => {
		routed = new Set();
		const started = Date.now();
		const durability = await write(b, 'written-after-C-returned', 'acknowledged-by-all-three');
		healMs = Date.now() - started;
		expect(durability, 'the write is acknowledged').to.not.equal(undefined);
		expect(isFullyDurable(durability!), `B's write, with every member back: ${JSON.stringify(durability)}`).to.equal(true);
		acknowledged.set('written-after-C-returned', 'acknowledged-by-all-three');

		expect([...routed], 'nothing was routed through C — its healing was its own').to.not.include(c.peerId.toString());
		const onC = await tailOn(c);
		expect(onC.latestRev, 'C\'s own storage now holds the revision it missed (or later)').to.be.at.least(missed.rev);
		expect(onC.pendings, 'the record for the missed commit is gone from C').to.not.include(missed.actionId);
		expect(await holdersOfMissed(), `whose own storage holds action ${missed.actionId}`).to.deep.equal(['A', 'B', 'C']);
	});

	it('phase 5 — every machine reads every row, and a further write from each is fully durable', async () => {
		await expectReadable(mesh.nodes, 'after C healed');
		for (const writer of mesh.nodes) {
			const key = `later-by-${label(writer)}`;
			const value = `written-by-${label(writer)}-later`;
			const durability = await write(writer, key, value);
			expect(durability && isFullyDurable(durability), `${label(writer)}'s later write: ${JSON.stringify(durability)}`).to.equal(true);
			acknowledged.set(key, value);
		}
		await expectReadable(mesh.nodes, 'after the later writes');
	});
});
