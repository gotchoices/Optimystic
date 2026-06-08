import type { EventScheduler, EventContext, PeerRef, VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import type { TopicTrafficV1, EventSink } from './topic-events.js';
import { NULL_EVENT_SINK } from './topic-events.js';
import { TopicTree } from './topic-tree.js';
import { ParticipantWalk } from './walk.js';
import {
	type CapabilityFilter,
	type SimProvider,
	type MatchmakingConfig,
	DEFAULT_MATCHMAKING_CONFIG,
	decideHangOut,
	countMatchable,
	FilterAcceptEstimator
} from './matchmaking.js';

/**
 * The seeker hang-out-vs-continue walk + path tracer — the modeled mirror of `docs/matchmaking.md`
 * §Hang-out vs. continue (and §Seeker query). A seeker registers via the inherited cohort-topic
 * walk (`simulator-participant-walk`), then at its landing tier issues a query, runs the
 * `matchmaking.ts` decision engine against the cohort's `topicTraffic`, and either:
 *  - **matches** (≥ `wantCount` providers present) and dials,
 *  - **hangs out** (re-querying every `requery_interval_ms` until `wantCount` accrues or patience
 *    drains), or
 *  - **escalates** (withdraw + re-register one tier toward the root — modeled as one latency hop).
 *
 * Each seeker emits a `SeekerTrace` (matchmaking.md §Seeker path tracer). The whole walk runs on
 * the virtual clock: registration is a `ParticipantWalk`, every query/escalation is one
 * `LatencyModel` hop, and the hang-out poll is a scheduled re-query loop — no async, no wall-clock.
 */

/** The seeker path trace (matchmaking.md §Seeker path tracer). */
export interface SeekerTrace {
	readonly seeker: PeerRef;
	/** Distinct tiers at which the seeker issued a query (landing tier + each escalation step). */
	tiersVisited: number;
	/** Total virtual time spent in hang-out re-query loops (bounded by `patienceMs`). */
	hangOutDurationMs: VTime;
	matched: boolean;
	/** Virtual time from walk start to the terminal outcome (match or patience drain). */
	matchLatency: VTime;
	/** Re-queries issued while hanging out (matchmaking.md: ≈ `patienceMs / requery_interval_ms`). */
	requeries: number;
	// --- honest extras beyond the doc's minimal shape ---
	startTier: number; // the registration landing tier
	finalTier: number; // the tier the seeker terminated at
	escalations: number; // walk-toward-root steps taken (one register hop each)
	matchedCount: number; // providers matched at the terminal tier (may be < wantCount on partial)
	filterAcceptRatio: number; // the decayed accept-ratio estimate at termination
	outcome: 'matched' | 'partial';
}

/**
 * A reported `topicTraffic` transform, modeling an honest or adversarial cohort primary
 * (matchmaking.md §Adversarial traffic reporting). Returning `undefined` models the
 * "`topicTraffic` absent on the reply" edge case (matchmaking.md §Edge cases item 1).
 */
export type TrafficReporter = (truthful: TopicTrafficV1, tier: number) => TopicTrafficV1 | undefined;

/** A per-tier modeled provider population + traffic signal the seeker queries against. */
export interface TierProviderConfig {
	readonly tier: number;
	/** Providers present from seed time (the cohort's standing pool). */
	readonly initial?: readonly SimProvider[];
	/** Providers present from seed time that fail the seeker's filter — for `filterAcceptRatio` decay. */
	readonly noise?: readonly SimProvider[];
	/** Reported arrival rate (drives `expectedNewMatches`); may diverge from `freshArrivalIntervalMs`. */
	readonly reportedArrivalsPerMin: number;
	/** Competing-seeker query rate (drives `contentionFactor`). */
	readonly queriesPerMin: number;
	/** `> 0` signals this tier has promoted (descend), surfaced on the traffic snapshot. */
	readonly childCohortCount?: number;
	/** Cadence at which a fresh matchable provider actually lands (the real arrival stream). */
	readonly freshArrivalIntervalMs?: VTime;
	readonly freshCapabilities?: readonly string[];
	readonly freshCapacityBudget?: number;
}

/**
 * The modeled provider pools across a topic's tiers. `providersAt` returns the live pool (standing
 * providers + the fresh arrivals that have landed by `now`); `truthfulTraffic` builds the honest
 * `topicTraffic` snapshot from the tier's configured rates and the live stock count.
 *
 * The split between `reportedArrivalsPerMin` (the rate the seeker estimates against) and
 * `freshArrivalIntervalMs` (the rate at which distinct matchable providers actually land) is
 * deliberate: `arrivalsPerMin` combines fresh registrations *and* renewals (cohort-topic.md §Topic
 * traffic signal), so it over-counts the fresh-provider rate — which is exactly what produces the
 * borderline regime, where the estimate says "hang out" but the realized arrivals under-deliver.
 */
export class TierProviderModel {
	private readonly tiers = new Map<number, TierProviderConfig>();

	constructor(configs: readonly TierProviderConfig[], private readonly windowSeconds = 60) {
		for (const c of configs) {
			this.tiers.set(c.tier, c);
		}
	}

	private config(tier: number): TierProviderConfig {
		const c = this.tiers.get(tier);
		if (!c) {
			throw new RangeError(`no provider config for tier ${tier}`);
		}
		return c;
	}

	has(tier: number): boolean {
		return this.tiers.has(tier);
	}

	/** The live provider pool at `tier` as of `now`: standing pool + noise + fresh arrivals landed. */
	providersAt(tier: number, now: VTime): SimProvider[] {
		const c = this.config(tier);
		const out: SimProvider[] = [...(c.initial ?? []), ...(c.noise ?? [])];
		const interval = c.freshArrivalIntervalMs ?? 0;
		if (interval > 0) {
			const caps = c.freshCapabilities ?? [];
			const budget = c.freshCapacityBudget ?? 1;
			// Deterministic stream: arrival i lands at t = i·interval (i ≥ 1); present once t ≤ now.
			const landed = Math.floor(now / interval);
			for (let i = 1; i <= landed; i++) {
				out.push({ id: `t${tier}-a${i}`, capabilities: caps, capacityBudget: budget, attachedAt: i * interval });
			}
		}
		return out;
	}

	/** The honest `topicTraffic` snapshot at `tier` (live stock + configured rates). */
	truthfulTraffic(tier: number, now: VTime): TopicTrafficV1 {
		const c = this.config(tier);
		return {
			windowSeconds: this.windowSeconds,
			arrivalsPerMin: c.reportedArrivalsPerMin,
			queriesPerMin: c.queriesPerMin,
			directParticipants: this.providersAt(tier, now).length,
			childCohortCount: c.childCohortCount ?? 0
		};
	}
}

export interface SeekerWalkOptions {
	readonly scheduler: EventScheduler;
	readonly tree: TopicTree;
	readonly participant: PeerRef;
	readonly topicId: string;
	/** `ladder[d] = coord_d(participant, topicId)`; `d_max = ladder.length − 1`. */
	readonly ladder: readonly RingCoord[];
	readonly providers: TierProviderModel;
	readonly wantCount: number;
	readonly patienceMs: VTime;
	readonly filter?: CapabilityFilter;
	readonly config?: MatchmakingConfig;
	/** Honest by default (`truthfulTraffic`); supply to model adversarial / absent reporting. */
	readonly reporter?: TrafficReporter;
	readonly sink?: EventSink;
	readonly onComplete?: (trace: SeekerTrace) => void;
}

/**
 * Drives one seeker through registration → query → hang-out / escalate, recording a `SeekerTrace`.
 * Registration reuses `ParticipantWalk` (the inherited cohort-topic walk); the hang-out decision
 * and escalation are the matchmaking-specific layer on top.
 */
export class SeekerWalk {
	private readonly scheduler: EventScheduler;
	private readonly tree: TopicTree;
	private readonly participant: PeerRef;
	private readonly topicId: string;
	private readonly ladder: readonly RingCoord[];
	private readonly providers: TierProviderModel;
	private readonly wantCount: number;
	private readonly patienceMs: VTime;
	private readonly filter: CapabilityFilter | undefined;
	private readonly cfg: MatchmakingConfig;
	private readonly reporter: TrafficReporter | undefined;
	private readonly sink: EventSink;
	private readonly onComplete: (trace: SeekerTrace) => void;
	private readonly estimator: FilterAcceptEstimator;

	private startTime = 0;
	private deadline = 0;
	private startTier = -1;
	private tiersVisited = 0;
	private escalations = 0;
	private requeries = 0;
	private hangOutDurationMs = 0;
	private done = false;
	private started = false;

	constructor(opts: SeekerWalkOptions) {
		this.scheduler = opts.scheduler;
		this.tree = opts.tree;
		this.participant = opts.participant;
		this.topicId = opts.topicId;
		this.ladder = opts.ladder;
		this.providers = opts.providers;
		this.wantCount = opts.wantCount;
		this.patienceMs = opts.patienceMs;
		this.filter = opts.filter;
		this.cfg = opts.config ?? DEFAULT_MATCHMAKING_CONFIG;
		this.reporter = opts.reporter;
		this.sink = opts.sink ?? NULL_EVENT_SINK;
		this.onComplete = opts.onComplete ?? (() => {});
		this.estimator = new FilterAcceptEstimator(this.cfg.filterAcceptRatioInitial);
	}

	/** Launch: register via the inherited walk, then begin the hang-out decision at the landing tier. */
	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.startTime = this.scheduler.now();
		this.deadline = this.startTime + this.patienceMs;
		const registration = new ParticipantWalk({
			scheduler: this.scheduler,
			tree: this.tree,
			participant: this.participant,
			topicId: this.topicId,
			ladder: this.ladder,
			onComplete: (trace) => {
				if (trace.landingTier < 0) {
					// Registration gave up (no willing cohort) — nothing to hang out on; return empty.
					this.finish(this.scheduler.now(), Math.max(0, trace.landingTier), 0, 'partial');
					return;
				}
				this.startTier = trace.landingTier;
				this.scheduler.scheduleAfter(0, (ctx) => this.queryTier(ctx, trace.landingTier));
			}
		});
		registration.start();
	}

	/** Remaining patience budget the seeker would spend hanging out, from `now`. */
	private remainingPatience(now: VTime): VTime {
		return Math.max(0, this.deadline - now);
	}

	/** Issue a `QueryV1` at `tier` (one RPC hop), then run the hang-out decision on the reply. */
	private queryTier(ctx: EventContext, tier: number): void {
		if (this.done) {
			return;
		}
		const hop = ctx.latency.hopDelay(this.participant, this.participant, ctx);
		ctx.scheduler.scheduleAfter(hop, (c) => this.onQueryReply(c, tier));
	}

	private onQueryReply(ctx: EventContext, tier: number): void {
		if (this.done) {
			return;
		}
		this.tiersVisited++;
		const pool = this.providers.providersAt(tier, ctx.now);
		const matchable = countMatchable(pool, this.filter);
		this.estimator.observe(matchable, pool.length);
		const truthful = this.providers.truthfulTraffic(tier, ctx.now);
		const traffic = this.reporter ? this.reporter(truthful, tier) : truthful;
		const budget = Math.floor(this.remainingPatience(ctx.now) * this.cfg.patiencePerTierFraction);
		const decision = decideHangOut(
			traffic,
			matchable,
			{ wantCount: this.wantCount, patienceMs: budget, filter: this.filter, filterAcceptRatio: this.estimator.ratio },
			this.cfg
		);
		switch (decision.action) {
			case 'matched': {
				this.finish(ctx.now, tier, matchable, 'matched');
				return;
			}
			case 'hang-out': {
				this.enterHangOut(ctx, tier);
				return;
			}
			case 'escalate': {
				this.escalate(ctx, tier);
				return;
			}
		}
	}

	/**
	 * Hang out at `tier`: re-query every `requery_interval_ms` until `wantCount` accrues or the
	 * tier's patience budget (`remaining × patience_per_tier_fraction`) drains. On drain, escalate if
	 * a tier remains and patience is left; otherwise return the partial set (matchmaking.md §Decision
	 * rule step 2 + `d = 0` terminal).
	 */
	private enterHangOut(ctx: EventContext, tier: number): void {
		const tierBudget = Math.floor(this.remainingPatience(ctx.now) * this.cfg.patiencePerTierFraction);
		const tierDeadline = ctx.now + tierBudget;
		this.scheduleRequery(tier, tierDeadline);
	}

	private scheduleRequery(tier: number, tierDeadline: VTime): void {
		const next = this.scheduler.now() + this.cfg.requeryIntervalMs;
		if (next > tierDeadline) {
			// Tier budget drained without meeting wantCount.
			this.scheduler.scheduleAt(tierDeadline, (ctx) => this.onHangOutDrained(ctx, tier));
			return;
		}
		this.scheduler.scheduleAt(next, (ctx) => this.onRequery(ctx, tier, tierDeadline));
	}

	private onRequery(ctx: EventContext, tier: number, tierDeadline: VTime): void {
		if (this.done) {
			return;
		}
		this.requeries++;
		this.hangOutDurationMs += this.cfg.requeryIntervalMs;
		const pool = this.providers.providersAt(tier, ctx.now);
		const matchable = countMatchable(pool, this.filter);
		this.estimator.observe(matchable, pool.length);
		if (matchable >= this.wantCount) {
			this.finish(ctx.now, tier, matchable, 'matched');
			return;
		}
		this.scheduleRequery(tier, tierDeadline);
	}

	private onHangOutDrained(ctx: EventContext, tier: number): void {
		if (this.done) {
			return;
		}
		const pool = this.providers.providersAt(tier, ctx.now);
		const matchable = countMatchable(pool, this.filter);
		if (matchable >= this.wantCount) {
			this.finish(ctx.now, tier, matchable, 'matched');
			return;
		}
		// Budget for this tier drained. With patience_per_tier_fraction < 1 a tier may remain; with
		// the default 1.0 the whole budget was spent here, so this returns the partial set.
		if (tier > 0 && this.remainingPatience(ctx.now) > 0) {
			this.escalate(ctx, tier);
			return;
		}
		this.finish(ctx.now, tier, matchable, 'partial');
	}

	/** Walk one tier toward the root: withdraw + re-register at `tier − 1` (one modeled hop). */
	private escalate(ctx: EventContext, tier: number): void {
		const next = tier - 1;
		if (next < 0) {
			// Already at the root — nowhere to walk. Hang out for whatever patience remains.
			this.enterHangOut(ctx, 0);
			return;
		}
		this.escalations++;
		this.queryTier(ctx, next);
	}

	private finish(now: VTime, tier: number, matchedCount: number, outcome: 'matched' | 'partial'): void {
		if (this.done) {
			return;
		}
		this.done = true;
		const trace: SeekerTrace = {
			seeker: this.participant,
			tiersVisited: this.tiersVisited,
			hangOutDurationMs: this.hangOutDurationMs,
			matched: outcome === 'matched',
			matchLatency: now - this.startTime,
			requeries: this.requeries,
			startTier: this.startTier,
			finalTier: tier,
			escalations: this.escalations,
			matchedCount,
			filterAcceptRatio: this.estimator.ratio,
			outcome
		};
		this.onComplete(trace);
	}
}
