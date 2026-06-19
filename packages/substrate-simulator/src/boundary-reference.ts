import { Metrics } from './metrics.js';
import { DEFAULT_LIFECYCLE_CONFIG } from './topic-tree.js';
import { runConvergence, expectedDepth } from './promotion-convergence.js';
import {
	findBoundary,
	recordBoundary,
	type EnvelopeBoundary,
	type BoundaryAxisSpec
} from './boundary.js';

/**
 * The **reference** operating-envelope boundary for `simulator-envelope-core`: one real, cheap axis
 * that proves the generic `findBoundary` harness end-to-end against a live driver before the heavier
 * subsystem axes (`simulator-envelope-tree`/`-churn`/`-reactivity`/`-matchmaking`) land. It pairs the
 * central cohort-topic claim `root-not-overloaded` (the tier-0 cohort stays within its promotion cap)
 * with the **arrivals-per-gossip-round** stress axis `R`, driven entirely by the existing
 * `runConvergence` validator on the virtual clock — no full-tree `register` growth, so it stays fast.
 *
 * Why this is the reference: it reuses `runConvergence` (one driven run per evaluation, deterministic
 * from `(seed, config, R)`), the harm is monotone (more arrivals per round ⇒ a bigger gossip-lagged
 * pile-up on the still-cold root before promotion cascades ⇒ the tree fails to reach its full
 * steady-state depth), and the margin is naturally expressed against `cap_promote`. Everything is
 * synchronous and seeded, so the `no-real-time`/`determinism` guarantees continue to hold.
 *
 * Like `simulator-envelope-tree`, this is *new measurement* over an existing model — it adds no tree
 * behaviour, only a `holds(R)` predicate over `runConvergence`'s readout. It deliberately lives beside
 * `boundary.ts` rather than inside it: `boundary.ts` stays generic (the `holds` callback its only
 * extension point), and this module supplies the one subsystem-specific evaluator the core ticket
 * owns, exactly as the four sibling `boundary-*` modules supply theirs.
 */

const GOSSIP_ROUND_MS = 1000;

export interface ReferenceBoundaryOptions {
	/** Population for the convergence runs. Default 2000 — expected depth 2, cheap (virtual clock). */
	readonly N?: number;
	/**
	 * Above this N the reference boundary is skipped (the skip is recorded), mirroring how `sweep.ts`
	 * gates its full-tree measurements: a cheap N runs by default, large N is opt-in. The finder makes
	 * O(log range) `runConvergence` calls, so a large N multiplies that cost. Default 100_000.
	 */
	readonly referenceSampleMaxN?: number;
	/** Fan-out per tier (default 16). */
	readonly F?: number;
	/** Direct-participant promotion cap (default 64) — also the margin reference (`designAssumption`). */
	readonly capPromote?: number;
	readonly seed?: number;
	/** Scan floor for the arrivals-per-round axis (a rate expected to hold). Default 8. */
	readonly loArrivalsPerRound?: number;
	/** Scan ceiling (a rate expected to fail). Default N — a single-round burst collapses the depth. */
	readonly hiArrivalsPerRound?: number;
}

/** The reference boundary plus its metrics sink and the N-gate skip list (mirrors `TreeBoundaryReport`). */
export interface ReferenceBoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
	/** Non-empty (`['arrivalsPerRound']`) when N exceeded `referenceSampleMaxN` and the axis was skipped. */
	readonly skipped: string[];
}

/**
 * The `root-not-overloaded` claim evaluated at arrivals-per-round `R`: `holds(R)` runs one gossip-lagged
 * convergence scenario (`runConvergence`, lookahead **off** so the lag — and thus the overshoot — is
 * real) and returns whether
 *
 *   1. the tier-0 promotion-window overshoot stays within one round of arrivals (`peakOvershoot ≤ R`),
 *      the one-round admission-buffer invariant the convergence fold-back established — structurally
 *      satisfied by this driver, carried here as an explicit sanity guard; **and**
 *   2. the tree still reaches its closed-form steady-state depth `⌈log_F(N/cap)⌉`.
 *
 * Condition 2 is the active edge: as `R` grows, more arrivals land on the still-cold root within one
 * gossip round before the lagged promotion fires, so an ever-larger fraction never routes deeper and
 * the tree settles shallow — depth first drops below the law at the edge `R*`. Harm is monotone in `R`
 * across the scanned bracket (an isolated sub-bracket interleaving artifact can dip depth for a single
 * `R` far below the edge, but the geometric scan steps over it, so the located edge is unaffected).
 */
export function rootOverloadAxis(
	opts: Required<Pick<ReferenceBoundaryOptions, 'N' | 'F' | 'capPromote' | 'seed' | 'loArrivalsPerRound' | 'hiArrivalsPerRound'>>
): BoundaryAxisSpec {
	const { N, F, capPromote, seed, loArrivalsPerRound, hiArrivalsPerRound } = opts;
	const expected = expectedDepth(N, F, capPromote);
	return {
		claim: 'root-not-overloaded',
		axis: 'arrivalsPerRound',
		// Margin reference = cap_promote: the overshoot analysis is naturally expressed relative to the
		// cap (overshoot < R, = 0 exactly when R divides cap_promote; the admission buffer is sized for
		// cap_promote + one round). The doc's nominal storm rate is the rejected alternative — it is
		// N/window-dependent and so a less stable reference. R* and margin = R* − cap_promote are
		// measured outputs, never hard-coded.
		designAssumption: capPromote,
		monotoneDirection: 'increasing-harm',
		lo: loArrivalsPerRound,
		hi: hiArrivalsPerRound,
		integer: true,
		holds(R: number): boolean {
			const r = runConvergence({
				N,
				F,
				capPromote,
				arrivalsPerRound: R,
				lookahead: false,
				gossipRoundMs: GOSSIP_ROUND_MS,
				seed
			});
			const overshootWithinRound = r.peakOvershoot <= R;
			const depthHoldsLaw = r.steadyStateDepth === expected;
			return overshootWithinRound && depthHoldsLaw;
		}
	};
}

/**
 * Locate the reference `root-not-overloaded` × `arrivalsPerRound` boundary and fold it into a `Metrics`
 * sink via `recordBoundary`. Gated by N exactly as `sweep.ts` gates its full-tree work: when
 * `N > referenceSampleMaxN` the axis is skipped and the skip recorded (`boundary.skipped` counter + the
 * returned `skipped` list). Deterministic from `(seed, config)`.
 */
export function runReferenceBoundary(opts: ReferenceBoundaryOptions = {}): ReferenceBoundaryReport {
	const N = opts.N ?? 2000;
	const referenceSampleMaxN = opts.referenceSampleMaxN ?? 100_000;
	const F = opts.F ?? DEFAULT_LIFECYCLE_CONFIG.F;
	const capPromote = opts.capPromote ?? DEFAULT_LIFECYCLE_CONFIG.capPromote;
	const seed = opts.seed ?? 1;
	const loArrivalsPerRound = opts.loArrivalsPerRound ?? 8;
	const hiArrivalsPerRound = opts.hiArrivalsPerRound ?? N;

	const metrics = new Metrics();
	const boundaries: EnvelopeBoundary[] = [];
	const skipped: string[] = [];

	if (N > referenceSampleMaxN) {
		skipped.push('arrivalsPerRound');
		metrics.counter('boundary.skipped', 1, { axis: 'arrivalsPerRound' });
		return { boundaries, metrics, skipped };
	}

	const b = findBoundary(
		rootOverloadAxis({ N, F, capPromote, seed, loArrivalsPerRound, hiArrivalsPerRound })
	);
	recordBoundary(metrics, b);
	boundaries.push(b);
	return { boundaries, metrics, skipped };
}
