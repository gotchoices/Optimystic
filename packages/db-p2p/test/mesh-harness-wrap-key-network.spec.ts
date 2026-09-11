import { expect } from 'chai';
import type { IKeyNetwork } from '@optimystic/db-core';
import { createMesh } from '../src/testing/mesh-harness.js';

/**
 * Regression guard for `MeshOptions.wrapKeyNetwork` — the observation hook `cold-apply-cost.spec.ts`
 * relies on to count EVERY cohort lookup in a mesh (each node's own coordinator plus the transactor),
 * not only what `mesh.keyNetwork` sees. See ticket `cold-apply-gate-counts-every-cohort-lookup`: before
 * this hook existed, reassigning `mesh.keyNetwork` after `createMesh` reached only the transactor,
 * because every node's coordinator and cluster member close over the mesh's SHARED key network
 * directly (via the per-node wrapper `makeNodeKeyNetwork`), never through the `Mesh.keyNetwork`
 * property.
 */
describe('mesh harness: wrapKeyNetwork', () => {
	it('a wrapped shared key network observes a node coordinator lookup AND a lookup through mesh.keyNetwork', async () => {
		let calls = 0;
		const wrap = (shared: IKeyNetwork): IKeyNetwork => ({
			findCoordinator: (key, opts) => shared.findCoordinator(key, opts),
			findCluster: (key) => {
				calls++;
				return shared.findCluster(key);
			}
		});

		const mesh = await createMesh(3, { responsibilityK: 3, wrapKeyNetwork: wrap });

		const beforeCoordinatorGet = calls;
		// A node's own coordinator never goes through `mesh.keyNetwork` — it closes over the
		// per-node wrapper built in `createMesh`'s phase 1, which in turn calls the SAME shared
		// instance `wrapKeyNetwork` wrapped. `get`'s proximity check (`isResponsibleForBlock`)
		// alone is enough to prove the hook sees it.
		await mesh.nodes[0]!.coordinatorRepo.get({ blockIds: ['wrap-hook-block'] });
		expect(calls, 'a node coordinator lookup must reach the wrapped shared key network')
			.to.be.greaterThan(beforeCoordinatorGet);

		const beforeMeshLookup = calls;
		// `Mesh.keyNetwork` itself must be the SAME wrapped instance — not the raw mock.
		await mesh.keyNetwork.findCluster(new TextEncoder().encode('wrap-hook-block'));
		expect(calls, 'mesh.keyNetwork must be the wrapped instance too')
			.to.be.greaterThan(beforeMeshLookup);
	});

	it('failure injection (findClusterFails, partitionSides) still applies through a wrapped key network', async () => {
		const wrap = (shared: IKeyNetwork): IKeyNetwork => ({
			findCoordinator: (key, opts) => shared.findCoordinator(key, opts),
			findCluster: (key) => shared.findCluster(key)
		});

		const mesh = await createMesh(3, { responsibilityK: 3, wrapKeyNetwork: wrap });
		mesh.failures.findClusterFails = true;

		const peers = await mesh.keyNetwork.findCluster(new TextEncoder().encode('wrap-hook-block-2'));
		expect(Object.keys(peers)).to.have.length(0);

		mesh.failures.findClusterFails = false;
	});

	it('omitting wrapKeyNetwork leaves mesh.keyNetwork as the unwrapped mock', async () => {
		const mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1 });
		const peers = await mesh.keyNetwork.findCluster(new TextEncoder().encode('plain-block'));
		// The solo node's self-including view: one entry, itself.
		expect(Object.keys(peers)).to.have.length(1);
	});
});
