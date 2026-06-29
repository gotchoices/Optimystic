import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { buildBlockTransferProtocol } from '../src/cluster/block-transfer-service.js';
import type { RebalanceMonitor } from '../src/cluster/rebalance-monitor.js';
import type { BlockTransferCoordinator } from '../src/cluster/block-transfer.js';

/**
 * **Rebalance node-wiring** (`5.1-rebalance-monitor-wiring-and-reaction`). On a real production node
 * the rebalance path must be activated: inside the arachnode/FRET gate, `createLibp2pNodeBase` inits +
 * starts a `RebalanceMonitor`, constructs a `BlockTransferCoordinator` against the LOCAL storageRepo,
 * connects the monitor's `RebalanceEvent` to `coordinator.handleRebalanceEvent`, feeds the monitor the
 * blocks this node physically holds (every commit / received replica via
 * `StorageRepo.onAnyCollectionChange`), and tears it down on `node.stop()` before transports close.
 *
 * The monitor's detection logic (gained/lost/debounce/throttle/partition-suppress) is unit-tested in
 * `rebalance-monitor.spec.ts`; the coordinator's pull/push reaction in `block-transfer.spec.ts`; and
 * the `onRebalance → handleRebalanceEvent` hop in `rebalance-reaction.spec.ts`. This spec proves the
 * *assembly + owned-block feed + teardown + config gate* on a real solo node. The wiring lives behind
 * the arachnode gate (fretAdapter + RestorationCoordinator only exist there), so it boots with
 * arachnode ENABLED here (unlike the spread node-wiring spec).
 */
describe('rebalance-monitor / node wiring (real libp2p, solo arachnode node)', function () {
	// Real libp2p boot + FRET seeding + arachnode init dominate; ops finish in seconds.
	this.timeout(40_000);

	const makeHeader = (id: string, collectionId: string): BlockHeader => ({
		id: id as BlockId,
		type: 'test',
		collectionId: collectionId as BlockId,
	});
	const makeBlock = (id: string, collectionId: string): IBlock => ({ header: makeHeader(id, collectionId) });
	const makeTransforms = (blockId: string, collectionId: string): Transforms => ({
		inserts: { [blockId]: makeBlock(blockId, collectionId) },
		updates: {},
		deletes: [],
	});

	async function pendCommit(repo: IRepo, blockId: string, collectionId: string, actionId: string, rev: number): Promise<void> {
		const pend = await repo.pend({ actionId, transforms: makeTransforms(blockId, collectionId), policy: 'c' } as any);
		expect(pend.success, `pend(${blockId})`).to.equal(true);
		const commit = await repo.commit({ actionId, tailId: blockId as BlockId, rev, blockIds: [blockId as BlockId] } as any);
		expect(commit.success, `commit(${blockId})`).to.equal(true);
	}

	async function spawn(networkName: string, overrides: Record<string, unknown> = {}): Promise<Libp2p> {
		return await createLibp2pNode({
			port: 0,
			networkName,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			...overrides,
		} as any);
	}

	it('inits + starts the monitor, constructs the coordinator, registers the block-transfer handler, and feeds owned blocks', async () => {
		const networkName = 'rebalance-wiring-on';
		const node: any = await spawn(networkName);
		try {
			// The block-transfer RECEIVE handler is registered under the same network-scoped prefix the
			// coordinator pushes to (protocol-prefix match — a mismatch silently fails every lost-block push).
			const blockTransferProtocol = buildBlockTransferProtocol(`/optimystic/${networkName}`);
			expect(node.getProtocols() as string[], 'block-transfer handler registered under /optimystic/<net>').to.include(blockTransferProtocol);

			const monitor = node.rebalanceMonitor as RebalanceMonitor;
			expect(monitor, 'rebalanceMonitor exposed on the node').to.exist;
			// start() is what registers the connection:open / connection:close listeners (proven in
			// rebalance-monitor.spec.ts); a started monitor confirms the node-base drove start().
			expect((monitor as any).running, 'monitor was started').to.equal(true);

			const coordinator = node.blockTransferCoordinator as BlockTransferCoordinator;
			expect(coordinator, 'blockTransferCoordinator exposed on the node').to.exist;

			expect(monitor.getTrackedBlockCount(), 'no blocks tracked before any commit').to.equal(0);

			// A commit through the coordinated repo lands in the local storageRepo, which emits
			// onAnyCollectionChange → the single shared owned-block feed. (clusterSize 1 → self-only.)
			const repo = node.coordinatedRepo as IRepo;
			await pendCommit(repo, 'rebalance-owned-block', 'rebalance-coll', 'rebalance-a1', 1);
			expect(monitor.getTrackedBlockCount(), 'the owned-block feed tracked the committed block').to.be.greaterThan(0);

			// Unified tracked set (5.2-unify-monitor-tracked-block-set): on an arachnode node BOTH the
			// rebalance and spread monitors are wired against ONE shared owned-block Set fed by a single
			// onAnyCollectionChange subscription, so after the commit they report the SAME non-zero count
			// (a drift here means the two monitors are back on separate sets).
			const spreadMonitor = node.spreadOnChurnMonitor;
			expect(spreadMonitor, 'spread monitor also wired on the arachnode node').to.exist;
			expect(spreadMonitor.getTrackedBlockCount(), 'both monitors agree on the shared tracked-block count')
				.to.equal(monitor.getTrackedBlockCount());
		} finally {
			await node.stop();
		}
	});

	it('node.stop() stops the monitor before the transports close', async () => {
		const node: any = await spawn('rebalance-wiring-stop');
		const monitor = node.rebalanceMonitor as RebalanceMonitor;
		expect(monitor, 'monitor exposed').to.exist;

		// Spy the disposal: the node.stop wrapper must invoke monitor.stop() (the unit test proves
		// stop() removes the connection listeners; here we prove the wrapper drives it).
		let stopCalls = 0;
		const realStop = monitor.stop.bind(monitor);
		(monitor as any).stop = async (): Promise<void> => { stopCalls++; await realStop(); };

		await node.stop();
		expect(stopCalls, 'node.stop() stopped the rebalance monitor').to.be.greaterThan(0);
		expect((monitor as any).running, 'monitor no longer running after stop').to.equal(false);
	});

	it('rebalance: { enabled: false } skips wiring entirely (no monitor, no coordinator)', async () => {
		const node: any = await spawn('rebalance-wiring-off', { rebalance: { enabled: false } });
		try {
			expect(node.rebalanceMonitor, 'no monitor wired when disabled').to.equal(undefined);
			expect(node.blockTransferCoordinator, 'no coordinator wired when disabled').to.equal(undefined);

			// A commit still succeeds, and the block-transfer RECEIVE handler is still registered
			// regardless of the rebalance opt-out (it is independent of the reaction sender).
			const repo = node.coordinatedRepo as IRepo;
			await pendCommit(repo, 'rebalance-disabled-block', 'rebalance-coll', 'rebalance-d1', 1);
			const blockTransferProtocol = buildBlockTransferProtocol('/optimystic/rebalance-wiring-off');
			expect(node.getProtocols() as string[], 'receive handler still registered when reaction disabled').to.include(blockTransferProtocol);
		} finally {
			await node.stop();
		}
	});

	it('arachnode disabled leaves the rebalance path inert (no monitor, no coordinator)', async () => {
		const node: any = await spawn('rebalance-wiring-noarachnode', { arachnode: { enableRingZulu: false } });
		try {
			// fretAdapter + RestorationCoordinator only exist inside the arachnode gate; without it the
			// rebalance reaction stays inert (acceptable — rebalance is a resilience optimization).
			expect(node.rebalanceMonitor, 'no monitor without arachnode/FRET adapter').to.equal(undefined);
			expect(node.blockTransferCoordinator, 'no coordinator without arachnode').to.equal(undefined);
		} finally {
			await node.stop();
		}
	});
});
