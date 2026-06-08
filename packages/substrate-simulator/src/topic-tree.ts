import type { EventScheduler, VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import { bytesToHex } from './hex.js';
import { TIER_COUNT, type AdmissionVerdict } from './willingness.js';
import {
	type EventSink,
	type TopicTrafficV1,
	NULL_EVENT_SINK
} from './topic-events.js';

/**
 * The modeled cohort-topic tree — the spec mirror the production `cohort-topic-*` substrate is
 * checked against (cohort-topic.md §Promotion and demotion lifecycle, §Capacity barometer,
 * §Topic traffic signal). It is *modeled behaviour only*: per-(topic, cohort) soft state on the
 * virtual clock, with every transition (promotion, demotion, gossip, traffic refresh) scheduled
 * as an event. Tier coordinates are derived elsewhere (`topic-addressing.ts`, async sha256) and
 * fed in as `RingCoord`s so this whole file stays synchronous.
 */

/** A sampled `(time, directParticipants)` point, for slope-based pre-promotion. */
export interface GrowthSample {
	readonly t: VTime;
	readonly count: number;
}

/** Per-(topic, cohort) modeled tree node (cohort-topic.md). */
export interface TopicCohortState {
	readonly topicId: string; // hex
	readonly coord: string; // hex of coord_d(...)
	readonly tier: number; // d
	directParticipants: number; // count attached at this cohort for this topic
	promoted: boolean; // serving Promoted(d+1) for new registrations
	childCohortCount: number; // >0 blocks demotion
	loadBucket: number[]; // per-tier 3-bit barometer, 0..7
	willingness: number; // 4-bit vector, one bit per tier T0..T3
	// The member's last-gossiped per-topic view — the reply surface (`trafficSignal`) reads this
	// snapshot, never the live counters, so every field lags raw state by at most one gossip round.
	traffic: { arrivalsPerMin: number; queriesPerMin: number; directParticipants: number; childCohortCount: number };
	lastGrowthSamples: GrowthSample[]; // for slope-based pre-promotion
	// --- lifecycle bookkeeping (not part of the wire model) ---
	promotedAt: VTime | undefined; // when this cohort last entered promoted mode
	lowLoadSince: VTime | undefined; // when directParticipants last dropped to ≤ cap_demote
	arrivalsInWindow: number; // raw arrival counter since windowStart
	queriesInWindow: number; // raw query counter since windowStart
	windowStart: VTime; // start of the current traffic window
}

/** Promotion/demotion/traffic parameters (cohort-topic.md §Configuration defaults). */
export interface LifecycleConfig {
	readonly F: number; // fan-out (16)
	readonly capPromote: number; // 64
	readonly capPromoteFast: number; // 32
	readonly bucketOverload: number; // 6
	readonly capDemote: number; // 16 (= cap_promote / 4)
	readonly tDemoteMs: VTime; // 300_000 (5 min)
	readonly tPromoteLookaheadMs: VTime; // 30_000
	readonly tPromoteStickyMs: VTime; // 60_000
	readonly growthWindowMs: VTime; // slope window for pre-promotion
	readonly trafficWindowMs: VTime; // 60_000 (TopicTrafficV1.windowSeconds * 1000)
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
	F: 16,
	capPromote: 64,
	capPromoteFast: 32,
	bucketOverload: 6,
	capDemote: 16,
	tDemoteMs: 300_000,
	tPromoteLookaheadMs: 30_000,
	tPromoteStickyMs: 60_000,
	growthWindowMs: 10_000,
	trafficWindowMs: 60_000
};

export interface TopicTreeOptions {
	readonly scheduler: EventScheduler;
	readonly config?: LifecycleConfig;
	readonly sink?: EventSink;
	/** Gossip-round cadence on the virtual clock; traffic refresh + lifecycle re-eval tick. */
	readonly gossipRoundMs: VTime;
}

export class TopicTree {
	private readonly states = new Map<string, TopicCohortState>();
	private readonly scheduler: EventScheduler;
	private readonly cfg: LifecycleConfig;
	private readonly sink: EventSink;
	private readonly gossipRoundMs: VTime;
	private gossipScheduled = false;

	constructor(opts: TopicTreeOptions) {
		this.scheduler = opts.scheduler;
		this.cfg = opts.config ?? DEFAULT_LIFECYCLE_CONFIG;
		this.sink = opts.sink ?? NULL_EVENT_SINK;
		this.gossipRoundMs = opts.gossipRoundMs;
	}

	// --- registry ------------------------------------------------------------

	private key(topicId: string, coord: string): string {
		return `${topicId}:${coord}`;
	}

	/** Look up an existing cohort state, if any. */
	get(topicId: string, coord: string): TopicCohortState | undefined {
		return this.states.get(this.key(topicId, coord));
	}

	has(topicId: string, coord: string): boolean {
		return this.states.has(this.key(topicId, coord));
	}

	/** All cohort states, in insertion order — for metrics/inspection. */
	all(): TopicCohortState[] {
		return [...this.states.values()];
	}

	/** Get-or-instantiate the cold cohort state for `(topicId, coord)` at `tier`. */
	ensure(topicId: string, coord: string, tier: number, now: VTime): TopicCohortState {
		const existing = this.get(topicId, coord);
		if (existing) {
			return existing;
		}
		const state: TopicCohortState = {
			topicId,
			coord,
			tier,
			directParticipants: 0,
			promoted: false,
			childCohortCount: 0,
			loadBucket: new Array(TIER_COUNT).fill(0),
			willingness: (1 << TIER_COUNT) - 1, // all tiers willing until load sheds them
			traffic: { arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 },
			lastGrowthSamples: [],
			promotedAt: undefined,
			lowLoadSince: undefined,
			arrivalsInWindow: 0,
			queriesInWindow: 0,
			windowStart: now
		};
		this.states.set(this.key(topicId, coord), state);
		return state;
	}

	// --- participant count + growth samples ----------------------------------

	/** Record `directParticipants` and a growth sample; refresh the low-load hysteresis clock. */
	setParticipants(state: TopicCohortState, count: number, now: VTime): void {
		if (!Number.isInteger(count) || count < 0) {
			throw new RangeError(`participant count must be a non-negative integer, got ${count}`);
		}
		state.directParticipants = count;
		this.pushGrowthSample(state, now);
		this.refreshLowLoadClock(state, now);
	}

	/** One participant arrives at this cohort; bumps count + arrival counter and re-evaluates promotion. */
	attach(state: TopicCohortState, now: VTime): void {
		state.arrivalsInWindow++;
		this.setParticipants(state, state.directParticipants + 1, now);
		this.evaluatePromotion(state, now);
	}

	/** One participant leaves (TTL eviction / departure). */
	detach(state: TopicCohortState, now: VTime): void {
		this.setParticipants(state, Math.max(0, state.directParticipants - 1), now);
	}

	private pushGrowthSample(state: TopicCohortState, now: VTime): void {
		state.lastGrowthSamples.push({ t: now, count: state.directParticipants });
		const cutoff = now - this.cfg.growthWindowMs;
		while (state.lastGrowthSamples.length > 1 && state.lastGrowthSamples[0]!.t < cutoff) {
			state.lastGrowthSamples.shift();
		}
	}

	private refreshLowLoadClock(state: TopicCohortState, now: VTime): void {
		if (state.directParticipants <= this.cfg.capDemote) {
			if (state.lowLoadSince === undefined) {
				state.lowLoadSince = now;
			}
		} else {
			state.lowLoadSince = undefined;
		}
	}

	// --- capacity barometer + willingness ------------------------------------

	/**
	 * Set the cohort's load bucket for `tier` (0..7) and flip the cohort willingness bit on the
	 * overload threshold crossing (cohort-topic.md §Capacity barometer). Then re-evaluate
	 * promotion, since a hot tier promotes earlier than the strict `cap_promote`.
	 */
	setLoadBucket(state: TopicCohortState, tier: number, bucket: number, now: VTime): void {
		if (!Number.isInteger(bucket) || bucket < 0 || bucket > 7) {
			throw new RangeError(`load bucket must be an integer in [0, 7], got ${bucket}`);
		}
		if (tier < 0 || tier >= TIER_COUNT) {
			throw new RangeError(`tier must be in [0, ${TIER_COUNT - 1}], got ${tier}`);
		}
		state.loadBucket[tier] = bucket;
		const bit = 1 << tier;
		if (bucket >= this.cfg.bucketOverload) {
			state.willingness &= ~bit; // shed: too loaded to serve this tier
		} else {
			state.willingness |= bit; // recovered: willing again
		}
		this.evaluatePromotion(state, now);
	}

	// --- promotion -----------------------------------------------------------

	/**
	 * Promote if any trigger fires (cohort-topic.md §Promotion):
	 *  - `directParticipants ≥ cap_promote`, OR
	 *  - `loadBucket[tier] ≥ bucket_overload` AND `directParticipants ≥ cap_promote_fast`, OR
	 *  - slope of `directParticipants` predicts crossing `cap_promote` within `T_promote_lookahead`.
	 * Idempotent: a cohort already promoted is left alone.
	 */
	evaluatePromotion(state: TopicCohortState, now: VTime): boolean {
		if (state.promoted) {
			return false;
		}
		if (this.promotionTriggered(state, now)) {
			this.promote(state, now);
			return true;
		}
		return false;
	}

	private promotionTriggered(state: TopicCohortState, now: VTime): boolean {
		if (state.directParticipants >= this.cfg.capPromote) {
			return true;
		}
		const hot = state.loadBucket[state.tier] !== undefined
			? state.loadBucket[state.tier]! >= this.cfg.bucketOverload
			: false;
		if (hot && state.directParticipants >= this.cfg.capPromoteFast) {
			return true;
		}
		return this.slopePredictsCrossing(state, now);
	}

	/** Linear extrapolation over the growth window: will we cross `cap_promote` within lookahead? */
	private slopePredictsCrossing(state: TopicCohortState, now: VTime): boolean {
		const samples = state.lastGrowthSamples;
		if (samples.length < 2) {
			return false;
		}
		const first = samples[0]!;
		const last = samples[samples.length - 1]!;
		const span = last.t - first.t;
		if (span <= 0) {
			return false;
		}
		const slope = (last.count - first.count) / span; // participants per ms
		if (slope <= 0) {
			return false;
		}
		const predicted = state.directParticipants + slope * this.cfg.tPromoteLookaheadMs;
		return predicted >= this.cfg.capPromote;
	}

	/** Enter promoted mode (sticky); emit `Promoted(tier → tier+1)`. */
	promote(state: TopicCohortState, now: VTime): void {
		if (state.promoted) {
			return;
		}
		state.promoted = true;
		state.promotedAt = now;
		this.sink.record({
			kind: 'Promoted',
			topicId: state.topicId,
			fromTier: state.tier,
			toTier: state.tier + 1,
			at: now
		});
	}

	// --- demotion ------------------------------------------------------------

	/**
	 * Demote only when ALL hold (cohort-topic.md §Demotion + §Hysteresis):
	 *  - cohort is promoted and has been for at least `T_promote_sticky` (sticky floor),
	 *  - `directParticipants ≤ cap_demote` and that has held for `T_demote`,
	 *  - `childCohortCount == 0` (never demote while child cohorts exist).
	 */
	evaluateDemotion(state: TopicCohortState, now: VTime): boolean {
		if (!this.demotionTriggered(state, now)) {
			return false;
		}
		this.demote(state, now);
		return true;
	}

	private demotionTriggered(state: TopicCohortState, now: VTime): boolean {
		if (!state.promoted) {
			return false;
		}
		if (state.promotedAt !== undefined && now - state.promotedAt < this.cfg.tPromoteStickyMs) {
			return false;
		}
		if (state.childCohortCount > 0) {
			return false;
		}
		if (state.directParticipants > this.cfg.capDemote) {
			return false;
		}
		if (state.lowLoadSince === undefined) {
			return false;
		}
		return now - state.lowLoadSince >= this.cfg.tDemoteMs;
	}

	/** Leave promoted mode; emit `Demoted` (recorded for the convergence tracer). */
	demote(state: TopicCohortState, now: VTime): void {
		if (!state.promoted) {
			return;
		}
		state.promoted = false;
		state.promotedAt = undefined;
		this.sink.record({ kind: 'Demoted', topicId: state.topicId, tier: state.tier, at: now });
	}

	// --- topic traffic -------------------------------------------------------

	/** An application-level query against this topic (counted toward `queriesPerMin`). */
	recordQuery(state: TopicCohortState): void {
		state.queriesInWindow++;
	}

	/**
	 * Roll the traffic window: convert raw counters to per-minute rates, snapshot the stock
	 * (`directParticipants`, `childCohortCount`) alongside them as the member's gossiped view
	 * (`state.traffic`), reset the window, and emit `TopicTraffic`. The reply path reads
	 * `state.traffic` exclusively — never the live counters — so the whole `TopicTrafficV1`
	 * surface lags raw state by at most one gossip round, exactly the staleness
	 * cohort-topic.md §Topic traffic signal describes ("does not recompute from raw counters at
	 * reply time").
	 */
	refreshTraffic(state: TopicCohortState, now: VTime): void {
		const elapsed = Math.max(1, now - state.windowStart);
		const perMin = (count: number): number => (count * 60_000) / elapsed;
		state.traffic = {
			arrivalsPerMin: perMin(state.arrivalsInWindow),
			queriesPerMin: perMin(state.queriesInWindow),
			directParticipants: state.directParticipants,
			childCohortCount: state.childCohortCount
		};
		state.arrivalsInWindow = 0;
		state.queriesInWindow = 0;
		state.windowStart = now;
		this.sink.record({
			kind: 'TopicTraffic',
			topicId: state.topicId,
			tier: state.tier,
			traffic: this.trafficSignal(state),
			at: now
		});
	}

	// --- admission / walk events --------------------------------------------

	/**
	 * Emit `NoState` — the cohort at `tier` holds nothing for this topic, so the walking
	 * participant steps one tier toward the root (cohort-topic.md §Lookup). The tree itself never
	 * decides this; the participant-walk model calls it on a registry miss.
	 */
	recordNoState(topicId: string, tier: number, now: VTime): void {
		this.sink.record({ kind: 'NoState', topicId, tier, at: now });
	}

	/**
	 * Emit the willingness outcome of an admission decision (cohort-topic.md §Willingness):
	 * `UnwillingMember` (retry a sibling) or `UnwillingCohort` (back off in time). `accepted`
	 * carries traffic on the reply (see `trafficSignal`) rather than its own metrics event.
	 */
	recordAdmission(topicId: string, tier: number, verdict: AdmissionVerdict, now: VTime): void {
		if (verdict.result === 'unwilling_member') {
			this.sink.record({ kind: 'UnwillingMember', topicId, tier, at: now });
		} else if (verdict.result === 'unwilling_cohort') {
			this.sink.record({ kind: 'UnwillingCohort', topicId, tier, at: now });
		}
	}

	/**
	 * The full `TopicTrafficV1` signal surfaced on a reply, read entirely from the last gossiped
	 * view (`state.traffic`). Every field — including the stock counts — therefore lags the live
	 * state by at most one gossip round; the responder never recomputes from raw counters here.
	 */
	trafficSignal(state: TopicCohortState): TopicTrafficV1 {
		return {
			windowSeconds: this.cfg.trafficWindowMs / 1000,
			arrivalsPerMin: state.traffic.arrivalsPerMin,
			queriesPerMin: state.traffic.queriesPerMin,
			directParticipants: state.traffic.directParticipants,
			childCohortCount: state.traffic.childCohortCount
		};
	}

	// --- gossip tick (scheduled lifecycle re-evaluation) ---------------------

	/**
	 * Start the recurring gossip tick: every `gossipRoundMs` on the virtual clock, refresh
	 * traffic and re-evaluate demotion for every cohort. Promotion is evaluated eagerly on
	 * arrival/load events; demotion is time-driven, so it lives on this tick. Idempotent — a
	 * second call is a no-op. Bound it with `scheduler.run(until)` in tests.
	 */
	startGossip(): void {
		if (this.gossipScheduled) {
			return;
		}
		this.gossipScheduled = true;
		this.scheduleGossipTick();
	}

	private scheduleGossipTick(): void {
		this.scheduler.scheduleAfter(this.gossipRoundMs, (ctx) => {
			for (const state of this.states.values()) {
				this.refreshTraffic(state, ctx.now);
				this.evaluateDemotion(state, ctx.now);
			}
			this.scheduleGossipTick();
		});
	}

	// --- registration / growth driver ----------------------------------------

	/**
	 * Register a participant whose tier coordinate ladder is `ladder[d] = coord_d(P, topicId)`.
	 * Walks root-outward following `Promoted` redirects to the deepest non-promoted cohort for the
	 * participant's prefix, instantiates it cold if needed (linking it as a child of its tier-(d−1)
	 * parent), and attaches. Returns the tier the participant landed at.
	 *
	 * This is a *simplified* growth driver sufficient for the depth-law smoke check: it grows the
	 * tree by load alone. The full `d_max`→root participant walk (NoState back-off, willingness
	 * redirects, latency) is `simulator-participant-walk`; this models only the promotion-driven
	 * shape that determines steady-state depth.
	 */
	register(topicId: string, ladder: readonly RingCoord[], now: VTime): number {
		if (ladder.length === 0) {
			throw new RangeError('coord ladder must have at least the root tier');
		}
		let d = 0;
		while (d < ladder.length - 1) {
			const parent = this.get(topicId, bytesToHex(ladder[d]!));
			if (parent && parent.promoted) {
				d++;
				continue;
			}
			break;
		}
		const coord = bytesToHex(ladder[d]!);
		const fresh = !this.has(topicId, coord);
		const state = this.ensure(topicId, coord, d, now);
		if (fresh && d > 0) {
			const parent = this.get(topicId, bytesToHex(ladder[d - 1]!));
			if (parent) {
				parent.childCohortCount++;
			}
		}
		this.attach(state, now);
		return d;
	}

	/** Deepest tier currently holding participants — the observed steady-state tree depth. */
	maxOccupiedTier(topicId: string): number {
		let max = 0;
		for (const state of this.states.values()) {
			if (state.topicId === topicId && state.directParticipants > 0 && state.tier > max) {
				max = state.tier;
			}
		}
		return max;
	}
}
