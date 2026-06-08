import type { VTime } from './types.js';
import type { WalkTrace } from './walk.js';

/**
 * Anti-flood instrumentation over a batch of `WalkTrace`s, modeled against `docs/cohort-topic.md`
 * §Anti-flood properties. These are pure aggregate readouts the claim tests assert on — distinct
 * start-coord fan-out (claim 1), hop-count percentiles (the O(log N) lookup cost), accepted-rate
 * curves (claims 2 + 5), and the single-direction / inward-restart structural checks (claims 3 + 4).
 * No clock, no randomness — they read finished traces.
 */

/** Traces that attached (accepted or cold-root); the rate/landing readouts ignore give-ups. */
function accepted(traces: readonly WalkTrace[]): WalkTrace[] {
	return traces.filter((t) => t.outcome === 'accepted' || t.outcome === 'cold-root');
}

/**
 * Distinct `coord_{d_max}` start coordinates across the batch (cohort-topic.md §Anti-flood claim 1).
 * In the sparse regime each participant's `d_max` coord differs by peer-ID prefix, so this
 * approaches the participant count — the walks fan across the ring rather than colliding at one coord.
 */
export function distinctStartCoords(traces: readonly WalkTrace[]): number {
	return new Set(traces.map((t) => t.startCoord)).size;
}

/** Accepts bucketed by whole virtual second (`⌊acceptedAt / 1000⌋` → count). */
export function acceptedPerSecond(traces: readonly WalkTrace[]): Map<number, number> {
	const perSecond = new Map<number, number>();
	for (const t of accepted(traces)) {
		if (t.acceptedAt === undefined) {
			continue;
		}
		const s = Math.floor(t.acceptedAt / 1000);
		perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
	}
	return perSecond;
}

/** Peak accepts in any single whole virtual second — the spike a re-registration burst would cause. */
export function peakAcceptedPerSecond(traces: readonly WalkTrace[]): number {
	const perSecond = acceptedPerSecond(traces);
	let peak = 0;
	for (const n of perSecond.values()) {
		if (n > peak) {
			peak = n;
		}
	}
	return peak;
}

/**
 * Maximum accepts whose `acceptedAt` fall within any sliding window of length `windowMs`
 * (cohort-topic.md §Anti-flood claim 2: inbound rate at the recovering cohort over `T_rejoin_jitter`).
 * A two-pointer sweep over the sorted accept times — the exact peak windowed inbound count.
 */
export function peakAcceptedInWindow(traces: readonly WalkTrace[], windowMs: VTime): number {
	const times = accepted(traces)
		.map((t) => t.acceptedAt)
		.filter((t): t is VTime => t !== undefined)
		.sort((a, b) => a - b);
	let peak = 0;
	let lo = 0;
	for (let hi = 0; hi < times.length; hi++) {
		while (times[hi]! - times[lo]! >= windowMs) {
			lo++;
		}
		const inWindow = hi - lo + 1;
		if (inWindow > peak) {
			peak = inWindow;
		}
	}
	return peak;
}

/** Accepts that landed at a specific tier — e.g. the count a bursting cohort absorbed before promoting. */
export function acceptedAtTier(traces: readonly WalkTrace[], tier: number): number {
	return accepted(traces).reduce((n, t) => (t.landingTier === tier ? n + 1 : n), 0);
}

/**
 * The `p`-th percentile (0..100) of hop counts across the batch, nearest-rank. Used to characterize
 * lookup cost: in the hot regime p50/p95 stay at 1–2 (resolve at `d_max` without touching the root);
 * the cold worst case is `d_max + 2` (probe every tier inward, then bootstrap) — i.e. O(log_F N).
 */
export function hopPercentile(traces: readonly WalkTrace[], p: number): number {
	if (p < 0 || p > 100) {
		throw new RangeError(`percentile must be in [0, 100], got ${p}`);
	}
	const hops = traces.map((t) => t.hops).sort((a, b) => a - b);
	if (hops.length === 0) {
		return 0;
	}
	const rank = Math.ceil((p / 100) * hops.length);
	const idx = Math.min(hops.length - 1, Math.max(0, rank - 1));
	return hops[idx]!;
}

/**
 * Claim 3 — no speculative outward probe. Every probe that moved to a *deeper* tier than its
 * predecessor must have been preceded by a `Promoted` reply; the walk never probes outward on a
 * guess. Returns `true` iff the trace satisfies this for every step.
 */
export function outwardMovesArePromoted(trace: WalkTrace): boolean {
	for (let i = 1; i < trace.probes.length; i++) {
		if (trace.probes[i]!.tier > trace.probes[i - 1]!.tier && trace.probes[i - 1]!.reply !== 'promoted') {
			return false;
		}
	}
	return true;
}

/**
 * Claim 4 — inward retry restarts at `d_max`. Every probe immediately following an `unwilling_cohort`
 * reply must re-start the walk at `startTier` (`d_max`), never re-hit the declined coord. Returns
 * `true` iff every post-`UnwillingCohort` retry in the trace restarts at the top.
 */
export function unwillingRetriesRestartAtDMax(trace: WalkTrace): boolean {
	for (let i = 0; i < trace.probes.length - 1; i++) {
		if (trace.probes[i]!.reply === 'unwilling_cohort' && trace.probes[i + 1]!.tier !== trace.startTier) {
			return false;
		}
	}
	return true;
}
