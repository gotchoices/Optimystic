import type { VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import { log2F } from './topic-addressing.js';
import { createSimWorld } from './world.js';
import {
	TopicTree,
	DEFAULT_LIFECYCLE_CONFIG,
	type LifecycleConfig
} from './topic-tree.js';
import {
	type EventSink,
	type SimEvent,
	NULL_EVENT_SINK
} from './topic-events.js';

/**
 * Promotion-depth tracer + convergence validator, modeled against `docs/cohort-topic.md` §Tree
 * growth and lookup and §Promotion and demotion lifecycle. It answers the central cohort-topic
 * scaling claim — that a topic's tree settles at steady-state depth `⌈log_F(N / cap_promote)⌉` —
 * and quantifies the *quality* of that convergence: how far the promotion window overshoots
 * `cap_promote`, how long depth takes to stabilize after load peaks, and how much (if at all) depth
 * oscillates before the `cap_promote`/`cap_demote` + `T_demote` hysteresis locks it.
 *
 * The tracer subscribes to the tree's `Promoted`/`Demoted` event stream (an `EventSink`), sampling
 * the depth-over-time timeline (`DepthSample[]`) on every depth-changing event, and is also sampled
 * explicitly once per gossip round by the driver so the *pre-promotion* peak (the overshoot) is
 * captured. The validator (`PromotionTracer.result`) derives the `ConvergenceResult` from that
 * timeline. Everything here is synchronous and clock-free — coordinates are synthetic prefix-shard
 * ladders (`uniformLadder`), not sha256, so the depth *law* is isolated from prefix-distribution
 * noise (which `topic-addressing.spec` and the real-sha256 smoke check in `topic-tree.spec` cover).
 */

/** A sampled `(time, depth)` point for one topic — the tracer's timeline element. */
export interface DepthSample {
	readonly t: VTime;
	readonly topicId: string;
	/** Deepest tier currently holding participants for this topic. */
	readonly maxDepth: number;
	/** Distinct `(tier, coord)` coordinates instantiated for this topic. */
	readonly coordCount: number;
	/** Coordinates currently above `cap_promote` (cohorts in/just-past the promotion window). */
	readonly overCapCount: number;
}

/** The validated convergence readout for one N (cohort-topic.md §Tree growth and lookup). */
export interface ConvergenceResult {
	/** Observed steady-state depth (final `maxDepth`). */
	readonly steadyStateDepth: number;
	/** The law: `⌈log_F(N / cap_promote)⌉`. */
	readonly expectedDepth: number;
	/** Virtual time from peak load to depth stabilization; 0 if depth converged before load peaked. */
	readonly convergenceLatency: VTime;
	/** Max `directParticipants` past `cap_promote` at any cohort during the promotion window. */
	readonly peakOvershoot: number;
	/** Observed-depth decreases across the timeline — flapping would show up here (0 = monotone lock). */
	readonly oscillations: number;
}

/**
 * The steady-state depth law `⌈log_F(N / cap_promote)⌉`, clamped at 0 for the sparse regime
 * (`N ≤ cap_promote`, only the root exists). The independent oracle the sweep asserts against.
 */
export function expectedDepth(N: number, F: number, capPromote: number): number {
	if (N <= capPromote) {
		return 0;
	}
	return Math.max(0, Math.ceil(Math.log(N / capPromote) / Math.log(F)));
}

/**
 * Snapshot the depth timeline element for `topicId` from the tree's live cohort states at `now`:
 * deepest occupied tier, distinct instantiated coords, and how many sit above `capPromote`.
 */
export function sampleDepth(tree: TopicTree, topicId: string, capPromote: number, now: VTime): DepthSample {
	let maxDepth = 0;
	let coordCount = 0;
	let overCapCount = 0;
	for (const s of tree.all()) {
		if (s.topicId !== topicId) {
			continue;
		}
		coordCount++;
		if (s.directParticipants > 0 && s.tier > maxDepth) {
			maxDepth = s.tier;
		}
		if (s.directParticipants > capPromote) {
			overCapCount++;
		}
	}
	return { t: now, topicId, maxDepth, coordCount, overCapCount };
}

/**
 * Records the depth-over-time timeline for one topic and derives the `ConvergenceResult`. Doubles as
 * an `EventSink`: the tree's `Promoted`/`Demoted` events drive a sample each (the depth-changing
 * stream the tracer subscribes to), and the convergence driver also calls `sample` once per gossip
 * round to capture the pre-promotion peak. `peakOvershoot` is tracked as the running max excess past
 * `cap_promote` across every cohort, refreshed on every sample.
 */
export class PromotionTracer implements EventSink {
	readonly samples: DepthSample[] = [];
	private peakExcess = 0;

	constructor(
		private readonly tree: TopicTree,
		private readonly capPromote: number,
		private readonly downstream: EventSink = NULL_EVENT_SINK
	) {}

	/** `EventSink` — forward downstream, then sample on depth-changing (`Promoted`/`Demoted`) events. */
	record(event: SimEvent): void {
		this.downstream.record(event);
		if (event.kind === 'Promoted' || event.kind === 'Demoted') {
			this.sample(event.topicId, event.at);
		}
	}

	/** Append a timeline sample for `topicId` at `now` and refresh the running overshoot peak. */
	sample(topicId: string, now: VTime): void {
		this.samples.push(sampleDepth(this.tree, topicId, this.capPromote, now));
		for (const s of this.tree.all()) {
			if (s.topicId !== topicId) {
				continue;
			}
			const excess = s.directParticipants - this.capPromote;
			if (excess > this.peakExcess) {
				this.peakExcess = excess;
			}
		}
	}

	/** Peak `directParticipants` past `cap_promote` observed across the whole run. */
	peakOvershoot(): number {
		return this.peakExcess;
	}

	/**
	 * Derive the `ConvergenceResult` from the recorded timeline. `steadyStateDepth` is the final
	 * `maxDepth`; `convergenceLatency` is the gap from `peakLoadAt` to the last depth change (0 when
	 * depth stabilized before load peaked); `oscillations` counts observed-depth *decreases* (a
	 * demotion-then-regrowth flap would register here — 0 under monotone convergence).
	 */
	result(expected: number, peakLoadAt: VTime): ConvergenceResult {
		const { samples } = this;
		const steadyStateDepth = samples.length > 0 ? samples[samples.length - 1]!.maxDepth : 0;
		let stabilizedAt = samples.length > 0 ? samples[0]!.t : 0;
		let oscillations = 0;
		for (let i = 1; i < samples.length; i++) {
			if (samples[i]!.maxDepth !== samples[i - 1]!.maxDepth) {
				stabilizedAt = samples[i]!.t;
			}
			if (samples[i]!.maxDepth < samples[i - 1]!.maxDepth) {
				oscillations++;
			}
		}
		return {
			steadyStateDepth,
			expectedDepth: expected,
			convergenceLatency: Math.max(0, stabilizedAt - peakLoadAt),
			peakOvershoot: this.peakExcess,
			oscillations
		};
	}
}

/**
 * A synthetic per-participant tier coordinate ladder with *idealized uniform* prefix sharding:
 * `ladder[d]` keys the tier-`d` cohort for bucket `index mod F^d`. Because `index mod F^d` refines
 * `index mod F^(d-1)` (`bucket_d mod F^(d-1) = bucket_{d-1}`), the ladder nests correctly into one
 * tree, and the F^d buckets at tier `d` fill perfectly evenly — removing the prefix-distribution
 * noise that real-sha256 addressing carries, so the observed steady-state depth tracks
 * `⌈log_F(N / cap_promote)⌉` without sharding skew. Note this isolates the promotion *law* but does
 * not make observed depth *identical* to the closed form at every N: the law is itself a ±1
 * approximation near the `N = cap_promote · F^k` boundaries, because it ignores that promoted
 * ancestors *retain* their participants (so depth `d` actually holds slightly more than `cap · F^d`
 * across the tier), and because slope-based lookahead can pre-promote a still-ramping root in the
 * sparse regime (`N ≲ cap_promote` ⇒ observed depth 1, not 0). The sweep N's are chosen clear of
 * those boundaries so observed and law coincide; the boundary-characterization spec pins the edges.
 * The coord packs `d` then the 32-bit bucket then a topic marker into 32 bytes; distinct
 * `(d, bucket)` ⇒ distinct coord.
 */
export function uniformLadder(index: number, dMax: number, F: number, marker = 0xed): RingCoord[] {
	if (!Number.isInteger(index) || index < 0) {
		throw new RangeError(`index must be a non-negative integer, got ${index}`);
	}
	if (!Number.isInteger(dMax) || dMax < 0) {
		throw new RangeError(`dMax must be a non-negative integer, got ${dMax}`);
	}
	log2F(F); // assert F is a power of two ≥ 2
	const ladder: RingCoord[] = [];
	for (let d = 0; d <= dMax; d++) {
		const buckets = Math.pow(F, d);
		if (buckets > 0xffff_ffff) {
			throw new RangeError(`F^${d} exceeds the 32-bit bucket field; reduce dMax`);
		}
		const bucket = d === 0 ? 0 : index % buckets;
		const coord = new Uint8Array(32);
		coord[0] = d;
		coord[1] = (bucket >>> 24) & 0xff;
		coord[2] = (bucket >>> 16) & 0xff;
		coord[3] = (bucket >>> 8) & 0xff;
		coord[4] = bucket & 0xff;
		coord[5] = marker & 0xff;
		ladder.push(coord);
	}
	return ladder;
}

/** A fixed opaque topic label for convergence runs (topicId is just a map key here). */
const CONVERGENCE_TOPIC = 'promotion-convergence';

export interface ConvergenceOptions {
	/** Active participant count for the topic. */
	readonly N: number;
	/** Enable slope-based pre-promotion (`T_promote_lookahead`); off ⇒ strictly higher overshoot. */
	readonly lookahead: boolean;
	/** Fan-out per tier (default 16). */
	readonly F?: number;
	/** Direct-participant cap before promotion (default 64). */
	readonly capPromote?: number;
	/** Gossip-round cadence = the promotion-decision lag quantum (default 1000 ms). */
	readonly gossipRoundMs?: VTime;
	/** Arrivals applied per round — the load-ramp rate. Bounds overshoot (`peakOvershoot < R`). */
	readonly arrivalsPerRound?: number;
	/** Ladder depth = `expectedDepth + dMaxPad` (default 2). */
	readonly dMaxPad?: number;
	/** Extra rounds after the last arrival, for depth to settle (default 5). */
	readonly settleRounds?: number;
	/** Reserved for sweep-API parity; the uniform model is fully deterministic regardless. */
	readonly seed?: number;
	/** Base lifecycle config; `tPromoteLookaheadMs` and `growthWindowMs` are overridden per run. */
	readonly lifecycle?: LifecycleConfig;
}

/**
 * Run one gossip-lagged growth scenario and validate convergence. Arrivals are applied in batches of
 * `arrivalsPerRound` on the virtual clock; promotion is evaluated *once per round* on the prior
 * round's counts (the lag), so without lookahead a cohort accrues up to one round of arrivals past
 * `cap_promote` before promotion lands (`peakOvershoot < arrivalsPerRound`), while the slope-based
 * pre-promotion fires a round early and drives that overshoot to ~0. Returns the `ConvergenceResult`.
 *
 * This is the validator `simulator-metrics-and-scenarios` invokes across the N sweep.
 */
export function runConvergence(opts: ConvergenceOptions): ConvergenceResult {
	const F = opts.F ?? DEFAULT_LIFECYCLE_CONFIG.F;
	const capPromote = opts.capPromote ?? DEFAULT_LIFECYCLE_CONFIG.capPromote;
	const gossipRoundMs = opts.gossipRoundMs ?? 1000;
	const N = opts.N;
	if (!Number.isInteger(N) || N < 0) {
		throw new RangeError(`N must be a non-negative integer, got ${N}`);
	}
	// Default ramp rate keeps the round count bounded (~≤200) so the 100k sweep stays fast; the
	// overshoot tests pass an explicit small rate so the `< R` bound is crisp.
	const arrivalsPerRound = opts.arrivalsPerRound ?? Math.max(8, Math.ceil(N / 200));
	const dMaxPad = opts.dMaxPad ?? 2;
	const settleRounds = opts.settleRounds ?? 5;
	const expected = expectedDepth(N, F, capPromote);
	const dMax = expected + dMaxPad;

	const base = opts.lifecycle ?? DEFAULT_LIFECYCLE_CONFIG;
	const lifecycle: LifecycleConfig = {
		...base,
		F,
		capPromote,
		// Lookahead window = one gossip round: pre-promotion fires a round early (near the cap, not
		// far below it), which removes the lagged overshoot without inducing premature extra depth.
		tPromoteLookaheadMs: opts.lookahead ? gossipRoundMs : 0,
		// Hold enough samples for a stable slope across rounds.
		growthWindowMs: 5 * gossipRoundMs
	};

	const world = createSimWorld({ seed: opts.seed ?? 1, gossipRoundMs });
	// The tree and tracer are mutually referential (tracer samples the tree; the tree emits to the
	// tracer). A thin forwarding sink closes the cycle: it captures `tracer`, which is assigned before
	// any event fires (events only fire inside `scheduler.run`, after construction).
	let tracer: PromotionTracer;
	const sink: EventSink = { record: (e) => tracer.record(e) };
	const tree = new TopicTree({ scheduler: world.scheduler, gossipRoundMs, config: lifecycle, sink });
	tracer = new PromotionTracer(tree, capPromote);

	return driveConvergence({
		world,
		tree,
		tracer,
		F,
		dMax,
		expected,
		N,
		arrivalsPerRound,
		settleRounds,
		gossipRoundMs
	});
}

interface DriveArgs {
	readonly world: ReturnType<typeof createSimWorld>;
	readonly tree: TopicTree;
	readonly tracer: PromotionTracer;
	readonly F: number;
	readonly dMax: number;
	readonly expected: number;
	readonly N: number;
	readonly arrivalsPerRound: number;
	readonly settleRounds: number;
	readonly gossipRoundMs: VTime;
}

/** The round loop: lagged promotion → apply this round's arrivals → sample. */
function driveConvergence(a: DriveArgs): ConvergenceResult {
	let nextIndex = 0;
	let peakLoadAt: VTime | undefined;
	const totalRounds = Math.ceil(a.N / a.arrivalsPerRound) + a.settleRounds;

	const runRound = (now: VTime): void => {
		// Lagged promotion decision: evaluate on the counts accumulated through the previous round.
		for (const s of a.tree.all()) {
			a.tree.evaluatePromotion(s, now);
		}
		// This round's arrivals land (count bumped, promotion deferred to next round).
		const upto = Math.min(nextIndex + a.arrivalsPerRound, a.N);
		for (; nextIndex < upto; nextIndex++) {
			a.tree.routeArrival(CONVERGENCE_TOPIC, uniformLadder(nextIndex, a.dMax, a.F), now);
		}
		if (nextIndex >= a.N && peakLoadAt === undefined) {
			peakLoadAt = now;
		}
		// Capture the pre-(next-round)-promotion peak — where overshoot is highest.
		a.tracer.sample(CONVERGENCE_TOPIC, now);
	};

	let fired = 0;
	const tick = (): void => {
		runRound(a.world.scheduler.now());
		fired++;
		if (fired < totalRounds) {
			a.world.scheduler.scheduleAfter(a.gossipRoundMs, tick);
		}
	};
	a.world.scheduler.scheduleAfter(a.gossipRoundMs, tick);
	a.world.scheduler.run();

	return a.tracer.result(a.expected, peakLoadAt ?? a.world.scheduler.now());
}

/** Both arms of the lookahead-on vs lookahead-off comparison, same population/parameters. */
export interface OvershootComparison {
	readonly withLookahead: ConvergenceResult;
	readonly withoutLookahead: ConvergenceResult;
}

/**
 * Run the same convergence scenario with slope-based pre-promotion on and off (cohort-topic.md
 * §Promotion: `T_promote_lookahead`). Same seed/population/parameters, so the only difference is
 * *when* promotion fires — confirming lookahead strictly reduces promotion-window overshoot.
 */
export function compareLookahead(opts: Omit<ConvergenceOptions, 'lookahead'>): OvershootComparison {
	return {
		withLookahead: runConvergence({ ...opts, lookahead: true }),
		withoutLookahead: runConvergence({ ...opts, lookahead: false })
	};
}
