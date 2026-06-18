import type { PeerRef, VTime } from './types.js';
import { Metrics } from './metrics.js';
import {
	classifyResume,
	coverageSeconds,
	simulateRotationBurst,
	DEFAULT_REACTIVITY_CONFIG,
	type ReactivityConfig,
	type ResumeKind
} from './reactivity.js';
import {
	findBoundary,
	recordBoundary,
	type EnvelopeBoundary,
	type BoundaryAxisSpec
} from './boundary.js';

/**
 * The reactivity (live-update) operating-envelope boundaries (`simulator-envelope-reactivity`): two
 * stress axes layered on the generic `findBoundary` harness, each pairing one monotone-in-harm axis
 * with a reactivity point-claim the `TailRotationScenario` already checks at its nominal point. This
 * is new *measurement* over the existing reactivity model — it reuses `classifyResume`/`coverageSeconds`
 * and `simulateRotationBurst` rather than re-modeling the replay window or the rotation burst. (The
 * R* / `root-not-overloaded` reference axis lives in `simulator-envelope-core`; the tree rows in
 * `simulator-envelope-tree`; the churn/partition rows in `simulator-envelope-churn`; this module adds
 * the two reactivity rows of the parent ticket's candidate table.)
 *
 *  1. **revision-continuity vs commit rate `cps`** — a reconnecting subscriber must replay from inside
 *     the layered recovery window. At a steady commit rate the window covers `(W + W_checkpoint)/cps`
 *     wall-clock seconds; as `cps` climbs against a fixed `W + W_checkpoint` the window stops covering a
 *     reconnect gap of `RECONNECT_GAP_SEC` and the resume falls to `OutOfWindow` (continuity breaks).
 *     This axis is the pure-function path (no full sim) — cheap, never N-gated.
 *
 *  2. **completes-within-drain vs `T_rejoin_jitter / T_drain` ratio** — on tail rotation the whole
 *     subscriber set re-registers at the new tail with jitter over `T_rejoin_jitter` while the old tail
 *     forwards until `T_drain`. The re-registration wave must drain before forwarding stops. Sweeping
 *     the ratio past 1 (a wider rejoin spread than the drain window) is what lets the wave genuinely
 *     outlast forwarding — the stress axis `simulator-strengthen-scenario-adversariality` calls for to
 *     give the otherwise-tautological `completes-within-drain` claim teeth.
 *
 * **Which resume bound (Boundary 1).** Boundary 1 uses the **layered** bound `W + W_checkpoint`
 * (`reactivity.md` §Parent checkpoint summaries is authoritative: the windows *stack*, total
 * single-round-trip recoverable range `W + W_checkpoint = 4352`), via `classifyResume`'s cutover to
 * `OutOfWindow`. The located `cps*` is therefore the **layered** edge. The far more conservative
 * **replay-only** edge (`W / RECONNECT_GAP_SEC`) is reported alongside it: the nominal commit rate sits
 * *below* the replay-only edge but well *inside* the layered one, which is exactly the adaptive-`W`
 * finding (`reactivity.md`: fixed `W = 256` drops below the 60 s recovery floor at ≥ 10 cps, while the
 * stacked window covers it to ≈ 72 cps).
 *
 * **De-tautologizing the drain claim (Boundary 2).** The shipped ratio `T_rejoin_jitter / T_drain =
 * 30 s / 60 s = 0.5` *cannot* fail: arrivals land in `[0, T_rejoin_jitter)`, always before `T_drain`.
 * The boundary drives the ratio past 1 so the wave's last arrival can exceed `T_drain`, and a positive
 * control (a ratio known to outlast `T_drain`) flips `completedWithinDrain` — so the margin is real, not
 * vacuous (the same trap the structural `heal-convergence` caveat guards). The non-vacuity witness that
 * the wave drains *via promotion fan-out* (root fast-promotes at `cap_promote_fast`, tree spreads off
 * the root) rather than via a trivially-short window is recorded as `viaPromotionFanout`.
 */

// --- design constants --------------------------------------------------------

/** The design's nominal commit rate (`reactivity.md` worked example / adaptive-`W` finding). */
export const NOMINAL_CPS = 10;

/**
 * The modeled subscriber reconnect-gap duration that must stay recoverable in one round trip. Named
 * (not implicit) because it sets where `cps*` lands: matches `reactivity.md`'s 60 s recovery floor.
 */
export const RECONNECT_GAP_SEC = 60;

/** The shipped rejoin/drain ratio, derived from the config so it tracks default changes (30 s / 60 s = 0.5). */
export const SHIPPED_REJOIN_DRAIN_RATIO =
	DEFAULT_REACTIVITY_CONFIG.tRejoinJitterMs / DEFAULT_REACTIVITY_CONFIG.tDrainMs;

// =============================================================================
// Boundary 1 — revision-continuity vs commit rate cps (pure function)
// =============================================================================

export interface ContinuityOptions {
	readonly config?: ReactivityConfig;
	/** Modeled reconnect-gap to keep recoverable, in seconds (default `RECONNECT_GAP_SEC`). */
	readonly reconnectGapSec?: number;
	/** The design's nominal commit rate, the boundary's design assumption (default `NOMINAL_CPS`). */
	readonly nominalCps?: number;
	/** Scan floor — strictly above 0 so `coverageSeconds` never divides by a silent (0 cps) topic (default 1). */
	readonly cpsFloor?: number;
	/** Scan ceiling — must exceed the layered edge so a finite edge is found (default 1000). */
	readonly cpsCeiling?: number;
	/** Bisection stop width on the cps axis (default `CONTINUITY_TOLERANCE`). */
	readonly tolerance?: number;
}

/** The continuity evaluation readout at one commit rate: the layered verdict + both window coverages. */
export interface ContinuityReadout {
	/** True ⇒ `revision-continuity` holds: the layered window still covers the reconnect gap (resume in-window). */
	readonly holds: boolean;
	readonly cps: number;
	/** Revisions accumulated during the reconnect gap at this rate — the modeled resume lag. */
	readonly gapRevisions: number;
	/** `classifyResume` verdict against the stacked bounds; `OutOfWindow` ⇒ the gap fell out of the layered window. */
	readonly resumeKind: ResumeKind;
	/** Wall-clock the **layered** window (`W + W_checkpoint`) covers at this rate — the authoritative edge. */
	readonly layeredCoverageSeconds: number;
	/** Wall-clock the **replay-only** window (`W`) covers — the far more conservative single-buffer edge. */
	readonly replayCoverageSeconds: number;
	readonly reconnectGapSec: number;
}

/** A fixed synthetic subscriber for the pure resume classification — only its (lag, tail) matter. */
const CONTINUITY_SUBSCRIBER: PeerRef = { id: 'reconnect-subscriber', key: new Uint8Array(32) };
/** A steady (un-rotated) tail, so `classifyResume` exercises the lag bounds, not the `TailRotated` path. */
const CONTINUITY_TAIL = 'tail-steady';
/** A head revision far above any modeled gap lag (≤ ceiling·gap), so `currentRevision − lag` stays positive. */
const CONTINUITY_BASE_REVISION = 1_000_000;
const CONTINUITY_TOLERANCE = 1e-2;

const CONTINUITY_DEFAULTS = {
	reconnectGapSec: RECONNECT_GAP_SEC,
	nominalCps: NOMINAL_CPS,
	cpsFloor: 1,
	cpsCeiling: 1000,
	tolerance: CONTINUITY_TOLERANCE
} as const;

interface ResolvedContinuity {
	readonly config: ReactivityConfig;
	readonly reconnectGapSec: number;
	readonly nominalCps: number;
	readonly cpsFloor: number;
	readonly cpsCeiling: number;
	readonly tolerance: number;
}

function continuityParams(opts: ContinuityOptions): ResolvedContinuity {
	return {
		config: opts.config ?? DEFAULT_REACTIVITY_CONFIG,
		reconnectGapSec: opts.reconnectGapSec ?? CONTINUITY_DEFAULTS.reconnectGapSec,
		nominalCps: opts.nominalCps ?? CONTINUITY_DEFAULTS.nominalCps,
		cpsFloor: opts.cpsFloor ?? CONTINUITY_DEFAULTS.cpsFloor,
		cpsCeiling: opts.cpsCeiling ?? CONTINUITY_DEFAULTS.cpsCeiling,
		tolerance: opts.tolerance ?? CONTINUITY_DEFAULTS.tolerance
	};
}

/**
 * Evaluate `revision-continuity` at commit rate `cps`. A reconnect gap of `reconnectGapSec` seconds at
 * `cps` commits/sec is a lag of `round(cps · gap)` revisions; the layered classifier (`classifyResume`)
 * returns an in-window kind (`Backfill`/`CheckpointWindow`) while that lag stays under `W + W_checkpoint`
 * and `OutOfWindow` once it does not. `holds` is exactly "not `OutOfWindow`" — the layered edge. The
 * readout also carries both window coverages so a reader sees the layered vs replay-only gap.
 */
function evalContinuity(cps: number, p: ResolvedContinuity): ContinuityReadout {
	if (cps <= 0) {
		throw new RangeError(`cps must be positive, got ${cps}`);
	}
	const gapRevisions = Math.round(cps * p.reconnectGapSec);
	const resumeKind = classifyResume(
		{
			subscriber: CONTINUITY_SUBSCRIBER,
			fromRevision: CONTINUITY_BASE_REVISION - gapRevisions,
			currentRevision: CONTINUITY_BASE_REVISION,
			currentTailId: CONTINUITY_TAIL,
			latestKnownTailId: CONTINUITY_TAIL
		},
		p.config
	);
	const layered = p.config.W + p.config.Wcheckpoint;
	return {
		holds: resumeKind !== 'OutOfWindow',
		cps,
		gapRevisions,
		resumeKind,
		layeredCoverageSeconds: coverageSeconds(layered, cps),
		replayCoverageSeconds: coverageSeconds(p.config.W, cps),
		reconnectGapSec: p.reconnectGapSec
	};
}

/**
 * Build the revision-continuity axis spec: `holds(cps)` returns whether the layered window still covers
 * the reconnect gap. `designAssumption = nominalCps`; the located `cps*` and `margin = cps* − nominalCps`
 * are what the layered `W + W_checkpoint` (and the adaptive-`W` recommendation `⌈gap · cps⌉`) buys against
 * a climbing commit rate. The floor is held strictly above 0 (a silent topic makes coverage unbounded).
 */
export function revisionContinuityAxis(opts: ContinuityOptions = {}): BoundaryAxisSpec {
	const p = continuityParams(opts);
	return {
		claim: 'revision-continuity',
		axis: 'commitRateCps',
		designAssumption: p.nominalCps,
		monotoneDirection: 'increasing-harm',
		lo: p.cpsFloor,
		hi: p.cpsCeiling,
		integer: false,
		tolerance: p.tolerance,
		holds(cps: number): boolean {
			return evalContinuity(cps, p).holds;
		}
	};
}

/** Public diagnostic for the continuity axis: the full readout (resume kind, both coverages) at `cps`. */
export function measureContinuityCoverage(cps: number, opts: ContinuityOptions = {}): ContinuityReadout {
	return evalContinuity(cps, continuityParams(opts));
}

/** The replay-only (single-buffer) continuity edge `W / gap` — the conservative bound, below the layered `cps*`. */
export function replayOnlyEdgeCps(opts: ContinuityOptions = {}): number {
	const p = continuityParams(opts);
	return p.config.W / p.reconnectGapSec;
}

// =============================================================================
// Boundary 2 — completes-within-drain vs rejoin/drain ratio (seeded burst)
// =============================================================================

export interface DrainOptions {
	readonly config?: ReactivityConfig;
	/** Re-registering subscribers in the burst (default 2000 — matches the doc's worked scenario). */
	readonly subscriberCount?: number;
	/** Seed threaded into `simulateRotationBurst` so `(seed, ratio)` is byte-reproducible (default 1). */
	readonly seed?: number;
	/** The shipped ratio, the boundary's design assumption (default `SHIPPED_REJOIN_DRAIN_RATIO` = 0.5). */
	readonly designRatio?: number;
	/** Scan floor (expected to drain — ratio well under 1) (default 0.1). */
	readonly ratioFloor?: number;
	/** Scan ceiling (expected to fail — ratio past 1) (default 2.0). */
	readonly ratioCeiling?: number;
}

/** The drain evaluation readout at one ratio: the drain verdict, the timing, and the fan-out witness. */
export interface DrainReadout {
	/** True ⇒ `completes-within-drain` holds: the last re-registration landed at or before `T_drain`. */
	readonly holds: boolean;
	readonly ratio: number;
	/** The `T_rejoin_jitter` this ratio maps to (`round(ratio · T_drain)`). */
	readonly tRejoinJitterMs: VTime;
	readonly tDrainMs: VTime;
	/** Virtual time of the last re-registration arrival — the quantity compared against `T_drain`. */
	readonly lastArrivalAt: VTime;
	readonly peakRootDirect: number;
	readonly capPromoteFast: number;
	readonly finalDepth: number;
	/**
	 * True ⇒ the wave drained *via promotion fan-out*: the new root filled to `cap_promote_fast` and
	 * fast-promoted (`peakRootDirect === cap_promote_fast`) and the tree spread off the root
	 * (`finalDepth > 0`). The non-vacuity witness that the claim is not held up by a trivially-short
	 * arrival window (the `heal-convergence` structural-trap analogue).
	 */
	readonly viaPromotionFanout: boolean;
}

const DRAIN_DEFAULTS = {
	subscriberCount: 2000,
	seed: 1,
	ratioFloor: 0.1,
	ratioCeiling: 2.0
} as const;

interface ResolvedDrain {
	readonly config: ReactivityConfig;
	readonly subscriberCount: number;
	readonly seed: number;
	readonly designRatio: number;
	readonly ratioFloor: number;
	readonly ratioCeiling: number;
}

function drainParams(opts: DrainOptions): ResolvedDrain {
	return {
		config: opts.config ?? DEFAULT_REACTIVITY_CONFIG,
		subscriberCount: opts.subscriberCount ?? DRAIN_DEFAULTS.subscriberCount,
		seed: opts.seed ?? DRAIN_DEFAULTS.seed,
		designRatio: opts.designRatio ?? SHIPPED_REJOIN_DRAIN_RATIO,
		ratioFloor: opts.ratioFloor ?? DRAIN_DEFAULTS.ratioFloor,
		ratioCeiling: opts.ratioCeiling ?? DRAIN_DEFAULTS.ratioCeiling
	};
}

/**
 * Evaluate `completes-within-drain` at rejoin/drain ratio `r`. Holds `T_drain` fixed and maps `r` to
 * `T_rejoin_jitter = round(r · T_drain)`, then runs the **seeded** `simulateRotationBurst` (the seed is
 * threaded so two evals at the same `(seed, ratio)` give identical drain outcomes). `holds` is the
 * burst's `completedWithinDrain` — true while the jittered wave's last arrival lands at or before
 * `T_drain`. Because `nextInt(bound) = ⌊nextFloat()·bound⌋` reuses the same underlying float per draw,
 * the wave's last-arrival time is monotone non-decreasing in `T_rejoin_jitter`, so harm is monotone in
 * `r` — the axis assumption the harness relies on. The burst keeps slope lookahead disabled (the
 * `simulateRotationBurst` wiring), so the peak-root fast-promote mechanics the claim depends on are
 * unchanged.
 */
function evalDrain(ratio: number, p: ResolvedDrain): DrainReadout {
	const tDrainMs = p.config.tDrainMs;
	const tRejoinJitterMs = Math.max(1, Math.round(ratio * tDrainMs));
	const config: ReactivityConfig = { ...p.config, tRejoinJitterMs };
	const burst = simulateRotationBurst({ subscriberCount: p.subscriberCount, config, seed: p.seed });
	return {
		holds: burst.completedWithinDrain,
		ratio,
		tRejoinJitterMs,
		tDrainMs,
		lastArrivalAt: burst.lastArrivalAt,
		peakRootDirect: burst.peakRootDirect,
		capPromoteFast: burst.capPromoteFast,
		finalDepth: burst.finalDepth,
		viaPromotionFanout: burst.peakRootDirect === burst.capPromoteFast && burst.finalDepth > 0
	};
}

/**
 * Build the completes-within-drain axis spec: `holds(r)` runs the rotation burst at `T_rejoin_jitter =
 * round(r · T_drain)` and returns whether the wave drained before `T_drain`. `designAssumption` is the
 * shipped ratio (0.5); the located `ratio*` and `margin = ratio* − 0.5` turn the tautological pass into
 * a real margin — `T_drain` (the forwarding window) is what buys it.
 */
export function tailDrainAxis(opts: DrainOptions = {}): BoundaryAxisSpec {
	const p = drainParams(opts);
	return {
		claim: 'completes-within-drain',
		axis: 'rejoinDrainRatio',
		designAssumption: p.designRatio,
		monotoneDirection: 'increasing-harm',
		lo: p.ratioFloor,
		hi: p.ratioCeiling,
		integer: false,
		holds(ratio: number): boolean {
			return evalDrain(ratio, p).holds;
		}
	};
}

/** Public diagnostic for the drain axis: the full readout (timing, fan-out witness) at ratio `r`. */
export function measureRotationDrain(ratio: number, opts: DrainOptions = {}): DrainReadout {
	return evalDrain(ratio, drainParams(opts));
}

// =============================================================================
// Driver
// =============================================================================

export interface ReactivityBoundaryOptions {
	readonly seed?: number;
	readonly continuity?: ContinuityOptions;
	readonly drain?: DrainOptions;
}

/** The two reactivity boundaries plus the metrics sink and the per-axis edge diagnostics. */
export interface ReactivityBoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
	/** Resume kind just past the continuity edge — should be `OutOfWindow` (the gap fell out of the layered window). */
	readonly continuityKindPastEdge: ResumeKind;
	/** Layered window coverage (s) at the located cps edge — ≈ the reconnect gap (the edge is where it crosses). */
	readonly layeredCoverageAtEdge: number;
	/** Replay-only window coverage (s) at the located cps edge — far below the gap (the conservative bound). */
	readonly replayCoverageAtEdge: number;
	/** The replay-only (`W / gap`) continuity edge — below the nominal cps, unlike the layered `cps*`. */
	readonly replayOnlyEdgeCps: number;
	/** True ⇒ the burst drained via fast-promote fan-out at the design ratio (non-vacuity witness). */
	readonly drainViaFanoutAtDesign: boolean;
	/** Last-arrival time just past the drain edge — the wave that first outlasts `T_drain` forwarding. */
	readonly lastArrivalPastDrainEdge: VTime;
}

/**
 * Run both reactivity boundaries, folding each into a `Metrics` sink via `recordBoundary`, and diagnose
 * each edge: the resume kind and both window coverages around the continuity edge (documenting the
 * layered-vs-replay-only bound), and the fan-out witness + the wave's last arrival past the drain edge.
 * Boundary 1 is a pure function (cheap, never N-gated); Boundary 2 runs the seeded burst. Deterministic
 * from `(seed, config)`.
 */
export function runReactivityBoundaries(opts: ReactivityBoundaryOptions = {}): ReactivityBoundaryReport {
	const seed = opts.seed ?? DRAIN_DEFAULTS.seed;
	const continuityOpts: ContinuityOptions = { ...opts.continuity };
	const drainOpts: DrainOptions = { seed, ...opts.drain };
	const cp = continuityParams(continuityOpts);
	const dp = drainParams(drainOpts);

	const metrics = new Metrics();
	const boundaries: EnvelopeBoundary[] = [];

	// Boundary 1 — revision-continuity vs commit rate cps (pure function, no N-gate).
	const continuityBoundary = findBoundary(revisionContinuityAxis(continuityOpts));
	recordBoundary(metrics, continuityBoundary);
	boundaries.push(continuityBoundary);
	const atEdge = evalContinuity(clampToRange(continuityBoundary.criticalValue, cp.cpsFloor, cp.cpsCeiling), cp);
	const pastEdge = evalContinuity(probePastEdge(continuityBoundary, cp.cpsFloor, cp.cpsCeiling, false), cp);

	// Boundary 2 — completes-within-drain vs rejoin/drain ratio (seeded burst).
	const drainBoundary = findBoundary(tailDrainAxis(drainOpts));
	recordBoundary(metrics, drainBoundary);
	boundaries.push(drainBoundary);
	const designDrain = evalDrain(dp.designRatio, dp);
	const drainPastEdge = evalDrain(probePastEdge(drainBoundary, dp.ratioFloor, dp.ratioCeiling, false), dp);

	return {
		boundaries,
		metrics,
		continuityKindPastEdge: pastEdge.resumeKind,
		layeredCoverageAtEdge: atEdge.layeredCoverageSeconds,
		replayCoverageAtEdge: atEdge.replayCoverageSeconds,
		replayOnlyEdgeCps: replayOnlyEdgeCps(continuityOpts),
		drainViaFanoutAtDesign: designDrain.viaPromotionFanout,
		lastArrivalPastDrainEdge: drainPastEdge.lastArrivalAt
	};
}

/** Clamp `v` into `[lo, hi]` — keeps a sentinel critical value (below-floor / at-ceiling) inside the evaluable range. */
function clampToRange(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/**
 * A probe value just past a located edge (one harm-tolerance step deeper into the failing region),
 * clamped to `[lo, hi]`. Real axes step by a small fraction of the range; when no finite edge was found
 * the critical value already sits at the ceiling, so the probe is the ceiling itself.
 */
function probePastEdge(b: EnvelopeBoundary, lo: number, hi: number, integer: boolean): number {
	if (!b.boundaryFound) {
		return clampToRange(b.criticalValue, lo, hi);
	}
	const step = integer ? 1 : (hi - lo) * 1e-3;
	return clampToRange(b.criticalValue + step, lo, hi);
}
