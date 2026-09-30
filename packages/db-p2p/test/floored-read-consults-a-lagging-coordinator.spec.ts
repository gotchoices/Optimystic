/**
 * Ticket: a-coordinator-told-of-a-newer-revision-consults-past-its-window.
 *
 * Mesh-tier regression for the shape a downstream consumer hit in one write of ten: a cohort member
 * that missed a commit the rest of the cohort acknowledged goes on answering reads from its own copy
 * inside its lazy read-repair window. A handle whose reads that member coordinates writes; the other
 * members refuse the write as stale and name the revision it lost to; the handle's next refresh asks
 * the same member for the log tail with that revision as its floor. Before the fix the member answered
 * from its window again, the refresh moved nowhere, and the write ended in `SyncRevisionStalledError`
 * with the revision it needed one hop away. Now the floor makes the member consult its cohort at once:
 * it repairs its own copy at the moment of the read, answers with the newer revision, and the retry
 * lands.
 *
 * Three members rather than two, so the lag is the ordinary production one — a commit acknowledged at
 * `majority` durability with one member unconfirmed — with no partition and no lying member. Every
 * read of the handle is routed to the lagging member's coordinator. That models the case the ticket
 * names, where the second-chance coordinator `NetworkTransactor.get` would try is inside its window
 * too, and isolates the coordinator-side fix from the transactor's retry.
 */

import { expect } from 'chai';
import { Tree, emptyTransforms, isFullyDurable, type ActionId, type CommitRequest, type ITransactor, type WriteDurability } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type MeshNode } from '../src/testing/mesh-harness.js';
import { captureLog } from './support/capture-log.js';

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

/**
 * A transactor whose READS are answered by `node`'s coordinator — the read path under test, window
 * and all — and whose writes take the real network path through `inner`. Explicit delegation rather
 * than a spread of `inner`: `NetworkTransactor` is a class, so its methods live on the prototype.
 */
const readingThroughCoordinator = (node: MeshNode, inner: ITransactor): ITransactor => {
	const transactor: ITransactor = {
		get: gets => node.coordinatorRepo.get(gets),
		getStatus: refs => inner.getStatus(refs),
		pend: request => inner.pend(request),
		cancel: ref => inner.cancel(ref),
		commit: request => inner.commit(request)
	};
	if (inner.queryClusterNominees) {
		transactor.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	if (inner.getLineage) {
		transactor.getLineage = ref => inner.getLineage!(ref);
	}
	return transactor;
};

/**
 * Makes `node`'s storage refuse the NEXT commit that reaches it with the "I am already past that
 * revision" answer a member tolerates without reconciling, and stores none of it. On a three-member
 * cohort the commit still lands on the other two and is acknowledged at `majority` durability, so
 * this member is left exactly one revision behind, holding a pending record it never promoted.
 */
const missTheNextCommit = (node: MeshNode): { missed: () => CommitRequest | undefined } => {
	let missed: CommitRequest | undefined;
	const storage = node.storageRepo;
	const apply = storage.commit.bind(storage);
	storage.commit = async (request, options, proof) => {
		if (missed !== undefined) return apply(request, options, proof);
		missed = request;
		return { success: false, missing: [{ actionId: 'never-applied' as ActionId, rev: request.rev, transforms: emptyTransforms() }] };
	};
	return { missed: () => missed };
};

type TriggerPayload = { blockId?: string; reason?: string; floor?: number };
const triggers = (captured: unknown[][]): TriggerPayload[] =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes('cluster-tx:read-repair-triggered'))
		.map(args => args[1] as TriggerPayload);

describe('A coordinator told of a newer revision consults its cohort past its window (mesh)', function () {
	this.timeout(60_000);

	it('repairs the lagging member at the moment of the floored read, and the refused write\'s retry lands', async () => {
		const mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3, superMajorityThreshold: 0.67 });
		const transactors = buildNetworkTransactors(mesh);
		const nodeA = mesh.nodes[0]!;
		const nodeB = mesh.nodes[1]!;
		const viaA = transactorFor(transactors, nodeA.peerId.toString());
		const treeId = 'floored-read-lagging-coordinator';

		const treeA = await Tree.createOrOpen<string, Row>(viaA, treeId, keyOf);
		await treeA.replace([['seed', { key: 'seed', value: 'Seed' }]]);

		// Member B checks every block of the tree with its cohort while all three agree, which arms
		// its read-repair window for each. Its clock is then held still, so the window cannot lapse
		// during the test and only the asker's floor can get it to consult again.
		const frozen = Date.now();
		nodeB.coordinatorRepo.now = () => frozen;
		const stamper = await Tree.createOrOpen<string, Row>(readingThroughCoordinator(nodeB, viaA), treeId, keyOf);
		expect(await stamper.get('seed')).to.deep.equal({ key: 'seed', value: 'Seed' });

		// B misses the next commit: A's write lands on A and C, is acknowledged, and B stays one
		// revision behind — inside its window.
		const { missed } = missTheNextCommit(nodeB);
		await treeA.replace([['lagging', { key: 'lagging', value: 'Lagging' }]]);
		const lagging = missed();
		expect(lagging, 'B missed A\'s commit').to.not.equal(undefined);
		expect(await nodeB.storageRepo.getRevisionAction(lagging!.tailId, lagging!.rev), 'B does not hold that revision of the tail')
			.to.equal(undefined);

		// A handle that reads through B and writes through the network sees B's stale view, pends at
		// the revision A's write took, is refused by A with that revision as `staleAt`, and refreshes
		// through B with it as the tail's floor. No `SyncRevisionStalledError` may escape here.
		const handle = await Tree.createOrOpen<string, Row>(readingThroughCoordinator(nodeB, viaA), treeId, keyOf);
		let durability: WriteDurability | undefined;
		const captured = await captureLog('coordinator-repo', async () => {
			durability = await handle.replace([['mine', { key: 'mine', value: 'Mine' }]]);
		});

		expect(durability, 'the write reports its durability').to.not.equal(undefined);
		expect(isFullyDurable(durability!), 'and every member holds it, the repaired one included').to.equal(true);
		expect(triggers(captured).filter(t => t.blockId === lagging!.tailId && t.reason === 'floor').map(t => t.floor),
			'B consulted for the tail because of the floor, not the window').to.deep.equal([lagging!.rev]);
		// The storage-side half: B holds A's revision of the tail under A's action, which only the
		// read-time repair can have put there — the retry's commit wrote the revision after it.
		expect(await nodeB.storageRepo.getRevisionAction(lagging!.tailId, lagging!.rev), 'B was repaired at the moment of the read')
			.to.equal(lagging!.actionId);

		const observer = await Tree.createOrOpen<string, Row>(viaA, treeId, keyOf);
		expect(await observer.get('mine')).to.deep.equal({ key: 'mine', value: 'Mine' });
		expect(await observer.get('lagging')).to.deep.equal({ key: 'lagging', value: 'Lagging' });
		expect(await handle.get('lagging'), 'the handle sees the revision it was told about').to.deep.equal({ key: 'lagging', value: 'Lagging' });
	});
});
