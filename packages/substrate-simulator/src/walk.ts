import type { EventScheduler, EventContext, PeerRef, SeededRng, VTime } from './types.js';
import type { RingCoord } from './ring-model.js';
import { bytesToHex } from './hex.js';
import { TopicTree, type TopicCohortState } from './topic-tree.js';
import { type EventSink, NULL_EVENT_SINK } from './topic-events.js';
import { type AdmissionVerdict } from './willingness.js';
import { backoffDelay, type BackoffConfig, DEFAULT_BACKOFF_CONFIG } from './backoff.js';

/**
 * The participant walk-toward-root engine, modeled against `docs/cohort-topic.md` §Tree growth and
 * lookup and §Anti-flood properties. A participant resolves a topic by walking **inward** (toward
 * the root) from `d_max`, probing one tier coordinate per RPC; the *only* outward move is following
 * a `Promoted` redirect (single-direction semantics). Each probe is a scheduled virtual-clock event
 * costing one `LatencyModel` hop, so a walk's `latency` is the summed RTT of its probe chain and the
 * whole engine stays on the synchronous event clock (no async, no wall-clock).
 *
 * The walk is the full lookup the tree ticket's simplified root-outward `register` driver deferred:
 * it handles `NoState` (step inward), `Promoted` (step outward once), `UnwillingMember` (retry a
 * sibling at the same coord), `UnwillingCohort` (back off in time, then **restart at `d_max`** —
 * decorrelating retry traffic), and cold-root bootstrap (`d < 0` → re-issue at the root with
 * `bootstrap:true`). A successful walk commits its landing via `TopicTree.attachAt`, so the walk and
 * `register` grow an identical tree shape.
 *
 * Each walk emits a `WalkTrace` (hops, latency, distinct start coord, redirect/back-off counts, and
 * a per-probe `reply` log) that feeds the anti-flood instrumentation in `walk-metrics.ts`. The trace
 * keys coords/ids as hex strings to match the rest of the modeled tree (`TopicCohortState`,
 * `TopicCohort`); the source ring coords / `PeerRef` are the seed-time inputs in the options.
 */

/** The reply a single probe resolved to, in walk terms (cohort-topic.md §Lookup). */
export type WalkReply =
	| 'accepted'
	| 'no_state'
	| 'promoted'
	| 'unwilling_member'
	| 'unwilling_cohort'
	| 'cold_root';

/** One probe in a walk: the tier/coord it hit and how that cohort replied. */
export interface WalkProbe {
	readonly tier: number;
	readonly coord: string; // hex
	readonly reply: WalkReply;
}

/**
 * The outcome record of one walk (cohort-topic.md §Instrumentation `WalkTrace`). `participantId`,
 * `topicId`, and `startCoord` are hex strings (the modeled-tree key form); `hops` counts probe RPCs;
 * `latency` is the total virtual time from walk start to terminal outcome; `probes` is the ordered
 * per-probe reply log the claim-3/claim-4 assertions read.
 */
export interface WalkTrace {
	readonly participantId: string;
	readonly topicId: string;
	readonly hops: number;
	readonly latency: VTime;
	readonly startCoord: string; // hex of coord_{d_max}(self, topicId)
	readonly startTier: number; // d_max
	readonly landingTier: number; // tier the walk attached at (−1 if gave up)
	readonly outcome: 'accepted' | 'cold-root' | 'gave-up';
	readonly redirects: number; // Promoted follows (outward moves)
	readonly backoffs: number; // UnwillingCohort waits (each restarts at d_max)
	readonly acceptedAt: VTime | undefined; // absolute virtual time of the terminal accept
	readonly probes: readonly WalkProbe[];
}

/**
 * A cohort's admission decision for a probe that found *existing* (non-promoted) forwarder state,
 * modeled as a pluggable oracle so a scenario can drive the willingness paths (cohort-topic.md
 * §Willingness). Default: always `accepted`. Cold instantiations (`Promoted` follow-ons, cold-root
 * bootstrap) model a willing quorum and do not consult the oracle — there is no state to weigh yet.
 */
export type WalkAdmission = (
	state: TopicCohortState,
	probe: { readonly tier: number; readonly coord: string; readonly memberAttempt: number; readonly now: VTime }
) => AdmissionVerdict;

const ALWAYS_ACCEPT: WalkAdmission = () => ({ result: 'accepted' });

export interface ParticipantWalkOptions {
	readonly scheduler: EventScheduler;
	readonly tree: TopicTree;
	readonly participant: PeerRef;
	/** Topic id as hex (the modeled-tree key form). */
	readonly topicId: string;
	/** `ladder[d] = coord_d(participant, topicId)` for `d ∈ [0, d_max]`; `d_max = ladder.length − 1`. */
	readonly ladder: readonly RingCoord[];
	readonly admission?: WalkAdmission;
	readonly backoff?: BackoffConfig;
	readonly sink?: EventSink;
	/** Cap on `UnwillingMember` sibling retries before treating it as a cohort decline (default `k=16`). */
	readonly maxMemberRetries?: number;
	/** Cap on `UnwillingCohort` back-off restarts before giving up (default 6). */
	readonly maxBackoffs?: number;
	/** Called once with the final trace when the walk terminates. */
	readonly onComplete?: (trace: WalkTrace) => void;
}

/**
 * Drives one participant's walk-toward-root as a chain of scheduled probe events. Construct, then
 * `start()`. State machine over `(d, memberAttempt, followOn, bootstrap)`:
 *  - `followOn` — the current tier was reached by following a `Promoted` redirect, so a cold cohort
 *    here may be instantiated (the tree is growing a new edge); without it, a cold cohort is
 *    `NoState` and the walk steps inward.
 *  - `bootstrap` — the current probe is the root cold-start re-issue (`d < 0` reached).
 */
export class ParticipantWalk {
	readonly participantId: string;
	readonly topicId: string;
	private readonly scheduler: EventScheduler;
	private readonly tree: TopicTree;
	private readonly participant: PeerRef;
	private readonly ladder: readonly RingCoord[];
	private readonly dMax: number;
	private readonly admission: WalkAdmission;
	private readonly backoffCfg: BackoffConfig;
	private readonly sink: EventSink;
	private readonly maxMemberRetries: number;
	private readonly maxBackoffs: number;
	private readonly onComplete: (trace: WalkTrace) => void;

	private hops = 0;
	private redirects = 0;
	private backoffs = 0;
	private readonly probes: WalkProbe[] = [];
	private startTime = 0;
	private landingTier = -1;
	private acceptedAt: VTime | undefined;
	private outcome: WalkTrace['outcome'] = 'gave-up';
	private done = false;
	private started = false;

	constructor(opts: ParticipantWalkOptions) {
		if (opts.ladder.length === 0) {
			throw new RangeError('coord ladder must have at least the root tier');
		}
		this.scheduler = opts.scheduler;
		this.tree = opts.tree;
		this.participant = opts.participant;
		this.topicId = opts.topicId;
		this.participantId = opts.participant.id;
		this.ladder = opts.ladder;
		this.dMax = opts.ladder.length - 1;
		this.admission = opts.admission ?? ALWAYS_ACCEPT;
		this.backoffCfg = opts.backoff ?? DEFAULT_BACKOFF_CONFIG;
		this.sink = opts.sink ?? NULL_EVENT_SINK;
		this.maxMemberRetries = opts.maxMemberRetries ?? 16;
		this.maxBackoffs = opts.maxBackoffs ?? 6;
		this.onComplete = opts.onComplete ?? (() => {});
	}

	/**
	 * Launch the walk. The first probe starts at `d_max` after a zero-delay kickoff (so the hop
	 * latency is drawn inside an event context, like every subsequent probe). Idempotent.
	 */
	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.startTime = this.scheduler.now();
		this.scheduler.scheduleAfter(0, (ctx) => this.scheduleProbe(ctx, this.dMax, 0, false, false));
	}

	private coordAt(d: number): string {
		return bytesToHex(this.ladder[d]!);
	}

	/** Schedule the next probe one `LatencyModel` hop out — the modeled RPC round-trip. */
	private scheduleProbe(ctx: EventContext, d: number, memberAttempt: number, followOn: boolean, bootstrap: boolean): void {
		const hop = ctx.latency.hopDelay(this.participant, this.participant, ctx);
		ctx.scheduler.scheduleAfter(hop, (c) => this.onProbe(c, d, memberAttempt, followOn, bootstrap));
	}

	private onProbe(ctx: EventContext, d: number, memberAttempt: number, followOn: boolean, bootstrap: boolean): void {
		if (this.done) {
			return;
		}
		this.hops++;
		const coord = this.coordAt(d);
		const state = this.tree.get(this.topicId, coord);

		if (state && state.promoted && !bootstrap) {
			this.onPromoted(ctx, d, coord);
			return;
		}
		if (state) {
			this.onExistingState(ctx, d, coord, state, memberAttempt, followOn, bootstrap);
			return;
		}
		// No forwarder state at this coord.
		if (followOn || bootstrap) {
			// A Promoted follow-on grows a fresh edge; a bootstrap instantiates the cold root. Both
			// model a willing quorum (cohort-topic.md §Cold-start instantiation).
			this.probes.push({ tier: d, coord, reply: bootstrap ? 'cold_root' : 'accepted' });
			this.accept(ctx, d, coord, bootstrap);
			return;
		}
		this.onNoState(ctx, d, coord);
	}

	/** `Promoted(d+1)` — the one outward move. Step toward the leaves following the redirect. */
	private onPromoted(ctx: EventContext, d: number, coord: string): void {
		this.probes.push({ tier: d, coord, reply: 'promoted' });
		this.redirects++;
		const next = d + 1;
		if (next > this.dMax) {
			// The pre-derived ladder does not reach the redirect target. In a well-formed scenario
			// d_max bounds the tree depth so this never fires; surfaced as gave-up rather than guessed.
			this.giveUp(ctx, d);
			return;
		}
		this.scheduleProbe(ctx, next, 0, true, false);
	}

	/** Existing, non-promoted forwarder state — run the willingness admission decision. */
	private onExistingState(
		ctx: EventContext,
		d: number,
		coord: string,
		state: TopicCohortState,
		memberAttempt: number,
		followOn: boolean,
		bootstrap: boolean
	): void {
		const verdict = this.admission(state, { tier: d, coord, memberAttempt, now: ctx.now });
		switch (verdict.result) {
			case 'accepted': {
				this.probes.push({ tier: d, coord, reply: 'accepted' });
				// Found existing forwarder state — a normal attach, even when reached via the bootstrap
				// re-issue (another walk instantiated the root first); only a true cold instantiation is
				// `cold-root`.
				this.accept(ctx, d, coord, false);
				void bootstrap;
				return;
			}
			case 'unwilling_member': {
				this.probes.push({ tier: d, coord, reply: 'unwilling_member' });
				this.tree.recordAdmission(this.topicId, d, verdict, ctx.now);
				if (memberAttempt + 1 >= this.maxMemberRetries) {
					// Exhausted the named siblings — fall through to a cohort-level back-off.
					this.declineCohort(ctx, d);
					return;
				}
				this.scheduleProbe(ctx, d, memberAttempt + 1, followOn, bootstrap); // same coord, next member
				return;
			}
			case 'unwilling_cohort': {
				this.probes.push({ tier: d, coord, reply: 'unwilling_cohort' });
				this.tree.recordAdmission(this.topicId, d, verdict, ctx.now);
				this.declineCohort(ctx, d);
				return;
			}
		}
	}

	/** `NoState` — step one tier toward the root; below the root, re-issue as a bootstrap. */
	private onNoState(ctx: EventContext, d: number, coord: string): void {
		this.probes.push({ tier: d, coord, reply: 'no_state' });
		this.tree.recordNoState(this.topicId, d, ctx.now);
		const next = d - 1;
		if (next < 0) {
			// Root returned NoState → cold-start: re-issue at the root with bootstrap:true.
			this.scheduleProbe(ctx, 0, 0, true, true);
			return;
		}
		this.scheduleProbe(ctx, next, 0, false, false);
	}

	/**
	 * `UnwillingCohort` — back off in time and **restart at `d_max`** (cohort-topic.md §Anti-flood
	 * claim 4: inward-retry decorrelation), never re-hitting the same coord immediately. Gives up
	 * once the back-off restart budget is exhausted.
	 */
	private declineCohort(ctx: EventContext, d: number): void {
		this.backoffs++;
		if (this.backoffs > this.maxBackoffs) {
			this.giveUp(ctx, d);
			return;
		}
		const delay = backoffDelay(this.backoffs - 1, this.backoffCfg);
		ctx.scheduler.scheduleAfter(delay, (c) => this.scheduleProbe(c, this.dMax, 0, false, false));
	}

	/** Commit the landing: instantiate+link+attach via the tree, then finish. Caller records the probe. */
	private accept(ctx: EventContext, d: number, _coord: string, coldRoot: boolean): void {
		this.tree.attachAt(this.topicId, this.ladder, d, ctx.now);
		this.landingTier = d;
		this.acceptedAt = ctx.now;
		this.outcome = coldRoot ? 'cold-root' : 'accepted';
		this.sink.record({ kind: 'Admitted', topicId: this.topicId, participantId: this.participantId, tier: d, at: ctx.now });
		this.finish(ctx.now);
	}

	private giveUp(ctx: EventContext, d: number): void {
		this.landingTier = -1;
		this.outcome = 'gave-up';
		this.finish(ctx.now);
		void d;
	}

	private finish(now: VTime): void {
		this.done = true;
		this.onComplete(this.trace(now));
	}

	/** The walk's trace at `now` (terminal time). Safe to read after completion. */
	trace(now: VTime = this.acceptedAt ?? this.scheduler.now()): WalkTrace {
		return {
			participantId: this.participantId,
			topicId: this.topicId,
			hops: this.hops,
			latency: now - this.startTime,
			startCoord: this.coordAt(this.dMax),
			startTier: this.dMax,
			landingTier: this.landingTier,
			outcome: this.outcome,
			redirects: this.redirects,
			backoffs: this.backoffs,
			acceptedAt: this.acceptedAt,
			probes: this.probes
		};
	}
}

/**
 * Re-registration jitter spread (cohort-topic.md §Anti-flood claim 2). After a cohort failure,
 * attached participants must not all re-register at once; each draws a uniform start offset over
 * `[0, windowMs)` (`T_rejoin_jitter`, default 30 s) from the seeded RNG, so the inbound burst
 * spreads across the window rather than spiking. Returns one offset per participant, in order.
 */
export function rejoinStagger(count: number, windowMs: VTime, rng: SeededRng): VTime[] {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(`count must be a non-negative integer, got ${count}`);
	}
	if (!Number.isInteger(windowMs) || windowMs <= 0) {
		throw new RangeError(`windowMs must be a positive integer, got ${windowMs}`);
	}
	return Array.from({ length: count }, () => rng.nextInt(windowMs));
}

/**
 * Rate-limited re-registration spread: place `count` arrivals at a fixed interval of
 * `windowMs / ratePerWindow`, so **any** window of length `windowMs` contains at most `ratePerWindow`
 * arrivals by construction (cohort-topic.md §Anti-flood claim 2: inbound rate at the recovering
 * cohort ≤ `cap_promote / T_rejoin_jitter`). Deterministic; the spacing form used when the bound
 * must hold exactly rather than in expectation.
 */
export function rateLimitedStagger(count: number, ratePerWindow: number, windowMs: VTime): VTime[] {
	if (!Number.isInteger(count) || count < 0) {
		throw new RangeError(`count must be a non-negative integer, got ${count}`);
	}
	if (!(ratePerWindow > 0)) {
		throw new RangeError(`ratePerWindow must be > 0, got ${ratePerWindow}`);
	}
	if (!Number.isInteger(windowMs) || windowMs <= 0) {
		throw new RangeError(`windowMs must be a positive integer, got ${windowMs}`);
	}
	const interval = windowMs / ratePerWindow;
	return Array.from({ length: count }, (_v, i) => Math.floor(i * interval));
}
