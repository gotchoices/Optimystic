import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork, IRepo, BlockGets, GetBlockResults, IBlock, BlockId, BlockHeader } from '@optimystic/db-core';
import { RebalanceMonitor, type RebalanceEvent, type RebalanceMonitorDeps } from '../src/cluster/rebalance-monitor.js';
import { BlockTransferCoordinator } from '../src/cluster/block-transfer.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';
import type { RestorationCoordinator } from '../src/storage/restoration-coordinator.js';
import type { BlockArchive } from '../src/storage/struct.js';
import type { FretService } from 'p2p-fret';

/**
 * The `onRebalance → BlockTransferCoordinator.handleRebalanceEvent` CONNECTION wired on a live node
 * (`5.1-rebalance-monitor-wiring-and-reaction`). The coordinator's own pull-gained / push-lost
 * reaction is exercised exhaustively in `block-transfer.spec.ts`; here the new coverage is that a
 * topology-triggered `RebalanceEvent` emitted by the monitor actually reaches the coordinator through
 * the `onRebalance(e => void coordinator.handleRebalanceEvent(e))` hop the node-base installs — i.e.
 * gained blocks get pulled and lost blocks get pushed when the monitor fires, not just when
 * `handleRebalanceEvent` is called directly.
 */

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

const makeArchive = (blockId: string): BlockArchive => ({
	blockId,
	revisions: {
		1: {
			action: { actionId: 'a1', transform: { insert: makeBlock(blockId) } },
			block: makeBlock(blockId)
		}
	},
	range: [1, 2]
});

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

type EventHandler = (...args: any[]) => void;

class MockLibp2p {
	peerId!: PeerId;
	private listeners = new Map<string, EventHandler[]>();
	addEventListener(event: string, handler: EventHandler): void {
		const list = this.listeners.get(event) ?? [];
		list.push(handler);
		this.listeners.set(event, list);
	}
	removeEventListener(event: string, handler: EventHandler): void {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(event, list.filter(h => h !== handler));
	}
	emit(event: string): void {
		for (const handler of this.listeners.get(event) ?? []) handler();
	}
}

class MockFret {
	private cohort: string[] = [];
	setCohort(peers: string[]): void { this.cohort = peers; }
	assembleCohort(_coord: Uint8Array, _wants: number): string[] { return this.cohort; }
	// FretService stubs
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	setMode(): void {}
	async ready(): Promise<void> {}
	neighborDistance(): number { return 0; }
	getNeighbors(): string[] { return []; }
	expandCohort(): string[] { return []; }
	async routeAct(): Promise<any> { return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }; }
	report(): void {}
	setMetadata(): void {}
	getMetadata(): Record<string, any> | undefined { return undefined; }
	listPeers(): Array<{ id: string }> { return []; }
	reportNetworkSize(): void {}
	getNetworkSizeEstimate() { return { size_estimate: 1, confidence: 0.5, sources: 0 }; }
	getNetworkChurn(): number { return 0; }
	detectPartition(): boolean { return false; }
	exportTable(): any { return { entries: [] }; }
	importTable(): number { return 0; }
}

class MockRepo implements IRepo {
	blocks = new Map<string, IBlock>();
	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		const result: GetBlockResults = {};
		for (const blockId of blockGets.blockIds) {
			const block = this.blocks.get(blockId);
			if (block) result[blockId] = { block, state: { latest: { rev: 1, actionId: 'a1' } } } as any;
		}
		return result;
	}
	async pend(): Promise<any> { return { success: true, blockIds: [], pending: [] }; }
	async commit(): Promise<any> { return { success: true }; }
	async cancel(): Promise<void> {}
	async saveReplicatedBlock(blockId: string, block: IBlock): Promise<void> { this.blocks.set(blockId, block); }
}

class MockRestorationCoordinator {
	restoreCalls: string[] = [];
	results = new Map<string, BlockArchive | undefined>();
	async restore(blockId: string): Promise<BlockArchive | undefined> {
		this.restoreCalls.push(blockId);
		return this.results.get(blockId);
	}
}

class MockPeerNetwork {
	connectCalls: Array<{ peerId: string; protocol: string }> = [];
	async connect(peerId: PeerId, protocol: string): Promise<any> {
		this.connectCalls.push({ peerId: peerId.toString(), protocol });
		// Reaction only needs to be proven to REACH the dial stage; the push itself failing here is
		// fine (block-transfer.spec covers a successful push end-to-end against a stream mock).
		throw new Error('mock: no stream');
	}
}

describe('RebalanceMonitor → BlockTransferCoordinator reaction wiring', () => {
	let selfId: PeerId;
	let peerId2: PeerId;
	let mockLibp2p: MockLibp2p;
	let mockFret: MockFret;
	let partitionDetector: PartitionDetector;
	let fretAdapter: ArachnodeFretAdapter;
	let deps: RebalanceMonitorDeps;
	let repo: MockRepo;
	let peerNetwork: MockPeerNetwork;
	let restoration: MockRestorationCoordinator;

	beforeEach(async () => {
		selfId = await makePeerId();
		peerId2 = await makePeerId();

		mockLibp2p = new MockLibp2p();
		mockLibp2p.peerId = selfId;
		mockFret = new MockFret();
		partitionDetector = new PartitionDetector();
		fretAdapter = new ArachnodeFretAdapter(mockFret as unknown as FretService);
		deps = {
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			fretAdapter
		};

		repo = new MockRepo();
		peerNetwork = new MockPeerNetwork();
		restoration = new MockRestorationCoordinator();
	});

	function wire(config = { debounceMs: 10, minRebalanceIntervalMs: 0 }): {
		monitor: RebalanceMonitor;
		coordinator: BlockTransferCoordinator;
		events: RebalanceEvent[];
	} {
		const monitor = new RebalanceMonitor(deps, config);
		const coordinator = new BlockTransferCoordinator(
			repo,
			peerNetwork as unknown as IPeerNetwork,
			restoration as unknown as RestorationCoordinator,
			partitionDetector,
			''
		);
		const events: RebalanceEvent[] = [];
		// Exactly the connection the node-base installs (async reaction hopped off the emit loop, with
		// its rejection swallowed so a restore/push failure cannot surface as an unhandled rejection).
		monitor.onRebalance((event) => { events.push(event); coordinator.handleRebalanceEvent(event).catch(() => {}); });
		return { monitor, coordinator, events };
	}

	it('a topology-triggered gained event drives the coordinator to PULL via restoration', async () => {
		mockFret.setCohort([selfId.toString()]); // self responsible → block-1 gained
		restoration.results.set('block-1', makeArchive('block-1'));

		const { monitor, events } = wire();
		monitor.trackBlock('block-1');

		await monitor.start();
		mockLibp2p.emit('connection:open');
		await new Promise(r => setTimeout(r, 80)); // debounce + async reaction
		await monitor.stop();

		expect(events, 'rebalance event reached the onRebalance handler').to.have.length(1);
		expect(events[0]!.gained).to.deep.equal(['block-1']);
		expect(restoration.restoreCalls, 'handleRebalanceEvent pulled the gained block').to.include('block-1');
	});

	it('a topology-triggered lost event drives the coordinator to PUSH to new owners', async () => {
		// Baseline: self is responsible for block-1 (sets the responsibility snapshot without emitting).
		mockFret.setCohort([selfId.toString()]);
		repo.blocks.set('block-1', makeBlock('block-1'));

		const { monitor, events } = wire();
		monitor.trackBlock('block-1');
		await monitor.checkNow(); // establishes wasResponsible=true (does not invoke handlers)

		await monitor.start();
		// Now self drops out; the cohort members become the new owners.
		mockFret.setCohort([peerId2.toString()]);
		mockLibp2p.emit('connection:close');
		await new Promise(r => setTimeout(r, 80));
		await monitor.stop();

		expect(events, 'rebalance event reached the onRebalance handler').to.have.length(1);
		expect(events[0]!.lost, 'block-1 reported lost').to.deep.equal(['block-1']);
		expect(events[0]!.newOwners.get('block-1'), 'new owners carried in the event').to.include(peerId2.toString());
		expect(peerNetwork.connectCalls.length, 'handleRebalanceEvent pushed (dialed a new owner)').to.be.greaterThan(0);
	});
});
