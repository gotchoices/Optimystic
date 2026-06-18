import type { VTime } from './types.js';
import { createSimWorld } from './world.js';
import { Metrics } from './metrics.js';
import {
	TopicTree,
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig,
	type TopicCohortState
} from './topic-tree.js';
import {
	expectedDepth,
	uniformLadder,
	skewedLadder,
	PromotionTracer
} from './promotion-convergence.js';
import { ParticipantWalk, type WalkTrace, type WalkAdmission } from './walk.js';
import { CollectingEventSink } from './topic-events.js';
import {
	findBoundary,
	recordBoundary,
	type EnvelopeBoundary,
	type BoundaryAxisSpec
} from './boundary.js';

/**
 * The cohort-topic **tree** operating-envelope boundaries (`simulator-envelope-tree`): three
 * heavier full-tree stress axes layered on the generic `findBoundary` harness, each pairing one
 * monotone-in-harm axis with a predicate over an existing tree claim. This is new *measurement*
 * over the existing tree model — it reuses `TopicTree`, `ParticipantWalk`, `expectedDepth`,
 * `skewedLadder`, `PromotionTracer`, and the willingness vocabulary rather than re-modeling tree
 * behaviour. (The R* / `root-not-overloaded` reference axis lives in `simulator-envelope-core`;
 * this module adds the remaining three tree rows of the parent ticket's candidate table.)
 *
 *  1. **depth-law vs prefix skew** — `skewedLadder` concentrates load into a hot shard; the
 *     observed steady-state depth first exceeds `⌈log_F(N/cap)⌉` at skew `s*`.
 *  2. **promotion/demotion stability vs churn** — arrival↔departure churn around a cohort held near
 *     `cap_promote`; depth flapping (`oscillations > 0`) first appears at churn rate `r*`.
 *  3. **walk no-give-ups + hop bound vs unwilling fraction** — a population of landing walks over a
 *     grown tree with a fraction `f` of members replying unwilling; walks first give up or breach
 *     the `≤ d_max + 2` hop bound at `f*`.
 *
 * Axes 1 and 3 grow a full tree per evaluation, so they are gated by N exactly as `sweep.ts` gates
 * its full-tree walk-hop measurement (`walkSampleMaxN`): a modest N by default, the large-N point
 * opt-in, the skip recorded. Axis 2 drives a single cohort and is never gated.
 */

const TOPIC = 'envelope-tree-topic';
const GOSSIP_ROUND_MS = 1000;

export interface TreeBoundaryOptions {
	/** Population for the full-tree axes (depth-law, unwilling). Default 2000 — depth law = 2, fast. */
	readonly N?: number;
	/** Above this N the full-tree axes are skipped (the skip is recorded). Default 10_000. */
	readonly treeSampleMaxN?: number;
	/** Fan-out per tier (default 16). */
	readonly F?: number;
	/** Direct-participant promotion cap (default 64). */
	readonly capPromote?: number;
	readonly seed?: number;
	/** Landing walks sampled for the unwilling-fraction axis (default 100). */
	readonly walkSamples?: number;
	/** Drain→demote→refill cycles per churn evaluation — the flap-detection window (default 6). */
	readonly churnCycles?: number;
}

/** Which sub-condition of the walk `no-give-ups` ∧ `hop-bound` conjunction broke at the edge. */
export type UnwillingBreach = 'give-up' | 'hop-bound' | 'both' | 'none';

/** The three tree boundaries plus the metrics sink, the N-gate skips, and the walk-axis diagnostic. */
export interface TreeBoundaryReport {
	readonly boundaries: EnvelopeBoundary[];
	readonly metrics: Metrics;
	/** Axis names skipped because N exceeded `treeSampleMaxN` (mirrors `sweep` walk-hop gating). */
	readonly skipped: string[];
	/** For the unwilling-fraction axis: which sub-condition flipped first at the located edge. */
	readonly unwillingBreach: UnwillingBreach;
}

// --- Boundary 1: depth-law vs prefix skew (full-tree, N-gated) ----------------

/** Build the prefix-skew axis spec: `holds(s)` grows a full tree and checks observed depth == the law. */
export function prefixSkewAxis(opts: Required<Pick<TreeBoundaryOptions, 'N' | 'F' | 'capPromote' | 'seed'>>): BoundaryAxisSpec {
	const { N, F, capPromote, seed } = opts;
	const expected = expectedDepth(N, F, capPromote);
	const dMax = expected + 2;
	const config: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, F, capPromote };
	return {
		claim: 'depth-law',
		axis: 'prefixSkew',
		designAssumption: 0, // the design assumes ~uniform sha256 sharding (skew 0)
		lo: 0,
		hi: 1,
		integer: false,
		holds(skew: number): boolean {
			const world = createSimWorld({ seed, gossipRoundMs: GOSSIP_ROUND_MS });
			const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS, config });
			for (let i = 0; i < N; i++) {
				tree.register(TOPIC, skewedLadder(i, dMax, F, skew, seed), 0);
			}
			return tree.maxOccupiedTier(TOPIC) === expected;
		}
	};
}

// --- Boundary 2: promotion/demotion stability vs churn (single cohort) --------

/** The churn evaluation readout: depth oscillations and the count of real demotions exercised. */
export interface ChurnReadout {
	readonly oscillations: number;
	readonly demotions: number;
}

/**
 * Run the churn scenario at rate `r` (departures+re-arrivals per round as a fraction of the cohort
 * population) and read back depth oscillations + demotions. A two-tier single branch is grown so a
 * tier-1 cohort sits near `cap_promote`; each cycle drains `⌊r·pop⌋` participants from it (high `r`
 * empties it → depth drops 1→0), ages the clock so the `T_demote` hysteresis can release it (a real
 * demotion — the "demotion is actually reachable" requirement), then refills it. Hysteresis is
 * shortened (`tDemoteMs = gossipRoundMs`, `tPromoteStickyMs = 0`) so the hysteresis itself — not an
 * unreachable demotion — is the thing under test. `oscillations` (observed-depth decreases) is read
 * from `PromotionTracer`, exactly the steady-state-flat readout the convergence validator uses.
 */
function evalChurn(r: number, F: number, capPromote: number, seed: number, cycles: number): ChurnReadout {
	const config: LifecycleConfig = {
		...DEFAULT_LIFECYCLE_CONFIG,
		F,
		capPromote,
		tDemoteMs: GOSSIP_ROUND_MS, // short hysteresis: demotion reachable within the flap window
		tPromoteStickyMs: 0
	};
	const world = createSimWorld({ seed, gossipRoundMs: GOSSIP_ROUND_MS });
	const sink = new CollectingEventSink();
	let tracer: PromotionTracer;
	const tree = new TopicTree({
		scheduler: world.scheduler,
		gossipRoundMs: GOSSIP_ROUND_MS,
		config,
		sink: { record: (e) => { sink.record(e); tracer.record(e); } }
	});
	tracer = new PromotionTracer(tree, capPromote);

	const ladder = uniformLadder(0, 1, F); // single branch, tiers 0 and 1
	let now: VTime = 0;
	// Build: cap_promote arrivals fill+promote tier 0, the next `base` land on tier 1 (held near cap).
	const base = capPromote;
	const pop = capPromote + base;
	for (let i = 0; i < pop; i++) {
		tree.register(TOPIC, ladder, now);
	}
	tracer.sample(TOPIC, now); // initial steady depth (1)

	const q = Math.floor(r * pop);
	for (let c = 0; c < cycles; c++) {
		// Drain the deepest occupied cohort.
		const deep = deepestOccupied(tree, TOPIC);
		let drained = 0;
		if (deep) {
			for (let k = 0; k < q && deep.directParticipants > 0; k++) {
				tree.detach(deep, now);
				drained++;
			}
		}
		now += GOSSIP_ROUND_MS;
		for (const s of tree.all()) {
			tree.evaluateDemotion(s, now); // age past T_demote → release the drained cohort
		}
		tracer.sample(TOPIC, now); // low point (depth 0 when fully drained)
		now += GOSSIP_ROUND_MS;
		// Refill: re-grow the branch with the same count that left.
		for (let k = 0; k < drained; k++) {
			tree.register(TOPIC, ladder, now);
		}
		for (const s of tree.all()) {
			tree.evaluatePromotion(s, now);
		}
		tracer.sample(TOPIC, now); // high point (depth 1)
		now += GOSSIP_ROUND_MS;
	}

	return { oscillations: tracer.result(0, 0).oscillations, demotions: sink.countOf('Demoted') };
}

/**
 * Public diagnostic for the churn axis: depth oscillations and the count of real demotions exercised
 * at churn rate `r`. The demotion count is the non-vacuity witness — a positive value proves the
 * cohort's demotion was actually reachable, so `oscillations` is not structurally zero (the
 * "hysteresis sticky floor" caveat).
 */
export function measureChurnFlap(
	r: number,
	opts: { F?: number; capPromote?: number; seed?: number; churnCycles?: number } = {}
): ChurnReadout {
	return evalChurn(
		r,
		opts.F ?? DEFAULT_LIFECYCLE_CONFIG.F,
		opts.capPromote ?? DEFAULT_LIFECYCLE_CONFIG.capPromote,
		opts.seed ?? 1,
		opts.churnCycles ?? 6
	);
}

/** Build the churn-flap axis spec: `holds(r)` runs the churn loop and returns `oscillations === 0`. */
export function churnFlapAxis(opts: Required<Pick<TreeBoundaryOptions, 'F' | 'capPromote' | 'seed' | 'churnCycles'>>): BoundaryAxisSpec {
	const { F, capPromote, seed, churnCycles } = opts;
	return {
		claim: 'promotion-demotion-stable',
		axis: 'churnRate',
		designAssumption: 0, // a settled tree (zero churn); T_demote is what buys the margin
		lo: 0,
		hi: 1,
		integer: false,
		holds(r: number): boolean {
			return evalChurn(r, F, capPromote, seed, churnCycles).oscillations === 0;
		}
	};
}

// --- Boundary 3: walk no-give-ups / hop bound vs unwilling fraction -----------

/** Deterministic unit float in [0, 1) from a string + salt via FNV-1a — the per-member unwilling coin. */
function unwillingCoin(coord: string, memberAttempt: number, seed: number): number {
	let h = 0x811c9dc5 >>> 0;
	const mix = (byte: number): void => {
		h ^= byte & 0xff;
		h = Math.imul(h, 0x0100_0193);
	};
	const s = (seed ^ 0x9e3779b9) >>> 0;
	for (let i = 0; i < 4; i++) {
		mix((s >>> (i * 8)) & 0xff);
	}
	for (let i = 0; i < coord.length; i++) {
		mix(coord.charCodeAt(i) & 0xff);
	}
	const a = memberAttempt >>> 0;
	for (let i = 0; i < 4; i++) {
		mix((a >>> (i * 8)) & 0xff);
	}
	return (h >>> 0) / 0x1_0000_0000;
}

/**
 * A `WalkAdmission` oracle that replies unwilling for a fraction `f` of members, deterministically
 * per `(coord, memberAttempt)`. As `f` rises the unwilling set grows monotonically (same coin, lower
 * threshold), so harm is monotone in `f`. The walk handles the rest with its own willingness
 * machinery: an unwilling member triggers a sibling retry (`+1` hop); `k` consecutive unwilling
 * members escalate to a cohort decline → back-off restart; exhausting the back-off budget is a
 * give-up. (Only `accepted`/`unwilling_member` are returned; the cohort-level decline emerges
 * structurally from consecutive member declines, exactly as the real walk drives it.)
 */
function unwillingOracle(f: number, seed: number): WalkAdmission {
	return (_state, probe) => {
		if (unwillingCoin(probe.coord, probe.memberAttempt, seed) < f) {
			return { result: 'unwilling_member' };
		}
		return { result: 'accepted' };
	};
}

/** The unwilling evaluation readout: whether the claim holds, plus the two sub-conditions for diagnosis. */
export interface UnwillingReadout {
	readonly holds: boolean;
	readonly gaveUp: number;
	readonly maxHops: number;
	readonly bound: number;
}

/** Grow a tree at N, run `walkSamples` landing walks with the fraction-`f` unwilling oracle, read give-ups + max hops. */
function evalUnwilling(f: number, N: number, F: number, capPromote: number, seed: number, walkSamples: number): UnwillingReadout {
	const expected = expectedDepth(N, F, capPromote);
	const dMax = expected + 2;
	const config: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, F, capPromote };
	const world = createSimWorld({ seed, gossipRoundMs: GOSSIP_ROUND_MS });
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS, config });
	for (let i = 0; i < N; i++) {
		tree.register(TOPIC, uniformLadder(i, dMax, F), 0);
	}
	const admission = unwillingOracle(f, seed);
	const traces: WalkTrace[] = [];
	const rng = world.rng.fork('unwilling-walk');
	for (let s = 0; s < walkSamples; s++) {
		const idx = rng.nextInt(N);
		const walk = new ParticipantWalk({
			scheduler: world.scheduler,
			tree,
			participant: { id: `u${s}`, key: new Uint8Array(32) },
			topicId: TOPIC,
			ladder: uniformLadder(idx, dMax, F),
			admission,
			onComplete: (t) => traces.push(t)
		});
		walk.start();
	}
	world.scheduler.run();
	const gaveUp = traces.reduce((n, t) => (t.outcome === 'gave-up' ? n + 1 : n), 0);
	const maxHops = traces.reduce((m, t) => Math.max(m, t.hops), 0);
	const bound = dMax + 2;
	return { holds: gaveUp === 0 && maxHops <= bound, gaveUp, maxHops, bound };
}

/**
 * Public diagnostic for the unwilling axis: whether the claim holds at fraction `f`, plus the two
 * sub-conditions (give-up count, max hops vs the bound) so a caller can see *which* part of the
 * conjunction is under pressure.
 */
export function measureUnwillingWalks(
	f: number,
	opts: { N?: number; F?: number; capPromote?: number; seed?: number; walkSamples?: number } = {}
): UnwillingReadout {
	return evalUnwilling(
		f,
		opts.N ?? 2000,
		opts.F ?? DEFAULT_LIFECYCLE_CONFIG.F,
		opts.capPromote ?? DEFAULT_LIFECYCLE_CONFIG.capPromote,
		opts.seed ?? 1,
		opts.walkSamples ?? 100
	);
}

/** Build the unwilling-fraction axis spec: `holds(f)` runs a walk population and returns no-give-ups ∧ hop-bound. */
export function unwillingFractionAxis(opts: Required<Pick<TreeBoundaryOptions, 'N' | 'F' | 'capPromote' | 'seed' | 'walkSamples'>>): BoundaryAxisSpec {
	const { N, F, capPromote, seed, walkSamples } = opts;
	return {
		claim: 'no-give-ups',
		axis: 'unwillingFraction',
		designAssumption: 0,
		lo: 0,
		hi: 1,
		integer: false,
		holds(f: number): boolean {
			return evalUnwilling(f, N, F, capPromote, seed, walkSamples).holds;
		}
	};
}

// --- driver ------------------------------------------------------------------

/** The deepest cohort currently holding participants for `topicId` — the churn drain target. */
function deepestOccupied(tree: TopicTree, topicId: string): TopicCohortState | undefined {
	let deepest: TopicCohortState | undefined;
	for (const s of tree.all()) {
		if (s.topicId === topicId && s.directParticipants > 0) {
			if (!deepest || s.tier > deepest.tier) {
				deepest = s;
			}
		}
	}
	return deepest;
}

/**
 * Run all three tree boundaries, folding each into a `Metrics` sink via `recordBoundary`. The two
 * full-tree axes (prefix-skew, unwilling-fraction) are gated by N: when `N > treeSampleMaxN` they
 * are skipped and the skip recorded (`boundary.skipped` counter + the returned `skipped` list),
 * mirroring `sweep`'s `walkHopsSkipped`. The churn axis drives a single cohort and always runs.
 * Deterministic from `(seed, config)`.
 */
export function runTreeBoundaries(opts: TreeBoundaryOptions = {}): TreeBoundaryReport {
	const N = opts.N ?? 2000;
	const treeSampleMaxN = opts.treeSampleMaxN ?? 10_000;
	const F = opts.F ?? DEFAULT_LIFECYCLE_CONFIG.F;
	const capPromote = opts.capPromote ?? DEFAULT_LIFECYCLE_CONFIG.capPromote;
	const seed = opts.seed ?? 1;
	const walkSamples = opts.walkSamples ?? 100;
	const churnCycles = opts.churnCycles ?? 6;

	const metrics = new Metrics();
	const boundaries: EnvelopeBoundary[] = [];
	const skipped: string[] = [];
	const fullTreeGated = N > treeSampleMaxN;

	// Boundary 1 — depth-law vs prefix skew (full-tree, N-gated).
	if (fullTreeGated) {
		skipped.push('prefixSkew');
		metrics.counter('boundary.skipped', 1, { axis: 'prefixSkew' });
	} else {
		const b = findBoundary(prefixSkewAxis({ N, F, capPromote, seed }));
		recordBoundary(metrics, b);
		boundaries.push(b);
	}

	// Boundary 2 — promotion/demotion stability vs churn (single cohort, never gated).
	{
		const b = findBoundary(churnFlapAxis({ F, capPromote, seed, churnCycles }));
		recordBoundary(metrics, b);
		boundaries.push(b);
	}

	// Boundary 3 — walk no-give-ups / hop bound vs unwilling fraction (full-tree, N-gated).
	let unwillingBreach: UnwillingBreach = 'none';
	if (fullTreeGated) {
		skipped.push('unwillingFraction');
		metrics.counter('boundary.skipped', 1, { axis: 'unwillingFraction' });
	} else {
		const b = findBoundary(unwillingFractionAxis({ N, F, capPromote, seed, walkSamples }));
		recordBoundary(metrics, b);
		boundaries.push(b);
		unwillingBreach = diagnoseUnwillingBreach(b, N, F, capPromote, seed, walkSamples);
	}

	return { boundaries, metrics, skipped, unwillingBreach };
}

/**
 * Determine which sub-condition of the walk conjunction (`no-give-ups` vs the `≤ d_max + 2` hop
 * bound) flipped first, by re-evaluating just past the located edge. Member retries each cost a hop,
 * so the hop bound typically breaches before walks actually give up — recording which lets the
 * readout be diagnosed rather than guessed.
 */
function diagnoseUnwillingBreach(b: EnvelopeBoundary, N: number, F: number, capPromote: number, seed: number, walkSamples: number): UnwillingBreach {
	if (!b.boundaryFound) {
		return 'none';
	}
	const step = b.scanHi * 1e-3;
	const probe = Math.min(b.scanHi, Math.max(b.criticalValue + step, step));
	const r = evalUnwilling(probe, N, F, capPromote, seed, walkSamples);
	const gaveUp = r.gaveUp > 0;
	const hopBound = r.maxHops > r.bound;
	if (gaveUp && hopBound) {
		return 'both';
	}
	if (gaveUp) {
		return 'give-up';
	}
	if (hopBound) {
		return 'hop-bound';
	}
	return 'none';
}
