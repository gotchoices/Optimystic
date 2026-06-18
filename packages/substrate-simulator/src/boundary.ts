import type { Metrics } from './metrics.js';

/**
 * The validity-envelope finder — the simulator's **third** validation mode, alongside the
 * absolute-target scenario checks (`scenarios.ts`) and the relationship/monotonicity sweep
 * (`sweep.ts`). Where the scenarios answer *"does the claim hold at the nominal point"* and the
 * sweep answers *"which direction does this parameter move the metric"*, this harness answers
 * *"how far can a worsening condition be pushed before the claim flips pass→fail, and how much
 * margin is there to the operating point the design assumes."* The headline output is the
 * **margin**, not the pass/fail (parent ticket `simulator-validity-envelope`).
 *
 * The finder drives a single **stress axis** that is monotone-in-harm (larger value ⇒ strictly
 * more stress on the claim) against an otherwise-nominal config: it scans the axis to bracket the
 * pass→fail transition, then bisects to locate the edge. Every evaluation is a fresh run
 * deterministic from `(seed, config, axisValue)` — scan/bisect run on the virtual clock only, no
 * wall-clock, no randomness outside the seeded rng — so the `no-real-time`/`determinism`
 * guarantees continue to hold.
 *
 * `holds(value)` is the ONLY subsystem-specific extension point; the subsystem boundary tickets
 * (`simulator-envelope-tree`, `-churn`, `-reactivity`, `-matchmaking`) supply per-axis evaluators
 * and reuse `findBoundary`/`EnvelopeBoundary` unchanged. Nothing tree/reactivity/matchmaking
 * specific is baked in here.
 */

/** A claim's measured operating-envelope edge along one stress axis (parent ticket §What a boundary readout looks like). */
export interface EnvelopeBoundary {
	readonly claim: string; // e.g. 'root-not-overloaded'
	readonly axis: string; // e.g. 'arrivalsPerRound'
	/** Last axis value at which the claim still held — the envelope edge. */
	readonly criticalValue: number;
	/** The operating point the design assumes (from the doc / DEFAULT_*). */
	readonly designAssumption: number;
	/** criticalValue − designAssumption. > 0 ⇒ the design sits inside the envelope. */
	readonly margin: number;
	/** criticalValue / designAssumption (NaN when designAssumption === 0) — the slack as a ratio. */
	readonly marginRatio: number;
	/** > 0 ⇒ design point is inside the envelope (margin > 0). */
	readonly designInsideEnvelope: boolean;
	readonly monotoneDirection: 'increasing-harm' | 'decreasing-harm';
	/** false ⇒ the claim held across the entire scanned range; criticalValue is then a *lower bound* (= scanHi). */
	readonly boundaryFound: boolean;
	/** true ⇒ a pass was observed at a value past an observed fail — the axis is not actually monotone-in-harm (finding is suspect). */
	readonly monotoneViolated: boolean;
	readonly scanLo: number;
	readonly scanHi: number;
	/** Count of holds() evaluations performed (cost transparency). */
	readonly evaluations: number;
}

/** Caller-supplied per-axis definition; `holds` is the only subsystem-specific part. */
export interface BoundaryAxisSpec {
	readonly claim: string;
	readonly axis: string;
	readonly designAssumption: number;
	readonly monotoneDirection?: 'increasing-harm' | 'decreasing-harm'; // default 'increasing-harm'
	readonly lo: number; // scan floor (expected to hold; if it already fails, margin < 0 is reported)
	readonly hi: number; // scan ceiling (cap on the search; if it still holds, boundaryFound=false)
	readonly integer: boolean; // integer-resolution axis (counts) vs real-valued (ratios/fractions)
	readonly tolerance?: number; // bisection stop width for real axes (default 1e-3 * (hi−lo))
	/** Evaluate the target claim at one axis value: true ⇒ claim holds. Must be deterministic. */
	holds(value: number): boolean;
}

/** A batch of boundary readouts plus the metrics sink they were folded into. */
export interface BoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
}

/** Default real-axis bisection stop width as a fraction of the scanned range. */
const DEFAULT_REAL_TOLERANCE_FRACTION = 1e-3;
/** Below this integer span the bracket scan steps linearly (1 at a time); above it, geometrically. */
const LINEAR_INT_THRESHOLD = 64;
/** First real-axis bracket step as a fraction of the range when starting from the scan floor. */
const REAL_FIRST_STEP_FRACTION = 1 / 64;
/** Hard cap on bracket-scan probes — a runaway/non-terminating `holds` backstop. */
const MAX_SCAN_STEPS = 1024;

/**
 * Locate the operating-envelope edge for one stress axis. Scans the axis in **harm-ascending**
 * order (for `increasing-harm`, that is the value order `lo → hi`; for `decreasing-harm` the
 * search is internally reflected so the same scanner applies), brackets the first pass→fail
 * transition, then bisects it. Three open-bracket cases are reported explicitly rather than
 * silently mis-reported:
 *
 *  - **Claim already fails at `lo`** (design outside the envelope) → `criticalValue < lo`,
 *    `margin < 0`, `designInsideEnvelope = false`. Never throws — the negative margin is the
 *    regression-detector signal.
 *  - **Claim still holds at `hi`** (margin larger than the scanned range) → `boundaryFound = false`,
 *    `criticalValue = hi` documented as a *lower bound*, not the true edge.
 *  - **Non-monotone predicate** (a pass observed at a harmier value than an observed fail) →
 *    `monotoneViolated = true`; the first-fail edge is still returned so the caller knows the axis
 *    assumption was violated rather than trusting a wrong number.
 *
 * `criticalValue` is the *last value that still holds*, not the first that fails. Cost is
 * O(log(range)) `holds` evaluations (geometric bracket + bisection), surfaced as `evaluations`.
 */
export function findBoundary(spec: BoundaryAxisSpec): EnvelopeBoundary {
	const direction = spec.monotoneDirection ?? 'increasing-harm';
	if (!(spec.hi > spec.lo)) {
		throw new RangeError(`scan ceiling hi (${spec.hi}) must exceed floor lo (${spec.lo})`);
	}
	const reflect = direction === 'decreasing-harm';
	// Map the harm-ascending coordinate `h ∈ [lo, hi]` back to the caller's axis value. For
	// increasing-harm the two coincide; for decreasing-harm harm rises as the value falls, so the
	// coordinate is reflected about the midpoint and the same ascending scanner is reused.
	const fromHarm = (h: number): number => (reflect ? spec.lo + spec.hi - h : h);
	const tol = spec.tolerance ?? (spec.hi - spec.lo) * DEFAULT_REAL_TOLERANCE_FRACTION;

	let evaluations = 0;
	const holdsH = (h: number): boolean => {
		evaluations++;
		return spec.holds(fromHarm(h));
	};

	// --- bracket scan: probe harm-ascending from lo toward hi, recording each (harm, ok) ---------
	const harms: number[] = [];
	{
		let cur = spec.lo;
		harms.push(cur);
		let steps = 0;
		while (cur < spec.hi && steps < MAX_SCAN_STEPS) {
			cur = stepUp(cur, spec.lo, spec.hi, spec.integer);
			harms.push(cur);
			steps++;
		}
	}
	const oks = harms.map(holdsH);
	const firstFailIdx = oks.findIndex((ok) => !ok);
	const heldThroughout = firstFailIdx === -1;

	// Non-monotone-in-harm: any pass at a harmier value than the first observed fail.
	let monotoneViolated = false;
	if (firstFailIdx !== -1) {
		for (let i = firstFailIdx + 1; i < oks.length; i++) {
			if (oks[i]) {
				monotoneViolated = true;
				break;
			}
		}
	}

	let criticalHarm: number;
	let boundaryFound: boolean;
	if (heldThroughout) {
		// Held to the ceiling — criticalValue is a *lower bound*, not the true edge.
		boundaryFound = false;
		criticalHarm = spec.hi;
	} else if (firstFailIdx === 0) {
		// Fails at the floor — the edge sits below the scanned range. Report a sentinel strictly
		// below lo so the margin goes negative (design outside the envelope) without a throw.
		boundaryFound = true;
		criticalHarm = spec.lo - (spec.integer ? 1 : tol);
	} else {
		boundaryFound = true;
		const aPass = harms[firstFailIdx - 1]!;
		const bFail = harms[firstFailIdx]!;
		criticalHarm = bisectHarm(aPass, bFail, spec.integer, tol, holdsH);
	}

	const criticalValue = fromHarm(criticalHarm);
	const designAssumption = spec.designAssumption;
	const margin = criticalValue - designAssumption;
	const marginRatio = designAssumption === 0 ? Number.NaN : criticalValue / designAssumption;
	return {
		claim: spec.claim,
		axis: spec.axis,
		criticalValue,
		designAssumption,
		margin,
		marginRatio,
		designInsideEnvelope: margin > 0,
		monotoneDirection: direction,
		boundaryFound,
		monotoneViolated,
		scanLo: spec.lo,
		scanHi: spec.hi,
		evaluations
	};
}

/** Next harm-ascending probe strictly greater than `cur`, clamped to `hi`. Linear for small integer ranges, geometric otherwise. */
function stepUp(cur: number, lo: number, hi: number, integer: boolean): number {
	const span = hi - lo;
	let next: number;
	if (integer) {
		if (span <= LINEAR_INT_THRESHOLD) {
			next = cur + 1;
		} else {
			next = cur <= 0 ? 1 : cur * 2;
			if (next <= cur) {
				next = cur + 1;
			}
		}
	} else if (cur <= lo) {
		next = lo + span * REAL_FIRST_STEP_FRACTION;
	} else {
		next = cur * 2;
		if (next <= cur) {
			next = cur + span * REAL_FIRST_STEP_FRACTION;
		}
	}
	return next > hi ? hi : next;
}

/**
 * Bisect the bracket `[aPass, bFail]` (harm-ascending: `holdsH(aPass)` true, `holdsH(bFail)` false)
 * to the last value that still holds. Integer axes bisect to adjacent integers (no infinite loop on
 * a sub-integer tolerance); real axes bisect to `tol`. A bracket already within tolerance returns
 * immediately rather than looping.
 */
function bisectHarm(aPass: number, bFail: number, integer: boolean, tol: number, holdsH: (h: number) => boolean): number {
	let a = aPass;
	let b = bFail;
	if (integer) {
		while (b - a > 1) {
			const m = a + Math.floor((b - a) / 2);
			if (holdsH(m)) {
				a = m;
			} else {
				b = m;
			}
		}
	} else {
		while (b - a > tol) {
			const m = (a + b) / 2;
			if (holdsH(m)) {
				a = m;
			} else {
				b = m;
			}
		}
	}
	return a;
}

/**
 * Fold one `EnvelopeBoundary` into a `Metrics` sink, keyed by `(claim, axis)` — mirrors
 * `sweep.recordScaleSample`. Histograms carry the numeric edges (critical value, margin, design
 * point, evaluation cost); counters carry the boolean verdicts; a timeline records the margin at
 * the critical value for over-axis inspection and JSON/CSV export. `marginRatio` is intentionally
 * NOT recorded (it is `NaN` when `designAssumption === 0`, which serializes to `null`).
 */
export function recordBoundary(metrics: Metrics, b: EnvelopeBoundary): void {
	const tags = { claim: b.claim, axis: b.axis };
	metrics.histogram('boundary.criticalValue', b.criticalValue, tags);
	metrics.histogram('boundary.margin', b.margin, tags);
	metrics.histogram('boundary.designAssumption', b.designAssumption, tags);
	metrics.histogram('boundary.evaluations', b.evaluations, tags);
	metrics.counter('boundary.designInsideEnvelope', b.designInsideEnvelope ? 1 : 0, tags);
	metrics.counter('boundary.boundaryFound', b.boundaryFound ? 1 : 0, tags);
	metrics.counter('boundary.monotoneViolated', b.monotoneViolated ? 1 : 0, tags);
	metrics.timeline(`boundary.margin.${b.claim}.${b.axis}`, b.criticalValue, b.margin);
}
