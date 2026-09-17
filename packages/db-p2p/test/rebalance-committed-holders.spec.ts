/**
 * Ticket: rebalance-pushes-freshly-committed-blocks-back-to-members-that-hold-them.
 *
 * Every block a commit touches enters the node's owned-block set, and the rebalance monitor treats a
 * block it has no memory of as brand new: the next check reports it `gained` (the reaction pulls it
 * from the cohort over `/sync`) and its whole non-self cohort `grown` (the reaction pushes it to each
 * of those peers over `/block-transfer`). For a freshly committed block both are pure waste — the
 * members stored it as part of the commit — and over a relay one insert set off dozens of streams.
 *
 * The fix reports, for each commit a node holds, which cohort members are known to hold it: the
 * member after a durable consensus apply (the record's approving signers), the coordinator on
 * acknowledging a cohort commit (confirmed holders that also signed, plus who is unconfirmed). This
 * spec drives real `ClusterMember`s and `CoordinatorRepo`s in the mesh harness, each node with a real
 * `RebalanceMonitor` fed by its own storage's change events — the `libp2p-node-base` wiring — and
 * counts the transfers a check would start straight off the event: one pull per `gained` block, one
 * push per `grown` (block, peer).
 */

import { expect } from 'chai';
import type { PeerId } from '@libp2p/interface';
import type { BlockHeader, BlockId, IBlock, Transforms } from '@optimystic/db-core';
import type { FretService } from 'p2p-fret';
import { createMesh, type Mesh, type MeshNode, type MeshOptions } from '../src/testing/mesh-harness.js';
import { RebalanceMonitor, type RebalanceEvent } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader
});

const insertsOf = (blockIds: string[]): Transforms => ({
	inserts: Object.fromEntries(blockIds.map(id => [id, makeBlock(id)])),
	updates: {},
	deletes: []
});

/** Just enough libp2p for the monitor: its peer id and the connection listeners it registers. */
const monitorLibp2p = (peerId: PeerId) => ({
	peerId,
	addEventListener: () => {},
	removeEventListener: () => {}
});

/** FRET stand-in: the cohort comes from the node's key network, so only the adapter needs a target. */
const idleFret = {} as unknown as FretService;

interface Rig {
	mesh: Mesh;
	monitors: Map<string, RebalanceMonitor>;
}

/**
 * A mesh whose every node runs a started `RebalanceMonitor` over the node's own key network and
 * owned-block set. `reportHolders: false` builds the pre-fix shape — nothing tells the monitor who
 * holds a commit — as the baseline the fix is measured against.
 */
const buildRig = async (nodeCount: number, options: MeshOptions, reportHolders: boolean): Promise<Rig> => {
	const monitors = new Map<string, RebalanceMonitor>();
	const mesh = await createMesh(nodeCount, {
		...options,
		onCommittedHolders: reportHolders
			? (node, committed) => monitors.get(node.peerId.toString())?.recordCommittedHolders(committed)
			: undefined
	});
	for (const node of mesh.nodes) {
		const owned = new Set<string>();
		node.storageRepo.onAnyCollectionChange(e => { for (const blockId of e.blockIds) owned.add(blockId); });
		const monitor = new RebalanceMonitor({
			libp2p: monitorLibp2p(node.peerId) as never,
			fret: idleFret,
			partitionDetector: new PartitionDetector(),
			fretAdapter: new ArachnodeFretAdapter(idleFret),
			trackedBlocks: owned,
			keyNetwork: node.keyNetwork,
			clusterSize: options.clusterSize
		}, { minRebalanceIntervalMs: 0, growthRecheckIntervalMs: 0 });
		await monitor.start();
		monitors.set(node.peerId.toString(), monitor);
	}
	return { mesh, monitors };
};

const commitThrough = async (coordinator: MeshNode, actionId: string, blockIds: string[]) => {
	const pend = await coordinator.coordinatorRepo.pend({ actionId, transforms: insertsOf(blockIds), policy: 'c' });
	expect(pend.success, `pend of ${actionId}`).to.equal(true);
	const commit = await coordinator.coordinatorRepo.commit({ actionId, tailId: blockIds[0] as BlockId, rev: 1, blockIds: blockIds as BlockId[] });
	expect(commit.success, `commit of ${actionId}`).to.equal(true);
	return commit;
};

/** The transfers a check's reaction would start: a pull per gained block, a push per grown (block, peer). */
const transfersOf = (event: RebalanceEvent | null): { pulls: string[]; pushes: string[] } => ({
	pulls: event?.gained ?? [],
	pushes: [...(event?.grown ?? new Map<string, string[]>())].flatMap(([blockId, peers]) => peers.map(peer => `${blockId}->${peer}`))
});

const checkNode = async (rig: Rig, node: MeshNode) => transfersOf(await rig.monitors.get(node.peerId.toString())!.checkNow());

const stopAll = async (rig: Rig): Promise<void> => {
	for (const monitor of rig.monitors.values()) await monitor.stop();
};

const TWO_MEMBERS: MeshOptions = { responsibilityK: 2, clusterSize: 2 };
const BLOCKS = ['block-insert-a', 'block-insert-b', 'block-insert-c'];

describe('rebalance after a commit (committed holders seed the growth memory)', () => {

	it('baseline without holder reports: each member would pull and push every block the other already holds', async () => {
		const rig = await buildRig(2, TWO_MEMBERS, false);
		const [coordinator, member] = rig.mesh.nodes as [MeshNode, MeshNode];
		const commit = await commitThrough(coordinator, 'a-baseline', BLOCKS);
		expect(commit.success && commit.durability.quorum, 'both members confirmed the commit').to.equal('full');

		for (const [node, other] of [[coordinator, member], [member, coordinator]] as const) {
			const { pulls, pushes } = await checkNode(rig, node);
			expect(pulls, 'every freshly committed block reads as gained').to.have.members(BLOCKS);
			expect(pushes, 'and is pushed back to the member that stored it').to.have.members(
				BLOCKS.map(blockId => `${blockId}->${other.peerId.toString()}`));
		}
		await stopAll(rig);
	});

	it('after a full-quorum commit, neither member pulls or pushes that commit\'s blocks — on this check or a later one', async () => {
		const rig = await buildRig(2, TWO_MEMBERS, true);
		const [coordinator, member] = rig.mesh.nodes as [MeshNode, MeshNode];
		const commit = await commitThrough(coordinator, 'a-seeded', BLOCKS);
		expect(commit.success && commit.durability.quorum).to.equal('full');

		// The coordinator's monitor heard from its member and its coordinator; the other member's
		// monitor heard from its member alone (it coordinated nothing).
		for (const node of [coordinator, member]) {
			expect(await checkNode(rig, node), `first check on ${node === coordinator ? 'coordinator' : 'member'}`)
				.to.deep.equal({ pulls: [], pushes: [] });
			expect(await checkNode(rig, node), 'a later check (the next connection event) stays quiet')
				.to.deep.equal({ pulls: [], pushes: [] });
		}
		await stopAll(rig);
	});

	it('a solo commit reports no holders, so the founder still pushes once peers appear', async () => {
		const reports: unknown[] = [];
		const mesh = await createMesh(1, {
			responsibilityK: 1,
			clusterSize: 1,
			onCommittedHolders: (_node, committed) => reports.push(committed)
		});
		const [founder] = mesh.nodes as [MeshNode];
		await commitThrough(founder, 'a-solo', BLOCKS);
		expect(reports, 'no cohort ran, so nothing is evidenced').to.deep.equal([]);
	});

	it('a cohort member that never confirmed the commit is still pushed the blocks', async () => {
		// Three members, one unreachable for the whole transaction: the commit lands on a majority, and
		// the unreachable member is the only peer either holder should push to.
		const rig = await buildRig(3, { responsibilityK: 3, clusterSize: 3, superMajorityThreshold: 0.51 }, true);
		const [coordinator, member, absent] = rig.mesh.nodes as [MeshNode, MeshNode, MeshNode];
		rig.mesh.failures.failingPeers = new Set([absent.peerId.toString()]);

		const commit = await commitThrough(coordinator, 'a-majority', BLOCKS);
		expect(commit.success && commit.durability.quorum).to.equal('majority');
		expect(commit.success && commit.durability.unconfirmed).to.deep.equal([absent.peerId.toString()]);

		const expected = { pulls: [], pushes: BLOCKS.map(blockId => `${blockId}->${absent.peerId.toString()}`) };
		for (const node of [coordinator, member]) {
			const transfers = await checkNode(rig, node);
			expect(transfers.pulls).to.deep.equal(expected.pulls);
			expect(transfers.pushes).to.have.members(expected.pushes);
		}
		await stopAll(rig);
	});
});
