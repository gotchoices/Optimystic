/**
 * Reactivity — configuration defaults (single source for the hot path).
 *
 * Transcribed from `docs/reactivity.md` §Configuration. Every tunable the reactivity hot path reads
 * is sourced from {@link DEFAULT_REACTIVITY_CONFIG} — never hard-coded at a call site — so the
 * simulator fold-back ([fold-simulator-findings-into-design-docs]) can retune `W` / `dedupe_window`
 * without touching origination, forwarding, the replay buffer, or delivery.
 *
 * **Simulator-validated-pending.** `W` (replay buffer depth), `dedupe_window`, `T_drain`, `queue_max`,
 * and `block_fill_size` are *provisional* pending the design simulator ([simulator-reactivity-replay],
 * folded back by [fold-simulator-findings-into-design-docs]). The simulator's REVISED guidance is that `W`
 * SHOULD become adaptive per measured commit-rate on hot collections (`W ≈ ⌈min_coverage × cps⌉`); the
 * static `W = 256` is kept as the Edge/low-rate default. {@link resolveW} exposes that hook; the
 * simulator's tail-rotation scenario also confirms the re-registration burst stays inside
 * `cap_promote_fast` within `T_drain`, and flags whether `queue_max` should scale with cohort size/tier
 * ({@link resolveQueueMax} is the parallel hook for that fold-back). Sourcing every tunable from this
 * single table is what lets the fold-back revise the values without touching the protocol code.
 *
 * Ownership: `W` / `dedupe_window` ← [reactivity-origination-replay-delivery]; `W_checkpoint` ←
 * [reactivity-backfill-resume-checkpoints]; `queue_max` / `delta_max` / `T_drain` / `warm_threshold` /
 * `block_fill_size` ← [reactivity-rotation-backpressure-policy] (this ticket). `T_rejoin_jitter`, TTL, and
 * ping are inherited from the cohort-topic defaults.
 */

import type { NodeProfile } from "../cohort-topic/tiers.js";
import { DEFAULT_T_REJOIN_JITTER_MS } from "../cohort-topic/antiflood/jitter.js";

/** Replay buffer depth (revisions per cohort, per collection). Simulator-validated-pending. */
export const W_DEFAULT = 256;
/** Sliding dedupe-window size (revisions). Simulator-validated-pending. */
export const DEDUPE_WINDOW_DEFAULT = 64;
/** Parent-checkpoint span (revisions). Owned by the backfill/resume ticket; default carried here. */
export const W_CHECKPOINT_DEFAULT = 4096;
/** Per-subscriber bounded queue depth at a forwarder. Simulator-validated-pending (may scale with cohort/tier). */
export const QUEUE_MAX_DEFAULT = 32;
/** Max delta payload size on a Core node (bytes). */
export const DELTA_MAX_CORE_BYTES = 4096;
/** Max delta payload size on an Edge node (bytes) — Edge declines deltas (`0` ⇒ omit `delta`). */
export const DELTA_MAX_EDGE_BYTES = 0;
/** Subscriber registration TTL on a Core node (ms), inherited from cohort-topic. */
export const SUBSCRIBER_TTL_CORE_MS = 90_000;
/** Subscriber registration TTL on an Edge node (ms), inherited from cohort-topic. */
export const SUBSCRIBER_TTL_EDGE_MS = 60_000;
/** Transactions per block — drives tail rotation. Simulator-validated-pending. */
export const BLOCK_FILL_SIZE_DEFAULT = 64;
/** Old-tail drain time after rotation (ms). Simulator-validated-pending. */
export const T_DRAIN_MS = 60_000;
/** Transactions remaining in tail before anticipatory warm-up. Owned by the rotation ticket. */
export const WARM_THRESHOLD_DEFAULT = 8;
/** Subscriber re-registration jitter span after a rotation hint (ms). Inherited from cohort-topic `T_rejoin_jitter`. */
export const T_REJOIN_JITTER_MS = DEFAULT_T_REJOIN_JITTER_MS;

/** The full reactivity config, with the documented defaults. */
export interface ReactivityConfig {
	/** Replay buffer depth `W`. Simulator-validated-pending. */
	readonly w: number;
	/** Sliding dedupe-window size. Simulator-validated-pending. */
	readonly dedupeWindow: number;
	/** Parent-checkpoint span (reserved; backfill/resume ticket). */
	readonly wCheckpoint: number;
	/** Per-subscriber bounded queue depth (reserved; backpressure ticket). */
	readonly queueMax: number;
	/** Max delta payload size on a Core node (bytes). */
	readonly deltaMaxCoreBytes: number;
	/** Max delta payload size on an Edge node (bytes). */
	readonly deltaMaxEdgeBytes: number;
	/** Subscriber TTL on a Core node (ms). */
	readonly subscriberTtlCoreMs: number;
	/** Subscriber TTL on an Edge node (ms). */
	readonly subscriberTtlEdgeMs: number;
	/** Transactions per block — drives tail rotation. Simulator-validated-pending. */
	readonly blockFillSize: number;
	/** Old-tail drain time after rotation (ms). Simulator-validated-pending. */
	readonly tDrainMs: number;
	/** Transactions remaining before anticipatory warm-up. */
	readonly warmThreshold: number;
	/** Subscriber re-registration jitter span after a rotation (ms); inherited from cohort-topic. */
	readonly tRejoinJitterMs: number;
}

/** The default reactivity config (`docs/reactivity.md` §Configuration). */
export const DEFAULT_REACTIVITY_CONFIG: ReactivityConfig = {
	w: W_DEFAULT,
	dedupeWindow: DEDUPE_WINDOW_DEFAULT,
	wCheckpoint: W_CHECKPOINT_DEFAULT,
	queueMax: QUEUE_MAX_DEFAULT,
	deltaMaxCoreBytes: DELTA_MAX_CORE_BYTES,
	deltaMaxEdgeBytes: DELTA_MAX_EDGE_BYTES,
	subscriberTtlCoreMs: SUBSCRIBER_TTL_CORE_MS,
	subscriberTtlEdgeMs: SUBSCRIBER_TTL_EDGE_MS,
	blockFillSize: BLOCK_FILL_SIZE_DEFAULT,
	tDrainMs: T_DRAIN_MS,
	warmThreshold: WARM_THRESHOLD_DEFAULT,
	tRejoinJitterMs: T_REJOIN_JITTER_MS,
};

/** `delta_max` for a node profile: Core admits deltas up to `delta_max`, Edge declines them (`0`). */
export function deltaMaxForProfile(profile: NodeProfile, config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG): number {
	return profile.kind === "edge" ? config.deltaMaxEdgeBytes : config.deltaMaxCoreBytes;
}

/** Subscriber TTL for a node profile (`docs/reactivity.md` §Subscription): Core 90 s / Edge 60 s. */
export function subscriberTtlForProfile(profile: NodeProfile, config: ReactivityConfig = DEFAULT_REACTIVITY_CONFIG): number {
	return profile.kind === "edge" ? config.subscriberTtlEdgeMs : config.subscriberTtlCoreMs;
}

/**
 * Resolve the replay-buffer depth `W` for a collection.
 *
 * Static default (no `cps`): returns the configured `config.w` unchanged — the simulator-confirmed
 * Edge/low-rate default. Adaptive (a measured `cps` and `minCoverageSeconds`): returns
 * `⌈minCoverageSeconds × cps⌉` clamped to `[config.w, maxW]`, the simulator's REVISED guidance for hot
 * collections. This is the single hook the backfill/resume ticket extends; the hot path here only ever
 * calls the static form, so behavior is unchanged until a `cps` is wired through.
 */
export function resolveW(opts: { cps?: number; minCoverageSeconds?: number; maxW?: number; config?: ReactivityConfig } = {}): number {
	const config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
	if (opts.cps === undefined || opts.minCoverageSeconds === undefined) {
		return config.w;
	}
	if (!Number.isFinite(opts.cps) || opts.cps <= 0 || !Number.isFinite(opts.minCoverageSeconds) || opts.minCoverageSeconds <= 0) {
		return config.w;
	}
	const adaptive = Math.ceil(opts.minCoverageSeconds * opts.cps);
	const maxW = opts.maxW ?? Number.POSITIVE_INFINITY;
	return Math.min(Math.max(config.w, adaptive), maxW);
}

/** Default `W_checkpoint`-to-`W` ratio (`docs/reactivity.md` §Parent checkpoint summaries: 16×). */
export const W_CHECKPOINT_RATIO = 16;

/**
 * Resolve the parent-checkpoint span `W_checkpoint` for a collection.
 *
 * Static default (no `cps`): the configured `config.wCheckpoint` (4096). Adaptive: `W_checkpoint`
 * "scales the same way and may stay a fixed 16× multiple of the resolved `W`" (`docs/reactivity.md`
 * §Configuration), so when a `cps` is supplied it tracks `W_CHECKPOINT_RATIO × resolveW(opts)`. This is
 * the single hook the simulator fold-back ([fold-simulator-findings-into-design-docs]) retunes; the
 * resume classifier reads it so a hot collection's stacked recovery range scales with the replay depth.
 */
export function resolveWCheckpoint(opts: { cps?: number; minCoverageSeconds?: number; maxW?: number; ratio?: number; config?: ReactivityConfig } = {}): number {
	const config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
	if (opts.cps === undefined || opts.minCoverageSeconds === undefined) {
		return config.wCheckpoint;
	}
	const ratio = opts.ratio ?? W_CHECKPOINT_RATIO;
	return resolveW(opts) * ratio;
}

/**
 * Resolve the per-subscriber bounded-queue depth `queue_max` for a cohort.
 *
 * Static default (no scaling input): the configured `config.queueMax` (32). The simulator flags whether
 * `queue_max` should scale with cohort size / tier on hot collections; this is the single hook the
 * fold-back ([fold-simulator-findings-into-design-docs]) retunes. When a `cohortSubscribers` count is
 * supplied, the depth scales as `⌈queue_max × subscribers / scaleBaseline⌉` clamped to `[queueMax, maxQueue]`
 * — never below the static default, optionally capped at a per-cohort memory budget. With no scaling input
 * the hot path is unchanged (constant `queue_max`).
 */
export function resolveQueueMax(opts: { cohortSubscribers?: number; scaleBaseline?: number; maxQueue?: number; config?: ReactivityConfig } = {}): number {
	const config = opts.config ?? DEFAULT_REACTIVITY_CONFIG;
	if (opts.cohortSubscribers === undefined) {
		return config.queueMax;
	}
	const baseline = opts.scaleBaseline ?? 1;
	if (!Number.isFinite(opts.cohortSubscribers) || opts.cohortSubscribers <= 0 || !(baseline > 0)) {
		return config.queueMax;
	}
	const scaled = Math.ceil((config.queueMax * opts.cohortSubscribers) / baseline);
	const maxQueue = opts.maxQueue ?? Number.POSITIVE_INFINITY;
	return Math.min(Math.max(config.queueMax, scaled), maxQueue);
}
