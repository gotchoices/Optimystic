import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { SpreadOnChurnMonitor } from '../src/cluster/spread-on-churn.js';
import { RebalanceMonitor } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';
import type { FretService } from 'p2p-fret';
import { waitFor } from '@optimystic/db-core/test';

/**
 * **Unified owned-block tracked set** (`5.2-unify-monitor-tracked-block-set`). On a live node the
 * `SpreadOnChurnMonitor` (sender) and `RebalanceMonitor` (responsibility tracker) share ONE
 * `Set<string>` of "blocks this node physically holds" (injected via `deps.trackedBlocks`), so the
 * two can never drift. The node feeds that set once and evicts from it on the rebalance `lost`
 * signal. These unit tests prove the SHARING and the EVICTION at the monitor layer with a single
 * injected Set; the real-node feed + handler wiring is proven in `rebalance-monitor-node-wiring.spec.ts`.
 */

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

/** Minimal FRET mock supporting the methods both monitors touch. */
class MockFret {
	private cohort: string[] = [];
	private expand: string[] = [];
	private rank = 0;
	setCohort(peers: string[]): void { this.cohort = peers; }
	setExpand(peers: string[]): void { this.expand = peers; }
	setNeighborDistance(rank: number): void { this.rank = rank; }
	neighborDistance(): number { return this.rank; }
	assembleCohort(): string[] { return [...this.cohort]; }
	expandCohort(): string[] { return [...this.expand]; }
	// FretService stubs
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	setMode(): void {}
	async ready(): Promise<void> {}
	getNeighbors(): string[] { return []; }
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
	setActivityHandler(): void {}
	iterativeLookup(): any { return (async function*() {})(); }
}

describe('unified owned-block tracked set (spread + rebalance share one Set)', () => {
	let selfId: PeerId;
	let peer2: PeerId;
	let peer4: PeerId;
	let mockLibp2p: MockLibp2p;
	let mockFret: MockFret;
	let partitionDetector: PartitionDetector;
	let fretAdapter: ArachnodeFretAdapter;

	beforeEach(async () => {
		selfId = await makePeerId();
		peer2 = await makePeerId();
		peer4 = await makePeerId();
		mockLibp2p = new MockLibp2p();
		mockLibp2p.peerId = selfId;
		mockFret = new MockFret();
		partitionDetector = new PartitionDetector();
		fretAdapter = new ArachnodeFretAdapter(mockFret as unknown as FretService);
	});

	function makeSpread(trackedBlocks: Set<string>): SpreadOnChurnMonitor {
		return new SpreadOnChurnMonitor({
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			// repo returns block data for any requested id so an eligible block actually spreads.
			repo: {
				async get(q: { blockIds: string[] }) {
					const r: Record<string, any> = {};
					for (const id of q.blockIds) r[id] = { block: { data: id } };
					return r;
				},
			} as any,
			// A peerNetwork that refuses every dial still yields a non-null spread event (the target
			// is recorded as failed) — enough to prove spread ATTEMPTED the block, without the
			// length-prefixed stream machinery.
			peerNetwork: { async connect() { throw new Error('refused in test'); } } as any,
			clusterSize: 5,
			trackedBlocks,
		});
	}

	function makeRebalance(trackedBlocks: Set<string>): RebalanceMonitor {
		return new RebalanceMonitor(
			{ libp2p: mockLibp2p as any, fret: mockFret as unknown as FretService, partitionDetector, fretAdapter, trackedBlocks },
			{ debounceMs: 20, minRebalanceIntervalMs: 0 },
		);
	}

	it('a single injected Set backs both monitors (a track on one is visible on the other)', () => {
		const shared = new Set<string>();
		const spread = makeSpread(shared);
		const rebalance = makeRebalance(shared);

		// Track via the rebalance monitor — the spread monitor sees it through the shared Set.
		rebalance.trackBlock('block-1');
		expect(rebalance.getTrackedBlockCount()).to.equal(1);
		expect(spread.getTrackedBlockCount(), 'spread sees rebalance.trackBlock via the shared Set').to.equal(1);

		// And the reverse direction.
		spread.trackBlock('block-2');
		expect(spread.getTrackedBlockCount()).to.equal(2);
		expect(rebalance.getTrackedBlockCount(), 'rebalance sees spread.trackBlock via the shared Set').to.equal(2);
		expect(shared.has('block-1') && shared.has('block-2')).to.equal(true);
	});

	it('a rebalance lost event evicts the block so spread\'s next checkNow() skips it', async () => {
		const shared = new Set<string>();
		const spread = makeSpread(shared);
		const rebalance = makeRebalance(shared);

		// Mirror the node-base onRebalance handler: a lost block is untracked (clears the shared Set
		// entry + the snapshot); a gained block is (re)added to the shared Set. Also record which
		// blocks the monitor reported gained/lost so the test can poll on the monitor having actually
		// emitted each event rather than sleeping a fixed span.
		const gained: string[] = [];
		const lost: string[] = [];
		rebalance.onRebalance((event) => {
			for (const blockId of event.gained) { shared.add(blockId); gained.push(blockId); }
			for (const blockId of event.lost) { rebalance.untrackBlock(blockId); lost.push(blockId); }
		});

		// One owned block, fed once into the shared Set.
		rebalance.trackBlock('block-1');
		expect(spread.getTrackedBlockCount(), 'shared before eviction').to.equal(1);

		// Make spread eligible for block-1: rank 0 < d, and an expansion target outside the cohort.
		mockFret.setNeighborDistance(0);
		mockFret.setCohort([selfId.toString()]);
		mockFret.setExpand([selfId.toString(), peer4.toString()]);

		// BEFORE eviction: spread attempts block-1 (proves the block is live in the shared Set).
		const before = await spread.checkNow();
		expect(before, 'spread attempts the owned block before eviction').to.not.be.null;
		expect(before!.spread.map(s => s.blockId)).to.include('block-1');

		// Drive a real rebalance lost event through the monitor's debounced emit path.
		await rebalance.start();
		// Baseline: self IS in the cohort → gained block-1, snapshot = responsible. Wait for the gained
		// event before shifting topology: the debounced check must establish wasResponsible=true first,
		// otherwise the second emit would only reset the debounce timer and no `lost` would be derived.
		mockFret.setCohort([selfId.toString()]);
		mockLibp2p.emit('connection:open');
		await waitFor(() => gained.includes('block-1'), { description: 'the rebalance monitor emitted the gained event (wasResponsible now set)' });
		// Topology shifts so self is no longer responsible → lost block-1 → handler evicts it.
		mockFret.setCohort([peer2.toString()]);
		mockLibp2p.emit('connection:close');
		await waitFor(() => lost.includes('block-1'), { description: 'the rebalance monitor emitted the lost event and the handler evicted the block' });
		await rebalance.stop();

		// The lost event removed block-1 from the SHARED Set (both monitors drop it).
		expect(shared.has('block-1'), 'lost event evicted the block from the shared Set').to.equal(false);
		expect(spread.getTrackedBlockCount(), 'spread dropped it too (shared Set)').to.equal(0);
		expect(rebalance.getTrackedBlockCount(), 'rebalance dropped it too').to.equal(0);

		// AFTER eviction: spread no longer attempts block-1 (nothing tracked → null).
		const after = await spread.checkNow();
		expect(after, 'spread skips the evicted block').to.be.null;
	});

	it('without an injected Set each monitor owns a private set (standalone construction)', () => {
		// No trackedBlocks passed → fresh private Set per monitor, fully independent.
		const spread = new SpreadOnChurnMonitor({
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			repo: { async get() { return {}; } } as any,
			peerNetwork: { async connect() { throw new Error('refused'); } } as any,
			clusterSize: 5,
		});
		const rebalance = new RebalanceMonitor({
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			fretAdapter,
		});

		spread.trackBlock('block-1');
		expect(spread.getTrackedBlockCount()).to.equal(1);
		expect(rebalance.getTrackedBlockCount(), 'no sharing without an injected Set').to.equal(0);
	});
});
