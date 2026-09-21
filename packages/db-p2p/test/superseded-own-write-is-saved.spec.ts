/**
 * Mesh-tier regression for a write reported as failed ("torn") although its row is saved — and for
 * the opposite mistake the fix must not make.
 *
 * A writer is told its commit failed, and before its retry gets to look, a second writer commits the
 * next revision of the same blocks. The retry (`Collection.completeOwnEntry`) re-sends the first
 * write at its own revision and every tier answers "stale: a different action holds a later
 * revision". That is true and says nothing about the write: the later revision was either built ON
 * it (the row is saved) or OVER it (the row is lost). Before the fix the writer took the refusal as
 * proof of loss and threw `TornActionError` either way; an application that resubmits on failure
 * then stored a saved row twice.
 *
 * The writer now asks the blocks' own history (`ITransactor.getLineage`). Three cases pin what that
 * answer has to get right, all on a two-member cohort, where one member's word decides everything:
 *
 *  1. every block landed everywhere, then the rival built on it — saved;
 *  2. one member MISSED the write and later took the rival's revision as a replica ("restored past
 *     the revision"). It holds no record of the write, so it cannot vouch for it — and must not
 *     veto the member that can. Saved;
 *  3. one member HOLDS the write, but the rival's revision was built on the base below it, and that
 *     member took the result as a replica (the fork). Its revision index still names the write, and
 *     must not be believed: the row is gone. Torn, and final.
 *
 * Cases 2 and 3 are built from one fault — a member that applies one commit's log tail but not its
 * data blocks — and real traffic from there on: the fork guard, reconcile and the durability gate do
 * the rest.
 */

import { expect } from 'chai';
import { Tree, TornActionError, emptyTransforms, type ActionId, type BlockLineage, type ITransactor, type CommitRequest, type CommitResult } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

/** What the wrapper below does with the writer's first multi-block commit. */
type Interception = {
	/** Runs once the commit has been attempted and BEFORE the writer hears the outcome: the rival. */
	beforeAnswer: () => Promise<void>;
	/** Report a refusal even though the commit succeeded (a lost or masked success). When false the
	 *  commit's own answer is passed on, which the test has arranged to be a refusal. */
	maskSuccess: boolean;
};

/**
 * Wraps a transactor so that the writer's FIRST multi-block commit is followed — before the writer
 * hears anything — by a rival's write. The writer's pending records are cancelled first when the
 * commit was refused: until they are, the rival's pend is held off by them, and awaiting the rival
 * from inside the writer's own commit would wait for a cancel that cannot run until it returns.
 *
 * Explicit delegation rather than a spread of `inner`: `NetworkTransactor` is a class, so its
 * methods live on the prototype and a spread would copy none of them.
 */
const interceptFirstCommit = (inner: ITransactor, interception: Interception): { transactor: ITransactor; intercepted: () => CommitRequest | undefined } => {
	let intercepted: CommitRequest | undefined;
	const wrapper: ITransactor = {
		get: gets => inner.get(gets),
		getStatus: refs => inner.getStatus(refs),
		pend: request => inner.pend(request),
		cancel: ref => inner.cancel(ref),
		commit: async (request: CommitRequest): Promise<CommitResult> => {
			if (intercepted || request.blockIds.every(id => id === request.tailId)) return inner.commit(request);
			intercepted = request;
			const answer = await inner.commit(request);
			if (!answer.success) {
				await inner.cancel({ actionId: request.actionId, blockIds: request.blockIds });
			}
			await interception.beforeAnswer();
			return answer.success && interception.maskSuccess
				? { success: false, missing: [], reason: 'commit-not-durable: injected after landing' }
				: answer;
		}
	};
	if (inner.queryClusterNominees) {
		wrapper.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	// A wrapper that drops this leaves the writer unable to ask whether a superseded write is
	// saved, and it then reports a torn write of unknown outcome — the honest answer, and the
	// wrong one to test against.
	if (inner.getLineage) {
		wrapper.getLineage = ref => inner.getLineage!(ref);
	}
	return { transactor: wrapper, intercepted: () => intercepted };
};

/**
 * A transactor whose READS are answered by `node`'s own storage, and whose writes take the real
 * network path. The mesh picks a block's read coordinator by ring distance to its (random) id, so
 * which member answers a fresh handle's read differs from run to run; a case whose shape depends
 * on the rival reading ONE member's copy pins it this way.
 */
const readingFrom = (node: MeshNode, inner: ITransactor): ITransactor => {
	const transactor: ITransactor = {
		get: gets => node.storageRepo.get(gets),
		getStatus: refs => inner.getStatus(refs),
		pend: request => inner.pend(request),
		cancel: ref => inner.cancel(ref),
		commit: request => inner.commit(request)
	};
	if (inner.queryClusterNominees) {
		transactor.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	return transactor;
};

/**
 * Makes `node` fail to apply the DATA blocks (every block but the log tail) of the next commit carrying
 * any that reaches its storage. The tail, when the commit carries it too (it does whenever one
 * coordinator covers the whole write), is applied for real; for the rest it answers the "I am already
 * past that revision" refusal a member tolerates without reconciling, and stores none of them. The
 * commit still lands whole on the other member, so the cohort's durability gate sees one holder of two
 * and refuses the writer.
 */
const missTheNextDataCommit = (node: MeshNode): { missed: () => number } => {
	let missed = 0;
	const storage = node.storageRepo;
	const apply = storage.commit.bind(storage);
	storage.commit = async (request, options, proof) => {
		const carriesTail = request.tailId !== undefined && request.blockIds.includes(request.tailId);
		if (missed === 0 && request.blockIds.some(id => id !== request.tailId)) {
			missed++;
			if (carriesTail) {
				const tail = await apply({ ...request, blockIds: [request.tailId!] }, options, proof);
				if (!tail.success) return tail;
			}
			return { success: false, missing: [{ actionId: 'never-applied' as ActionId, rev: request.rev, transforms: emptyTransforms() }] };
		}
		return apply(request, options, proof);
	};
	return { missed: () => missed };
};

describe('A superseded write is reported for what it is: saved when built upon, torn when built over (mesh)', function () {
	this.timeout(60_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;
	let peerA: string;
	let peerB: string;

	beforeEach(async () => {
		mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2, superMajorityThreshold: 0.67 });
		transactors = buildNetworkTransactors(mesh);
		peerA = mesh.nodes[0]!.peerId.toString();
		peerB = mesh.nodes[1]!.peerId.toString();
	});

	const openOn = (peer: string, treeId: string, transactor = transactorFor(transactors, peer)): Promise<Tree<string, Row>> =>
		Tree.createOrOpen<string, Row>(transactor, treeId, keyOf);

	/** What ONE member's own records say about the intercepted write, per data block it named — the
	 *  per-member answers the cohort verdict is folded from. Asserted so a case cannot pass without
	 *  the members being in the state its name claims. */
	const memberLineage = async (node: MeshNode, write: CommitRequest): Promise<(BlockLineage | undefined)[]> => {
		const dataBlocks = write.blockIds.filter(id => id !== write.tailId);
		const answers = await node.storageRepo.get({ blockIds: dataBlocks, lineageOf: { actionId: write.actionId, rev: write.rev } });
		return dataBlocks.map(id => answers[id]?.lineage);
	};

	it('resolves when the rival committed the next revision on top of a write that landed everywhere', async () => {
		const treeId = 'superseded-landed-everywhere';
		const treeA = await openOn(peerA, treeId);
		await treeA.replace([['seed', { key: 'seed', value: 'Seed' }]]);

		const { transactor, intercepted } = interceptFirstCommit(transactorFor(transactors, peerB), {
			beforeAnswer: async () => { await treeA.replace([['rival', { key: 'rival', value: 'Rival' }]]); },
			maskSuccess: true
		});
		const treeB = await openOn(peerB, treeId, transactor);
		await treeB.update();

		const durability = await treeB.replace([['mine', { key: 'mine', value: 'Mine' }]]);
		expect(intercepted(), 'the refusal was injected after the blocks landed').to.not.equal(undefined);
		expect(durability, 'a saved write reports who holds it').to.not.equal(undefined);
		expect(treeB.hasUnsyncedChanges(), 'nothing is left staged to be written a second time').to.equal(false);

		const observer = await openOn(peerA, treeId);
		expect(await observer.get('mine'), 'the row reported saved is stored').to.deep.equal({ key: 'mine', value: 'Mine' });
		expect(await observer.get('rival'), 'the rival row is stored too').to.deep.equal({ key: 'rival', value: 'Rival' });
	});

	it('resolves when one member missed the write and took the rival\'s revision as a replica (restored past the revision)', async () => {
		const treeId = 'superseded-restored-past';
		const treeA = await openOn(peerA, treeId);
		await treeA.replace([['seed', { key: 'seed', value: 'Seed' }]]);
		const { missed } = missTheNextDataCommit(mesh.nodes[0]!);

		// The rival is a handle that has walked the writer's log entry, so its read of the leaf is
		// floored at the writer's revision: node A's older copy is refused and the read is answered
		// by node B's. The rival therefore builds on the write, declaring it as its base — which node
		// A, holding the revision before it, refuses to apply and reconciles from node B instead.
		const { transactor, intercepted } = interceptFirstCommit(transactorFor(transactors, peerB), {
			beforeAnswer: async () => { await treeA.replace([['rival', { key: 'rival', value: 'Rival' }]]); },
			maskSuccess: false
		});
		const treeB = await openOn(peerB, treeId, transactor);
		await treeB.update();

		await treeB.replace([['mine', { key: 'mine', value: 'Mine' }]]);
		expect(missed(), 'node A missed the writer\'s data-block commit').to.equal(1);
		const write = intercepted()!;
		expect(await memberLineage(mesh.nodes[1]!, write), 'node B applied both revisions itself and can vouch for the write')
			.to.deep.equal(['contains']);
		expect(await memberLineage(mesh.nodes[0]!, write), 'node A holds no record of it and cannot say — the answer that must not veto')
			.to.deep.equal(['unknown']);

		for (const peer of [peerA, peerB]) {
			const observer = await openOn(peer, treeId);
			expect(await observer.get('mine'), `the row reported saved is stored, read through ${peer === peerA ? 'A' : 'B'}`)
				.to.deep.equal({ key: 'mine', value: 'Mine' });
			expect(await observer.get('rival')).to.deep.equal({ key: 'rival', value: 'Rival' });
		}
	});

	it('is torn, and final, when the rival built over the write — though one member\'s revision index still names it (the fork)', async () => {
		const treeId = 'superseded-forked';
		const seeder = await openOn(peerA, treeId);
		await seeder.replace([['seed', { key: 'seed', value: 'Seed' }]]);
		const { missed } = missTheNextDataCommit(mesh.nodes[0]!);

		// This rival reads node A's copy of the leaf — the revision BEFORE the write — and builds on
		// it. (It opens after the writer's log entry exists and never walked it, so no floor sends its
		// read elsewhere either.) Node A applies the result; node B, holding the write, refuses it
		// (its latest is not the declared base) and reconciles node A's content over its own.
		const { transactor, intercepted } = interceptFirstCommit(transactorFor(transactors, peerB), {
			beforeAnswer: async () => {
				const rival = await openOn(peerA, treeId, readingFrom(mesh.nodes[0]!, transactorFor(transactors, peerA)));
				await rival.replace([['rival', { key: 'rival', value: 'Rival' }]]);
			},
			maskSuccess: false
		});
		const treeB = await openOn(peerB, treeId, transactor);
		await treeB.update();

		let thrown: unknown;
		try {
			await treeB.replace([['mine', { key: 'mine', value: 'Mine' }]]);
		} catch (err) {
			thrown = err;
		}
		expect(missed(), 'node A missed the writer\'s data-block commit').to.equal(1);
		const write = intercepted()!;
		const [leaf] = write.blockIds.filter(id => id !== write.tailId);
		expect(await mesh.nodes[1]!.storageRepo.getRevisionAction(leaf!, write.rev), 'node B\'s revision index still names the write')
			.to.equal(write.actionId);
		expect(await memberLineage(mesh.nodes[1]!, write), 'and node B does not take that as proof: what it holds now came from node A')
			.to.deep.equal(['unknown']);
		expect(await memberLineage(mesh.nodes[0]!, write), 'node A built the rival\'s revision on the one before the write')
			.to.deep.equal(['excludes']);
		expect(thrown, 'a write that was built over is not reported saved').to.be.instanceOf(TornActionError);
		const torn = thrown as TornActionError;
		expect(torn.reason).to.equal('rival-holds-revision');
		expect(torn.final, 'every member accounted for, pending records confirmed gone').to.equal(true);
		expect(treeB.hasUnsyncedChanges(), 'and the failed replace left nothing staged').to.equal(false);

		// Final means final: the row is absent now, and submitting it again stores it exactly once.
		for (const peer of [peerA, peerB]) {
			const observer = await openOn(peer, treeId);
			expect(await observer.get('mine'), `absent, read through ${peer === peerA ? 'A' : 'B'}`).to.equal(undefined);
			expect(await observer.get('rival')).to.deep.equal({ key: 'rival', value: 'Rival' });
		}
		await treeB.replace([['mine', { key: 'mine', value: 'Mine' }]]);
		const observer = await openOn(peerA, treeId);
		expect(await observer.get('mine'), 'the resubmitted row lands').to.deep.equal({ key: 'mine', value: 'Mine' });
	});
});
