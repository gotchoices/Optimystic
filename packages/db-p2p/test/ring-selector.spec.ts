import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { RingSelector, type RingSelectorConfig } from '../src/storage/ring-selector.js';
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../src/storage/arachnode-fret-adapter.js';

/** Generate `n` real (base58-encodable) Ed25519 peer-id strings — what calculatePartition needs
 *  to reach p2p-fret's hashPeerId, which reads `peerId.toMultihash().bytes`. */
async function makeValidPeerIds(n: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const key = await generateKeyPair('Ed25519');
		ids.push(peerIdFromPrivateKey(key).toString());
	}
	return ids;
}

/** Mock storage monitor that implements only the getCapacity method needed by RingSelector */
class MockStorageMonitor {
	private _total: number;
	private _used: number;

	constructor(total: number, used: number) {
		this._total = total;
		this._used = used;
	}

	setCapacity(total: number, used: number): void {
		this._total = total;
		this._used = used;
	}

	async getCapacity(): Promise<{ total: number; used: number; available: number }> {
		return {
			total: this._total,
			used: this._used,
			available: this._total - this._used
		};
	}
}

type RingStat = { ringDepth: number; peerCount: number; avgCapacity: number };

class MockFretAdapter implements Pick<ArachnodeFretAdapter, 'getMyArachnodeInfo' | 'getKnownRings' | 'getRingStats'> {
	private _ringStats: RingStat[] = [];
	private _myInfo: ArachnodeInfo | undefined;

	setRingStats(stats: RingStat[]): void {
		this._ringStats = stats;
	}

	/** Set the node's currently-advertised ArachnodeInfo (the hysteresis anchor shouldTransition reads). */
	setMyArachnodeInfo(info: ArachnodeInfo | undefined): void {
		this._myInfo = info;
	}

	getMyArachnodeInfo() { return this._myInfo; }
	getKnownRings() { return this._ringStats.map(s => s.ringDepth); }
	getRingStats() { return this._ringStats; }
}

/** Deterministic clock (Unix ms). `now` advances only via {@link advance} — no wall time. */
class FakeClock {
	private t = 0;
	readonly now = (): number => this.t;
	advance(ms: number): void { this.t += ms; }
}

/** Build a minimal advertised ArachnodeInfo at ring `ringDepth`. Capacity fields are unused here. */
function advertise(ringDepth: number, status: ArachnodeInfo['status'] = 'active'): ArachnodeInfo {
	return { ringDepth, capacity: { total: 0, used: 0, available: 0 }, status };
}

describe('RingSelector', () => {
	const defaultConfig: RingSelectorConfig = {
		minCapacity: 1024 * 1024, // 1MB minimum
		thresholds: {
			moveOut: 0.8, // Move to outer ring when >80% used
			moveIn: 0.2   // Move to inner ring when <20% used
		}
	};

	let monitor: MockStorageMonitor;
	let fretAdapter: MockFretAdapter;
	let selector: RingSelector;
	let peerIds: string[];

	before(async () => {
		peerIds = await makeValidPeerIds(8);
	});

	beforeEach(() => {
		monitor = new MockStorageMonitor(1024 * 1024 * 1024, 0); // 1GB total, 0 used
		fretAdapter = new MockFretAdapter();
		// Cast monitor to satisfy the type - RingSelector only uses getCapacity()
		selector = new RingSelector(fretAdapter as any, monitor as any, defaultConfig);
	});

	describe('determineRing', () => {
		it('returns -1 when capacity below minimum', async () => {
			monitor.setCapacity(512 * 1024, 0); // 512KB, below 1MB minimum
			const ring = await selector.determineRing();
			expect(ring).to.equal(-1);
		});

		it('returns ring 0 for very large capacity', async () => {
			// With huge capacity relative to estimated data, ring 0 (full keyspace)
			monitor.setCapacity(1024 * 1024 * 1024 * 10, 0); // 10GB
			const ring = await selector.determineRing();
			expect(ring).to.equal(0);
		});

		it('returns higher ring depth for smaller capacity', async () => {
			// With less capacity, need more partitions
			monitor.setCapacity(10 * 1024 * 1024, 0); // 10MB
			const ring = await selector.determineRing();
			expect(ring).to.be.greaterThan(0);
		});

		it('caps ring depth at 16', async () => {
			// Extremely small capacity should still cap at ring 16
			monitor.setCapacity(1024 * 1024, 0); // Exactly at minimum
			const ring = await selector.determineRing();
			expect(ring).to.be.at.most(16);
		});

		it('ring depth increases as available capacity decreases', async () => {
			// First measurement with lots of capacity
			monitor.setCapacity(1024 * 1024 * 1024, 0); // 1GB available
			const ring1 = await selector.determineRing();

			// Second measurement with less capacity (90% used)
			monitor.setCapacity(1024 * 1024 * 1024, 900 * 1024 * 1024); // 100MB available
			const ring2 = await selector.determineRing();

			expect(ring2).to.be.at.least(ring1);
		});

		it('uses observed ring stats to size network when available (single-ring)', async () => {
			// 4 peers in one ring, each with 100MB available -> network estimate = 400MB.
			// Local available = 100MB -> coverage = 0.25 -> ringDepth = ceil(-log2(0.25)) = 2.
			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 4, avgCapacity: 100 * 1024 * 1024 }
			]);
			monitor.setCapacity(100 * 1024 * 1024, 0); // 100MB available
			const ring = await selector.determineRing();
			expect(ring).to.equal(2);
		});

		it('aggregates capacity across multiple rings', async () => {
			// Ring 0: 1 peer × 1GB = 1GB; Ring 4: 8 peers × 100MB = 800MB. Total ≈ 1.8GB.
			// Local available = 100MB -> coverage ≈ 100MB / 1.8GB ≈ 0.0543 -> ceil(-log2(0.0543)) = 5.
			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 1, avgCapacity: 1024 * 1024 * 1024 },
				{ ringDepth: 4, peerCount: 8, avgCapacity: 100 * 1024 * 1024 }
			]);
			monitor.setCapacity(100 * 1024 * 1024, 0);
			const ring = await selector.determineRing();
			expect(ring).to.equal(5);
		});

		it('ring depth grows as observed network capacity grows (more peers)', async () => {
			// Hold local capacity fixed; increase network capacity -> ring depth must rise.
			monitor.setCapacity(100 * 1024 * 1024, 0); // 100MB local

			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 2, avgCapacity: 100 * 1024 * 1024 } // 200MB network
			]);
			const ringSmallNetwork = await selector.determineRing();

			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 64, avgCapacity: 100 * 1024 * 1024 } // 6.4GB network
			]);
			const ringLargeNetwork = await selector.determineRing();

			expect(ringLargeNetwork).to.be.greaterThan(ringSmallNetwork);
		});

		it('ring depth shrinks as observed network capacity shrinks (fewer peers)', async () => {
			monitor.setCapacity(100 * 1024 * 1024, 0); // 100MB local

			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 64, avgCapacity: 100 * 1024 * 1024 } // 6.4GB network
			]);
			const ringLargeNetwork = await selector.determineRing();

			fretAdapter.setRingStats([
				{ ringDepth: 0, peerCount: 2, avgCapacity: 100 * 1024 * 1024 } // 200MB network
			]);
			const ringSmallNetwork = await selector.determineRing();

			expect(ringSmallNetwork).to.be.lessThan(ringLargeNetwork);
		});

		it('falls back to constant-based estimate when no ring stats are observed (bootstrap)', async () => {
			// Empty stats -> bootstrap: estimatedTotalData = 100MB. With 10GB local, coverage >> 1, ring = 0.
			fretAdapter.setRingStats([]);
			monitor.setCapacity(10 * 1024 * 1024 * 1024, 0);
			const ring = await selector.determineRing();
			expect(ring).to.equal(0);
		});
	});

	describe('calculatePartition', () => {
		it('returns undefined for ring 0', async () => {
			const partition = await selector.calculatePartition(0, peerIds[0]!);
			expect(partition).to.equal(undefined);
		});

		it('returns partition info for ring > 0', async () => {
			// Real peer id → hashPeerId succeeds → a defined partition is produced. This
			// assertion fails outright if calculatePartition throws (the pre-fix behavior).
			const partition = await selector.calculatePartition(4, peerIds[0]!);
			expect(partition).to.not.equal(undefined);
			expect(partition!.prefixBits).to.equal(4);
			expect(partition!.prefixValue).to.be.at.least(0);
			expect(partition!.prefixValue).to.be.lessThan(16);
		});

		it('partition value is bounded by ring depth', async () => {
			for (const ringDepth of [1, 2, 3, 8, 12]) {
				const partition = await selector.calculatePartition(ringDepth, peerIds[ringDepth % peerIds.length]!);
				expect(partition).to.not.equal(undefined);
				const maxValue = Math.pow(2, ringDepth);
				expect(partition!.prefixValue).to.be.at.least(0);
				expect(partition!.prefixValue).to.be.lessThan(maxValue);
			}
		});

		it('same peer gets same partition for same ring depth', async () => {
			const peerId = peerIds[1]!;
			const p1 = await selector.calculatePartition(5, peerId);
			const p2 = await selector.calculatePartition(5, peerId);
			expect(p1).to.not.equal(undefined);
			expect(p1).to.deep.equal(p2);
		});

		it('different peers may get different partitions', async () => {
			const partitions = await Promise.all(
				peerIds.slice(0, 5).map(id => selector.calculatePartition(8, id))
			);
			for (const p of partitions) {
				expect(p).to.not.equal(undefined);
			}
			const values = partitions.map(p => p!.prefixValue);
			const uniqueValues = new Set(values);
			expect(uniqueValues.size).to.be.at.least(1);
		});
	});

	describe('shouldTransition (damped)', () => {
		// A dedicated selector wired with the damping config + a fake clock, so dwell can be
		// exercised without sleeping. Defaults mirror production intent: h = 0.5 (a full ring between
		// triggers), α = 0.2. moveOut/moveIn kept at the suite's 0.8/0.2 for readable percentages.
		const MINUTE = 60 * 1000;
		const dwellMs = 10 * MINUTE;
		let clock: FakeClock;
		let dampedConfig: RingSelectorConfig;

		beforeEach(() => {
			clock = new FakeClock();
			dampedConfig = {
				minCapacity: 1024 * 1024,
				thresholds: { moveOut: 0.8, moveIn: 0.2 },
				smoothingAlpha: 0.2,
				deadband: 0.5,
				minDwellMs: dwellMs,
				now: clock.now
			};
			selector = new RingSelector(fretAdapter as any, monitor as any, dampedConfig);
		});

		/**
		 * Drive the demand signal so the *smoothed* continuous depth equals `d` on the first sample
		 * (EWMA seeds from the first sample, so seeded value == raw). `coverage = available/totalData
		 * = 2^-d`; usedPercent is set independently via the monitor. total defaults to 1 GB.
		 */
		function setSignal(usedPercent: number, d: number, total = 1024 * 1024 * 1024): void {
			const used = Math.round(usedPercent * total);
			monitor.setCapacity(total, used);
			const available = total - used;
			const totalData = available * Math.pow(2, d);
			fretAdapter.setRingStats([{ ringDepth: 0, peerCount: 1, avgCapacity: totalData }]);
		}

		it('no move when depth sits inside the dead-band and usage is normal', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(3));
			setSignal(0.5, 3.0); // depth exactly on the ring, moderate usage
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(false);
		});

		it('moves out when depth is past the outer boundary AND usage exceeds moveOut', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(2));
			setSignal(0.9, 3.0); // d=3 ≥ R+1-h=2.5 and 0.9 > 0.8
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(true);
			expect(result.direction).to.equal('out');
			expect(result.newRingDepth).to.equal(3);
		});

		it('dead-band blocks a move-out when usage is high but depth is not past the boundary', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(2));
			setSignal(0.9, 2.2); // usage high, but d=2.2 < R+1-h=2.5
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(false);
		});

		it('moves in when depth is past the inner boundary AND usage is below moveIn', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(3));
			setSignal(0.1, 2.0); // d=2 ≤ R-1+h=2.5 and 0.1 < 0.2
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(true);
			expect(result.direction).to.equal('in');
			expect(result.newRingDepth).to.equal(2);
		});

		it('never moves in from ring 0', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(0));
			setSignal(0.05, 0.0); // very low usage, ring 0
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(false);
		});

		it('does not start a new move while a shift is already in flight (status=moving)', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(2, 'moving'));
			setSignal(0.9, 3.0); // would move out if not already moving
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(false);
		});

		it('boundary hover produces zero moves across an oscillating sequence', async () => {
			// Node advertises R=3; usage pinned high (would move out if the dead-band did not hold).
			// The depth jitters ±0.3 around the node's own ring integer 3 — the no-move zone for R=3 is
			// (R-1+h, R+1-h) = (2.5, 3.5), and the jitter never leaves it. Smoothing keeps the running
			// depth near 3, so no move must ever fire in either direction.
			fretAdapter.setMyArachnodeInfo(advertise(3));
			const jitter = [3.3, 2.7, 3.2, 2.8, 3.3, 2.7, 3.1, 2.9, 3.3, 2.7, 3.2, 2.8];
			for (const d of jitter) {
				setSignal(0.9, d);
				const result = await selector.shouldTransition();
				expect(result.shouldMove, `d=${d}`).to.equal(false);
				clock.advance(MINUTE); // time passes; still no move
			}
		});

		it('smoothing absorbs a single boundary-crossing spike that the raw signal would act on', async () => {
			// Isolates mechanism #1 (the EWMA), which the boundary-hover test above does NOT: there every
			// raw sample already sits inside the dead-band, so the dead-band alone explains the no-move.
			// Here the node advertises R=2 and settles at d≈2.0 (below the move-out boundary R+1-h=2.5),
			// then a single spike whose *raw* depth is 2.9 — solidly past 2.5, so an unsmoothed signal
			// WOULD move out. With α=0.2 one spike only drags the smoothed depth to ≈2.23, still inside
			// the band, so no move fires. (Contrast the seeding test below: a *fresh* selector seeded at
			// 2.9 would move immediately — it is the accumulated history that damps the spike here.)
			fretAdapter.setMyArachnodeInfo(advertise(2));
			for (let i = 0; i < 3; i++) {
				setSignal(0.9, 2.0); // usage high throughout, so only the depth gate can block a move
				const settle = await selector.shouldTransition();
				expect(settle.shouldMove, `settling sample ${i}`).to.equal(false);
				clock.advance(MINUTE);
			}
			setSignal(0.9, 2.9); // raw d=2.9 ≥ 2.5 would move out if unsmoothed
			const spike = await selector.shouldTransition();
			expect(spike.shouldMove, 'EWMA absorbs the single spike').to.equal(false);
		});

		it('seeds the EWMA from the first real sample, not from 0', async () => {
			// A 0 seed would make smoothedAvailable=0 → coverage=0 → depth=16 on the first tick, which
			// would BLOCK this legitimate move-in (16 ≤ R-1+h=0.5 is false). Correct seeding yields
			// depth=0, so the move-in fires.
			fretAdapter.setMyArachnodeInfo(advertise(1));
			setSignal(0.1, 0.0); // high coverage → depth 0; usage below moveIn
			const result = await selector.shouldTransition();
			expect(result.shouldMove).to.equal(true);
			expect(result.direction).to.equal('in');
			expect(result.newRingDepth).to.equal(0);
		});

		it('dwell rate-limits rapid flips but a sustained move fires after minDwellMs', async () => {
			fretAdapter.setMyArachnodeInfo(advertise(2));
			setSignal(0.9, 3.0);

			const first = await selector.shouldTransition();
			expect(first.shouldMove, 'first move fires immediately').to.equal(true);

			// Within the dwell window the same sustained pressure must NOT flip again.
			clock.advance(MINUTE);
			setSignal(0.9, 3.0);
			const blocked = await selector.shouldTransition();
			expect(blocked.shouldMove, 'rapid re-flip suppressed within dwell').to.equal(false);

			// Once the dwell elapses, genuine sustained over-capacity moves again — dwell rate-limits,
			// it does not veto.
			clock.advance(dwellMs);
			setSignal(0.9, 3.0);
			const after = await selector.shouldTransition();
			expect(after.shouldMove, 'sustained pressure moves after dwell').to.equal(true);
			expect(after.direction).to.equal('out');
		});

		it('steps exactly one ring even when depth implies a two-ring jump', async () => {
			// From ring 0 with depth ≈ 2.5, one call must target ring 1 only. The second ring is taken
			// only on a later tick, after dwell and after the node advertises the intermediate ring.
			fretAdapter.setMyArachnodeInfo(advertise(0));
			setSignal(0.9, 2.5);
			const step1 = await selector.shouldTransition();
			expect(step1.shouldMove).to.equal(true);
			expect(step1.newRingDepth).to.equal(1); // NOT 2, despite d ≈ 2.5

			// Simulate the move landing: advertise ring 1, let dwell elapse, re-sample the same signal.
			fretAdapter.setMyArachnodeInfo(advertise(1));
			clock.advance(dwellMs);
			setSignal(0.9, 2.5);
			const step2 = await selector.shouldTransition();
			expect(step2.shouldMove).to.equal(true);
			expect(step2.newRingDepth).to.equal(2); // second ring, on the later tick
		});
	});

	describe('createArachnodeInfo', () => {
		it('creates valid info for normal capacity', async () => {
			monitor.setCapacity(1024 * 1024 * 1024, 100 * 1024 * 1024); // 1GB total, 100MB used
			const info = await selector.createArachnodeInfo(peerIds[0]!);

			expect(info.ringDepth).to.be.at.least(0);
			expect(info.capacity.total).to.equal(1024 * 1024 * 1024);
			expect(info.capacity.used).to.equal(100 * 1024 * 1024);
			expect(info.capacity.available).to.equal(924 * 1024 * 1024);
			expect(info.status).to.equal('active');
		});

		it('handles below-minimum capacity gracefully', async () => {
			monitor.setCapacity(100, 0); // Way below minimum
			const info = await selector.createArachnodeInfo(peerIds[0]!);

			// ringDepth becomes max(0, -1) = 0 when below minimum
			expect(info.ringDepth).to.equal(0);
			expect(info.status).to.equal('active');
		});

		it('includes partition info for non-zero ring depth', async () => {
			// 50MB available against the bootstrap 100MB estimate → coverage 0.5 → ring 1. With a real
			// peer id calculatePartition succeeds, so a ring > 0 node DOES publish a partition (the
			// pre-fix throw would have left partition unset and never surfaced here).
			monitor.setCapacity(50 * 1024 * 1024, 0);
			const info = await selector.createArachnodeInfo(peerIds[2]!);

			expect(info.ringDepth).to.be.greaterThan(0);
			expect(info.partition).to.not.equal(undefined);
			expect(info.partition!.prefixBits).to.be.greaterThan(0);
		});
	});

	describe('extractPrefix (via calculatePartition)', () => {
		it('extracts correct prefix for various bit counts', async () => {
			const testCases = [
				{ bits: 1, maxValue: 2 },
				{ bits: 4, maxValue: 16 },
				{ bits: 8, maxValue: 256 },
				{ bits: 16, maxValue: 65536 }
			];

			for (const { bits, maxValue } of testCases) {
				const partition = await selector.calculatePartition(bits, peerIds[3]!);
				expect(partition).to.not.equal(undefined);
				expect(partition!.prefixValue).to.be.at.least(0);
				expect(partition!.prefixValue).to.be.lessThan(maxValue);
			}
		});
	});
});
