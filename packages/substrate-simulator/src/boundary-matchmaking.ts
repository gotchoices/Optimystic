import type { PeerRef, VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import type { TopicTrafficV1 } from './topic-events.js';
import { createSimWorld } from './world.js';
import { DeterministicLatency, DEFAULT_HOP_MS } from './latency.js';
import { bytesToHex } from './hex.js';
import { TopicTree } from './topic-tree.js';
import { Metrics } from './metrics.js';
import {
	type SimProvider,
	type CapabilityFilter,
	type SeekerDemand,
	type MatchmakingConfig,
	DEFAULT_MATCHMAKING_CONFIG,
	contentionFactor,
	expectedNewMatches
} from './matchmaking.js';
import {
	SeekerWalk,
	TierProviderModel,
	type TierProviderConfig,
	type SeekerTrace,
	type TrafficReporter
} from './seeker-walk.js';
import { seekerPoolContentionWouldFlip } from './refinement-signal.js';
import {
	findBoundary,
	recordBoundary,
	type EnvelopeBoundary,
	type BoundaryAxisSpec
} from './boundary.js';

/**
 * The matchmaking operating-envelope boundaries (`simulator-envelope-matchmaking`): two stress axes
 * layered on the generic `findBoundary` harness, each pairing one monotone-in-harm axis with a
 * matchmaking point-claim the `AdversarialReportingScenario` / the decision math already check at the
 * nominal point. This is new *measurement* over the existing matchmaking model — it reuses
 * `SeekerWalk`/`TierProviderModel`/`TrafficReporter`, `contentionFactor`/`expectedNewMatches`, and
 * `seekerPoolContentionWouldFlip` rather than re-modeling the seeker walk or the decision rule. (The
 * R* / `root-not-overloaded` reference axis lives in `simulator-envelope-core`; the tree rows in
 * `-tree`; the churn rows in `-churn`; the reactivity rows in `-reactivity`; this module adds the two
 * matchmaking rows of the parent ticket's candidate table.)
 *
 *  1. **bounded-harm vs lying-reporter fraction** — a fraction `f` of the cohort primaries along the
 *     seeker's path mis-report `topicTraffic`. The design claims bounded harm: an under-reporter costs
 *     `≤ +1` escalation hop per under-reported tier, an over-reporter wastes `≤ patienceMs` of drain,
 *     and the seeker *still matches*. The lie is a **per-query-flip** adversary (from
 *     `simulator-strengthen-scenario-adversariality`): the seeker cannot settle against it, so the
 *     claim can genuinely break where a static lie's `≤ patienceMs` bound is near-tautological (the
 *     seeker's own deadline bounds the drain). Past `f*` the flip drains the seeker's whole patience at
 *     a lied-about tier (because `patience_per_tier_fraction = 1.0` commits the entire budget to one
 *     tier) and the seeker fails to match — unbounded harm. That fragility is exactly what
 *     `matchmaking-per-tier-patience-splitting` would fix, so `f*` quantifies the need for it.
 *
 *  2. **hang-out-fairness vs seeker-pool contention ratio** — the decision rule approximates
 *     competition as `queriesPerMin × meanWantCount` and clamps `contentionFactor` at
 *     `contention_factor_cap = 4`. The exact alternative is `Σ wantCount` over the registered-seeker
 *     pool. As the seeker:provider ratio `ρ` rises, the exact contention diverges above the fixed
 *     approximation and the hang-out decision misfires (the seeker hangs out when the exact sum says
 *     escalate). The boundary is the `ρ*` at which the capped-approximation decision first flips away
 *     from the exact-contention decision — reusing `seekerPoolContentionWouldFlip` so the predicate is
 *     the actual decision flip, not merely "the raw factor exceeded 4". `ρ*` lands *below* the ratio at
 *     which the exact contention saturates the cap, so the misfire precedes the design's assumed
 *     worst-case contention: a negative margin, the principled answer that
 *     `matchmaking-contention-from-seeker-pool` (the exact-sum refinement) is warranted.
 *
 * **De-tautologizing bounded-harm (Boundary 1).** Against a *static* under-report the seeker escalates
 * through the lied-about tiers and still matches at the root (`AdversarialReportingScenario`
 * `under-report-not-fatal`), so `holds` stays true across the whole fraction range — the bound is
 * tautological. The per-query-flip is what gives the adversary teeth: at the swept fraction its
 * over-report component (the lie the seeker cannot pre-empt) drains the whole patience budget at a
 * provider-less tier and the match fails. The driver records both — the flip edge `f*` and the
 * static lie still holding at `f = 1` — so the margin is demonstrably the *flip's*, not a vacuous one.
 *
 * **Determinism.** Boundary 1 draws from seeded `SeekerWalk`s on the virtual clock (no wall-clock, no
 * randomness outside the seeded rng); Boundary 2 is a pure function of the decision math. Two runs at
 * the same `(seed, config, axisValue)` give identical boundaries.
 */

const TOPIC = 'envelope-matchmaking-topic';
const GOSSIP_ROUND_MS = 1000;
const PDF_FILTER: CapabilityFilter = { must: ['pdf'] };
/** The over-reporter's fabricated `arrivalsPerMin` — a "hot tier" claim large enough to force hang-out. */
const OVER_REPORT_ARRIVALS = 100_000;
/** Default seed shared by both boundaries' drivers. */
const DEFAULT_SEED = 90909;

// =============================================================================
// Boundary 1 — bounded-harm vs lying-reporter fraction (seeded seeker walks)
// =============================================================================

/** The design's tolerated lying fraction — all-honest (`AdversarialReportingScenario` nominal point). */
export const BOUNDED_HARM_DESIGN_FRACTION = 0;

/** Which lie the swept fraction of reporters applies (the per-query-flip is the boundary; static is the control). */
export type LyingReporterMode = 'per-query-flip' | 'static-under-report';

/** Which sub-condition of the bounded-harm conjunction broke (or none) at a given fraction. */
export type HarmMechanism = 'within-bounds' | 'match-failure' | 'excess-hops' | 'excess-drain';

export interface BoundedHarmOptions {
	readonly seed?: number;
	/** Seeker landing tier `T`; the path is tiers `{T, T-1, …, 0}` (default 8). */
	readonly startTier?: number;
	/** Providers the seeker wants (default 8 — `AdversarialReportingScenario`'s `wantCount`). */
	readonly wantCount?: number;
	/** Seeker patience budget (default 10_000 — `patience_default_ms`). */
	readonly patienceMs?: VTime;
	readonly config?: MatchmakingConfig;
	/** Scan floor on the fraction axis (default 0 — all-honest). */
	readonly fractionFloor?: number;
	/** Scan ceiling on the fraction axis (default 1 — every path reporter lies). */
	readonly fractionCeiling?: number;
	/** Bisection stop width on the fraction axis (default 1e-3). */
	readonly tolerance?: number;
}

/** The bounded-harm evaluation at one lying fraction: the honest-vs-lied deltas and which bound (if any) broke. */
export interface BoundedHarmReadout {
	/** True ⇒ `bounded-harm` holds: the seeker still matched and both extra-cost bounds held. */
	readonly holds: boolean;
	readonly lyingFraction: number;
	/** Number of non-root path tiers that lie at this fraction (`round(f · pathLength)`). */
	readonly lyingTierCount: number;
	readonly honestEscalations: number;
	readonly liedEscalations: number;
	/** `liedEscalations − honestEscalations` — the extra hops the lie cost. */
	readonly extraHops: number;
	/** The claimed bound on extra hops: `+1` per under-reported tier ⇒ `lyingTierCount`. */
	readonly boundHops: number;
	readonly honestHangOutMs: VTime;
	readonly liedHangOutMs: VTime;
	/** `liedHangOutMs − honestHangOutMs` — the extra hang-out drain the lie wasted. */
	readonly extraDrainMs: VTime;
	readonly patienceMs: VTime;
	readonly honestMatched: boolean;
	readonly liedMatched: boolean;
	readonly harmMechanism: HarmMechanism;
	readonly mode: LyingReporterMode;
}

interface ResolvedBoundedHarm {
	readonly seed: number;
	readonly startTier: number;
	readonly wantCount: number;
	readonly patienceMs: VTime;
	readonly config: MatchmakingConfig;
	readonly fractionFloor: number;
	readonly fractionCeiling: number;
	readonly tolerance: number;
}

const BOUNDED_HARM_DEFAULTS = {
	startTier: 8,
	wantCount: 8,
	patienceMs: 10_000,
	fractionFloor: 0,
	fractionCeiling: 1,
	tolerance: 1e-3
} as const;

function boundedHarmParams(opts: BoundedHarmOptions): ResolvedBoundedHarm {
	return {
		seed: opts.seed ?? DEFAULT_SEED,
		startTier: opts.startTier ?? BOUNDED_HARM_DEFAULTS.startTier,
		wantCount: opts.wantCount ?? BOUNDED_HARM_DEFAULTS.wantCount,
		patienceMs: opts.patienceMs ?? BOUNDED_HARM_DEFAULTS.patienceMs,
		config: opts.config ?? DEFAULT_MATCHMAKING_CONFIG,
		fractionFloor: opts.fractionFloor ?? BOUNDED_HARM_DEFAULTS.fractionFloor,
		fractionCeiling: opts.fractionCeiling ?? BOUNDED_HARM_DEFAULTS.fractionCeiling,
		tolerance: opts.tolerance ?? BOUNDED_HARM_DEFAULTS.tolerance
	};
}

function providers(n: number, from: number): SimProvider[] {
	return Array.from({ length: n }, (_v, i) => ({ id: `p${from + i}`, capabilities: ['pdf'], capacityBudget: 1, attachedAt: 0 }));
}

/** A coord ladder of `tiers + 1` coords (mirrors `AdversarialReportingScenario.ladder`). */
function ladder(tiers: number, marker: number): RingCoord[] {
	return Array.from({ length: tiers + 1 }, (_v, tier) => {
		const c = new Uint8Array(32);
		c[0] = tier;
		c[1] = marker;
		return c;
	});
}

/**
 * The escalate-to-root tier model: every non-root tier is thin (no standing providers, no fresh
 * arrivals) and honestly reports a cold rate, so an honest seeker walks straight to the root and
 * matches against its full pool. This baseline is what makes the per-query-flip's over-report
 * catastrophic — a lied-about tier has *no* real providers, so an over-report that forces a hang-out
 * drains the whole (un-split) patience budget against an empty pool and the seeker fails to match.
 */
function buildModel(p: ResolvedBoundedHarm): TierProviderModel {
	const configs: TierProviderConfig[] = [];
	for (let tier = 1; tier <= p.startTier; tier++) {
		configs.push({ tier, initial: [], reportedArrivalsPerMin: 1, queriesPerMin: 0 });
	}
	// Root: the full pool — an honest (and an under-reported) seeker resolves here immediately.
	configs.push({ tier: 0, initial: providers(p.wantCount, 0), reportedArrivalsPerMin: 600, queriesPerMin: 4 });
	return new TierProviderModel(configs);
}

/** Is `tier` among the topmost `lyingTierCount` non-root tiers of the path? */
function isLyingTier(tier: number, startTier: number, lyingTierCount: number): boolean {
	return tier >= 1 && tier >= startTier - lyingTierCount + 1;
}

/**
 * The per-query-flip reporter: a lied-about tier flips its lie on a per-query counter the seeker
 * cannot predict — even queries claim a cold tier (`arrivalsPerMin = 0`, forcing escalate), odd
 * queries claim a hot tier (`arrivalsPerMin` huge, forcing a hang-out that then drains against the
 * tier's empty pool). Because the seeker queries the path top-down one tier at a time, the parity at
 * tier `t` is `(startTier − t)`, so the second tier the seeker reaches over-reports — the lie the
 * seeker has already committed past and cannot settle against.
 */
function flipReporter(startTier: number, lyingTierCount: number): TrafficReporter {
	let queryCount = 0;
	return (truthful, tier) => {
		const lying = isLyingTier(tier, startTier, lyingTierCount);
		const parity = queryCount % 2;
		queryCount++;
		if (!lying) {
			return truthful;
		}
		return parity === 0
			? { ...truthful, arrivalsPerMin: 0 }
			: { ...truthful, arrivalsPerMin: OVER_REPORT_ARRIVALS };
	};
}

/** The static under-report control: every lied-about tier consistently claims a cold tier (the near-tautological lie). */
function staticUnderReporter(startTier: number, lyingTierCount: number): TrafficReporter {
	return (truthful, tier) =>
		isLyingTier(tier, startTier, lyingTierCount) ? { ...truthful, arrivalsPerMin: 0 } : truthful;
}

/** Run one seeker landing at `startTier` against the model, honest unless a `reporter` is supplied. */
function runSeeker(p: ResolvedBoundedHarm, model: TierProviderModel, marker: number, reporter?: TrafficReporter): SeekerTrace {
	const world = createSimWorld({ seed: p.seed, gossipRoundMs: GOSSIP_ROUND_MS }, new DeterministicLatency(DEFAULT_HOP_MS));
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS });
	const coords = ladder(p.startTier, marker);
	tree.ensure(TOPIC, bytesToHex(coords[p.startTier]!), p.startTier, 0);
	let trace: SeekerTrace | undefined;
	const walk = new SeekerWalk({
		scheduler: world.scheduler,
		tree,
		participant: { id: `seeker-${marker}`, key: new Uint8Array(32) },
		topicId: TOPIC,
		ladder: coords,
		providers: model,
		wantCount: p.wantCount,
		patienceMs: p.patienceMs,
		filter: PDF_FILTER,
		config: p.config,
		reporter,
		onComplete: (t) => {
			trace = t;
		}
	});
	walk.start();
	world.scheduler.run();
	if (!trace) {
		throw new Error('seeker walk did not complete');
	}
	return trace;
}

/** Largest lied-about tier count at a fraction: `round(f · pathLength)`, clamped to `[0, pathLength]`. */
function lyingTierCountAt(fraction: number, startTier: number): number {
	return Math.max(0, Math.min(startTier, Math.round(fraction * startTier)));
}

/**
 * Evaluate `bounded-harm` at lying fraction `f` under `mode`. Runs an honest baseline `SeekerWalk` and
 * a lied `SeekerWalk` (same seeded world, model, demand) and compares: the harm is the *extra* hops and
 * *extra* drain relative to the honest run (so the bound is not trivially satisfied by absolute
 * latency), and the seeker must still match. `holds` is the conjunction
 * `liedMatched ∧ extraHops ≤ lyingTierCount ∧ extraDrain ≤ patienceMs`; `harmMechanism` records which
 * conjunct broke first.
 */
export function measureBoundedHarm(fraction: number, opts: BoundedHarmOptions = {}, mode: LyingReporterMode = 'per-query-flip'): BoundedHarmReadout {
	// `boundedHarmParams` is idempotent — a resolved params object (as the axis closure passes) re-resolves
	// to itself, so callers may hand in either raw options or already-resolved params.
	const p = boundedHarmParams(opts);
	const lyingTierCount = lyingTierCountAt(fraction, p.startTier);
	const model = buildModel(p);
	const honest = runSeeker(p, model, 0x50);
	const reporter = mode === 'per-query-flip'
		? flipReporter(p.startTier, lyingTierCount)
		: staticUnderReporter(p.startTier, lyingTierCount);
	const lied = runSeeker(p, model, 0x55, reporter);

	const extraHops = lied.escalations - honest.escalations;
	const extraDrainMs = lied.hangOutDurationMs - honest.hangOutDurationMs;
	const boundHops = lyingTierCount;

	let harmMechanism: HarmMechanism = 'within-bounds';
	if (!lied.matched) {
		harmMechanism = 'match-failure';
	} else if (extraHops > boundHops) {
		harmMechanism = 'excess-hops';
	} else if (extraDrainMs > p.patienceMs) {
		harmMechanism = 'excess-drain';
	}
	const holds = honest.matched && harmMechanism === 'within-bounds';

	return {
		holds,
		lyingFraction: fraction,
		lyingTierCount,
		honestEscalations: honest.escalations,
		liedEscalations: lied.escalations,
		extraHops,
		boundHops,
		honestHangOutMs: honest.hangOutDurationMs,
		liedHangOutMs: lied.hangOutDurationMs,
		extraDrainMs,
		patienceMs: p.patienceMs,
		honestMatched: honest.matched,
		liedMatched: lied.matched,
		harmMechanism,
		mode
	};
}

/**
 * Build the bounded-harm axis spec: `holds(f)` runs the honest-vs-per-query-flip comparison at fraction
 * `f` and returns whether harm stayed bounded. `designAssumption = 0` (all-honest); the located `f*`
 * and `margin = f* − 0` are the fraction of flipping reporters the design tolerates before the seeker
 * fails to match — bounded up to `f*` by the `patienceMs` deadline and the per-tier `+1`-hop structure.
 */
export function lyingFractionAxis(opts: BoundedHarmOptions = {}): BoundaryAxisSpec {
	const p = boundedHarmParams(opts);
	return {
		claim: 'bounded-harm',
		axis: 'lyingFraction',
		designAssumption: BOUNDED_HARM_DESIGN_FRACTION,
		monotoneDirection: 'increasing-harm',
		lo: p.fractionFloor,
		hi: p.fractionCeiling,
		integer: false,
		tolerance: p.tolerance,
		holds(fraction: number): boolean {
			return measureBoundedHarm(fraction, p, 'per-query-flip').holds;
		}
	};
}

// =============================================================================
// Boundary 2 — hang-out-fairness vs seeker-pool contention ratio (pure function)
// =============================================================================

export interface SeekerContentionOptions {
	readonly config?: MatchmakingConfig;
	/** The provider pool's reported arrival rate — the denominator both contention terms divide by (default 60). */
	readonly arrivalsPerMin?: number;
	/** Competing-seeker query rate, fixing the approximation's contention below the cap (default 20 ⇒ approx = 2). */
	readonly queriesPerMin?: number;
	/** The modeled provider pool size (surfaced on the snapshot; not consulted by the decision math). Default 60. */
	readonly providerCount?: number;
	/** The seeker's own demand (default 8). */
	readonly wantCount?: number;
	/** Providers already matched at the tier — held `< wantCount` so the contention terms are actually consulted (default 4). */
	readonly currentMatches?: number;
	/** Seeker patience budget driving `expectedNewMatches` (default 24_000 ⇒ LHS sits in the divergence window). */
	readonly patienceMs?: VTime;
	/** Scan floor on the ratio axis (default 0 — no competing demand). */
	readonly ratioFloor?: number;
	/** Scan ceiling on the ratio axis (default 10 — well past where the exact contention saturates the cap). */
	readonly ratioCeiling?: number;
	/** Bisection stop width on the ratio axis (default 1e-3 × range). */
	readonly tolerance?: number;
}

/** The hang-out-fairness evaluation at one contention ratio: the two contention terms and the resulting decisions. */
export interface SeekerContentionReadout {
	/** True ⇒ `hang-out-fairness` holds: the capped-approximation decision matches the exact-contention decision. */
	readonly holds: boolean;
	readonly ratio: number;
	/** The exact `Σ wantCount` this ratio maps to: `ratio · arrivalsPerMin`. */
	readonly seekerWantSum: number;
	/** The shipped capped approximation `min(1 + queriesPerMin·meanWantCount/arrivals, cap)` (fixed in `ratio`). */
	readonly approxContention: number;
	/** The exact `min(1 + ΣwantCount/arrivals, cap)` — rises with `ratio` until it saturates the cap. */
	readonly exactContention: number;
	readonly approxHangOut: boolean;
	readonly exactHangOut: boolean;
	/** True ⇒ the two decisions disagree (the misfire). `holds = !wouldFlip`. */
	readonly wouldFlip: boolean;
	/** True ⇒ the uncapped exact contention `1 + ratio` has reached the cap (the design's assumed worst case). */
	readonly exactReachedCap: boolean;
	readonly cap: number;
}

interface ResolvedSeekerContention {
	readonly config: MatchmakingConfig;
	readonly arrivalsPerMin: number;
	readonly queriesPerMin: number;
	readonly providerCount: number;
	readonly wantCount: number;
	readonly currentMatches: number;
	readonly patienceMs: VTime;
	readonly cap: number;
	readonly ratioFloor: number;
	readonly ratioCeiling: number;
	readonly tolerance: number;
}

const SEEKER_CONTENTION_DEFAULTS = {
	arrivalsPerMin: 60,
	queriesPerMin: 20,
	providerCount: 60,
	wantCount: 8,
	currentMatches: 4,
	patienceMs: 24_000,
	ratioFloor: 0,
	ratioCeiling: 10
} as const;

function seekerContentionParams(opts: SeekerContentionOptions): ResolvedSeekerContention {
	const config = opts.config ?? DEFAULT_MATCHMAKING_CONFIG;
	const ratioCeiling = opts.ratioCeiling ?? SEEKER_CONTENTION_DEFAULTS.ratioCeiling;
	const ratioFloor = opts.ratioFloor ?? SEEKER_CONTENTION_DEFAULTS.ratioFloor;
	return {
		config,
		arrivalsPerMin: opts.arrivalsPerMin ?? SEEKER_CONTENTION_DEFAULTS.arrivalsPerMin,
		queriesPerMin: opts.queriesPerMin ?? SEEKER_CONTENTION_DEFAULTS.queriesPerMin,
		providerCount: opts.providerCount ?? SEEKER_CONTENTION_DEFAULTS.providerCount,
		wantCount: opts.wantCount ?? SEEKER_CONTENTION_DEFAULTS.wantCount,
		currentMatches: opts.currentMatches ?? SEEKER_CONTENTION_DEFAULTS.currentMatches,
		patienceMs: opts.patienceMs ?? SEEKER_CONTENTION_DEFAULTS.patienceMs,
		cap: config.contentionFactorCap,
		ratioFloor,
		ratioCeiling,
		tolerance: opts.tolerance ?? (ratioCeiling - ratioFloor) * 1e-3
	};
}

/**
 * Evaluate `hang-out-fairness` at seeker:provider contention ratio `ρ`. Maps `ρ` to an exact seeker-pool
 * demand `Σ wantCount = ρ · arrivalsPerMin` and asks `seekerPoolContentionWouldFlip` whether swapping the
 * shipped capped approximation for that exact sum flips the hang-out decision. `holds = !wouldFlip`. The
 * readout carries both contention terms and whether the exact contention has saturated the cap, so a
 * reader sees the misfire onset relative to the cap. Harm is monotone in `ρ`: the approximation is fixed
 * while the exact term rises, so once they diverge enough to flip the decision they stay flipped.
 */
export function measureSeekerContention(ratio: number, opts: SeekerContentionOptions = {}): SeekerContentionReadout {
	// `seekerContentionParams` is idempotent — a resolved params object (as the axis closure passes)
	// re-resolves to itself, so callers may hand in either raw options or already-resolved params.
	const p = seekerContentionParams(opts);
	const traffic: TopicTrafficV1 = {
		windowSeconds: 60,
		arrivalsPerMin: p.arrivalsPerMin,
		queriesPerMin: p.queriesPerMin,
		directParticipants: p.providerCount,
		childCohortCount: 0
	};
	const demand: SeekerDemand = { wantCount: p.wantCount, patienceMs: p.patienceMs, filter: PDF_FILTER, filterAcceptRatio: 1.0 };
	const seekerWantSum = ratio * p.arrivalsPerMin;
	const wouldFlip = seekerPoolContentionWouldFlip(traffic, p.currentMatches, demand, seekerWantSum, p.config);

	// Diagnostics — replicate the two terms the flip predicate compares (the cap clamps both).
	const newMatches = expectedNewMatches(traffic.arrivalsPerMin, demand.filterAcceptRatio, demand.patienceMs);
	const approxContention = contentionFactor(traffic.arrivalsPerMin, traffic.queriesPerMin, p.config.meanWantCount, p.cap);
	const exactContention = Math.min(1 + seekerWantSum / Math.max(traffic.arrivalsPerMin, 1), p.cap);
	const lhs = p.currentMatches + newMatches;

	return {
		holds: !wouldFlip,
		ratio,
		seekerWantSum,
		approxContention,
		exactContention,
		approxHangOut: lhs >= demand.wantCount * approxContention,
		exactHangOut: lhs >= demand.wantCount * exactContention,
		wouldFlip,
		exactReachedCap: 1 + ratio >= p.cap,
		cap: p.cap
	};
}

/**
 * Build the hang-out-fairness axis spec: `holds(ρ)` returns whether the capped-approximation decision
 * still matches the exact-contention decision. `designAssumption = cap − 1` — the ratio at which the
 * exact contention `1 + ρ` saturates `contention_factor_cap` (the design's assumed worst-case
 * contention). The located `ρ*` and `margin = ρ* − (cap − 1)` answer whether
 * `matchmaking-contention-from-seeker-pool` is needed: `ρ* < cap − 1` (negative margin) ⇒ the
 * approximation misfires *before* contention even reaches the cap ⇒ the exact-sum refinement is
 * warranted.
 */
export function seekerContentionAxis(opts: SeekerContentionOptions = {}): BoundaryAxisSpec {
	const p = seekerContentionParams(opts);
	return {
		claim: 'hang-out-fairness',
		axis: 'seekerProviderRatio',
		designAssumption: p.cap - 1,
		monotoneDirection: 'increasing-harm',
		lo: p.ratioFloor,
		hi: p.ratioCeiling,
		integer: false,
		tolerance: p.tolerance,
		holds(ratio: number): boolean {
			return measureSeekerContention(ratio, p).holds;
		}
	};
}

/** The seeker:provider ratio at which the exact contention saturates the cap (`cap − 1`) — the design's worst case. */
export function contentionRatioAtCap(opts: SeekerContentionOptions = {}): number {
	return seekerContentionParams(opts).cap - 1;
}

// =============================================================================
// Driver
// =============================================================================

export interface MatchmakingBoundaryOptions {
	readonly seed?: number;
	readonly boundedHarm?: BoundedHarmOptions;
	readonly seekerContention?: SeekerContentionOptions;
}

/** The two matchmaking boundaries plus the metrics sink and the per-axis edge diagnostics. */
export interface MatchmakingBoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
	/** Which bounded-harm conjunct broke just past the lying-fraction edge — should be `match-failure`. */
	readonly harmMechanismAtEdge: HarmMechanism;
	/** Lied-about tier count just past the bounded-harm edge (the flip's reach at `f*`). */
	readonly lyingTierCountPastEdge: number;
	/** De-tautologization: the static under-report still holds at `f = 1` (only the flip breaks the claim). */
	readonly staticUnderReportHoldsAtCeiling: boolean;
	/** The located seeker:provider misfire ratio `ρ*`. */
	readonly contentionFlipOnsetRatio: number;
	/** The ratio at which the exact contention saturates the cap (`cap − 1`) — the design's assumed worst case. */
	readonly contentionRatioAtCap: number;
	/** Exact contention at the located edge — below the cap, so the misfire precedes cap saturation. */
	readonly exactContentionAtEdge: number;
	/** True ⇒ `ρ* < cap − 1` (margin < 0): the approximation misfires before the cap ⇒ exact-sum refinement warranted. */
	readonly contentionRefinementWarranted: boolean;
}

/** Clamp `v` into `[lo, hi]` — keeps a sentinel critical value (below-floor / at-ceiling) inside the evaluable range. */
function clampToRange(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/** A probe value just past a located real-valued edge (one small step deeper into the failing region), clamped. */
function probePastEdge(b: EnvelopeBoundary, lo: number, hi: number): number {
	if (!b.boundaryFound) {
		return clampToRange(b.criticalValue, lo, hi);
	}
	const step = (hi - lo) * 1e-3;
	return clampToRange(b.criticalValue + step, lo, hi);
}

/**
 * Run both matchmaking boundaries, folding each into a `Metrics` sink via `recordBoundary`, and diagnose
 * each edge: the harm mechanism + lied-tier reach just past the bounded-harm edge and the static-lie
 * control still holding at `f = 1` (the de-tautologization), and the contention misfire ratio vs the
 * cap-saturation ratio (documenting the negative margin that warrants the exact-sum refinement).
 * Boundary 1 runs seeded seeker walks; Boundary 2 is a pure function. Deterministic from `(seed, config)`.
 */
export function runMatchmakingBoundaries(opts: MatchmakingBoundaryOptions = {}): MatchmakingBoundaryReport {
	const seed = opts.seed ?? DEFAULT_SEED;
	const bhOpts: BoundedHarmOptions = { seed, ...opts.boundedHarm };
	const scOpts: SeekerContentionOptions = { ...opts.seekerContention };
	const bp = boundedHarmParams(bhOpts);
	const sp = seekerContentionParams(scOpts);

	const metrics = new Metrics();
	const boundaries: EnvelopeBoundary[] = [];

	// Boundary 1 — bounded-harm vs lying-reporter fraction (seeded seeker walks).
	const harmBoundary = findBoundary(lyingFractionAxis(bhOpts));
	recordBoundary(metrics, harmBoundary);
	boundaries.push(harmBoundary);
	const pastHarm = measureBoundedHarm(probePastEdge(harmBoundary, bp.fractionFloor, bp.fractionCeiling), bhOpts, 'per-query-flip');
	const staticAtCeiling = measureBoundedHarm(bp.fractionCeiling, bhOpts, 'static-under-report');

	// Boundary 2 — hang-out-fairness vs seeker-pool contention ratio (pure function).
	const contentionBoundary = findBoundary(seekerContentionAxis(scOpts));
	recordBoundary(metrics, contentionBoundary);
	boundaries.push(contentionBoundary);
	const atEdge = measureSeekerContention(clampToRange(contentionBoundary.criticalValue, sp.ratioFloor, sp.ratioCeiling), scOpts);

	return {
		boundaries,
		metrics,
		harmMechanismAtEdge: pastHarm.harmMechanism,
		lyingTierCountPastEdge: pastHarm.lyingTierCount,
		staticUnderReportHoldsAtCeiling: staticAtCeiling.holds,
		contentionFlipOnsetRatio: contentionBoundary.criticalValue,
		contentionRatioAtCap: sp.cap - 1,
		exactContentionAtEdge: atEdge.exactContention,
		contentionRefinementWarranted: contentionBoundary.margin < 0
	};
}
