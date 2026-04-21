import { expect } from 'chai';
import { Tree, type ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from './mesh-harness.js';

// Phase 3 of ticket-7: multi-node cold-start coverage for the real production
// stack (StorageRepo + CoordinatorRepo + NetworkTransactor) driving Tree/Collection.
// The solo-mesh coverage in `fresh-node-ddl.spec.ts` misses multi-node paths
// because of the `peerCount<=1` fast path in `verifyResponsibility`; these
// scenarios drive DDL+DML across 3- and 5-node meshes to catch cold-start bugs
// that only surface once real cluster consensus is in the loop.

interface TestEntry {
	key: number;
	value: string;
}

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

describe('Fresh-node DDL (multi-node, real production stack)', function () {
	describe('Scenario A — 3-node cold-start, DDL on A / SELECT on B and C', function () {
		// Multi-node consensus is slower than solo; 10s keeps any hang from
		// stalling CI forever while still being comfortably above normal runtime.
		this.timeout(10_000);

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

		it('DDL on A round-trips to SELECT on B and C', async () => {
			const treeId = 'multi-3-ddl-select';
			const keyFn = (entry: TestEntry) => entry.key;
			const value: TestEntry = { key: 1, value: 'from-A' };

			const nodeA = mesh.nodes[0]!;
			const nodeB = mesh.nodes[1]!;
			const nodeC = mesh.nodes[2]!;

			// 1. First DDL/DML ever on the mesh — driven by node A.
			const treeA = await Tree.createOrOpen<number, TestEntry>(
				transactorFor(transactors, nodeA.peerId.toString()),
				treeId,
				keyFn
			);
			await treeA.replace([[value.key, value]]);

			// 2. Fresh SELECT from node B — must see A's write.
			const treeB = await Tree.createOrOpen<number, TestEntry>(
				transactorFor(transactors, nodeB.peerId.toString()),
				treeId,
				keyFn
			);
			expect(await treeB.get(value.key)).to.deep.equal(value);

			// 3. Same SELECT from node C — confirms all three replicas converged.
			const treeC = await Tree.createOrOpen<number, TestEntry>(
				transactorFor(transactors, nodeC.peerId.toString()),
				treeId,
				keyFn
			);
			expect(await treeC.get(value.key)).to.deep.equal(value);
		});
	});

	// Skipped pending `tickets/fix/5-multi-node-cold-start-commit-with-failing-peer.md`.
	// Remove `.skip` once that fix lands — the repro below is the deterministic case the
	// fix must make green.
	describe.skip('Scenario B — 5-node cold-start with one peer down at boot', function () {
		// 15s: 5-node consensus + super-majority math across 4 reachable peers
		// costs more round-trips than the 3-node case.
		this.timeout(15_000);

		let mesh: Mesh;
		let transactors: Map<string, ITransactor>;

		beforeEach(async () => {
			mesh = await createMesh(5, {
				responsibilityK: 5,
				clusterSize: 5,
				superMajorityThreshold: 0.6
			});
			// Mark peer 4 unreachable before the first transaction ever runs —
			// super-majority of 5 at 0.6 = 3 required, 4 reachable peers still satisfy it.
			mesh.failures.failingPeers = new Set([mesh.nodes[4]!.peerId.toString()]);
			transactors = buildNetworkTransactors(mesh);
		});

		it('DDL on A completes with peer E unreachable; SELECT on B sees the write', async () => {
			const treeId = 'multi-5-cold-start';
			const keyFn = (entry: TestEntry) => entry.key;
			const value: TestEntry = { key: 42, value: 'despite-E-down' };

			const nodeA = mesh.nodes[0]!;
			const nodeB = mesh.nodes[1]!;

			const treeA = await Tree.createOrOpen<number, TestEntry>(
				transactorFor(transactors, nodeA.peerId.toString()),
				treeId,
				keyFn
			);
			await treeA.replace([[value.key, value]]);

			const treeB = await Tree.createOrOpen<number, TestEntry>(
				transactorFor(transactors, nodeB.peerId.toString()),
				treeId,
				keyFn
			);
			expect(await treeB.get(value.key)).to.deep.equal(value);
		});
	});
});
