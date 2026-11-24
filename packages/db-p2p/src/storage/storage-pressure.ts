/**
 * The node's one answer to "how full is too full". `StorageAccount`
 * (`packages/db-p2p/src/storage/storage-account.ts`) measures the disk; this READS that measurement
 * against the operator's thresholds and names a stage, so every reaction a node has to filling up —
 * evicting its read cache, narrowing the slice of the keyspace it is responsible for, deleting what
 * it handed over, refusing new data from other machines — acts on one reading rather than inventing
 * its own threshold against its own scan. `packages/db-p2p/docs/storage.md` §10.
 *
 * It reads the account and nothing else, is built once per node on either role beside the account,
 * and is reachable as `node.storagePressure`.
 */

import type { StorageAccount, StorageCapacity } from './storage-account.js';
import { createLogger, type Logger } from '../logger.js';
import { armUnrefTimer } from '../unref-timer.js';

const defaultLog = createLogger('storage:pressure');

/**
 * How full the node is, as a name rather than a fraction. Ordered least to most pressure, so a
 * consumer asks {@link atLeastPressure} ("at least shedding?") instead of comparing fractions of its
 * own.
 *
 * | Stage | When | What acts on it |
 * | --- | --- | --- |
 * | `unknown` | the node cannot measure its storage: no allotment configured and the backend reports no free space, so `capacity().totalBytes` is absent | **nothing** — the node behaves exactly as it does with no pressure reading at all, and the start-up `WARN:` line already tells its operator why |
 * | `slack` | measured use is below `reclaimBelow` | the ring decision may move inward |
 * | `steady` | between `reclaimBelow` and `shedAbove` | nothing |
 * | `shedding` | measured use is above `shedAbove` | the ring decision moves outward; the read cache is enforced; the released-block sweep runs |
 * | `refusing` | measured use is above `refuseAbove` | everything `shedding` does, and every refusal gate |
 */
export type StoragePressureStage = 'unknown' | 'slack' | 'steady' | 'shedding' | 'refusing';

/**
 * The stages least to most pressure. `unknown` sits BELOW every acting stage, which is the whole
 * point of its place in this list: a consumer that asks for "at least `shedding`" gets `false` from a
 * node that cannot measure itself, so an unmeasurable node is never read as full.
 */
export const STORAGE_PRESSURE_STAGES = ['unknown', 'slack', 'steady', 'shedding', 'refusing'] as const satisfies readonly StoragePressureStage[];

/**
 * Whether `stage` is `atLeast` as much pressure as the caller cares about — the ONE comparison a
 * consumer makes, so no site re-derives the order. Asking for `'unknown'` is vacuously true and says
 * nothing; every acting site asks for `'shedding'` or `'refusing'`.
 */
export function atLeastPressure(stage: StoragePressureStage, atLeast: StoragePressureStage): boolean {
	return STORAGE_PRESSURE_STAGES.indexOf(stage) >= STORAGE_PRESSURE_STAGES.indexOf(atLeast);
}

/**
 * The fractions of the effective total at which a node changes what it does.
 * `NodeOptions.storageAllotment.thresholds`.
 *
 * They sit with the allotment rather than under `arachnode` for the reason the allotment itself does:
 * they are about this machine's disk, and a client node has an allotment and an account exactly as a
 * serving node does.
 *
 * `refuseAbove` is deliberately BELOW the allotment, and the gap is not slack: it is the headroom for
 * pends a cohort member has already approved, for the host's own writes, and for the sampling window
 * {@link StoragePressure.stage} accepts.
 */
export interface StoragePressureThresholds {
	/** Below this fraction of the effective total the node is at `slack` and may take more responsibility back. */
	reclaimBelow: number;
	/** Above this fraction the node is at `shedding`: it evicts, narrows its ring and sweeps what it released. */
	shedAbove: number;
	/** Above this fraction the node is at `refusing`: everything `shedding` does, plus every refusal gate. */
	refuseAbove: number;
}

/**
 * 40 % / 85 % / 95 %. The first two are the figures ring selection moved on before they were an
 * operator's to set (`RingSelectorConfig.thresholds.moveIn` / `.moveOut`), so a node whose operator
 * configures nothing behaves exactly as it did.
 */
export const DEFAULT_STORAGE_PRESSURE_THRESHOLDS: StoragePressureThresholds = {
	reclaimBelow: 0.40,
	shedAbove: 0.85,
	refuseAbove: 0.95
};

/**
 * How often {@link StoragePressure} samples: 60 s, the `StorageAccount` memo's own default TTL
 * (`storageAllotment.usedBytesCacheTtlMs`). Sampling faster would buy nothing — the account would
 * serve the same memoized scan — so this is the cadence, and the staleness it implies is bounded and
 * deliberate.
 */
export const DEFAULT_PRESSURE_SAMPLE_INTERVAL_MS = 60_000;

/** What one {@link StoragePressure.read} answered. */
export interface StoragePressureReading {
	readonly stage: StoragePressureStage;
	/**
	 * The capacity the stage was derived from; ABSENT when this read's scan FAILED, and then `stage`
	 * is the last stage actually measured rather than a new verdict. A one-off scan failure must not
	 * disarm the gates, so it is not the same thing as `unknown`, which is a successful scan that
	 * found no total.
	 */
	readonly capacity?: StorageCapacity;
}

export interface StoragePressureDeps {
	/** The node's ONE accounting of its disk. Only `capacity()` is read, which is also the seam tests stub. */
	readonly account: Pick<StorageAccount, 'capacity'>;
	/** The operator's thresholds, already defaulted and validated (`resolveStoragePressureThresholds`). */
	readonly thresholds: StoragePressureThresholds;
	/**
	 * Ask the read cache to enforce its budget, called after a read that landed at `shedding` or
	 * above. This is the trigger the cache was missing: `cacheBudgetBytes` already falls to 0 as other
	 * use fills the allotment, but `BlobCacheBudget` is enforced only after a read or fetch that
	 * pulled something, so a node filling up with blocks kept every cached blob until some read
	 * happened to arrive. `BlobCacheBudget.request()` logs rather than rejects, which is why this
	 * returns nothing.
	 */
	readonly requestCacheEnforcement?: () => void;
	/** Default {@link DEFAULT_PRESSURE_SAMPLE_INTERVAL_MS}. */
	readonly sampleIntervalMs?: number;
	/**
	 * How long after {@link StoragePressure.start} the FIRST sample is taken; default 0, so the gates
	 * arm as soon as the event loop turns rather than a sample interval into the node's life. It is a
	 * timer rather than an inline call so node construction never waits on a block-store scan.
	 */
	readonly firstSampleDelayMs?: number;
	/** Default `armUnrefTimer`, the seam the node's other timers take; tests inject a timer they can see. */
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
	/** Default the module's `storage:pressure` channel; the node passes a peer-id-suffixed one. */
	readonly log?: Logger;
}

/**
 * Default and validate `NodeOptions.storageAllotment.thresholds`, throwing rather than clamping — the
 * rule `assertStorageAllotmentBytes` follows. Each must be a finite number strictly between 0 and 1,
 * and `reclaimBelow < shedAbove < refuseAbove` must hold: an operator who inverted two of them is
 * told, not quietly given a node that sheds and reclaims at once.
 *
 * Over the numbers alone, so it runs and throws even on a node that will read `unknown` for its whole
 * life. That is right: a typo is a typo. An explicitly `undefined` field throws for the same reason
 * rather than falling back to its default: the operator named the field, and the message names it back.
 */
export function resolveStoragePressureThresholds(declared?: Partial<StoragePressureThresholds>): StoragePressureThresholds {
	const resolved: StoragePressureThresholds = { ...DEFAULT_STORAGE_PRESSURE_THRESHOLDS, ...declared };
	for (const name of ['reclaimBelow', 'shedAbove', 'refuseAbove'] as const) {
		const value = resolved[name];
		if (!Number.isFinite(value) || value <= 0 || value >= 1) {
			throw new RangeError(`storageAllotment.thresholds.${name} must be a fraction above 0 and below 1, got ${value}`);
		}
	}
	if (!(resolved.reclaimBelow < resolved.shedAbove && resolved.shedAbove < resolved.refuseAbove)) {
		throw new RangeError(`storageAllotment.thresholds must satisfy reclaimBelow < shedAbove < refuseAbove, got reclaimBelow=${resolved.reclaimBelow} shedAbove=${resolved.shedAbove} refuseAbove=${resolved.refuseAbove}`);
	}
	return resolved;
}

/**
 * How much of the effective total is used, as a fraction; `undefined` exactly when the node cannot
 * measure its storage. Unclamped above 1, which is the point: `StorageCapacity.usedBytes` is
 * unclamped so a node past its allotment reads above 1.0 and lands in `refusing`.
 *
 * A total of 0 is unreachable today: an allotment of 0 throws at construction, and a location that
 * reports no free space leaves `locationBytes` ABSENT rather than 0 (`StorageScan.locationBytes`), so
 * `effectiveTotalBytes` answers either a positive figure or nothing. The branch is a guard against a
 * future total of 0 dividing into `NaN`, which compares false against every threshold and would read
 * as `steady` — silently disarming every gate. Reading it as fully used fails the other way instead.
 */
export function usedFractionOf(capacity: StorageCapacity): number | undefined {
	const { totalBytes, usedBytes } = capacity;
	if (totalBytes === undefined) return undefined;
	return totalBytes > 0 ? usedBytes / totalBytes : 1;
}

/**
 * The stage one capacity implies. Pure, and the one place the thresholds are compared against a
 * measurement.
 *
 * Each boundary falls on the side that keeps the node calm: `slack` and `shedding` are STRICT (the
 * comparisons `RingSelector.shouldTransition` already made), so a node sitting exactly on a threshold
 * is `steady` and does nothing.
 */
export function pressureStageOf(capacity: StorageCapacity, thresholds: StoragePressureThresholds): StoragePressureStage {
	const fraction = usedFractionOf(capacity);
	if (fraction === undefined) return 'unknown';
	if (fraction > thresholds.refuseAbove) return 'refusing';
	if (fraction > thresholds.shedAbove) return 'shedding';
	if (fraction < thresholds.reclaimBelow) return 'slack';
	return 'steady';
}

/**
 * The node's pressure reading: one sample per tick, one stage, and a synchronous accessor for the
 * inbound paths that must not block on a disk scan.
 *
 * The difference between the two reads is load-bearing. {@link read} asks the account (one memoized
 * `capacity()` call) and answers a fresh stage; {@link stage} answers the LAST stage read, with no
 * I/O at all, which is what a push handler, an announce handler or a promise vote reads.
 */
export class StoragePressure {
	private readonly account: Pick<StorageAccount, 'capacity'>;
	private readonly thresholds: StoragePressureThresholds;
	private readonly requestCacheEnforcement: (() => void) | undefined;
	private readonly sampleIntervalMs: number;
	private readonly firstSampleDelayMs: number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	private readonly log: Logger;
	/** The last stage MEASURED. `unknown` until the first successful read, so a node refuses nothing until it has measured itself once. */
	private lastStage: StoragePressureStage = 'unknown';
	/** Whether a read has ever succeeded; the first one logs its stage even when that stage is `unknown`. */
	private measured = false;
	/** The read in flight, absent while none runs — so one tick's sample and a consumer's `read()` share one scan. */
	private reading: Promise<StoragePressureReading> | undefined;
	private cancelTimer: (() => void) | undefined;
	/** Whether {@link start} armed the schedule; a `read()` on an unstarted reading arms no timer. */
	private scheduled = false;
	private stopped = false;

	constructor(deps: StoragePressureDeps) {
		this.account = deps.account;
		this.thresholds = deps.thresholds;
		this.requestCacheEnforcement = deps.requestCacheEnforcement;
		this.sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_PRESSURE_SAMPLE_INTERVAL_MS;
		this.firstSampleDelayMs = deps.firstSampleDelayMs ?? 0;
		this.setTimer = deps.setTimer ?? armUnrefTimer;
		this.log = deps.log ?? defaultLog;
	}

	// NOTE: `stage()` answers the last sample, so between samples a node can accept up to one
	// sample-interval's inbound data past its limit. The gap between `refuseAbove` and the
	// allotment is the headroom for exactly that (and for pends already approved). If a node is
	// ever seen well past its allotment between samples, add the bytes accepted since the last
	// sample to the reading rather than scanning on the gate.
	/**
	 * The last stage read, synchronously and with no I/O. `unknown` before the first successful
	 * {@link read}, and still the last stage measured after a read whose scan failed — a one-off
	 * storage fault must not disarm the gates.
	 */
	stage(): StoragePressureStage {
		return this.lastStage;
	}

	/**
	 * The thresholds this reading was built with. The ring decision's `moveOut` / `moveIn` are read
	 * from here at construction (`libp2p-node-base.ts`), so the resolved
	 * `storageAllotment.thresholds` reach that decision as part of the reading that names stages from
	 * them rather than as a second copy threaded beside it.
	 */
	configuredThresholds(): StoragePressureThresholds {
		return this.thresholds;
	}

	/**
	 * Sample the account and answer the stage, logging one line when the stage CHANGED. Never
	 * rejects: a scan that failed keeps the last known stage and is logged, because only an absent
	 * `totalBytes` from a SUCCESSFUL scan means `unknown`.
	 *
	 * Joins the read in flight rather than starting a second: both would be served the same memoized
	 * scan, and two reads of one sample must not log the stage change twice.
	 */
	read(): Promise<StoragePressureReading> {
		this.reading ??= this.readOnce().finally(() => { this.reading = undefined; });
		return this.reading;
	}

	/** Arm the first sample after `firstSampleDelayMs`, then each later one `sampleIntervalMs` after the previous ENDS. */
	start(): void {
		if (this.stopped || this.scheduled) {
			return;
		}
		this.scheduled = true;
		this.arm(this.firstSampleDelayMs);
	}

	/** Clear the timer, refuse further samples, and wait for the one in flight. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		await this.reading?.then(noop, noop);
	}

	/**
	 * Replaces whatever timer is pending rather than adding to it, for the reason
	 * `BlobReclaimPass.arm` gives: a consumer's `read()` re-arms from here while the schedule's timer
	 * is still pending, and an arm that only overwrote the canceller would leave the earlier timer
	 * live, un-cancellable, and sampling on its own.
	 */
	private arm(delayMs: number): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		if (this.stopped) {
			return;
		}
		this.cancelTimer = this.setTimer(() => {
			this.cancelTimer = undefined;
			// `read()` never rejects, so there is nothing here to catch.
			void this.read();
		}, delayMs);
	}

	private async readOnce(): Promise<StoragePressureReading> {
		let capacity: StorageCapacity;
		try {
			capacity = await this.account.capacity();
		} catch (error) {
			// Kept rather than demoted to `unknown`: a directory walk over a tree a permission change
			// made unreadable must not turn every gate off. The next sample tries again.
			this.log('pressure:unmeasured stage=%s (kept) - %e', this.lastStage, error);
			this.reschedule();
			return { stage: this.lastStage };
		}
		const stage = pressureStageOf(capacity, this.thresholds);
		if (!this.measured || stage !== this.lastStage) {
			this.logStage(stage, this.measured ? this.lastStage : 'none', capacity);
		}
		this.measured = true;
		this.lastStage = stage;
		// Supplies the trigger the read cache was missing. `request()` logs rather than rejects, and is
		// single-flight with one queued follow-on, so asking every sample costs at most one pass.
		//
		// Caught even though today's trigger cannot throw synchronously, because the re-arm is BELOW it:
		// a trigger that threw would take the sampler down for the life of the node, and every gate
		// would then read a stage frozen at whatever it last measured. One subsystem's fault must not
		// disarm the node's reading of its own disk.
		if (atLeastPressure(stage, 'shedding')) {
			try {
				this.requestCacheEnforcement?.();
			} catch (error) {
				this.log('pressure:enforcement-refused stage=%s - %e', stage, error);
			}
		}
		this.reschedule();
		return { stage, capacity };
	}

	/** Each sample re-arms the next `sampleIntervalMs` after this one ENDS, so samples never overlap. */
	private reschedule(): void {
		if (this.scheduled) {
			this.arm(this.sampleIntervalMs);
		}
	}

	private logStage(stage: StoragePressureStage, from: StoragePressureStage | 'none', capacity: StorageCapacity): void {
		const fraction = usedFractionOf(capacity);
		this.log('pressure:stage stage=%s from=%s usedBytes=%d totalBytes=%s fraction=%s threshold=%s',
			stage,
			from,
			capacity.usedBytes,
			capacity.totalBytes ?? 'unknown',
			fraction === undefined ? 'unknown' : fraction.toFixed(4),
			thresholdCrossed(stage, this.thresholds));
	}
}

/** Which threshold puts the node at `stage`, for the stage-change line. `steady` is a band, so it names both ends. */
function thresholdCrossed(stage: StoragePressureStage, thresholds: StoragePressureThresholds): string {
	switch (stage) {
		case 'unknown': return 'none(no allotment configured and this backend reports no free space)';
		case 'slack': return `below reclaimBelow=${thresholds.reclaimBelow}`;
		case 'steady': return `within reclaimBelow=${thresholds.reclaimBelow}..shedAbove=${thresholds.shedAbove}`;
		case 'shedding': return `above shedAbove=${thresholds.shedAbove}`;
		case 'refusing': return `above refuseAbove=${thresholds.refuseAbove}`;
	}
}

function noop(): void {
	// Waiting for a sample to end, not for what it found.
}
