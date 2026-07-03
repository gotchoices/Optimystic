/**
 * Cohort-topic substrate — cohort-side member engine.
 *
 * This is the logic a cohort member runs when FRET's `RouteAndMaybeAct` lands a `RegisterV1`/`RenewV1`
 * on it (the activity callback in `docs/cohort-topic.md` §FRET integration). It is the cohort-facing
 * half of the substrate, composed from the prereq tickets' pure modules — the participant-facing half
 * lives in {@link import("./service.js").CohortTopicService}. db-p2p's FRET host decodes an inbound
 * frame, supplies the routing context this module can't see (`followOn` — derived from the wire
 * `RegisterV1.followOn` flag, evidence-gated in step 1 — plus the quorum-willing tally), and serializes
 * whatever reply this returns back over the wire. db-core never imports FRET here.
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
import { clampTtl } from "./registration/types.js";
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
import type { DemotionNoticeV1, PromotionNoticeV1, RegisterReplyV1, RegisterV1, RenewReplyV1, RenewV1 } from "./wire/types.js";

/** Routing context the FRET host supplies for an inbound register (db-core can't derive it). */
export interface RegisterContext {
	/**
	 * Did this register arrive as a follow-on to a parent cohort's `Promoted` redirect? The host derives
	 * this from the wire `RegisterV1.followOn` flag (`followOn: reg.followOn === true`). It is participant-
	 * asserted and therefore evidence-gated: `runGuards` (step 1) already ran `bootstrapEvidence.verify`,
	 * which demands the same proof for `followOn: true` as for `bootstrap: true`, so an unbacked follow-on
	 * never reaches this instantiation decision (it short-circuited to `unwilling_cohort`).
	 */
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
	/**
	 * Dedicated per-(peer, topic) rate limiter for the read-only {@link CohortMemberEngine.handleRegister}
	 * **probe** path — its own budget, separate from {@link rateLimiter}, so a probe flood cannot exhaust a
	 * participant's register budget (or vice-versa). An over-rate probe answers `unwilling_cohort`
	 * (walk → `retry_later` → `CohortBackoffError`). Absent → the probe rate gate is skipped (the read-only
	 * classify still runs), keeping key-less / unit / mock flows composing.
	 */
	readonly probeRateLimiter?: RegisterRateLimiter;
	readonly replayGuard?: CorrelationReplayGuard;
	readonly topicBudget?: TopicBudget;
	readonly bootstrapEvidence?: BootstrapEvidence;
	/**
	 * Optional participant peer-key signature verifier (db-p2p binds it to the peer-sig primitive over
	 * {@link import("./wire/payloads.js").registerSigningPayload}). A `RegisterV1` whose signature does
	 * not verify against the claimed `participantCoord` is answered `no_state` (serve nothing, record
	 * nothing) — a cohort member cannot trust an unsigned/forged `participantCoord`. Verified first so a
	 * forged frame never reaches (or pollutes) the replay/rate guards. Absent → the gate is skipped.
	 */
	readonly verifyRegisterSig?: (reg: RegisterV1) => boolean;
	/**
	 * Sink for a freshly threshold-signed promotion/demotion notice produced on an arrival (the `accept`
	 * path's promotion trigger). db-p2p's host wires this to broadcast the notice over the `promote`
	 * protocol to the cohort (and, for a demotion, the parent coord). Absent → notices are produced and
	 * applied locally but not broadcast (unit/mock flows). Called fire-and-forget, off the reply path.
	 */
	readonly onNotice?: (notice: PromotionNoticeV1 | DemotionNoticeV1) => void;
	/**
	 * Optional logger. Used only to record a failed promotion sign/broadcast (the threshold-sign round
	 * can reject when the cohort quorum is unreachable) rather than swallow it. Absent → silent.
	 */
	readonly log?: (formatter: string, ...args: unknown[]) => void;
	/**
	 * Sink for a freshly-admitted registration record (the `accept` path), symmetric to the renewal
	 * `gossip.touch` hook. db-p2p wires this to the same per-coord gossip delta queue the renewal side
	 * appends to, so an admitted record is replicated to the cohort at the next gossip round — closing the
	 * durability window between admission and the participant's first renewal touch. A queue append, not a
	 * synchronous broadcast: admission must not block on a round, and last-writer-wins by `lastPing` dedupes
	 * an admit-then-touch landing in the same round. Absent → no admission-time replication (unit/mock flows
	 * that don't exercise gossip).
	 */
	readonly onAdmit?: (rec: RegistrationRecord) => void;
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

		// 0. Read-only lookup probe: classify + return the cohort snapshot without admitting anything.
		//    Branches before the admission pipeline (and the durable-state anti-DoS guards), so even a
		//    hand-crafted `probe: true, bootstrap: true` frame can never instantiate — defense in depth.
		if (reg.probe === true) {
			return this.handleProbe(reg, topicId, participantId, ctx, now);
		}

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

		// 3. Cold path: instantiate only at a legitimate growth point with a willing quorum. `ctx.followOn`
		//    mirrors the wire `reg.followOn` flag (the host derives it), and by the time we reach here the
		//    step-1 bootstrap-evidence gate has already verified a `followOn: true` carries the same proof a
		//    `bootstrap: true` root cold-start carries — so this branch never instantiates an unbacked follow-on.
		const quorumWilling = this.deps.quorumWilling(tier);
		if (!shouldInstantiate({ bootstrap: reg.bootstrap === true, followOn: ctx.followOn, quorumWilling })) {
			return { v: 1, result: "no_state" };
		}
		if (this.deps.topicBudget?.admit(topicId) === false) {
			// Forwarder-state budget is full of populated topics — decline in time.
			return this.unwillingCohort(reg, now);
		}
		this.deps.coldStart.instantiate(topicId, ctx.treeTier, ctx.parentCoord, tier);
		return this.admitOrDecline(reg, topicId, participantId, tier, ctx, now);
	}

	/**
	 * Read-only resolution of the cohort for a topic (the `lookup` probe). It walks the same path a
	 * register does (the walk loop is byte-for-byte identical) but the **terminal** member action is a
	 * classify, never an admission: it persists **no** record, counts **no** arrival, fires **no**
	 * promotion trigger, touches **no** topic budget, and **never** instantiates a cold-start forwarder.
	 *
	 * DoS posture (`docs/cohort-topic.md` §Anti-DoS): a probe still runs the stateless participant-sig gate
	 * (forged → `no_state`) and a dedicated probe rate limiter (over-rate → `unwilling_cohort`), but skips
	 * the replay guard, the bootstrap-evidence gate, and the topic budget — an idempotent read records
	 * nothing, so it is strictly cheaper than the register it replaces.
	 *
	 * Classification mirrors a register's terminal cases so the walk's existing branches drive a probe
	 * unchanged: a served-and-promoted topic answers `promoted(treeTier + 1)` (the walk follows it), a
	 * served topic answers `accepted` with the participant-specific slot assignment + read-only traffic
	 * snapshot, and a topic this cohort does not serve answers `no_state` (the walk steps inward).
	 */
	private handleProbe(reg: RegisterV1, topicId: Uint8Array, participantId: Uint8Array, ctx: RegisterContext, now: number): RegisterReplyV1 {
		if (this.deps.verifyRegisterSig?.(reg) === false) {
			// Unsigned / forged participant signature: serve nothing, exactly like the register path — a
			// cohort member never resolves a cohort snapshot for an untrusted `participantCoord`.
			return { v: 1, result: "no_state" };
		}
		const rate = this.deps.probeRateLimiter?.check(participantId, topicId, now);
		if (rate !== undefined && rate.ok === false) {
			return { v: 1, result: "unwilling_cohort", retryAfterMs: rate.retryAfterMs };
		}
		if (this.serves(topicId)) {
			if (this.deps.promotion.isPromoted(topicId)) {
				return promotedRedirectReply(ctx.treeTier + 1, this.deps.traffic.snapshot(topicId));
			}
			const { members, cohortEpoch } = this.deps.cohort();
			const { primary, backups } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
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
		return { v: 1, result: "no_state" };
	}

	handleRenew(msg: RenewV1, now: number): RenewReplyV1 {
		const reply = this.deps.renewal.onRenew(msg, now);
		if (reply.result === "ok") {
			// A renewal is an arrival proxy for the traffic barometer (§Topic traffic signal).
			this.deps.traffic.recordArrival(b64urlToBytes(msg.topicId), now);
		} else if (reply.result === "withdrawn") {
			// A withdraw evicted a direct participant: re-touch the topic budget DOWN (mirrors the
			// sweepStale drain release below) so the freed slot does not leak. Never an arrival — it is a
			// departure, so the traffic barometer is deliberately not touched.
			const topicId = b64urlToBytes(msg.topicId);
			this.deps.topicBudget?.touch(topicId, this.deps.store.directParticipants(topicId));
		}
		return reply;
	}

	sweepStale(now: number): readonly RegistrationRecord[] {
		// Reclaim idle (peer, topic) rate-limiter keys on the existing gossip cadence. The limiters' own
		// hard LRU cap already bounds worst-case footprint; this sweep adds proactive steady-state reclaim
		// of long-quiet keys so a long-running coord does not hold register/probe state for departed peers.
		this.deps.rateLimiter?.sweep(now);
		this.deps.probeRateLimiter?.sweep(now);

		const evicted = this.deps.renewal.sweepStale(now);
		const budget = this.deps.topicBudget;
		if (budget !== undefined && evicted.length > 0) {
			// Mirror the `accept()` up-touch on the drain side: a TTL sweep that removes a topic's last
			// direct participant must re-`touch` the budget down so the topic falls to participantCount 0
			// and becomes the coldest-evictable resident again. Without this the budget slot leaks — a
			// drained topic keeps its stale positive count forever and `coldestEvictable()` never picks it,
			// so the cohort eventually refuses every new topic while serving nothing. Re-touch once per
			// distinct affected topic from `store.directParticipants` (the source of truth, post-eviction).
			const seen = new Set<string>();
			for (const rec of evicted) {
				const key = bytesKey(rec.topicId);
				if (seen.has(key)) continue;
				seen.add(key);
				budget.touch(rec.topicId, this.deps.store.directParticipants(rec.topicId));
			}
		}
		return evicted;
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
		const ttl = clampTtl(reg.ttl);
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
		this.deps.onAdmit?.(record);
		this.deps.traffic.recordArrival(topicId, now);
		this.deps.topicBudget?.touch(topicId, this.deps.store.directParticipants(topicId));
		// Promotion may fire on this arrival; broadcast whatever notice comes back. Fire-and-forget so the
		// register reply is not delayed by the threshold-sign collection round.
		void this.firePromotion(topicId, now);

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

	/** Run the promotion trigger for an arrival and hand any signed notice to {@link CohortMemberEngineDeps.onNotice}. */
	private async firePromotion(topicId: Uint8Array, now: number): Promise<void> {
		try {
			const notice = await this.deps.promotion.onParticipantCountChange(topicId, now);
			if (notice !== undefined) {
				this.deps.onNotice?.(notice);
			}
		} catch (err) {
			// Threshold signing rejects when the cohort quorum is unreachable this round; the next arrival
			// re-fires, so this is transient. Log rather than crash the register path — or leak the
			// unhandled rejection the bare `void promotion...` did once signing became real (db-p2p ticket 1).
			this.deps.log?.("cohort-topic: promotion sign/broadcast failed for an arrival: %o", err);
		}
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
		if (this.deps.verifyRegisterSig?.(reg) === false) {
			// Unsigned / forged participant signature: serve nothing and record nothing (the cohort
			// cannot trust this participantCoord). Cheap + stateless, so checked first — a forged frame
			// cannot consume any downstream guard state.
			return { v: 1, result: "no_state" };
		}
		// Rate-check BEFORE the replay guard records anything: a fresh-correlationId spam frame that the
		// rate limiter would reject must not first insert a `seen` entry (which would let an attacker grow
		// the replay guard's memory at full attack speed regardless of the rate limit). Running it before
		// the potentially-expensive bootstrap verify (which may do PoW) also short-circuits floods sooner.
		const rate = this.deps.rateLimiter?.check(participantId, topicId, now);
		if (rate !== undefined && rate.ok === false) {
			return { v: 1, result: "unwilling_cohort", retryAfterMs: rate.retryAfterMs };
		}
		if (this.deps.bootstrapEvidence?.verify(reg, tier) === false) {
			return this.unwillingCohort(reg, now);
		}
		// Replay guard records LAST, so only frames that passed signature + rate + bootstrap ever insert a
		// `seen` entry. An *accepted* frame is still always recorded here, so a genuine replay of a served
		// correlationId is still caught; only rate-rejected frames (never served, never recorded) skip it.
		const correlationId = b64urlToBytes(reg.correlationId);
		if (this.deps.replayGuard?.accept(correlationId, participantId, reg.timestamp, now) === false) {
			// Stale / future-skewed / replayed: serve nothing and record nothing.
			return { v: 1, result: "no_state" };
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
