/**
 * Cohort-topic substrate — TTL renewal and failover.
 *
 * Per `docs/cohort-topic.md` §TTL and renewal and §Failure modes:
 *
 * - Participant pings `primary` every `ttl/3`. Success → primary touches `lastPing` and gossips it.
 * - Three consecutive ping failures → participant promotes `backups[0]` via a re-attach RPC: a renew
 *   carrying a **signed `reattach` flag** (no full re-registration). The backup accepts when it holds
 *   the record locally *and* is a computed backup under the current epoch — re-stamping `primary` to
 *   itself and serving subsequent plain pings via an epoch-scoped failover override (the unchanged
 *   `cohortEpoch` still names the dead node as the computed primary). A re-attach answered
 *   `primary_moved` means a real rotation moved primary to a live member: the participant adopts that
 *   payload instead of promoting the contacted backup (ignoring a reply that points back at the dead
 *   primary). **Resolved (GROUNDING):** the participant's `cohortEpoch` hint refreshes lazily — on the
 *   *next* ping/renewal after failover, not eagerly at failover time.
 * - All of primary + backups fail → participant re-runs lookup from `d_max` (walk ticket, injected).
 * - Cohort-side: evict where `now − lastPing > ttl`; eviction is gossiped so members converge.
 *
 * Both sides take their transport/gossip by injection so storage + sharding + TTL stay unit-testable
 * in isolation; db-core never imports FRET or libp2p here.
 */

import { b64urlToBytes } from "../wire/codec.js";
import type { RenewReplyV1, RenewV1 } from "../wire/types.js";
import { bytesEqual, bytesKey, recordKey } from "./bytes.js";
import type { SlotAssigner } from "./sharding.js";
import { MAX_PING_FAILURES, pingIntervalMs } from "./types.js";
import type { RegistrationRecord, RegistrationStore } from "./types.js";

// --- participant side ---

/** Participant-side TTL renewal: periodic ping with 3-fail backup promotion. */
export interface RenewalParticipant {
	/** Run one ping cycle: ping the current primary, count failures, promote/relookup as needed. */
	pingLoop(): Promise<void>;
	/** Re-attach to `target` (a backup), carrying the existing record; resolves with the reply. */
	reattach(target: Uint8Array): Promise<RenewReplyV1>;
	/** `ttl/3` cadence the scheduler should call {@link pingLoop} at. */
	readonly pingIntervalMs: number;
	/** The participant's current view of its registration (primary/backups). */
	readonly record: RegistrationRecord;
	/**
	 * Cached cohort-epoch hint (subscriber-side `cohortHint`). Deliberately *not* refreshed at
	 * failover; a `primary_moved` reply on the next ping refreshes it lazily.
	 */
	readonly cohortEpochHint: Uint8Array | undefined;
}

/** The unsigned body of a renew/re-attach RPC; the injected signer turns it into a {@link RenewV1}. */
export type UnsignedRenew = Omit<RenewV1, "signature">;

/** Transport the participant drives; supplied by db-p2p (FRET dial / RouteAndMaybeAct underneath). */
export interface RenewalParticipantTransport {
	/** Send a renew/re-attach to `target`; resolves with the reply, rejects on RPC failure. */
	send(target: Uint8Array, msg: RenewV1): Promise<RenewReplyV1>;
	/** Primary + all backups unreachable: re-run lookup from `d_max` (walk ticket owns the body). */
	relookup(): Promise<void>;
}

export interface RenewalParticipantDeps {
	transport: RenewalParticipantTransport;
	/** Monotonic-ish wall clock in unix ms (injected for deterministic tests). */
	clock: () => number;
	/** Signs the renew body; db-p2p supplies the peer-key signature. */
	sign: (body: UnsignedRenew) => string;
	/** Correlation id matching the original RegisterV1, base64url. */
	correlationId: string;
	/** Initial cohort-epoch hint from the registration reply (refreshed lazily thereafter). */
	initialCohortEpoch?: Uint8Array;
}

class TtlRenewalParticipant implements RenewalParticipant {
	private consecutiveFailures = 0;
	private current: RegistrationRecord;
	private epochHint: Uint8Array | undefined;

	constructor(initial: RegistrationRecord, private readonly deps: RenewalParticipantDeps) {
		this.current = initial;
		this.epochHint = deps.initialCohortEpoch;
	}

	get record(): RegistrationRecord {
		return this.current;
	}

	get cohortEpochHint(): Uint8Array | undefined {
		return this.epochHint;
	}

	get pingIntervalMs(): number {
		return pingIntervalMs(this.current.ttl);
	}

	async pingLoop(): Promise<void> {
		const reply = await this.trySend(this.current.primary);
		if (reply !== undefined) {
			this.onPingSuccess(reply);
			return;
		}
		this.consecutiveFailures++;
		if (this.consecutiveFailures < MAX_PING_FAILURES) {
			return;
		}
		await this.failover();
	}

	async reattach(target: Uint8Array): Promise<RenewReplyV1> {
		return this.deps.transport.send(target, this.buildRenew(true));
	}

	/** Send a renew, mapping an RPC rejection to `undefined` (a counted failure). */
	private async trySend(target: Uint8Array): Promise<RenewReplyV1 | undefined> {
		try {
			return await this.deps.transport.send(target, this.buildRenew(false));
		} catch {
			return undefined;
		}
	}

	private onPingSuccess(reply: RenewReplyV1): void {
		this.consecutiveFailures = 0;
		if (reply.result === "primary_moved") {
			// Lazy cohortEpoch refresh lands here: a move discovered on a normal ping updates the hint.
			this.applyPrimaryMoved(reply);
		}
	}

	/**
	 * 3-fail path: re-attach to each backup in turn (a signed `reattach=true` renew). An `ok` means the
	 * backup accepted the crash-failover promotion → promote it locally. A `primary_moved` means a real
	 * rotation moved primary to a different live member → adopt that payload (not the contacted backup),
	 * **unless** it points back at the just-failed primary (the bounce guard) — then keep trying. All
	 * backups exhausted → re-run lookup from `d_max`.
	 */
	private async failover(): Promise<void> {
		const failedPrimary = this.current.primary;
		for (const backup of this.current.backups) {
			const reply = await this.tryReattach(backup);
			if (reply === undefined) {
				continue;
			}
			if (reply.result === "ok") {
				this.promote(backup);
				return;
			}
			if (reply.result === "primary_moved") {
				// A genuine rotation: adopt the rotated assignment — but never re-adopt the dead primary
				// (the defensive guard against the exact bounce crash-failover is meant to fix).
				if (reply.newPrimary !== undefined && bytesEqual(b64(reply.newPrimary), failedPrimary)) {
					continue;
				}
				this.applyPrimaryMoved(reply);
				return;
			}
			// unknown_registration (replication lag) or anything else: try the next backup.
		}
		await this.deps.transport.relookup();
		// relookup is a terminal recovery action (it owns re-establishing the registration out of
		// band); reset the counter so a still-dead primary backs off to one relookup per
		// MAX_PING_FAILURES cycles rather than re-running the d_max walk on every subsequent ping.
		this.consecutiveFailures = 0;
	}

	private async tryReattach(target: Uint8Array): Promise<RenewReplyV1 | undefined> {
		try {
			return await this.reattach(target);
		} catch {
			return undefined;
		}
	}

	/**
	 * Promote `target` (a backup) to primary. The `cohortEpoch` hint is deliberately *not* refreshed
	 * here — per the resolved open question it refreshes lazily on the next ping/renewal.
	 */
	private promote(target: Uint8Array): void {
		const backups = this.current.backups.filter((b) => !bytesEqual(b, target));
		this.current = { ...this.current, primary: target, backups, lastPing: this.deps.clock() };
		this.consecutiveFailures = 0;
	}

	private applyPrimaryMoved(reply: RenewReplyV1): void {
		const patch: Partial<RegistrationRecord> = { lastPing: this.deps.clock() };
		if (reply.newPrimary !== undefined) {
			patch.primary = b64(reply.newPrimary);
		}
		if (reply.newBackups !== undefined) {
			patch.backups = reply.newBackups.map(b64);
		}
		if (reply.cohortEpoch !== undefined) {
			// Lazy refresh: the epoch hint catches up here, on the ping that discovers the move.
			this.epochHint = b64(reply.cohortEpoch);
		}
		this.current = { ...this.current, ...patch };
	}

	/**
	 * Build a signed renew. `reattach=true` (crash-failover) is carried inside the signed body so the
	 * accepting member can trust the attestation; a plain ping omits the field entirely (a stray renew
	 * can never silently usurp a live primary).
	 */
	private buildRenew(reattach: boolean): RenewV1 {
		const body: UnsignedRenew = {
			v: 1,
			topicId: bytesKey(this.current.topicId),
			participantId: bytesKey(this.current.participantId),
			correlationId: this.deps.correlationId,
			timestamp: this.deps.clock(),
		};
		if (reattach) {
			body.reattach = true;
		}
		return { ...body, signature: this.deps.sign(body) };
	}
}

/** Build a {@link RenewalParticipant} around an initial record. */
export function createRenewalParticipant(initial: RegistrationRecord, deps: RenewalParticipantDeps): RenewalParticipant {
	return new TtlRenewalParticipant(initial, deps);
}

// --- cohort side ---

/** Emits cohort gossip so members converge on the active set after a touch or eviction. */
export interface RenewalGossip {
	/** Gossip a `lastPing` touch for `rec`. */
	touch(rec: RegistrationRecord): void;
	/** Gossip an eviction for `rec`. */
	evicted(rec: RegistrationRecord): void;
}

export interface RenewalCohortSideDeps {
	store: RegistrationStore;
	/** This member's own peer id. */
	self: Uint8Array;
	/** Deterministic slot assignment, shared with the handoff. */
	slots: SlotAssigner;
	/** Current cohort snapshot — db-p2p supplies it from the membership source. */
	cohort: () => { members: readonly Uint8Array[]; cohortEpoch: Uint8Array };
	gossip: RenewalGossip;
	/**
	 * Optional dual-serve predicate, wired to the rotation handoff's `isServing`. During a handoff
	 * the previous primary is no longer the computed primary but must keep serving until it is acked;
	 * when this returns `true` `onRenew` touches and serves instead of replying `primary_moved`.
	 */
	isServing?: (topicId: Uint8Array, participantId: Uint8Array) => boolean;
}

/** Cohort-side TTL handling: touch on renew, redirect on rotation, sweep stale records. */
export interface RenewalCohortSide {
	/** Handle an inbound renew. Touches the record, or replies `primary_moved` if this member is no longer primary. */
	onRenew(msg: RenewV1, now: number): RenewReplyV1;
	/** Evict every stale record and gossip each eviction; returns the evicted set. */
	sweepStale(now: number): readonly RegistrationRecord[];
}

class StoreRenewalCohortSide implements RenewalCohortSide {
	/**
	 * Epoch-scoped crash-failover overrides: `recordKey → cohortEpoch under which this member accepted a
	 * promotion`. A matching entry makes a *subsequent plain ping* serve here even though the computed
	 * primary is still the dead node, so the migrated participant stops bouncing. Cleared on epoch change
	 * (the next rotation handoff reasserts the deterministic assignment). Sibling to the rotation
	 * `isServing` dual-serve exception — distinct state, OR-ed into the serve decision.
	 */
	private readonly failoverServing = new Map<string, Uint8Array>();

	constructor(private readonly deps: RenewalCohortSideDeps) {}

	onRenew(msg: RenewV1, now: number): RenewReplyV1 {
		const topicId = b64(msg.topicId);
		const participantId = b64(msg.participantId);
		const rec = this.deps.store.getByParticipant(topicId, participantId);
		if (rec === undefined) {
			return { v: 1, result: "unknown_registration" };
		}
		const { members, cohortEpoch } = this.deps.cohort();
		const { primary, backups } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
		const self = this.deps.self;
		const key = recordKey(topicId, participantId);

		if (msg.reattach === true) {
			// Crash-failover promotion request (participant attests primary unreachable).
			if (bytesEqual(primary, self)) {
				// A rotation already made this member the computed primary; serve, no override needed.
				return this.touchAndServe(rec, now);
			}
			if (backups.some((b) => bytesEqual(b, self))) {
				// Legitimate backup takeover: re-stamp primary, gossip the new assignment, and record an
				// epoch-scoped override so subsequent plain pings keep being served here.
				const restamped: RegistrationRecord = {
					...rec,
					primary: self,
					backups: rec.backups.filter((b) => !bytesEqual(b, self)),
					lastPing: now,
				};
				this.deps.store.put(restamped);
				this.failoverServing.set(key, cohortEpoch);
				this.deps.gossip.touch(restamped);
				return { v: 1, result: "ok" };
			}
			if (this.deps.isServing?.(topicId, participantId) === true) {
				// Rotation dual-serve already covers this record here.
				return this.touchAndServe(rec, now);
			}
			// Not a valid takeover target (stale participant view): redirect, do not promote.
			return this.primaryMoved(primary, backups, cohortEpoch);
		}

		// Plain ping.
		const isComputedPrimary = bytesEqual(primary, self);
		const override = this.failoverServing.get(key);
		const overrideMatches = override !== undefined && bytesEqual(override, cohortEpoch);
		// Housekeeping: drop a now-redundant override (this member is the computed primary again) or a
		// stale one tagged under a prior epoch (the rotation handoff governs across the epoch change).
		if (override !== undefined && (isComputedPrimary || !overrideMatches)) {
			this.failoverServing.delete(key);
		}
		const serving = isComputedPrimary || this.deps.isServing?.(topicId, participantId) === true || overrideMatches;
		if (serving) {
			return this.touchAndServe(rec, now);
		}
		return this.primaryMoved(primary, backups, cohortEpoch);
	}

	/** Existing touch path: stamp `lastPing`, gossip the touch, reply `ok`. */
	private touchAndServe(rec: RegistrationRecord, now: number): RenewReplyV1 {
		const touched: RegistrationRecord = { ...rec, lastPing: now };
		this.deps.store.put(touched);
		this.deps.gossip.touch(touched);
		return { v: 1, result: "ok" };
	}

	private primaryMoved(primary: Uint8Array, backups: readonly Uint8Array[], cohortEpoch: Uint8Array): RenewReplyV1 {
		return {
			v: 1,
			result: "primary_moved",
			newPrimary: bytesKey(primary),
			newBackups: backups.map(bytesKey),
			cohortEpoch: bytesKey(cohortEpoch),
		};
	}

	sweepStale(now: number): readonly RegistrationRecord[] {
		const evicted = this.deps.store.evictStale(now);
		for (const rec of evicted) {
			this.deps.gossip.evicted(rec);
		}
		return evicted;
	}
}

/** Build a {@link RenewalCohortSide}. */
export function createRenewalCohortSide(deps: RenewalCohortSideDeps): RenewalCohortSide {
	return new StoreRenewalCohortSide(deps);
}

/** Decode a base64url wire field to bytes (the canonical byte form on the wire). */
function b64(s: string): Uint8Array {
	return b64urlToBytes(s);
}
