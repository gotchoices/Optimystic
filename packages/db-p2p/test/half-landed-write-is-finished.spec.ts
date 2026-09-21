/**
 * Mesh-tier regression for the write that is acknowledged on the strength of its log entry alone.
 *
 * A write to a tree touches its log tail AND its data blocks (the leaf the row lives in). Every
 * member applies the tail before the rest; `NetworkTransactor.commit` sends them in one round when one
 * coordinator covers them all, and otherwise commits the tail first and sweeps the rest only if the
 * tail answered success — and a failed answer does not mean the tail is absent: the durability gate
 * answers `commit-not-durable` whenever fewer than a majority hold the revision, even though some
 * members stored it. The writer then cancels (dropping the data blocks' pending records on every member),
 * refreshes, and finds its own log entry. Before the fix it took that entry as proof the write was
 * saved: `replace()` resolved, the collection's revision advanced, and the leaf stayed at its
 * previous revision on every node. The row was gone and no reader got an error.
 *
 * db-core pins the client-side rule against an in-memory double
 * (`packages/db-core/test/own-entry-completes-the-action.spec.ts`). This file pins the half that
 * double cannot: finishing the action is a re-send of the SAME action id at the SAME revision AFTER
 * the writer has cancelled, and it only works if every real tier — `StorageRepo.pend`/`.commit`,
 * `ClusterMember`, `CoordinatorRepo`, consensus — accepts the tail as already this action's own
 * while landing the blocks that are missing. The sibling diary spec
 * (`concurrent-diary-append-acknowledgement.spec.ts`) cannot reach that arm, as its own NOTE says: a
 * diary append touches no block beyond the tail, so its torn commit drops nothing.
 */

import { expect } from 'chai';
import { Tree, type ITransactor, type CommitRequest, type CommitResult } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '../src/testing/mesh-harness.js';

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

/** One injected tear: how many of the action's blocks were let through, and how many abandoned. */
interface TearRecord {
	committed: number;
	dropped: number;
}

/**
 * Wraps a transactor so its FIRST multi-block commit lands ONLY the log tail — for real, through
 * consensus — and then answers the retryable refusal the durability gate produces. Every block
 * after the tail is never committed, exactly as when `NetworkTransactor.commit` returns at a
 * refused tail without sweeping (its two-step path). A commit carrying nothing but the tail has nothing to abandon and
 * is passed through untouched.
 *
 * Explicit delegation rather than a spread of `inner`: `NetworkTransactor` is a class, so its
 * methods live on the prototype and a spread would copy none of them.
 */
const landOnlyTheTailOnce = (inner: ITransactor): { transactor: ITransactor; tears: TearRecord[] } => {
	const tears: TearRecord[] = [];
	const wrapper: ITransactor = {
		get: gets => inner.get(gets),
		getStatus: refs => inner.getStatus(refs),
		pend: request => inner.pend(request),
		cancel: ref => inner.cancel(ref),
		commit: async (request: CommitRequest): Promise<CommitResult> => {
			const abandoned = request.blockIds.filter(id => id !== request.tailId);
			if (tears.length > 0 || abandoned.length === 0) return inner.commit(request);
			const tail = await inner.commit({ ...request, blockIds: [request.tailId] });
			// A tail that itself lost is an ordinary loss: nothing is torn, report it verbatim.
			if (!tail.success) return tail;
			tears.push({ committed: 1, dropped: abandoned.length });
			return { success: false, conflict: true, reason: 'commit-not-durable: injected tail-only landing' };
		}
	};
	if (inner.queryClusterNominees) {
		wrapper.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	return { transactor: wrapper, tears };
};

describe('A half-landed write is finished before it is acknowledged (mesh)', function () {
	this.timeout(30_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	beforeEach(async () => {
		mesh = await createMesh(3, {
			responsibilityK: 3,
			clusterSize: 3,
			superMajorityThreshold: 0.67
		});
		transactors = buildNetworkTransactors(mesh);
	});

	it('a row whose write landed only its log tail is readable on every node once replace() resolves', async () => {
		const treeId = 'half-landed-participants';
		const writerPeer = mesh.nodes[0]!.peerId.toString();
		const observerPeer = mesh.nodes[1]!.peerId.toString();

		// Seed through the unwrapped transactor so the tree exists with a committed header: the
		// half-landed write below is then an ordinary update of an existing leaf, and its own log
		// entry is reachable on refresh.
		const host = await Tree.createOrOpen<string, Row>(transactorFor(transactors, writerPeer), treeId, keyOf);
		await host.replace([['host', { key: 'host', value: 'Host' }]]);

		const { transactor: tearing, tears } = landOnlyTheTailOnce(transactorFor(transactors, writerPeer));
		const joiner = await Tree.createOrOpen<string, Row>(tearing, treeId, keyOf);
		await joiner.update();
		await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]]);	// resolves: "saved"

		// The injection must actually have fired, and must actually have abandoned a block — a tear
		// that dropped nothing (the diary shape) would make everything below vacuous.
		expect(tears.length, 'the first commit landed only its tail').to.equal(1);
		expect(tears[0]!.dropped, 'a block beyond the tail was abandoned').to.be.at.least(1);

		// The writer reads its own acknowledged row...
		await joiner.update();
		expect(await joiner.get('joiner'), 'writer view').to.deep.equal({ key: 'joiner', value: 'Joiner' });

		// ...and so does a tree freshly opened on a node that never saw the tear: the row is
		// genuinely stored, not an artifact of the writer's local tracker.
		const observer = await Tree.createOrOpen<string, Row>(transactorFor(transactors, observerPeer), treeId, keyOf);
		expect(await observer.get('joiner'), 'observer view').to.deep.equal({ key: 'joiner', value: 'Joiner' });
		expect(await observer.get('host'), 'the earlier row is untouched').to.deep.equal({ key: 'host', value: 'Host' });

		// Finished AT the revision the tail took — a second revision would mean the write was
		// re-driven and logged twice.
		expect(observer.committedRevision(), 'one revision for the one write').to.equal(joiner.committedRevision());
		expect(observer.committedActionId(), 'under the one action id').to.equal(joiner.committedActionId());

		// And the tree is still writable afterwards: the re-send left no pending record standing
		// on the tail (a record there would refuse every later writer).
		await observer.replace([['later', { key: 'later', value: 'Later' }]]);
		await joiner.update();
		expect(await joiner.get('later'), 'a later write from another node lands').to.deep.equal({ key: 'later', value: 'Later' });
	});
});
