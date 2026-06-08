/**
 * Cohort-topic substrate — cohort-side member engine.
 *
 * This is the logic a cohort member runs when FRET's `RouteAndMaybeAct` lands a `RegisterV1`/`RenewV1`
 * on it (the activity callback in `docs/cohort-topic.md` §FRET integration). It is the cohort-facing
 * half of the substrate, composed from the prereq tickets' pure modules — the participant-facing half
 * lives in {@link import("./service.js").CohortTopicService}. db-p2p's FRET host decodes an inbound
 * frame, supplies the routing context this module can't see (`followOn`, the quorum-willing tally),
 * and serializes whatever reply this returns back over the wire. db-core never imports FRET here.
 *
 * Inbound `RegisterV1` decision pipeline (§Registration mechanics, §Willingness, §Cold-start):
 *
 * 1. **Anti-DoS** — freshness/replay guard, per-(peer,topic) rate limit, and cold-root bootstrap
 *    evidence. A failure short-circuits to `unwilling_cohort` (temporal back-off) or, for a replay,
 *    a silent `no_state` (no state is served and nothing is recorded).
 * 2. **Hot vs cold** — if this cohort already serves the topic (forwarder state resident), run the
 *    willingness check; a promoted topic answers `Promoted(d+1)`. If cold, the topic-budget +
 *    cold-start gate decides whether to instantiate, else `no_state` (walk steps toward the root).
 * 3. **Admission** — on `accepted`, assign the deterministic primary/backup slots, persist the
 *    soft-state record, count the arrival, run the promotion trigger, and attach the topic-traffic
 *    signal to the reply.
 *
 * Every collaborator is injected, so the engine unit-tests without FRET or libp2p.
 */

import type { IRingHash } from "./ports.js";
import { bytesEqual, bytesKey } from "./registration/bytes.js";
import type { RegistrationRecord, RegistrationStore } from "./registration/types.js";
import { DEFAULT_TTL_MS } from "./registration/types.js";
import type { SlotAssigner } from "./registration/sharding.js";
import type { RenewalCohortSide } from "./registration/renewal.js";
import type { WillingnessCheck } from "./willingness.js";
import { backoffRetryMs } from "./willingness.js";
import type { PromotionLifecycle } from "./promotion.js";
import { promotedRedirectReply } from "./coldstart.js";
import type { ColdStartManager } from "./coldstart.js";
import { shouldInstantiate } from "./coldstart.js";
import type { TrafficCounters } from "./traffic.js";
import { attachTopicTraffic } from "./traffic.js";
import type { RegisterRateLimiter } from "./antidos/rate-limiter.js";
import type { CorrelationReplayGuard } from "./antidos/replay-guard.js";
import type { TopicBudget } from "./antidos/topic-budget.js";
import type { BootstrapEvidence } from "./antidos/bootstrap-evidence.js";
import type { NodeProfile, Tier } from "./tiers.js";
import { b64urlToBytes } from "./wire/codec.js";
import type { RegisterReplyV1, RegisterV1, RenewReplyV1, RenewV1 } from "./wire/types.js";

/** Routing context the FRET host supplies for an inbound register (db-core can't derive it). */
export interface RegisterContext {
	/** Did this register arrive as a follow-on to a parent cohort's `Promoted` redirect? */
	readonly followOn: boolean;
	/** Tree tier `d` this cohort serves the topic at (the walk position the register landed on). */
	readonly treeTier: number;
	/** The tier-`(d − 1)` parent cohort coord, for a cold-start forwarder's parent registration. */
	readonly parentCoord?: Uint8Array;
}

/** Current cohort snapshot — the FRET host fills this from the membership source. */
export interface CohortSnapshotView {
	readonly members: readonly Uint8Array[];
	readonly cohortEpoch: Uint8Array;
}

export interface CohortMemberEngineDeps {
	/** This member's own peer id. */
	readonly self: Uint8Array;
	/** This member's static tier profile (Edge/Core willing-tier set). */
	readonly profile: NodeProfile;
	/** Hash used for slot assignment + keys (db-core's own SHA-256). */
	readonly hash: IRingHash;
	/** Replicated soft-state registration store. */
	readonly store: RegistrationStore;
	/** Deterministic primary/backup slot assignment, shared with renewal + handoff. */
	readonly slots: SlotAssigner;
	/** Per-member willingness / admission control. */
	readonly willingness: WillingnessCheck;
	/** Promotion / demotion lifecycle. */
	readonly promotion: PromotionLifecycle;
	/** Cold-start forwarder instantiation + parent registration. */
	readonly coldStart: ColdStartManager;
	/** Per-topic traffic counters (gossip-derived snapshots feed the reply signal). */
	readonly traffic: TrafficCounters;
	/** Cohort-side TTL renewal handler (touch / primary_moved / sweep). */
	readonly renewal: RenewalCohortSide;
	/** Live cohort snapshot (members + epoch). */
	readonly cohort: () => CohortSnapshotView;
	/** Whether a quorum of members is willing to serve `tier` (the cold-start gate input). */
	readonly quorumWilling: (tier: Tier) => boolean;
	// --- anti-DoS guards (all optional; absent = that gate is skipped) ---
	readonly rateLimiter?: RegisterRateLimiter;
	readonly replayGuard?: CorrelationReplayGuard;
	readonly topicBudget?: TopicBudget;
	readonly bootstrapEvidence?: BootstrapEvidence;
}

/** Cohort-side register/renew handler — the body of the FRET activity callback. */
export interface CohortMemberEngine {
	/** Classify and admit (or decline) an inbound `RegisterV1`, returning the reply to serialize. */
	handleRegister(reg: RegisterV1, ctx: RegisterContext, now: number): Promise<RegisterReplyV1>;
	/** Handle an inbound `RenewV1` (ping / re-attach), delegating to the renewal cohort side. */
	handleRenew(msg: RenewV1, now: number): RenewReplyV1;
	/** Evict stale records and gossip each eviction; returns the evicted set. */
	sweepStale(now: number): readonly RegistrationRecord[];
}

class StoreCohortMemberEngine implements CohortMemberEngine {
	constructor(private readonly deps: CohortMemberEngineDeps) {}

	async handleRegister(reg: RegisterV1, ctx: RegisterContext, now: number): Promise<RegisterReplyV1> {
		const topicId = b64urlToBytes(reg.topicId);
		const participantId = b64urlToBytes(reg.participantCoord);
		const tier = reg.tier as Tier;

		// 1. Anti-DoS gates. A replay/stale frame is answered with NoState (serve nothing, record
		//    nothing); an over-rate source or missing bootstrap evidence backs off in time.
		const guard = this.runGuards(reg, topicId, participantId, tier, now);
		if (guard !== undefined) {
			return guard;
		}

		// 2. Hot path: this cohort already serves the topic.
		if (this.serves(topicId)) {
			if (this.deps.promotion.isPromoted(topicId)) {
				// Promoted: bounce same-tier registrations onward (the cheap single-RPC redirect).
				return promotedRedirectReply(ctx.treeTier + 1, this.deps.traffic.snapshot(topicId));
			}
			return this.admitOrDecline(reg, topicId, participantId, tier, ctx, now);
		}

		// 3. Cold path: instantiate only at a legitimate growth point with a willing quorum.
		const quorumWilling = this.deps.quorumWilling(tier);
		if (!shouldInstantiate({ bootstrap: reg.bootstrap === true, followOn: ctx.followOn, quorumWilling })) {
			return { v: 1, result: "no_state" };
		}
		if (this.deps.topicBudget?.admit(topicId) === false) {
			// Forwarder-state budget is full of populated topics — decline in time.
			return this.unwillingCohort(reg, now);
		}
		this.deps.coldStart.instantiate(topicId, ctx.treeTier, ctx.parentCoord);
		return this.admitOrDecline(reg, topicId, participantId, tier, ctx, now);
	}

	handleRenew(msg: RenewV1, now: number): RenewReplyV1 {
		const reply = this.deps.renewal.onRenew(msg, now);
		if (reply.result === "ok") {
			// A renewal is an arrival proxy for the traffic barometer (§Topic traffic signal).
			this.deps.traffic.recordArrival(b64urlToBytes(msg.topicId), now);
		}
		return reply;
	}

	sweepStale(now: number): readonly RegistrationRecord[] {
		return this.deps.renewal.sweepStale(now);
	}

	// --- admission ---

	/** Run the willingness check; on `accepted` persist the record and attach the traffic signal. */
	private async admitOrDecline(
		reg: RegisterV1,
		topicId: Uint8Array,
		participantId: Uint8Array,
		tier: Tier,
		ctx: RegisterContext,
		now: number,
	): Promise<RegisterReplyV1> {
		const outcome = this.deps.willingness.evaluate(reg, this.deps.profile, now);
		switch (outcome.kind) {
			case "unwilling_member": {
				return { v: 1, result: "unwilling_member", candidateMembers: outcome.candidateMembers.map(bytesKey) };
			}
			case "unwilling_cohort": {
				return { v: 1, result: "unwilling_cohort", retryAfterMs: outcome.retryAfterMs };
			}
			case "accepted": {
				return this.accept(reg, topicId, participantId, tier, ctx, now);
			}
			default: {
				return this.unwillingCohort(reg, now);
			}
		}
	}

	private async accept(
		reg: RegisterV1,
		topicId: Uint8Array,
		participantId: Uint8Array,
		tier: Tier,
		ctx: RegisterContext,
		now: number,
	): Promise<RegisterReplyV1> {
		const { members, cohortEpoch } = this.deps.cohort();
		const { primary, backups } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
		const ttl = reg.ttl > 0 ? reg.ttl : DEFAULT_TTL_MS;
		const record: RegistrationRecord = {
			topicId,
			participantId,
			tier,
			primary,
			backups,
			attachedAt: now,
			lastPing: now,
			ttl,
			appState: reg.appPayload === undefined ? undefined : b64urlToBytes(reg.appPayload),
		};
		this.deps.store.put(record);
		this.deps.traffic.recordArrival(topicId, now);
		this.deps.topicBudget?.touch(topicId, this.deps.store.directParticipants(topicId));
		// Promotion may fire on this arrival; the host broadcasts whatever notice comes back.
		void this.deps.promotion.onParticipantCountChange(topicId, now);

		const reply: RegisterReplyV1 = {
			v: 1,
			result: "accepted",
			primary: bytesKey(primary),
			backups: backups.map(bytesKey),
			cohortEpoch: bytesKey(cohortEpoch),
			cohortMembers: members.map(bytesKey),
		};
		return attachTopicTraffic(reply, this.deps.traffic.snapshot(topicId));
	}

	// --- guards ---

	/** Returns a short-circuit reply if any anti-DoS gate rejects `reg`, else `undefined`. */
	private runGuards(
		reg: RegisterV1,
		topicId: Uint8Array,
		participantId: Uint8Array,
		tier: Tier,
		now: number,
	): RegisterReplyV1 | undefined {
		const correlationId = b64urlToBytes(reg.correlationId);
		if (this.deps.replayGuard?.accept(correlationId, participantId, reg.timestamp, now) === false) {
			// Stale / future-skewed / replayed: serve nothing and record nothing.
			return { v: 1, result: "no_state" };
		}
		if (this.deps.bootstrapEvidence?.verify(reg, tier) === false) {
			return this.unwillingCohort(reg, now);
		}
		const rate = this.deps.rateLimiter?.check(participantId, topicId, now);
		if (rate !== undefined && rate.ok === false) {
			return { v: 1, result: "unwilling_cohort", retryAfterMs: rate.retryAfterMs };
		}
		return undefined;
	}

	private serves(topicId: Uint8Array): boolean {
		return this.deps.coldStart.get(topicId) !== undefined || this.deps.store.directParticipants(topicId) > 0;
	}

	private unwillingCohort(reg: RegisterV1, now: number): RegisterReplyV1 {
		void reg;
		void now;
		return { v: 1, result: "unwilling_cohort", retryAfterMs: backoffRetryMs(0) };
	}
}

/** Build a {@link CohortMemberEngine} over the injected cohort-side collaborators. */
export function createCohortMemberEngine(deps: CohortMemberEngineDeps): CohortMemberEngine {
	return new StoreCohortMemberEngine(deps);
}

/** True iff `a` and `b` name the same peer (re-exported convenience for host equality checks). */
export function samePeer(a: Uint8Array, b: Uint8Array): boolean {
	return bytesEqual(a, b);
}
