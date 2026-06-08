/**
 * Cohort-topic substrate — capacity barometer.
 *
 * Transcribed from `docs/cohort-topic.md` §Capacity barometer (and folded back from the
 * simulator-validated `packages/substrate-simulator/src/willingness.ts`). A cohort member tracks a
 * coarse **3-bit (0..7) log-bucketed utilization** per tier (T0..T3). The barometer feeds two
 * decisions:
 *
 * 1. **Willingness-bit refresh.** When a tier's bucket reaches `overloadBucket` the member sheds
 *    that tier — its load-driven willingness bit flips off until utilization recedes. Siblings see
 *    the flip within one gossip round (the bit rides `CohortGossipV1.willingnessBits`).
 * 2. **Early-promote signal.** `bucket ≥ overloadBucket` (default 6, the `bucket_overload` of
 *    §Configuration) is the "cohort is hot at this tier" signal the promotion ticket consumes to
 *    fire promotion earlier than the strict `cap_promote`. This module only *exposes* the signal;
 *    it does not itself promote.
 *
 * The barometer is **not** aggregated across the tree — children promote independently, so a member
 * only ever observes its own per-tier utilization here. The 3-bit buckets (× 4 tiers) plus the
 * willingness bit fit in 16 bits of cohort gossip; the cost is negligible.
 */

import { ALL_TIERS, type Tier } from "../tiers.js";

/** A single tier's coarse load reading, as carried in cohort gossip. */
export interface LoadBarometer {
	readonly tier: Tier;
	/** 0..7, log-bucketed utilization (see {@link utilizationBucket}). */
	readonly bucket: number;
}

/**
 * Load-barometer bucket at/above which a member sheds a tier (willingness flips off) and the cohort
 * is considered hot enough to promote early. `bucket_overload` in `docs/cohort-topic.md`
 * §Configuration; simulator-confirmed at 6.
 */
export const DEFAULT_OVERLOAD_BUCKET = 6;

/**
 * Map a utilization ratio (`load / capacity`, where `1.0` = at capacity) to a 0..7 log bucket.
 *
 * Each bucket spans a doubling of utilization, anchored so the top of the range is at-capacity:
 *
 * | bucket | utilization range |
 * |--------|-------------------|
 * | 7      | `u ≥ 1.0`         |
 * | 6      | `[0.5, 1.0)`      |
 * | 5      | `[0.25, 0.5)`     |
 * | …      | …                 |
 * | 1      | `[1/64, 1/32)`    |
 * | 0      | `u < 1/64` (incl. 0, negative clamped) |
 *
 * Monotonic non-decreasing in `u`; `bucket = clamp(7 + ⌊log₂ u⌋, 0, 7)`. With the default
 * `overloadBucket = 6`, a member sheds a tier once utilization reaches half capacity.
 */
export function utilizationBucket(utilization: number): number {
	if (!(utilization > 0)) {
		return 0; // zero, negative, or NaN → idle
	}
	const b = 7 + Math.floor(Math.log2(utilization));
	if (b < 0) return 0;
	if (b > 7) return 7;
	return b;
}

/** Mutable per-tier capacity barometer for one cohort member. */
export interface LoadBarometerState {
	/** Record this member's current utilization (`load / capacity`) for `tier`. */
	observe(tier: Tier, utilization: number): void;
	/** Current 0..7 bucket for `tier`. */
	bucket(tier: Tier): number;
	/** `{ tier, bucket }` reading for `tier`. */
	reading(tier: Tier): LoadBarometer;
	/** All four buckets (T0..T3), the array gossiped in `CohortGossipV1.loadBuckets`. */
	loadBuckets(): number[];
	/**
	 * Early-promote / shed signal: `bucket(tier) ≥ overloadBucket`. True means the member is hot at
	 * `tier` — its load-driven willingness bit is off and the promotion layer may promote early.
	 */
	isOverloaded(tier: Tier): boolean;
	/** Load-driven willingness bit for `tier`: `!isOverloaded(tier)`. (Profile/budget gates live in the willingness check.) */
	loadWilling(tier: Tier): boolean;
}

export interface LoadBarometerConfig {
	/** Bucket at/above which a tier is shed and flagged hot. Default {@link DEFAULT_OVERLOAD_BUCKET}. */
	overloadBucket?: number;
}

class ArrayLoadBarometer implements LoadBarometerState {
	private readonly buckets: number[] = [0, 0, 0, 0];
	private readonly overloadBucket: number;

	constructor(config?: LoadBarometerConfig) {
		const ob = config?.overloadBucket ?? DEFAULT_OVERLOAD_BUCKET;
		if (!Number.isInteger(ob) || ob < 1 || ob > 7) {
			throw new RangeError(`overloadBucket must be an integer in [1, 7], got ${ob}`);
		}
		this.overloadBucket = ob;
	}

	observe(tier: Tier, utilization: number): void {
		this.buckets[tier] = utilizationBucket(utilization);
	}

	bucket(tier: Tier): number {
		return this.buckets[tier]!;
	}

	reading(tier: Tier): LoadBarometer {
		return { tier, bucket: this.buckets[tier]! };
	}

	loadBuckets(): number[] {
		return [...this.buckets];
	}

	isOverloaded(tier: Tier): boolean {
		return this.buckets[tier]! >= this.overloadBucket;
	}

	loadWilling(tier: Tier): boolean {
		return !this.isOverloaded(tier);
	}
}

/** Construct an idle (all-bucket-0) {@link LoadBarometerState}. */
export function createLoadBarometer(config?: LoadBarometerConfig): LoadBarometerState {
	return new ArrayLoadBarometer(config);
}

/** Iterate the four tiers — convenience for callers folding the barometer into a gossip frame. */
export function eachTier(): readonly Tier[] {
	return ALL_TIERS;
}
