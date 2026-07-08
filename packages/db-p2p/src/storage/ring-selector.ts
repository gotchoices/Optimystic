import { hashPeerId } from 'p2p-fret';
import { peerIdFromString } from '@libp2p/peer-id';
import type { StorageMonitor } from './storage-monitor.js';
import type { ArachnodeInfo, ArachnodeFretAdapter } from './arachnode-fret-adapter.js';

/** EWMA weight for the demand inputs. Higher = more reactive, lower = smoother. */
const DEFAULT_SMOOTHING_ALPHA = 0.2;
/** Hysteresis half-width in rings. 0.5 puts a full ring between the move-out and move-in triggers. */
const DEFAULT_DEADBAND = 0.5;
/** Minimum time (ms) at a ring after a move is triggered before another may start. */
const DEFAULT_MIN_DWELL_MS = 10 * 60 * 1000;
/** Floor for smoothed coverage so `-log2` never sees 0; the [0,16] clamp bounds the result anyway. */
const DEPTH_EPSILON = 1e-12;

export interface RingSelectorConfig {
	/** Minimum storage capacity in bytes */
	minCapacity: number;

	/** Thresholds for ring transitions */
	thresholds: {
		/** Move to outer ring when used > this % */
		moveOut: number;
		/** Move to inner ring when used < this % */
		moveIn: number;
	};

	/**
	 * EWMA weight (0..1) applied to the demand inputs (available capacity and estimated network
	 * data) each sample tick. A single noisy sample only moves the smoothed depth by this fraction.
	 * Default {@link DEFAULT_SMOOTHING_ALPHA} (0.2).
	 */
	smoothingAlpha?: number;

	/**
	 * Hysteresis dead-band half-width `h`, in rings. A move only fires when the smoothed depth is
	 * past the ring boundary by `h`, so the region of width `2h` around each integer produces no
	 * move. Default {@link DEFAULT_DEADBAND} (0.5) — a full ring between the move-out and move-in
	 * triggers, so a node can never satisfy both at once.
	 */
	deadband?: number;

	/**
	 * Minimum dwell in ms: no new move may be triggered within this window of the last one. Bounds
	 * shift frequency independent of signal noise. Default {@link DEFAULT_MIN_DWELL_MS} (10 min).
	 */
	minDwellMs?: number;

	/**
	 * Injectable clock (Unix ms), used only for the dwell timer. Defaults to `Date.now`; tests
	 * inject a fake clock so dwell can be exercised without sleeping on wall time.
	 */
	now?: () => number;
}

/**
 * Determines appropriate ring depth based on storage capacity and network demand.
 *
 * Ring depth represents keyspace partitioning:
 * - Ring 0: Full keyspace (1 partition)
 * - Ring N: 2^N partitions
 *
 * A node selects its ring based on: available_capacity / estimated_neighborhood_demand
 *
 * The transition decision ({@link shouldTransition}) is damped so it does not thrash near a ring
 * boundary: the demand signal is smoothed with an EWMA, a dead-band keeps a hovering ratio from
 * moving, and a minimum-dwell timer + single-step rule bound how often and how far it moves. See
 * `docs/arachnode-ring-handoff.md` § Part 1.
 */
export class RingSelector {
	/** EWMA of available capacity (bytes). Undefined until the first sample seeds it. */
	private smoothedAvailable: number | undefined;
	/** EWMA of estimated total network data (bytes). Undefined until the first sample seeds it. */
	private smoothedTotalData: number | undefined;
	/** Clock time (ms) a move was last triggered; undefined = no move yet, so dwell does not block. */
	private lastMoveAt: number | undefined;
	private readonly now: () => number;

	constructor(
		private readonly fretAdapter: ArachnodeFretAdapter,
		private readonly storageMonitor: StorageMonitor,
		private readonly config: RingSelectorConfig
	) {
		this.now = config.now ?? ((): number => Date.now());
	}

	/**
	 * Determine appropriate ring depth from an instantaneous capacity + demand snapshot.
	 *
	 * This is the *undamped* reading used for the deterministic first-boot ring and anywhere a
	 * one-shot estimate is wanted. The damped transition logic lives in {@link shouldTransition};
	 * this method intentionally does not touch the EWMA state so its result is a pure function of
	 * the current snapshot.
	 */
	async determineRing(): Promise<number> {
		const capacity = await this.storageMonitor.getCapacity();

		if (capacity.available < this.config.minCapacity) {
			// Not enough capacity for any ring
			return -1;
		}

		const estimatedTotalData = this.estimateNetworkData(capacity.available);

		// Calculate what fraction of keyspace we can cover
		const coverage = capacity.available / estimatedTotalData;

		// Ring depth: 0 = full keyspace, N = 2^N partitions
		// If coverage = 0.01 (1%), we need ~100 partitions ≈ Ring 7
		// If coverage = 1.0 (100%), we can handle full keyspace = Ring 0
		const ringDepth = Math.max(0, Math.ceil(-Math.log2(Math.max(0.001, coverage))));

		return Math.min(ringDepth, 16); // Cap at Ring 16 (65536 partitions)
	}

	/**
	 * Estimate total network spare capacity (bytes) by aggregating observed per-ring stats.
	 *
	 * See docs/arachnode.md §"Capacity Management and Ring Adjustment": ring selection should
	 * reflect observed network demand, not a hard-coded constant. We treat Σ (peerCount ×
	 * avgCapacity) over known rings as a proxy for total network spare capacity, so `coverage`
	 * becomes our share of it. More peers (or richer peers) → smaller share → higher ring depth
	 * (more specialization). On bootstrap, when no ring stats are observed yet, we fall back to a
	 * conservative fixed estimate so first-boot behavior is deterministic.
	 *
	 * @param availableForFallback local available bytes, used only for the pathological
	 * zero-aggregate case (e.g. all peers report 0 available) so coverage collapses to 1.0 (ring 0).
	 */
	private estimateNetworkData(availableForFallback: number): number {
		const ringStats = this.fretAdapter.getRingStats();
		let estimatedTotalData: number;
		if (ringStats.length > 0) {
			estimatedTotalData = ringStats.reduce(
				(sum, stat) => sum + stat.peerCount * stat.avgCapacity,
				0
			);
		} else {
			const avgBlockSize = 100 * 1024; // 100KB typical block
			const estimatedTotalBlocks = 1000; // Conservative estimate
			estimatedTotalData = estimatedTotalBlocks * avgBlockSize;
		}

		if (estimatedTotalData <= 0) {
			estimatedTotalData = availableForFallback;
		}

		return estimatedTotalData;
	}

	/**
	 * Fold one sample into the EWMA of each demand input. Seeds from the first real sample rather
	 * than from 0 — a 0 seed would drag the smoothed depth for many ticks.
	 */
	private updateSmoothing(available: number, totalData: number): void {
		const alpha = this.config.smoothingAlpha ?? DEFAULT_SMOOTHING_ALPHA;
		this.smoothedAvailable = this.smoothedAvailable === undefined
			? available
			: alpha * available + (1 - alpha) * this.smoothedAvailable;
		this.smoothedTotalData = this.smoothedTotalData === undefined
			? totalData
			: alpha * totalData + (1 - alpha) * this.smoothedTotalData;
	}

	/**
	 * Continuous smoothed ring depth `d = clamp(-log2(smoothedCoverage), 0, 16)` from the current
	 * EWMA state. Returns 0 (ring 0) if no sample has been folded in yet.
	 */
	private smoothedDepth(): number {
		const available = this.smoothedAvailable ?? 0;
		const totalData = this.smoothedTotalData ?? 0;
		const coverage = totalData > 0 ? available / totalData : 1;
		const depth = -Math.log2(Math.max(DEPTH_EPSILON, coverage));
		return Math.min(16, Math.max(0, depth));
	}

	/**
	 * Calculate partition for a given ring depth and peer ID.
	 */
	async calculatePartition(
		ringDepth: number,
		peerId: string
	): Promise<{ prefixBits: number, prefixValue: number } | undefined> {
		if (ringDepth === 0) {
			return undefined; // Full keyspace, no partition
		}

		// Hash peer ID to get coordinate. hashPeerId reads `peerId.toMultihash().bytes`, so it
		// needs a real PeerId — reconstruct one from the string. Peers must occupy the SAME ring
		// coordinate FRET uses to place them (hashPeerId(peerId)), or restoration's block-prefix
		// vs peer-prefix comparison stops meaning "this peer owns this block's slice".
		const coord = await hashPeerId(peerIdFromString(peerId));

		// Extract prefix bits from coordinate
		const prefixBits = ringDepth;
		const prefixValue = this.extractPrefix(coord, prefixBits);

		return { prefixBits, prefixValue };
	}

	/**
	 * Create Arachnode info for this node.
	 *
	 * @param ringDepthOverride when supplied (e.g. the single-step target from
	 * {@link shouldTransition}), the node advertises exactly this ring instead of a freshly
	 * recomputed {@link determineRing}. The transition site passes it so the advertised ring can
	 * never disagree with the ring the transition decision just chose.
	 */
	async createArachnodeInfo(peerId: string, ringDepthOverride?: number): Promise<ArachnodeInfo> {
		const capacity = await this.storageMonitor.getCapacity();
		const ringDepth = ringDepthOverride ?? await this.determineRing();
		const partition = ringDepth >= 0
			? await this.calculatePartition(ringDepth, peerId)
			: undefined;

		return {
			ringDepth: Math.max(0, ringDepth),
			partition,
			capacity: {
				total: capacity.total,
				used: capacity.used,
				available: capacity.available
			},
			status: 'active'
		};
	}

	/**
	 * Decide whether a damped ring transition should start.
	 *
	 * Damping (see `docs/arachnode-ring-handoff.md` § Part 1):
	 * - **Smoothing** — every call folds the current sample into an EWMA of the demand inputs and
	 *   works off the smoothed continuous depth `d`, so a single noisy sample cannot trigger a move.
	 * - **Hysteresis** — anchored on the node's *currently-advertised* ring `R` (not a freshly
	 *   recomputed one). A move only fires when `d` is past the boundary by the dead-band `h`, so a
	 *   ratio hovering around an integer produces no move.
	 * - **Dwell + single-step** — no new move within `minDwellMs` of the last, no move while a shift
	 *   is already in flight (`status === 'moving'`), and each move steps by exactly ±1 ring even
	 *   when `d` implies a larger jump.
	 *
	 * Return shape (`{ shouldMove, direction, newRingDepth }`) is the *trigger* the handoff protocol
	 * consumes; it is kept stable so that consumer is unaffected.
	 */
	async shouldTransition(): Promise<{
		shouldMove: boolean;
		direction?: 'in' | 'out';
		newRingDepth?: number
	}> {
		const capacity = await this.storageMonitor.getCapacity();
		const usedPercent = capacity.total > 0 ? capacity.used / capacity.total : 0;

		// Smoothing updates every tick, regardless of whether we act, so the EWMA keeps tracking
		// demand even while a candidate move is dwell-blocked or a shift is already in flight.
		const rawTotalData = this.estimateNetworkData(capacity.available);
		this.updateSmoothing(capacity.available, rawTotalData);
		const d = this.smoothedDepth();

		const info = this.fretAdapter.getMyArachnodeInfo();
		// Hysteresis anchor: the node's currently-advertised ring. Fall back to the smoothed depth
		// only in the pathological case where nothing has been advertised yet (production always
		// advertises at bootstrap before the first tick).
		const advertisedRing = info?.ringDepth ?? Math.min(16, Math.max(0, Math.round(d)));

		// No re-entrant shift: a move already in flight (advertise→confirm→release) owns the ring.
		if (info?.status === 'moving') {
			return { shouldMove: false };
		}

		// Minimum dwell: rate-limit so signal noise cannot drive rapid flips. `lastMoveAt` undefined
		// means no prior move, so the first genuine move is never blocked.
		// NOTE: dwell keys off when a move is *triggered*, not when the advertise→confirm→release
		// handoff completes; once that protocol lands (sibling ticket), re-stamp `lastMoveAt` on
		// completion so an aborted/rolled-back shift does not consume the dwell window.
		const minDwellMs = this.config.minDwellMs ?? DEFAULT_MIN_DWELL_MS;
		if (this.lastMoveAt !== undefined && (this.now() - this.lastMoveAt) < minDwellMs) {
			return { shouldMove: false };
		}

		const h = this.config.deadband ?? DEFAULT_DEADBAND;

		// Move OUT (R → R+1): smoothed depth solidly past the outer boundary AND storage pressure high.
		if (d >= advertisedRing + 1 - h && usedPercent > this.config.thresholds.moveOut) {
			this.lastMoveAt = this.now();
			return {
				shouldMove: true,
				direction: 'out',
				newRingDepth: advertisedRing + 1 // single step, even if d implies a larger jump
			};
		}

		// Move IN (R → R-1): smoothed depth solidly past the inner boundary AND storage slack AND R>0.
		if (advertisedRing > 0 && d <= advertisedRing - 1 + h && usedPercent < this.config.thresholds.moveIn) {
			this.lastMoveAt = this.now();
			return {
				shouldMove: true,
				direction: 'in',
				newRingDepth: advertisedRing - 1 // single step
			};
		}

		return { shouldMove: false };
	}

	/**
	 * Extract first N bits from byte array as a number.
	 */
	private extractPrefix(bytes: Uint8Array, bits: number): number {
		let value = 0;
		for (let i = 0; i < bits; i++) {
			const byteIndex = Math.floor(i / 8);
			const bitIndex = 7 - (i % 8);
			const bit = (bytes[byteIndex]! >> bitIndex) & 1;
			value = (value << 1) | bit;
		}
		return value;
	}
}
