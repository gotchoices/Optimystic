import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { buildBlockTransferProtocol } from '../src/cluster/block-transfer-service.js';
import type { SpreadOnChurnMonitor } from '../src/cluster/spread-on-churn.js';

/**
 * **Spread-on-churn node-wiring** (`optimystic-spread-on-churn-monitor-wiring`). On a real
 * production node the SENDING side of the churn-resilient spread protocol must be activated:
 * `createLibp2pNodeBase` inits + starts a `SpreadOnChurnMonitor`, feeds it the blocks this node
 * physically holds (every commit / received replica via `StorageRepo.onAnyCollectionChange`), and
 * tears it down on `node.stop()` before transports close. The protocol-level behavior (eligibility,
 * expansion targets, debounce, self-prune, protocol prefix) is unit-tested in
 * `spread-on-churn.spec.ts`; this spec proves the *assembly + owned-block feed + teardown* on a real
 * solo node. End-to-end churn re-replication over real sockets is the env-gated case in
 * `real-libp2p.integration.spec.ts`.
 */
describe('spread-on-churn / node wiring (real libp2p, solo forming node)', function () {
	// Real libp2p boot + FRET seeding dominate; ops finish in seconds.
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
			arachnode: { enableRingZulu: false },
			...overrides,
		} as any);
	}

	it('starts the monitor, registers the block-transfer handler under the network prefix, and feeds owned blocks', async () => {
		const networkName = 'spread-wiring-on';
		const node: any = await spawn(networkName);
		try {
			// The block-transfer RECEIVE handler is registered under the same network-scoped prefix
			// the monitor dials (protocol-prefix match — a mismatch silently fails every push to dial).
			const blockTransferProtocol = buildBlockTransferProtocol(`/optimystic/${networkName}`);
			const protocols: string[] = node.getProtocols();
			expect(protocols, 'block-transfer handler registered under /optimystic/<net>').to.include(blockTransferProtocol);

			const monitor = node.spreadOnChurnMonitor as SpreadOnChurnMonitor;
			expect(monitor, 'spreadOnChurnMonitor exposed on the node').to.exist;
			expect(monitor.getTrackedBlockCount(), 'no blocks tracked before any commit').to.equal(0);

			// A commit through the coordinated repo lands in the local storageRepo, which emits
			// onAnyCollectionChange → trackBlock. (clusterSize 1 → self-only consensus.)
			const repo = node.coordinatedRepo as IRepo;
			await pendCommit(repo, 'spread-owned-block', 'spread-coll', 'spread-a1', 1);
			expect(monitor.getTrackedBlockCount(), 'the owned-block feed tracked the committed block').to.be.greaterThan(0);
		} finally {
			await node.stop();
		}
	});

	it('node.stop() stops the monitor before the transports close', async () => {
		const node: any = await spawn('spread-wiring-stop');
		const monitor = node.spreadOnChurnMonitor as SpreadOnChurnMonitor;
		expect(monitor, 'monitor exposed').to.exist;

		// Spy the disposal: the node.stop wrapper must invoke monitor.stop() (the unit test proves
		// stop() removes the connection:close listener; here we prove the wrapper drives it).
		let stopCalls = 0;
		const realStop = monitor.stop.bind(monitor);
		(monitor as any).stop = async (): Promise<void> => { stopCalls++; await realStop(); };

		await node.stop();
		expect(stopCalls, 'node.stop() stopped the spread monitor').to.be.greaterThan(0);
	});

	it('spreadOnChurn: { enabled: false } skips wiring entirely (no monitor, no subscription leak)', async () => {
		const node: any = await spawn('spread-wiring-off', { spreadOnChurn: { enabled: false } });
		try {
			// The whole init/start/subscribe block is skipped, so no monitor is exposed and no
			// owned-block subscription (hence no connection:close listener) is registered.
			expect(node.spreadOnChurnMonitor, 'no monitor wired when disabled').to.equal(undefined);

			// A commit still succeeds (the receive handler + storageRepo are independent of the
			// sender monitor); the point is no listener leak and no tracking occurs.
			const repo = node.coordinatedRepo as IRepo;
			await pendCommit(repo, 'spread-disabled-block', 'spread-coll', 'spread-d1', 1);

			// The block-transfer RECEIVE handler is still registered regardless of the sender opt-out.
			const blockTransferProtocol = buildBlockTransferProtocol('/optimystic/spread-wiring-off');
			expect((node.getProtocols() as string[]), 'receive handler still registered when sender disabled').to.include(blockTransferProtocol);
		} finally {
			await node.stop();
		}
	});
});
