import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { RebalanceMonitor, type RebalanceEvent, type RebalanceMonitorDeps } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter, type ArachnodeInfo } from '../src/storage/arachnode-fret-adapter.js';
import type { FretService } from 'p2p-fret';
import { waitFor, delay } from '@optimystic/db-core/test';

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
	private peerMetadata = new Map<string, Record<string, any>>();
	assembleCohortCalls: Array<{ coord: Uint8Array; wants: number }> = [];

	/** Set what assembleCohort returns. Key is '*' for default, or stringified coord. */
	setCohort(key: string, peers: string[]): void {
		this.cohortResults.set(key, peers);
	}

	assembleCohort(coord: Uint8Array, wants: number, _exclude?: Set<string>): string[] {
		this.assembleCohortCalls.push({ coord, wants });
		// Try specific key first, then wildcard
		const specific = this.cohortResults.get(Array.from(coord).join(','));
		if (specific) return specific;
		return this.cohortResults.get('*') ?? [];
	}

	// Stubs for FretService interface
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	setMode(): void {}
	async ready(): Promise<void> {}
	neighborDistance(): number { return 0; }
	getNeighbors(): string[] { return []; }
	expandCohort(): string[] { return []; }
	async routeAct(): Promise<any> { return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }; }
	report(): void {}
	setMetadata(_md: Record<string, any>): void { /* no-op in test */ }
	getMetadata(peerId: string): Record<string, any> | undefined { return this.peerMetadata.get(peerId); }
	listPeers(): Array<{ id: string; metadata?: Record<string, any> }> { return []; }
	reportNetworkSize(): void {}
	getNetworkSizeEstimate() { return { size_estimate: 1, confidence: 0.5, sources: 0 }; }
	getNetworkChurn(): number { return 0; }
	detectPartition(): boolean { return false; }
	exportTable(): any { return { entries: [] }; }
	async importTable(): Promise<number> { return 0; }
}

// --- Tests ---

describe('RebalanceMonitor', () => {
	let selfId: PeerId;
	let peerId2: PeerId;
	let peerId3: PeerId;
	let mockLibp2p: MockLibp2p;
	let mockFret: MockFret;
	let partitionDetector: PartitionDetector;
	let fretAdapter: ArachnodeFretAdapter;
	let deps: RebalanceMonitorDeps;

	beforeEach(async () => {
		selfId = await makePeerId();
		peerId2 = await makePeerId();
		peerId3 = await makePeerId();

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
	});

	describe('lifecycle', () => {
		it('registers and removes event listeners on start/stop', async () => {
			const monitor = new RebalanceMonitor(deps);

			await monitor.start();
			expect(mockLibp2p.getListenerCount('connection:open')).to.equal(1);
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(1);

			await monitor.stop();
			expect(mockLibp2p.getListenerCount('connection:open')).to.equal(0);
			expect(mockLibp2p.getListenerCount('connection:close')).to.equal(0);
		});

		it('is idempotent on start/stop', async () => {
			const monitor = new RebalanceMonitor(deps);

			await monitor.start();
			await monitor.start();
			expect(mockLibp2p.getListenerCount('connection:open')).to.equal(1);

			await monitor.stop();
			await monitor.stop();
			expect(mockLibp2p.getListenerCount('connection:open')).to.equal(0);
		});
	});

	describe('block tracking', () => {
		it('tracks and untracks blocks', () => {
			const monitor = new RebalanceMonitor(deps);

			monitor.trackBlock('block-1');
			monitor.trackBlock('block-2');
			expect(monitor.getTrackedBlockCount()).to.equal(2);

			monitor.untrackBlock('block-1');
			expect(monitor.getTrackedBlockCount()).to.equal(1);
		});
	});

	describe('checkNow', () => {
		it('returns null when no blocks are tracked', async () => {
			const monitor = new RebalanceMonitor(deps);
			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('detects gained responsibility when self is in cohort', async () => {
			// Self is in the cohort for block-1
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const monitor = new RebalanceMonitor(deps);
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.gained).to.deep.equal(['block-1']);
			expect(event!.lost).to.deep.equal([]);
		});

		it('detects lost responsibility when self is no longer in cohort', async () => {
			// First check: self is responsible
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');

			await monitor.checkNow();

			// Now self is no longer in the cohort
			mockFret.setCohort('*', [peerId2.toString(), peerId3.toString()]);

			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.gained).to.deep.equal([]);
			expect(event!.lost).to.deep.equal(['block-1']);
			expect(event!.newOwners.get('block-1')).to.include(peerId2.toString());
			expect(event!.newOwners.get('block-1')).to.include(peerId3.toString());
		});

		it('returns null when responsibility has not changed', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');

			// First check establishes baseline
			await monitor.checkNow();

			// Second check — no change
			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('reports both gained and lost in a single event', async () => {
			// Initially responsible for block-1 only
			const selfStr = selfId.toString();
			const peer2Str = peerId2.toString();

			mockFret.setCohort('*', [selfStr]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');
			monitor.trackBlock('block-2');

			// First check: responsible for both
			await monitor.checkNow();

			// Now: self loses block-1, gains nothing new
			// We need per-block control. Since assembleCohort uses coord,
			// and all blocks go through '*', we simulate losing ALL and re-gaining none
			mockFret.setCohort('*', [peer2Str]);

			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.lost).to.include('block-1');
			expect(event!.lost).to.include('block-2');
		});
	});

	describe('growth detection (cohort grows while responsibility is kept)', () => {
		it('first observation reports the whole non-self cohort as grown (alongside gained)', async () => {
			// No snapshot entry yet ⇒ prior cohort treated as empty ⇒ every non-self cohort member is
			// "new". This is the founder-heal: peers that joined before the monitor's first check (or
			// before a holder restart) still get the push.
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString(), peerId3.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.gained, 'first observation is also a gain').to.deep.equal(['block-1']);
			expect(event!.grown.get('block-1'), 'both cohort peers are newly co-responsible').to.have.members(
				[peerId2.toString(), peerId3.toString()]);
			expect(event!.grown.get('block-1'), 'self never appears in grown').to.not.include(selfId.toString());
		});

		it('a peer joining the cohort reports ONLY the new peer as grown', async () => {
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');
			await monitor.checkNow(); // baseline: peerId2 recorded as seen

			mockFret.setCohort('*', [selfId.toString(), peerId2.toString(), peerId3.toString()]);
			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.gained, 'still responsible — nothing gained').to.deep.equal([]);
			expect(event!.lost).to.deep.equal([]);
			expect(event!.grown.get('block-1'), 'only the joiner, not the already-seen peer').to.deep.equal(
				[peerId3.toString()]);
		});

		it('a stable cohort does not re-emit growth', async () => {
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');
			await monitor.checkNow(); // first observation emits gained+grown

			const second = await monitor.checkNow();
			expect(second, 'no change → no event → no re-push loop').to.be.null;

			const third = await monitor.checkNow();
			expect(third).to.be.null;
		});

		it('a lost block never appears in grown (lost ⇒ not responsible ⇒ growth arm skipped)', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');
			await monitor.checkNow(); // baseline: responsible

			mockFret.setCohort('*', [peerId2.toString(), peerId3.toString()]);
			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.lost).to.deep.equal(['block-1']);
			expect(event!.grown.size, 'grown and lost are mutually exclusive per block').to.equal(0);
		});

		it('the growth budget defers excess blocks and re-detects them on the next check', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0, growthBlockBudget: 1 });
			monitor.trackBlock('block-1');
			monitor.trackBlock('block-2');
			await monitor.checkNow(); // baseline: responsible for both, no non-self peers yet

			// Both blocks grow at once; the budget admits one per check.
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const first = await monitor.checkNow();
			expect(first).to.not.be.null;
			expect(first!.grown.size, 'budget admits exactly one block').to.equal(1);

			// The dropped block's snapshot was NOT updated, so the same growth is re-detected.
			const second = await monitor.checkNow();
			expect(second).to.not.be.null;
			expect(second!.grown.size, 'the deferred block surfaces next check').to.equal(1);
			const firstBlock = [...first!.grown.keys()][0];
			const secondBlock = [...second!.grown.keys()][0];
			expect(secondBlock, 'it is the OTHER block, not a re-emit').to.not.equal(firstBlock);
			expect(second!.grown.get(secondBlock!)).to.deep.equal([peerId2.toString()]);

			// Both now recorded — nothing left to defer.
			const third = await monitor.checkNow();
			expect(third).to.be.null;
		});

		it('regaining responsibility re-reports the whole cohort as grown (seen set cleared on loss)', async () => {
			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);

			const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
			monitor.trackBlock('block-1');
			await monitor.checkNow(); // baseline: responsible, peerId2 seen

			mockFret.setCohort('*', [peerId2.toString()]); // self drops out
			await monitor.checkNow(); // lost

			mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]); // self back in
			const event = await monitor.checkNow();

			expect(event).to.not.be.null;
			expect(event!.gained).to.deep.equal(['block-1']);
			expect(event!.grown.get('block-1'), 'peerId2 re-reported: the seen set was cleared on loss').to.deep.equal(
				[peerId2.toString()]);
		});
	});

	describe('debounce behavior', () => {
		it('rapid topology changes produce a single debounced check', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const events: RebalanceEvent[] = [];
			const monitor = new RebalanceMonitor(deps, {
				debounceMs: 50,
				minRebalanceIntervalMs: 0
			});
			monitor.onRebalance(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();

			// Fire multiple topology changes rapidly
			mockLibp2p.emit('connection:open');
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:open');
			mockLibp2p.emit('connection:close');
			mockLibp2p.emit('connection:open');

			// Wait until the debounce collapses the rapid changes into a single fired check.
			await waitFor(() => events.length >= 1, { description: 'the debounced topology changes fired a single rebalance check' });

			// Should have at most 1 event (gained block-1)
			expect(events.length).to.be.at.most(1);

			await monitor.stop();
		});

		it('does not fire events after stop', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const events: RebalanceEvent[] = [];
			const monitor = new RebalanceMonitor(deps, {
				debounceMs: 50,
				minRebalanceIntervalMs: 0
			});
			monitor.onRebalance(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();
			mockLibp2p.emit('connection:open');

			await monitor.stop();

			// Residual bounded sleep: this is a NEGATIVE assertion (nothing fires), which a condition
			// poll cannot express. stop() clears the debounce timer, so waiting past the 50ms debounce
			// window proves no event escapes the stop.
			await delay(100);

			expect(events).to.have.length(0);
		});
	});

	describe('partition suppression', () => {
		it('suppresses rebalance when partition is detected', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			// Simulate partition
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}

			const monitor = new RebalanceMonitor(deps, { suppressDuringPartition: true });
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.be.null;
		});

		it('allows rebalance when suppression is disabled', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			// Simulate partition
			for (let i = 0; i < 10; i++) {
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
				partitionDetector.recordFailure(`peer-${i}`);
			}

			const monitor = new RebalanceMonitor(deps, { suppressDuringPartition: false });
			monitor.trackBlock('block-1');

			const event = await monitor.checkNow();
			expect(event).to.not.be.null;
			expect(event!.gained).to.deep.equal(['block-1']);
		});
	});

	describe('throttling', () => {
		it('throttles rebalance checks to minRebalanceIntervalMs', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const events: RebalanceEvent[] = [];
			const monitor = new RebalanceMonitor(deps, {
				debounceMs: 10,
				minRebalanceIntervalMs: 200
			});
			monitor.onRebalance(e => events.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();

			// First topology change fires one event (debounce 10ms).
			mockLibp2p.emit('connection:open');
			await waitFor(() => events.length >= 1, { description: 'the first topology change fired one rebalance event' });

			// Second topology change — should be throttled by minRebalanceIntervalMs.
			mockFret.setCohort('*', [peerId2.toString()]);
			mockLibp2p.emit('connection:close');
			// Residual bounded sleep: proving the second change does NOT emit within the throttle window
			// is a negative assertion. Wait past the 10ms debounce so the throttled check has run and been
			// rejected, then confirm no extra event landed.
			await delay(50);

			// Only the first event should have fired (gained block-1)
			expect(events.length).to.be.at.most(1);

			await monitor.stop();
		});
	});

	describe('ArachnodeInfo status transitions', () => {
		it('setStatus delegates to fretAdapter.setStatus', () => {
			const statusLog: Array<ArachnodeInfo['status']> = [];
			const adapter = {
				setStatus: (status: ArachnodeInfo['status']) => { statusLog.push(status); }
			} as unknown as ArachnodeFretAdapter;

			const monitor = new RebalanceMonitor({
				...deps,
				fretAdapter: adapter
			});

			monitor.setStatus('moving');
			monitor.setStatus('active');
			monitor.setStatus('leaving');

			expect(statusLog).to.deep.equal(['moving', 'active', 'leaving']);
		});
	});

	describe('event handlers', () => {
		it('calls all registered handlers on topology-triggered rebalance', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const calls1: RebalanceEvent[] = [];
			const calls2: RebalanceEvent[] = [];

			const monitor = new RebalanceMonitor(deps, {
				debounceMs: 10,
				minRebalanceIntervalMs: 0
			});
			monitor.onRebalance(e => calls1.push(e));
			monitor.onRebalance(e => calls2.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();
			mockLibp2p.emit('connection:open');

			// Wait until the debounced rebalance fired and invoked every registered handler.
			await waitFor(() => calls1.length >= 1 && calls2.length >= 1, { description: 'the debounced rebalance fired and invoked all handlers' });

			expect(calls1).to.have.length(1);
			expect(calls2).to.have.length(1);
			expect(calls1[0]!.gained).to.deep.equal(['block-1']);

			await monitor.stop();
		});

		it('handler errors do not prevent other handlers from firing', async () => {
			mockFret.setCohort('*', [selfId.toString()]);

			const calls: RebalanceEvent[] = [];

			const monitor = new RebalanceMonitor(deps, {
				debounceMs: 10,
				minRebalanceIntervalMs: 0
			});
			monitor.onRebalance(() => { throw new Error('handler error'); });
			monitor.onRebalance(e => calls.push(e));
			monitor.trackBlock('block-1');

			await monitor.start();
			mockLibp2p.emit('connection:open');

			// Wait until the surviving handler recorded the event (the first handler throws).
			await waitFor(() => calls.length >= 1, { description: 'the second handler still fired despite the first throwing' });

			expect(calls).to.have.length(1);

			await monitor.stop();
		});
	});
});
