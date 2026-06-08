import type { EventScheduler, VTime } from './types.js';
import { type EventSink, NULL_EVENT_SINK } from './topic-events.js';
import { CohortMembership, slotOf, type PrimaryAssignment } from './cohort-membership.js';

/**
 * TTL renewal, three-failure backup promotion, deterministic primary handoff, and cohort-side
 * stale eviction — modeled against `docs/cohort-topic.md` §TTL and renewal, §Membership rotation
 * and primary handoff, and §Failure modes. Everything runs on the virtual clock; nothing here is
 * async or wall-clock.
 *
 * Two views of one registration:
 *  - the **cohort** holds the authoritative `RegistrationRecord` (who currently serves), keyed by
 *    participant id, and answers renewals;
 *  - the **participant** (`ParticipantRenewal`) caches its primary/backups and pings on the
 *    `ttl/3` cadence, detecting primary loss after three consecutive failures.
 *
 * Member reachability — `membership ∩ ¬dead` — is the single lever churn, crashes, and partitions
 * pull. The cohort always serves via the deterministic slot order *skipping unreachable members*,
 * so a crashed assigned-primary is transparently covered by the next live member, and any
 * membership change surfaces to the participant as `primary_moved` on its next ping.
 */

/** Soft state a cohort holds per participant (cohort-topic.md §Registration record). */
export interface RegistrationRecord {
	readonly topicId: string;
	readonly participantId: string;
	readonly tier: number;
	primary: string;
	backups: string[];
	attachedAt: VTime;
	lastPing: VTime;
	readonly ttl: VTime;
}

export type RenewResult = 'ok' | 'unknown_registration' | 'primary_moved';

/** Reply to a renewal ping (cohort-topic.md §Renew wire format `RenewReplyV1`). */
export interface RenewReply {
	readonly result: RenewResult;
	readonly newPrimary?: string;
	readonly newBackups?: string[];
	readonly cohortEpoch?: string;
}

export interface TopicCohortOptions {
	readonly topicId: string;
	readonly coord: string;
	readonly tier: number;
	readonly membership: CohortMembership;
	readonly sink?: EventSink;
	/** Warm backups per registration (cohort-topic.md default 2). */
	readonly backupsPerRegistration?: number;
}

/**
 * The serving cohort for one `(topicId, coord)`: deterministic assignment, renewal, membership
 * rotation, partition split/heal, and stale eviction. Holds only soft per-participant state.
 */
export class TopicCohort {
	readonly topicId: string;
	readonly coord: string;
	readonly tier: number;
	private currentMembership: CohortMembership;
	private readonly records = new Map<string, RegistrationRecord>();
	private readonly dead = new Set<string>();
	private readonly sink: EventSink;
	private readonly backupsPer: number;

	constructor(opts: TopicCohortOptions) {
		this.topicId = opts.topicId;
		this.coord = opts.coord;
		this.tier = opts.tier;
		this.currentMembership = opts.membership;
		this.sink = opts.sink ?? NULL_EVENT_SINK;
		this.backupsPer = opts.backupsPerRegistration ?? 2;
	}

	get membership(): CohortMembership {
		return this.currentMembership;
	}

	get epoch(): string {
		return this.currentMembership.epoch;
	}

	get registrationCount(): number {
		return this.records.size;
	}

	record(participantId: string): RegistrationRecord | undefined {
		return this.records.get(participantId);
	}

	// --- membership lifecycle ------------------------------------------------

	/** A member is unreachable when it has crashed/partitioned away or left the membership. */
	reachable(memberId: string): boolean {
		return this.currentMembership.has(memberId) && !this.dead.has(memberId);
	}

	/** Mark a member crashed / partitioned-off (its pings fail; assignment skips it). */
	kill(memberId: string): void {
		this.dead.add(memberId);
	}

	/** Bring a member back (partition heal of a single member). */
	revive(memberId: string): void {
		this.dead.delete(memberId);
	}

	/**
	 * Rotate to a new membership snapshot (FRET stabilization, partition, or heal). The change is
	 * *lazy*: existing records keep their current `primary` until each participant's next renewal,
	 * which then returns `primary_moved` — the previous primary serves until the new one is picked
	 * up, exactly as cohort-topic.md §Membership rotation describes ("refreshes on the next ping,
	 * not eagerly"). Reviving any members that re-entered the membership clears their dead flag.
	 */
	rotate(membership: CohortMembership): void {
		this.currentMembership = membership;
		for (const id of membership.members) {
			this.dead.delete(id);
		}
	}

	// --- registration / renewal ---------------------------------------------

	/** Fresh registration: deterministic assignment under the current epoch. */
	register(participantId: string, now: VTime, ttl: VTime): PrimaryAssignment {
		const eff = this.effectiveAssignment(participantId);
		if (!eff) {
			throw new Error(`cohort ${this.coord} has no reachable member to serve ${participantId}`);
		}
		const rec: RegistrationRecord = {
			topicId: this.topicId,
			participantId,
			tier: this.tier,
			primary: eff.primary,
			backups: eff.backups,
			attachedAt: now,
			lastPing: now,
			ttl
		};
		this.records.set(participantId, rec);
		return { primary: eff.primary, backups: eff.backups };
	}

	/**
	 * Renewal ping. Compares the participant's currently-served primary to the deterministic
	 * effective primary under the live membership; a mismatch is a `primary_moved` handoff.
	 */
	renew(participantId: string, now: VTime): RenewReply {
		const rec = this.records.get(participantId);
		if (!rec) {
			return { result: 'unknown_registration' };
		}
		const eff = this.effectiveAssignment(participantId);
		if (!eff) {
			// Whole cohort unreachable — force the participant to re-run lookup elsewhere.
			return { result: 'unknown_registration' };
		}
		rec.lastPing = now;
		if (eff.primary !== rec.primary) {
			rec.primary = eff.primary;
			rec.backups = eff.backups;
			this.sink.record({ kind: 'PrimaryMoved', topicId: this.topicId, participantId, newPrimary: eff.primary, at: now });
			return { result: 'primary_moved', newPrimary: eff.primary, newBackups: eff.backups, cohortEpoch: this.epoch };
		}
		return { result: 'ok', cohortEpoch: this.epoch };
	}

	/**
	 * Participant-driven re-attach to a promoted backup (cohort-topic.md §TTL and renewal: "promote
	 * `backups[0]` by sending a re-attach RPC… backup verifies it sees the record"). The backup
	 * becomes the served primary; backups re-derive from the live slot order around it.
	 */
	reattach(participantId: string, newPrimary: string, now: VTime): PrimaryAssignment {
		const rec = this.records.get(participantId);
		if (!rec) {
			return this.register(participantId, now, 0);
		}
		rec.primary = newPrimary;
		rec.backups = this.liveBackupsAfter(participantId, newPrimary);
		rec.lastPing = now;
		return { primary: rec.primary, backups: rec.backups };
	}

	/** Evict records whose last ping aged past their TTL (cohort-topic.md §TTL and renewal). */
	evictStale(now: VTime): string[] {
		const evicted: string[] = [];
		for (const [id, rec] of this.records) {
			if (now - rec.lastPing > rec.ttl) {
				evicted.push(id);
			}
		}
		for (const id of evicted) {
			this.records.delete(id);
			this.sink.record({ kind: 'Evicted', topicId: this.topicId, participantId: id, at: now });
		}
		return evicted;
	}

	// --- deterministic effective assignment ----------------------------------

	/**
	 * The deterministic slot order for a participant, skipping unreachable members. The first
	 * reachable member is the effective primary; the next reachable members (up to
	 * `backupsPerRegistration`) are the backups. Returns `undefined` when no member is reachable.
	 */
	private effectiveAssignment(participantId: string): PrimaryAssignment | undefined {
		const live = this.liveSlotOrder(participantId);
		if (live.length === 0) {
			return undefined;
		}
		return { primary: live[0]!, backups: live.slice(1, 1 + this.backupsPer) };
	}

	private liveBackupsAfter(participantId: string, primary: string): string[] {
		const live = this.liveSlotOrder(participantId).filter((m) => m !== primary);
		return live.slice(0, this.backupsPer);
	}

	/** Reachable members in deterministic slot order starting at the participant's slot. */
	private liveSlotOrder(participantId: string): string[] {
		const members = this.currentMembership.members;
		const k = members.length;
		const slot = slotOf(participantId, this.epoch, k);
		const order: string[] = [];
		for (let i = 0; i < k; i++) {
			const cand = members[(slot + i) % k]!;
			if (this.reachable(cand)) {
				order.push(cand);
			}
		}
		return order;
	}
}

export interface ParticipantRenewalOptions {
	readonly scheduler: EventScheduler;
	readonly cohort: TopicCohort;
	readonly participantId: string;
	readonly ttl: VTime;
	readonly sink?: EventSink;
}

/**
 * Participant-side renewal loop (cohort-topic.md §TTL and renewal). Pings the cached primary every
 * `ttl/3`; three consecutive unreachable pings promote the first reachable backup via re-attach;
 * if primary *and* all backups are unreachable it re-runs the lookup (re-registers). A
 * `primary_moved` reply repoints the cache within one renewal window. Counters expose the observed
 * dynamics for the failover tests.
 */
export class ParticipantRenewal {
	readonly participantId: string;
	readonly ttl: VTime;
	readonly pingInterval: VTime;
	private readonly scheduler: EventScheduler;
	private readonly cohort: TopicCohort;
	private readonly sink: EventSink;
	private cachedPrimary: string;
	private cachedBackups: string[];
	private consecutiveFailures = 0;
	private active = false;

	// --- observed dynamics (assertion surface for tests) ---
	pings = 0;
	repoints = 0;
	backupPromotions = 0;
	reLookups = 0;
	lastRepointAt: VTime | undefined;
	lastBackupPromotionAt: VTime | undefined;

	constructor(opts: ParticipantRenewalOptions) {
		this.scheduler = opts.scheduler;
		this.cohort = opts.cohort;
		this.participantId = opts.participantId;
		this.ttl = opts.ttl;
		this.sink = opts.sink ?? NULL_EVENT_SINK;
		this.pingInterval = Math.max(1, Math.floor(opts.ttl / 3));
		const assignment = opts.cohort.record(opts.participantId);
		if (!assignment) {
			throw new Error(`participant ${opts.participantId} has no registration on cohort ${opts.cohort.coord}`);
		}
		this.cachedPrimary = assignment.primary;
		this.cachedBackups = [...assignment.backups];
	}

	get primary(): string {
		return this.cachedPrimary;
	}

	get backups(): readonly string[] {
		return this.cachedBackups;
	}

	get failures(): number {
		return this.consecutiveFailures;
	}

	/** Begin the renewal loop; the first ping fires one `ttl/3` window out. */
	start(): void {
		if (this.active) {
			return;
		}
		this.active = true;
		this.scheduleNextPing();
	}

	/** Stop pinging — models a clean departure; the cohort evicts on TTL. */
	stop(): void {
		this.active = false;
	}

	private scheduleNextPing(): void {
		this.scheduler.scheduleAfter(this.pingInterval, (ctx) => {
			if (!this.active) {
				return;
			}
			this.ping(ctx.now);
			this.scheduleNextPing();
		});
	}

	private ping(now: VTime): void {
		this.pings++;
		if (this.cohort.reachable(this.cachedPrimary)) {
			this.onReachablePrimary(now);
			return;
		}
		this.onUnreachablePrimary(now);
	}

	private onReachablePrimary(now: VTime): void {
		const reply = this.cohort.renew(this.participantId, now);
		switch (reply.result) {
			case 'primary_moved': {
				this.cachedPrimary = reply.newPrimary!;
				this.cachedBackups = [...(reply.newBackups ?? [])];
				this.consecutiveFailures = 0;
				this.repoints++;
				this.lastRepointAt = now;
				break;
			}
			case 'ok': {
				this.consecutiveFailures = 0;
				break;
			}
			case 'unknown_registration': {
				this.reLookup(now);
				break;
			}
		}
	}

	private onUnreachablePrimary(now: VTime): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures < 3) {
			return;
		}
		const backup = this.cachedBackups.find((b) => this.cohort.reachable(b));
		if (backup !== undefined) {
			const assignment = this.cohort.reattach(this.participantId, backup, now);
			this.cachedPrimary = assignment.primary;
			this.cachedBackups = [...assignment.backups];
			this.consecutiveFailures = 0;
			this.backupPromotions++;
			this.lastBackupPromotionAt = now;
			this.sink.record({ kind: 'BackupPromoted', topicId: this.cohort.topicId, participantId: this.participantId, newPrimary: assignment.primary, at: now });
			return;
		}
		this.reLookup(now);
	}

	/** Primary and all backups gone — re-run the lookup against the live membership. */
	private reLookup(now: VTime): void {
		const live = this.cohort.membership.members.some((m) => this.cohort.reachable(m));
		if (!live) {
			// Whole cohort unreachable; keep the failure standing and retry on the next ping.
			return;
		}
		const assignment = this.cohort.register(this.participantId, now, this.ttl);
		this.cachedPrimary = assignment.primary;
		this.cachedBackups = [...assignment.backups];
		this.consecutiveFailures = 0;
		this.reLookups++;
	}
}
