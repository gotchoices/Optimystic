/**
 * Cohort-topic substrate — anti-flood structural invariants (centralized for the e2e suite).
 *
 * Transcribed from `docs/cohort-topic.md` §Anti-flood properties. Three of the five named floods are
 * defended *by construction* in the walk / promotion machinery already; this module does not
 * re-implement that machinery — it provides pure, dependency-free predicates over a recorded walk
 * trace so the unit and e2e suites can assert the invariants hold on the real engine's behaviour,
 * the same way `packages/substrate-simulator/src/walk-metrics.ts` instruments
 * `outwardMovesArePromoted` / `unwillingRetriesRestartAtDMax` on the simulator side.
 *
 * The caller records one {@link WalkProbe} per probe RPC the {@link import("../walk.js").WalkEngine}
 * issues (its `treeTier` and the reply `result`), grouping the probes of one
 * {@link import("../walk.js").WalkEngine.register} call into a {@link WalkTrace}. The predicates then
 * check the anti-flood discipline:
 *
 * - **claim 3 — no speculative outward probe:** {@link outwardMovesArePromoted}. The only tier
 *   *increase* between consecutive probes is one taken immediately after a `promoted` reply.
 * - **walk discipline — inward only on `no_state`:** {@link inwardStepsFollowNoState}. Every single
 *   tier *decrease* is the response to a `no_state` (no inward move on any other reply).
 * - **claim 4 — inward retry restarts at `d_max`:** {@link retriesRestartAtDMax}. A fresh walk (the
 *   restart after an `unwilling_cohort` / cohort-level back-off) begins at `d_max`, never re-hitting
 *   the declined coord.
 * - **claim 5 — sticky promotion:** {@link DEFAULT_T_PROMOTE_STICKY_MS} re-exported as the canonical
 *   sticky window; the promotion lifecycle (`promotion.ts`) enforces it and `promotion.spec.ts`
 *   covers the no-flap behaviour. {@link stickyHolds} is the predicate the e2e suite uses to confirm
 *   a freshly-promoted cohort refuses demotion within the window.
 */

import type { RegisterResult } from "../wire/types.js";
import { DEFAULT_T_PROMOTE_STICKY_MS } from "../promotion.js";

export { DEFAULT_T_PROMOTE_STICKY_MS };

/** One probe RPC in a walk: the tier it was issued at and the reply result it drew. */
export interface WalkProbe {
	/** Walk position `d` the probe was issued at. */
	readonly treeTier: number;
	/** The cohort reply classification. */
	readonly result: RegisterResult;
}

/** The ordered probe log of a single {@link import("../walk.js").WalkEngine.register} call. */
export interface WalkTrace {
	/** `d_max` the walk started from. */
	readonly dMax: number;
	/** Probes in issue order. */
	readonly probes: readonly WalkProbe[];
}

/**
 * Claim 3 (no speculative outward probe): every tier *increase* between consecutive probes is taken
 * only in response to a `promoted` redirect on the preceding probe. Any outward move not preceded by
 * `promoted` is a speculative deeper probe — the flood this invariant forbids.
 */
export function outwardMovesArePromoted(trace: WalkTrace): boolean {
	const { probes } = trace;
	for (let i = 1; i < probes.length; i++) {
		const moveOutward = probes[i]!.treeTier > probes[i - 1]!.treeTier;
		if (moveOutward && probes[i - 1]!.result !== "promoted") {
			return false;
		}
	}
	return true;
}

/**
 * Walk discipline: every single inward step (`treeTier` decreased by exactly 1, or reset to 0 at the
 * root cold-start) is the response to a `no_state`. The walk never moves toward the root on any other
 * reply, so inward traffic is one-hop-per-`no_state`, not a storm.
 */
export function inwardStepsFollowNoState(trace: WalkTrace): boolean {
	const { probes } = trace;
	for (let i = 1; i < probes.length; i++) {
		const moveInward = probes[i]!.treeTier < probes[i - 1]!.treeTier;
		if (moveInward && probes[i - 1]!.result !== "no_state") {
			return false;
		}
	}
	return true;
}

/**
 * Claim 4 (inward retry restarts at `d_max`): each fresh walk in a re-registration sequence starts at
 * its `d_max`, so a participant that drew `unwilling_cohort` backs off in *time* and re-walks from the
 * top rather than re-hitting the declined coord. `traces` are consecutive `register` calls by one
 * participant; the first probe of each must sit at that walk's `d_max`.
 */
export function retriesRestartAtDMax(traces: readonly WalkTrace[]): boolean {
	for (const trace of traces) {
		const first = trace.probes[0];
		if (first === undefined) {
			continue;
		}
		if (first.treeTier !== trace.dMax) {
			return false;
		}
	}
	return true;
}

/**
 * Claim 5 (sticky promotion): a cohort promoted at `promotedAt` must not be reconsidered for demotion
 * before `promotedAt + stickyMs`. Returns whether `now` is still inside the sticky window — the e2e
 * suite asserts the promotion lifecycle refuses demotion exactly while this is `true`.
 */
export function stickyHolds(promotedAt: number, now: number, stickyMs: number = DEFAULT_T_PROMOTE_STICKY_MS): boolean {
	return now - promotedAt < stickyMs;
}
