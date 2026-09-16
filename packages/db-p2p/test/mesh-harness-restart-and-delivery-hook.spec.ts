import { expect } from 'chai';
import type { BlockHeader, BlockId, IBlock, Transforms } from '@optimystic/db-core';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

/**
 * Regression guard for the two mesh-harness seams a spec about a member that leaves mid-session and returns
 * relies on (`member-leaves-and-returns.spec.ts`):
 *
 *  - `MeshFailureConfig.onClusterDelivery` — observes every REMOTE cluster delivery before reachability is
 *    judged for it, so a spec can make a member drop out at an exact protocol step;
 *  - `Mesh.restart` — rebuilds one node over its own identity and raw storage, and makes the instance it
 *    replaced inert, so a commit retry the old process owed cannot deliver later and pass for healing.
 */

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: { header: { id: blockId as BlockId, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
});

async function commitNewBlock(coordinator: MeshNode, blockId: string, actionId: string): Promise<void> {
	const pended = await coordinator.coordinatorRepo.pend({ actionId, transforms: makeTransforms(blockId), policy: 'c' });
	expect(pended.success, `pend of ${blockId}`).to.equal(true);
	const committed = await coordinator.coordinatorRepo.commit({ actionId, tailId: blockId as BlockId, rev: 1, blockIds: [blockId as BlockId] });
	expect(committed.success, `commit of ${blockId}`).to.equal(true);
}

const latestRev = async (node: MeshNode, blockId: string): Promise<number | undefined> =>
	(await node.storageRepo.get({ blockIds: [blockId as BlockId] }))[blockId]?.state?.latest?.rev;

const threeNodeMesh = (): Promise<Mesh> => createMesh(3, { responsibilityK: 3, clusterSize: 3 });

describe('mesh harness: onClusterDelivery', () => {
	it('sees every remote delivery and never the coordinator\'s own member', async () => {
		const mesh = await threeNodeMesh();
		const [coordinator] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		const targets: string[] = [];
		mesh.failures.onClusterDelivery = (target) => { targets.push(target); };

		await commitNewBlock(coordinator, 'delivery-hook-block', 'delivery-hook-action');

		const others = mesh.nodes.slice(1).map(node => node.peerId.toString()).sort();
		expect([...new Set(targets)].sort(), 'the remote members, and only them').to.deep.equal(others);
	});

	it('runs before reachability is judged: a member made unreachable inside the hook misses that very delivery', async () => {
		const mesh = await threeNodeMesh();
		const [coordinator, , leaver] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		const leaverId = leaver.peerId.toString();
		mesh.failures.onClusterDelivery = (target) => {
			if (target === leaverId) mesh.failures.failingPeers = new Set([leaverId]);
		};

		// The leaver's very first delivery is its promise request, so its promise never arrives and a
		// three-member cohort cannot reach its all-three promise bar.
		let refusal: unknown;
		try {
			await coordinator.coordinatorRepo.pend({ actionId: 'hook-first-delivery', transforms: makeTransforms('hook-first-delivery-block'), policy: 'c' });
		} catch (err) {
			refusal = err;
		}
		expect(String((refusal as Error)?.message ?? refusal)).to.match(/Failed to get super-majority: 2\/3 approvals/);
	});
});

describe('mesh harness: restart', () => {
	it('keeps identity and storage, and the restarted node receives cluster traffic with its new instance', async () => {
		const mesh = await threeNodeMesh();
		const [coordinator, restarted] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		await commitNewBlock(coordinator, 'restart-before', 'restart-before-action');
		const peerId = restarted.peerId;
		const old = { member: restarted.clusterMember, coordinator: restarted.coordinatorRepo, storage: restarted.storageRepo };

		mesh.restart(restarted);

		expect(mesh.nodes[1], 'restarted in place').to.equal(restarted);
		expect(restarted.peerId.equals(peerId), 'same identity').to.equal(true);
		expect(restarted.clusterMember).to.not.equal(old.member);
		expect(restarted.coordinatorRepo).to.not.equal(old.coordinator);
		expect(restarted.storageRepo).to.not.equal(old.storage);
		expect(await latestRev(restarted, 'restart-before'), 'what was committed before the restart survives it').to.equal(1);

		await commitNewBlock(coordinator, 'restart-after', 'restart-after-action');
		expect(await latestRev(restarted, 'restart-after'), 'a commit after the restart lands in the new instance\'s storage').to.equal(1);
	});

	it('makes the replaced instance inert: it sends no cluster traffic, so nothing it owed can still deliver', async () => {
		const mesh = await threeNodeMesh();
		const [, restarted] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
		const oldCoordinator = restarted.coordinatorRepo;
		mesh.restart(restarted);

		const deliveries: string[] = [];
		mesh.failures.onClusterDelivery = (target) => { deliveries.push(target); };
		let refusal: unknown;
		try {
			await oldCoordinator.pend({ actionId: 'from-a-stopped-instance', transforms: makeTransforms('stopped-instance-block'), policy: 'c' });
		} catch (err) {
			refusal = err;
		}

		expect(refusal, 'a stopped instance cannot assemble a cohort').to.be.instanceOf(Error);
		expect(deliveries, 'no delivery left the stopped instance').to.deep.equal([]);
		for (const node of mesh.nodes) {
			const pendings = (await node.storageRepo.get({ blockIds: ['stopped-instance-block' as BlockId] }))['stopped-instance-block']?.state?.pendings ?? [];
			expect(pendings, 'no member stored anything for it').to.not.include('from-a-stopped-instance');
		}
	});
});
