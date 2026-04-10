import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import {
	SpreadOnChurnMonitor,
	type SpreadOnChurnConfig,
	type SpreadOnChurnDeps,
	type SpreadEvent
} from '../src/cluster/spread-on-churn.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import type { FretService } from 'p2p-fret';

// --- Helpers ---

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
		for (const handler of this.listeners.get(event) ?? []) {
			handler();
		}
	}

	getListenerCount(event: string): number {
		return (this.listeners.get(event) ?? []).length;
	}
}

class MockFret {
	private cohortResults = new Map<string, string[]>();
	private expandResults = new Map<string, string[]>();
	private neighborDistanceResult: number | Map<string, number> = 0;

	assembleCohortCalls: Array<{ coord: Uint8Array; wants: number }> = [];
	expandCohortCalls: Array<{ current: string[]; coord: Uint8Array; step: number }> = [];
	neighborDistanceCalls: Array<{ selfId: string; coord: Uint8Array; k: number }> = [];

	/** Set what assembleCohort returns. Key is '*' for default, or stringified coord. */
	setCohort(key: string, peers: string[]): void {
		this.cohortResults.set(key, peers);
	}

	/** Set what expandCohort returns. Key is '*' for default, or stringified coord. */
	setExpandResult(key: string, peers: string[]): void {
		this.expandResults.set(key, peers);
	}

	/** Set neighborDistance result. Pass a Map<blockId, rank> for per-block control. */
	setNeighborDistance(result: number | Map<string, number>): void {
		this.neighborDistanceResult = result;
	}

	neighborDistance(selfId: string, coord: Uint8Array, k: number): number {
		this.neighborDistanceCalls.push({ selfId, coord, k });
		if (this.neighborDistanceResult instanceof Map) {
			const key = Array.from(coord).join(',');
			return this.neighborDistanceResult.get(key) ?? Number.POSITIVE_INFINITY;
		}
		return this.neighborDistanceResult;
	}

	assembleCohort(coord: Uint8Array, wants: number, _exclude?: Set<string>): string[] {
		this.assembleCohortCalls.push({ coord, wants });
		const specific = this.cohortResults.get(Array.from(coord).join(','));
		if (specific) return specific;
		return this.cohortResults.get('*') ?? [];
	}

	expandCohort(current: string[], coord: Uint8Array, step: number, _exclude?: Set<string>): string[] {
		this.expandCohortCalls.push({ current, coord, step });
		const specific = this.expandResults.get(Array.from(coord).join(','));
		if (specific) return specific;
		const defaultResult = this.expandResults.get('*');
		if (defaultResult) return defaultResult;
		// Default: return current (no expansion)
		return [...current];
	}

	// Stubs for remaining FretService interface
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	setMode(): void {}
	async ready(): Promise<void> {}
	getNeighbors(): string[] { return []; }
	async routeAct(): Promise<any> { return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }; }
	report(): void {}
	setMetadata(): void {}
	getMetadata(): Record<string, any> | undefined { return undefined; }
	listPeers(): Array<{ id: string; metadata?: Record<string, any> }> { return []; }
	reportNetworkSize(): void {}
	getNetworkSizeEstimate() { return { size_estimate: 1, confidence: 0.5, sources: 0 }; }
	getNetworkChurn(): number { return 0; }
	detectPartition(): boolean { return false; }
	exportTable(): any { return { entries: [] }; }
	importTable(): number { return 0; }
	setActivityHandler(): void {}
	iterativeLookup(): any { return (async function*() {})(); }
}

/** Builds a mock repo that returns specified block data. */
function makeMockRepo(blocks: Record<string, any> = {}) {
	return {
		async get(query: { blockIds: string[] }) {
			const result: Record<string, any> = {};
			for (const id of query.blockIds) {
				if (blocks[id] !== undefined) {
					result[id] = { block: blocks[id] };
				} else {
					result[id] = null;
				}
			}
			return result;
		},
		async pend() { return {} as any; },
		async cancel() {},
		async commit() { return {} as any; },
	};
}

/** Tracks pushBlocks calls for verification. */
interface PushCall {
	peerId: string;
	blockIds: string[];
	reason: string;
}

/**
 * Builds a mock peerNetwork that records push calls.
 * The connect() method returns a mock stream that the ProtocolClient can use.
 */
function makeMockPeerNetwork(pushCalls: PushCall[], failTargets: Set<string> = new Set()) {
	return {
		async connect(peerId: PeerId, _protocol: string) {
			const targetId = peerId.toString();
			if (failTargets.has(targetId)) {
				throw new Error(`Connection refused: ${targetId}`);
			}
			// Record the push and return a mock stream
			// The ProtocolClient will pipe data through this stream.
			// We need to simulate the stream protocol (length-prefixed JSON).
			pushCalls.push({ peerId: targetId, blockIds: [], reason: 'replication' });

			// Return a mock stream that:
			// 1. Accepts a request (sink)
			// 2. Returns a response (source)
			return createMockStream(targetId, failTargets);
		}
	};
}

function createMockStream(_targetId: string, _failTargets: Set<string>) {
	// Build a varint-LP-encoded response matching BlockTransferResponse
	const response: { blocks: Record<string, string>; missing: string[] } = { blocks: {}, missing: [] };
	const payload = new TextEncoder().encode(JSON.stringify(response));
	// Varint encode the length (works for payloads < 128 bytes)
	const frame = new Uint8Array(1 + payload.length);
	frame[0] = payload.length;
	frame.set(payload, 1);

	return {
		send: (_data: any) => {},
		close: async () => {},
		closeRead: () => {},
		closeWrite: () => {},
		abort: () => {},
		reset: () => {},
		id: 'mock-stream',
		direction: 'outbound' as const,
		timeline: { open: Date.now() },
		metadata: {},
		status: 'open',
		readStatus: 'ready',
		writeStatus: 'ready',
		log: { enabled: false, trace: () => {}, error: () => {} },
		async *[Symbol.asyncIterator]() {
			yield frame;
		},
	};
}

// --- Tests ---

describe('SpreadOnChurnMonitor', () => {
	let selfId: PeerId;
	let peerId2: PeerId;
	let peerId3: PeerId;
	let peerId4: PeerId;
	let peerId5: PeerId;
	let mockLibp2p: MockLibp2p;
	let mockFret: MockFret;
	let partitionDetector: PartitionDetector;
	let mockRepo: ReturnType<typeof makeMockRepo>;
	let pushCalls: PushCall[];

	beforeEach(async () => {
		selfId = await makePeerId();
		peerId2 = await makePeerId();
		peerId3 = await makePeerId();
		peerId4 = await makePeerId();
		peerId5 = await makePeerId();

		mockLibp2p = new MockLibp2p();
		mockLibp2p.peerId = selfId;

		mockFret = new MockFret();
		partitionDetector = new PartitionDetector();
		mockRepo = makeMockRepo({ 'block-1': { data: 'hello' }, 'block-2': { data: 'world' } });
		pushCalls = [];
	});

	function makeDeps(overrides: Partial<SpreadOnChurnDeps> = {}): SpreadOnChurnDeps {
		return {
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			repo: mockRepo as any,
			peerNetwork: makeMockPeerNetwork(pushCalls) as any,
			clusterSize: 5,
			...overrides,
		};
	}

	function makeMonitor(
		deps?: Partial<SpreadOnChurnDeps>,
		config?: Partial<SpreadOnChurnConfig>
	): SpreadOnChurnMonitor {
		return new SpreadOnChurnMonitor(makeDeps(deps), config);
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	describe('lifecycle', () => {
		it('registers and removes connection:close listener on start/stop', async () => {
			const monitor = makeMonitor();

			await monitor.start();
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(1);

			await monitor.stop();
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(0);
		});

		it('is idempotent on start/stop', async () => {
			const monitor = makeMonitor();

			await monitor.start();
			await monitor.start();
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(1);

			await monitor.stop();
			await monitor.stop();
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(0);
		});

		it('does not fire spread after stop', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0); // eligible
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			const events: SpreadEvent[] = [];
			const monitor = makeMonitor({}, { departureDebounceMs: 20 });
			monitor.onSpread(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();
			mockLibp2p.emit('connection:close');
			await monitor.stop();

			// Wait past debounce
			await new Promise(r => setTimeout(r, 60));
			expect(events).to.have.length(0);
		});
	});

	// ── Block tracking ───────────────────────────────────────────────

	describe('block tracking', () => {
		it('tracks and untracks blocks', () => {
			const monitor = makeMonitor();

			monitor.trackBlock('block-1');
			monitor.trackBlock('block-2');
			expect(monitor.getTrackedBlockCount()).to.equal(2);

			monitor.untrackBlock('block-1');
			expect(monitor.getTrackedBlockCount()).to.equal(1);
		});
	});

	// ── Eligibility ──────────────────────────────────────────────────

	describe('eligibility', () => {
		it('middle peer (rank < d) triggers spread', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0); // rank 0 < d(3)
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.spread.length).to.be.greaterThan(0);
			expect(event!.spread[0]!.blockId).to.equal('block-1');
		});

		it('edge peer (rank >= d) does not trigger spread', async () => {
			mockFret.setNeighborDistance(5); // rank 5 >= d(3)
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);
			mockFret.setExpandResult('*', [selfId.toString(), peerId2.toString(), peerId3.toString()]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('rank exactly equal to d does not trigger spread', async () => {
			mockFret.setNeighborDistance(3); // rank 3 == d(3), not < d
			mockFret.setCohort('*', [selfId.toString()]);
			mockFret.setExpandResult('*', [selfId.toString(), peerId2.toString()]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});
	});

	// ── Expansion targets ────────────────────────────────────────────

	describe('expansion targets', () => {
		it('only targets peers beyond the cohort boundary', async () => {
			const selfStr = selfId.toString();
			const peer2Str = peerId2.toString();
			const peer3Str = peerId3.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peer2Str, peer3Str]);
			// expandCohort returns cohort + expansion peers
			mockFret.setExpandResult('*', [selfStr, peer2Str, peer3Str, peer4Str]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			// Should only target peer4 (beyond cohort boundary), not peer2/peer3 (in cohort)
			expect(event!.spread[0]!.targets).to.deep.equal([peer4Str]);
		});

		it('skips self even if in expansion result', async () => {
			const selfStr = selfId.toString();
			const peer2Str = peerId2.toString();
			const peer3Str = peerId3.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peer2Str]);
			// Expansion includes self (shouldn't be targeted)
			mockFret.setExpandResult('*', [selfStr, peer2Str, peer3Str]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.spread[0]!.targets).to.deep.equal([peer3Str]);
		});

		it('records failed pushes in the spread result', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();
			const peer5Str = peerId5.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString()]);
			// Two expansion targets: peer4 (will succeed) and peer5 (will fail)
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peer4Str, peer5Str]);

			const failTargets = new Set([peer5Str]);
			const monitor = makeMonitor({
				peerNetwork: makeMockPeerNetwork(pushCalls, failTargets) as any,
			});
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;

			const entry = event!.spread[0]!;
			expect(entry.targets).to.include(peer4Str);
			expect(entry.targets).to.include(peer5Str);
			expect(entry.succeeded).to.include(peer4Str);
			expect(entry.failed).to.include(peer5Str);
		});

		it('graceful no-op when expand returns nothing new', async () => {
			const selfStr = selfId.toString();
			const peer2Str = peerId2.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peer2Str]);
			// expandCohort returns same as cohort — no new targets
			mockFret.setExpandResult('*', [selfStr, peer2Str]);

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});
	});

	// ── Dynamic d ────────────────────────────────────────────────────

	describe('dynamic d', () => {
		it('increases d under rapid churn', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			// spreadDistance=2, so rank 2 is normally NOT eligible (rank >= d).
			// With 3+ departures, effectiveD increases to 3 (capped at clusterSize/2).
			mockFret.setNeighborDistance(2);
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			// Use a long debounce so the background handler doesn't fire during the test.
			const monitor = makeMonitor({ clusterSize: 8 }, {
				departureDebounceMs: 60000,
				dynamicSpreadDistance: true,
				spreadDistance: 2,
			});
			monitor.trackBlock('block-1');

			await monitor.start();

			// Trigger 3+ departures to populate the sliding window
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:close');

			// checkNow() bypasses debounce, directly invokes performSpread.
			// With 3 departures, effectiveD = d+1 = 3, rank 2 < 3 → eligible
			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.effectiveD).to.equal(3);

			await monitor.stop();
		});

		it('scales d up under low cluster health', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			// spreadDistance=2, rank=2 normally ineligible (rank >= d).
			// With low health (estimate/clusterSize < threshold), d scales up.
			mockFret.setNeighborDistance(2);
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			// Simulate low cluster health: getDiagnostics returns estimate much lower than clusterSize
			const fretWithDiag = Object.create(mockFret);
			fretWithDiag.getDiagnostics = () => ({ estimate: 2 });

			const monitor = makeMonitor(
				{ fret: fretWithDiag as unknown as FretService, clusterSize: 10 },
				{ spreadDistance: 2, dynamicSpreadDistance: true, healthThreshold: 0.6 }
			);
			monitor.trackBlock('block-1');

			// estimate/clusterSize = 2/10 = 0.2 < 0.6 threshold
			// scaled = ceil(2 * (10/2)) = 10, capped at floor(10/2) = 5
			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.effectiveD).to.equal(5);
		});

		it('uses base d when churn is stable', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			const monitor = makeMonitor({}, {
				dynamicSpreadDistance: true,
			});
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.effectiveD).to.equal(3); // default d
		});
	});

	// ── Partition suppression ────────────────────────────────────────

	describe('partition suppression', () => {
		it('suppresses spread during detected partition', async () => {
			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfId.toString()]);
			mockFret.setExpandResult('*', [selfId.toString(), peerId2.toString()]);

			// Simulate partition
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}

			const monitor = makeMonitor();
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});
	});

	// ── Debounce ─────────────────────────────────────────────────────

	describe('debounce', () => {
		it('multiple rapid departures coalesce into single spread check', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			const events: SpreadEvent[] = [];
			const monitor = makeMonitor({}, { departureDebounceMs: 30 });
			monitor.onSpread(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();

			// Fire multiple departures rapidly
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:close');

			// Wait for debounce
			await new Promise(r => setTimeout(r, 80));

			// Should coalesce into at most 1 event
			expect(events.length).to.be.at.most(1);

			await monitor.stop();
		});
	});

	// ── Config: disabled ─────────────────────────────────────────────

	describe('config: disabled', () => {
		it('enabled: false skips all spread logic', async () => {
			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfId.toString()]);
			mockFret.setExpandResult('*', [selfId.toString(), peerId2.toString()]);

			const monitor = makeMonitor({}, { enabled: false });
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('enabled: false prevents debounced spread after connection:close', async () => {
			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfId.toString()]);
			mockFret.setExpandResult('*', [selfId.toString(), peerId2.toString()]);

			const events: SpreadEvent[] = [];
			const monitor = makeMonitor({}, { enabled: false, departureDebounceMs: 20 });
			monitor.onSpread(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();
			mockLibp2p.emit('connection:close');
			await new Promise(r => setTimeout(r, 60));

			expect(events).to.have.length(0);
			await monitor.stop();
		});
	});

	// ── SpreadEvent emission ─────────────────────────────────────────

	describe('SpreadEvent emission', () => {
		it('handlers receive events with correct structure', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString(), peerId3.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peerId3.toString(), peer4Str]);

			const events: SpreadEvent[] = [];
			const monitor = makeMonitor();
			monitor.onSpread(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.checkNow();

			expect(events).to.have.length(1);
			const event = events[0]!;
			expect(event.spread).to.be.an('array');
			expect(event.spread[0]!.blockId).to.equal('block-1');
			expect(event.spread[0]!.targets).to.include(peer4Str);
			expect(event.effectiveD).to.be.a('number');
			expect(event.triggeredAt).to.be.a('number');
		});

		it('multiple handlers all receive the event', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peer4Str]);

			const calls1: SpreadEvent[] = [];
			const calls2: SpreadEvent[] = [];

			const monitor = makeMonitor();
			monitor.onSpread(e => calls1.push(e));
			monitor.onSpread(e => calls2.push(e));
			monitor.trackBlock('block-1');

			await monitor.checkNow();

			expect(calls1).to.have.length(1);
			expect(calls2).to.have.length(1);
		});

		it('one handler throwing does not prevent others', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peer4Str]);

			const calls: SpreadEvent[] = [];

			const monitor = makeMonitor();
			monitor.onSpread(() => { throw new Error('handler error'); });
			monitor.onSpread(e => calls.push(e));
			monitor.trackBlock('block-1');

			await monitor.checkNow();

			expect(calls).to.have.length(1);
		});
	});

	// ── Empty / no tracked blocks ────────────────────────────────────

	describe('empty cases', () => {
		it('returns null when no blocks are tracked', async () => {
			mockFret.setNeighborDistance(0);
			const monitor = makeMonitor();

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('returns null when block not in local repo', async () => {
			const selfStr = selfId.toString();
			const peer4Str = peerId4.toString();

			mockFret.setNeighborDistance(0);
			mockFret.setCohort('*', [selfStr, peerId2.toString()]);
			mockFret.setExpandResult('*', [selfStr, peerId2.toString(), peer4Str]);

			// Track a block that doesn't exist in repo
			const monitor = makeMonitor({ repo: makeMockRepo({}) as any });
			monitor.trackBlock('nonexistent-block');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});
	});
});
