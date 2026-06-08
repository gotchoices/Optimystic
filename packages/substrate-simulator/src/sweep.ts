import type { VTime } from './types.js';
import { createSimWorld } from './world.js';
import { Metrics } from './metrics.js';
import { TopicTree, DEFAULT_LIFECYCLE_CONFIG } from './topic-tree.js';
import {
	runConvergence,
	expectedDepth,
	uniformLadder
} from './promotion-convergence.js';
import { ParticipantWalk, type WalkTrace } from './walk.js';
import { hopPercentile } from './walk-metrics.js';
import { coverageSeconds } from './reactivity.js';
import {
	decideHangOut,
	contentionFactor,
	DEFAULT_MATCHMAKING_CONFIG,
	type SeekerDemand
} from './matchmaking.js';
import type { TopicTrafficV1 } from './topic-events.js';

/**
 * The scale + sensitivity sweep — the gate's quantitative core (`simulator-metrics-and-scenarios`
 * Phase 3). The **scale sweep** confirms the cohort-topic depth law `⌈log_F(N/cap_promote)⌉` and the
 * logarithmic lookup cost across N ∈ {100 … 1M}; the **sensitivity sweep** quantifies how each tunable
 * parameter (`cap_promote`, `F`, `d_max_cap`, `W`/`W_checkpoint`, `contention_factor_cap`) moves the
 * design's headline metrics — convergence time, walk hops, replay coverage, hang-out feasibility.
 * Both fold their readouts into a `Metrics` sink for JSON/CSV export; the sensitivity report is the
 * input artifact `fold-simulator-findings-into-design-docs` consumes.
 *
 * Performance: the depth law is measured by `runConvergence` (one driven run per N, virtual clock).
 * Walk-hop measurement grows a full tree via `TopicTree.register`, so it is gated to N ≤
 * `walkSampleMaxN` (default 10k) — beyond that, the depth law plus the `≤ d_max + 2` lookup bound
 * (both O(log N) by construction) carry the claim, and the skip is recorded. The N = 1M scale point
 * is likewise opt-in (`SCALE_NS` / explicit `Ns`) so a default agent run stays inside its time budget.
 */

const TOPIC = 'sweep-topic';
const GOSSIP_ROUND_MS = 1000;
const F_DEFAULT = DEFAULT_LIFECYCLE_CONFIG.F;
const CAP_DEFAULT = DEFAULT_LIFECYCLE_CONFIG.capPromote;

// --- scale sweep -------------------------------------------------------------

export interface ScaleSweepOptions {
	/** Population sizes to sweep (ascending). Default {100, 1k, 10k, 100k}; add 1M explicitly. */
	readonly Ns?: readonly number[];
	/** Above this N, the full-tree walk-hop measurement is skipped (depth law still measured). */
	readonly walkSampleMaxN?: number;
	/** Landing walks sampled per measured N for the hop distribution. */
	readonly walkSamples?: number;
	readonly seed?: number;
}

/** Per-N scale readout (ticket §Scale sweep). */
export interface ScaleSample {
	readonly N: number;
	readonly F: number;
	readonly capPromote: number;
	readonly expectedDepth: number;
	readonly observedDepth: number;
	readonly convergenceLatencyMs: VTime;
	readonly peakOvershoot: number;
	/** d_max used for the walk ladders (= expectedDepth + 2). */
	readonly dMax: number;
	/** p95 / max landing-walk hops; −1 when the walk measurement was skipped for this N. */
	readonly walkHopsP95: number;
	readonly walkHopsMax: number;
	readonly walkMeasured: boolean;
	/** Observed steady-state depth equals the closed-form law. */
	readonly depthMatches: boolean;
	/** Lookup cost stayed within the logarithmic bound (`walkHopsMax ≤ d_max + 2`). */
	readonly hopsBounded: boolean;
}

export interface ScaleSweepResult {
	readonly samples: ScaleSample[];
	readonly metrics: Metrics;
}

// The full N sweep including 1M. The depth law is measured by `runConvergence` on the virtual clock,
// which drains 1M arrivals in ~10s — cheap enough to keep 1M in the default run. Only the full-tree
// walk-hop measurement (which calls `register` N times) is gated, via `walkSampleMaxN`.
const DEFAULT_SCALE_NS: readonly number[] = [100, 1_000, 10_000, 100_000, 1_000_000];

/**
 * Run the N-scale sweep. For each N: drive `runConvergence` to read the steady-state depth + timing,
 * and (when N ≤ `walkSampleMaxN`) grow a full tree and sample landing-walk hops. Records every readout
 * into the returned `Metrics` and computes per-N pass flags for the depth law and the lookup bound.
 */
export function runScaleSweep(opts: ScaleSweepOptions = {}): ScaleSweepResult {
	const Ns = opts.Ns ?? DEFAULT_SCALE_NS;
	const walkSampleMaxN = opts.walkSampleMaxN ?? 10_000;
	const walkSamples = opts.walkSamples ?? 100;
	const seed = opts.seed ?? 1;
	const metrics = new Metrics();
	const samples: ScaleSample[] = [];

	for (const N of Ns) {
		const expected = expectedDepth(N, F_DEFAULT, CAP_DEFAULT);
		const dMax = expected + 2;
		const convergence = runConvergence({ N, lookahead: true });
		let walkHopsP95 = -1;
		let walkHopsMax = -1;
		let walkMeasured = false;
		if (N <= walkSampleMaxN) {
			const hops = measureWalkHops(N, F_DEFAULT, CAP_DEFAULT, dMax, walkSamples, seed);
			walkHopsP95 = hops.p95;
			walkHopsMax = hops.max;
			walkMeasured = true;
		}
		const sample: ScaleSample = {
			N,
			F: F_DEFAULT,
			capPromote: CAP_DEFAULT,
			expectedDepth: expected,
			observedDepth: convergence.steadyStateDepth,
			convergenceLatencyMs: convergence.convergenceLatency,
			peakOvershoot: convergence.peakOvershoot,
			dMax,
			walkHopsP95,
			walkHopsMax,
			walkMeasured,
			depthMatches: convergence.steadyStateDepth === expected,
			hopsBounded: !walkMeasured || walkHopsMax <= dMax + 2
		};
		samples.push(sample);
		recordScaleSample(metrics, sample);
	}
	return { samples, metrics };
}

/** Fold one scale sample into the metrics sink (counters + timelines keyed by N). */
function recordScaleSample(metrics: Metrics, s: ScaleSample): void {
	const tags = { N: s.N };
	metrics.counter('scale.observedDepth', s.observedDepth, tags);
	metrics.counter('scale.expectedDepth', s.expectedDepth, tags);
	metrics.timeline('scale.depthByN', s.N, s.observedDepth);
	metrics.timeline('scale.convergenceLatencyByN', s.N, s.convergenceLatencyMs);
	if (s.walkMeasured) {
		metrics.histogram('scale.walkHopsMax', s.walkHopsMax, tags);
		metrics.timeline('scale.walkHopsMaxByN', s.N, s.walkHopsMax);
	} else {
		metrics.counter('scale.walkHopsSkipped', 1, tags);
	}
}

/** Grow a steady-state tree at N via `register`, then sample `walkSamples` landing walks; read p95/max hops. */
function measureWalkHops(N: number, F: number, capPromote: number, dMax: number, walkSamples: number, seed: number): { p95: number; max: number } {
	const world = createSimWorld({ seed, gossipRoundMs: GOSSIP_ROUND_MS });
	const tree = new TopicTree({
		scheduler: world.scheduler,
		gossipRoundMs: GOSSIP_ROUND_MS,
		config: { ...DEFAULT_LIFECYCLE_CONFIG, F, capPromote }
	});
	for (let i = 0; i < N; i++) {
		tree.register(TOPIC, uniformLadder(i, dMax, F), 0);
	}
	const traces: WalkTrace[] = [];
	const rng = world.rng.fork('walk-sample');
	for (let s = 0; s < walkSamples; s++) {
		const idx = rng.nextInt(N);
		const walk = new ParticipantWalk({
			scheduler: world.scheduler,
			tree,
			participant: { id: `w${s}`, key: new Uint8Array(32) },
			topicId: TOPIC,
			ladder: uniformLadder(idx, dMax, F),
			onComplete: (t) => traces.push(t)
		});
		walk.start();
	}
	world.scheduler.run();
	return { p95: hopPercentile(traces, 95), max: hopPercentile(traces, 100) };
}

// --- sensitivity sweep -------------------------------------------------------

/** A swept parameter and the metric it moves. */
export type SweepParameter =
	| 'cap_promote'
	| 'F'
	| 'd_max_cap'
	| 'W'
	| 'W_checkpoint'
	| 'contention_factor_cap';

/** One parameter-value → metric readout (the fold-back's input row). */
export interface SensitivitySample {
	readonly parameter: SweepParameter;
	readonly value: number;
	readonly metric: string;
	readonly observed: number;
}

export interface SensitivitySweepResult {
	readonly samples: SensitivitySample[];
	readonly metrics: Metrics;
}

export interface SensitivitySweepOptions {
	/** Population for the convergence/walk measurements (default 10k). */
	readonly N?: number;
	/** Commit rate (commits/sec) for the replay-coverage measurements (default 10). */
	readonly cps?: number;
}

const CAP_PROMOTE_VALUES = [16, 32, 64, 128];
const F_VALUES = [4, 8, 16, 32];
const D_MAX_CAP_VALUES = [3, 4, 5, 6];
const W_VALUES = [64, 256, 1024, 4096];
const W_CHECKPOINT_VALUES = [1024, 4096, 16_384];
const CONTENTION_CAP_VALUES = [1, 2, 4, 8];

/**
 * Run the parameter-sensitivity sweep — vary one knob at a time and record its effect on the
 * relevant headline metric. Produces the JSON/CSV report `fold-simulator-findings-into-design-docs`
 * consumes; each parameter's samples are monotone in the direction the design predicts (more capacity
 * ⇒ shallower tree, larger fan-out ⇒ shallower tree, deeper `d_max` ⇒ costlier cold lookup, larger
 * window ⇒ longer recovery coverage, higher contention cap ⇒ higher hang-out threshold).
 */
export function runSensitivitySweep(opts: SensitivitySweepOptions = {}): SensitivitySweepResult {
	const N = opts.N ?? 10_000;
	const cps = opts.cps ?? 10;
	const metrics = new Metrics();
	const samples: SensitivitySample[] = [];
	const push = (parameter: SweepParameter, value: number, metric: string, observed: number): void => {
		samples.push({ parameter, value, metric, observed });
		metrics.histogram(`sweep.${parameter}.${metric}`, observed, { value });
		metrics.timeline(`sweep.${parameter}.${metric}`, value, observed);
	};

	// cap_promote → convergence depth + latency.
	for (const capPromote of CAP_PROMOTE_VALUES) {
		const r = runConvergence({ N, capPromote, lookahead: true });
		push('cap_promote', capPromote, 'observedDepth', r.steadyStateDepth);
		push('cap_promote', capPromote, 'convergenceLatencyMs', r.convergenceLatency);
	}

	// F (fan-out) → convergence depth.
	for (const F of F_VALUES) {
		const r = runConvergence({ N, F, lookahead: true });
		push('F', F, 'observedDepth', r.steadyStateDepth);
	}

	// d_max_cap → cold-lookup hop cost (probes every tier inward, then bootstraps).
	for (const dMaxCap of D_MAX_CAP_VALUES) {
		push('d_max_cap', dMaxCap, 'walkHopsMax', measureColdWalkHops(dMaxCap, F_DEFAULT));
	}

	// W / W_checkpoint → recovery-window coverage at the fixed commit rate.
	for (const W of W_VALUES) {
		push('W', W, 'replayCoverageSeconds', coverageSeconds(W, cps));
	}
	for (const Wcheckpoint of W_CHECKPOINT_VALUES) {
		push('W_checkpoint', Wcheckpoint, 'checkpointCoverageSeconds', coverageSeconds(Wcheckpoint, cps));
	}

	// contention_factor_cap → hang-out threshold on a fixed high-contention reply.
	for (const cap of CONTENTION_CAP_VALUES) {
		const { threshold, hangOut } = measureContentionThreshold(cap);
		push('contention_factor_cap', cap, 'hangOutThreshold', threshold);
		push('contention_factor_cap', cap, 'hangOut', hangOut ? 1 : 0);
	}

	return { samples, metrics };
}

/** Cold lookup hop count on an empty tree with ladder depth `dMaxCap`: probes d_max…0 then bootstraps. */
function measureColdWalkHops(dMaxCap: number, F: number): number {
	const world = createSimWorld({ seed: 1, gossipRoundMs: GOSSIP_ROUND_MS });
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs: GOSSIP_ROUND_MS });
	let trace: WalkTrace | undefined;
	const walk = new ParticipantWalk({
		scheduler: world.scheduler,
		tree,
		participant: { id: 'cold', key: new Uint8Array(32) },
		topicId: TOPIC,
		ladder: uniformLadder(0, dMaxCap, F),
		onComplete: (t) => {
			trace = t;
		}
	});
	walk.start();
	world.scheduler.run();
	return trace?.hops ?? 0;
}

const CONTENTION_TRAFFIC: TopicTrafficV1 = {
	windowSeconds: 60,
	arrivalsPerMin: 10,
	queriesPerMin: 100,
	directParticipants: 2,
	childCohortCount: 0
};

/** The hang-out threshold (and resulting decision) at a given `contention_factor_cap` on a fixed reply. */
function measureContentionThreshold(cap: number): { threshold: number; hangOut: boolean } {
	const demand: SeekerDemand = { wantCount: 3, patienceMs: 10_000, filterAcceptRatio: 1.0 };
	const config = { ...DEFAULT_MATCHMAKING_CONFIG, contentionFactorCap: cap };
	const contention = contentionFactor(
		CONTENTION_TRAFFIC.arrivalsPerMin,
		CONTENTION_TRAFFIC.queriesPerMin,
		config.meanWantCount,
		cap
	);
	const decision = decideHangOut(CONTENTION_TRAFFIC, demand.wantCount - 1, demand, config);
	return { threshold: demand.wantCount * contention, hangOut: decision.action === 'hang-out' };
}

/** Samples for one swept parameter, in sweep order — convenience for monotonicity checks. */
export function samplesFor(result: SensitivitySweepResult, parameter: SweepParameter, metric: string): SensitivitySample[] {
	return result.samples.filter((s) => s.parameter === parameter && s.metric === metric);
}
