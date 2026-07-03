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

import { DEFAULT_REPLAY_MAX_AGE_MS, DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS } from "../antidos/replay-guard.js";
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
	/**
	 * Best-effort remote tombstone: send a signed withdraw renew to the current primary so the cohort
	 * frees the registration immediately rather than holding it for a full TTL. Swallows any transport
	 * failure (TTL expiry remains the fallback) and does NOT touch the failure counters or trigger
	 * failover — withdraw is one-shot and fire-and-forget.
	 */
	withdraw(): Promise<void>;
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
	/** Signs the renew body; db-p2p supplies the (async) peer-key signature. */
	sign: (body: UnsignedRenew) => Promise<string>;
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
		return this.deps.transport.send(target, await this.buildRenew({ reattach: true }));
	}

	async withdraw(): Promise<void> {
		// Fire-and-forget signed tombstone to the current primary. A send failure is swallowed — the
		// record TTL-expires as it does today (the local-half fallback) — and crucially we never bump
		// `consecutiveFailures` or fail over: the participant is leaving, not recovering.
		try {
			await this.deps.transport.send(this.current.primary, await this.buildRenew({ withdraw: true }));
		} catch {
			/* best-effort; the cohort TTL bounds the leak */
		}
	}

	/** Send a renew, mapping an RPC rejection to `undefined` (a counted failure). */
	private async trySend(target: Uint8Array): Promise<RenewReplyV1 | undefined> {
		try {
			return await this.deps.transport.send(target, await this.buildRenew({}));
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
				// We now have a fresh, live primary to ping — clear the strike count so the next single
				// transient failure doesn't immediately re-failover (matching `promote` and the
				// normal-ping `primary_moved` path, which both reset here).
				this.consecutiveFailures = 0;
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
	 * Build a signed renew. The `reattach=true` (crash-failover) / `withdraw=true` (leave tombstone)
	 * flags are carried inside the signed body so the accepting member can trust the attestation; a plain
	 * ping omits both fields entirely (a stray renew can never silently usurp a live primary or evict a
	 * registration). Each flag is set only when true, matching the current plain-ping wire shape.
	 */
	private async buildRenew(opts: { reattach?: boolean; withdraw?: boolean }): Promise<RenewV1> {
		const body: UnsignedRenew = {
			v: 1,
			topicId: bytesKey(this.current.topicId),
			participantId: bytesKey(this.current.participantId),
			correlationId: this.deps.correlationId,
			timestamp: this.deps.clock(),
		};
		if (opts.reattach === true) {
			body.reattach = true;
		}
		if (opts.withdraw === true) {
			body.withdraw = true;
		}
		return { ...body, signature: await this.deps.sign(body) };
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
	/**
	 * Optional participant peer-key signature verifier (db-p2p binds it to the peer-sig primitive over
	 * {@link import("../wire/payloads.js").renewSigningPayload}). It gates the two privileged
	 * participant-attested paths: a `reattach` promotion and a `withdraw` eviction. A renew on either path
	 * whose signature does not verify against the claimed `participantId` must never act — a stray/MITM'd
	 * ping cannot usurp a live primary or evict someone else's registration (§TTL and renewal). Absent →
	 * the gate is skipped (unit tests run without peer crypto); plain pings are never verified here (they
	 * only touch `lastPing`).
	 */
	verifyParticipantSig?: (renew: RenewV1) => boolean;
	/**
	 * Optional freshness window for the two privileged, participant-attested paths (`withdraw` eviction and
	 * `reattach` promotion). The renew signature already binds `timestamp` (see
	 * {@link import("../wire/payloads.js").renewSigningPayload}), so an attacker cannot forge a fresher
	 * timestamp onto a captured frame — replay is exact-frame only. A timestamp gate is therefore a
	 * complete freshness regime for these frames: it rejects a stale/implausibly-future `timestamp`, and a
	 * per-record monotonic check (`timestamp <= rec.lastPing`) closes the sub-`maxAge` fast-replay window
	 * using state already on the record. Defaults to the register-path skew constants
	 * ({@link DEFAULT_REPLAY_MAX_AGE_MS} / {@link DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS}); db-p2p wires the same
	 * `{ maxAgeMs, maxFutureSkewMs }` config the register path's replay guard consumes so an operator tuning
	 * the skew window moves both paths together. Absent → defaults (key-less unit tests and callers work
	 * unchanged, matching how {@link verifyParticipantSig} is optional). Plain pings are NOT gated (a
	 * replayed ping is low-harm — it only re-touches `lastPing`).
	 */
	freshness?: { maxAgeMs?: number; maxFutureSkewMs?: number };
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

	/** Resolved staleness window / forward-skew tolerance for the privileged freshness gate. */
	private readonly maxAgeMs: number;
	private readonly maxFutureSkewMs: number;

	constructor(private readonly deps: RenewalCohortSideDeps) {
		this.maxAgeMs = deps.freshness?.maxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS;
		this.maxFutureSkewMs = deps.freshness?.maxFutureSkewMs ?? DEFAULT_REPLAY_MAX_FUTURE_SKEW_MS;
	}

	/**
	 * Freshness gate for the two privileged, participant-attested branches (`withdraw`, `reattach`). Returns
	 * `false` — reject — when `msg.timestamp` is stale (older than `now − maxAgeMs`), implausibly future
	 * (newer than `now + maxFutureSkewMs`), or not strictly newer than the record's `lastPing`. The signed
	 * timestamp is immutable to a replayer, so this fully bounds a captured privileged frame: the skew
	 * window catches an old capture, and the `<= rec.lastPing` monotonic check catches a fast replay that
	 * still fits inside the window (e.g. a `withdraw` captured at `t0` replayed after the record was
	 * re-registered at `t_reregister > t0`, or a `reattach` replayed after its own accepted re-stamp
	 * already advanced `lastPing`).
	 */
	private isFreshPrivileged(msg: RenewV1, rec: RegistrationRecord, now: number): boolean {
		if (msg.timestamp < now - this.maxAgeMs) {
			return false; // stale
		}
		if (msg.timestamp > now + this.maxFutureSkewMs) {
			return false; // implausibly future
		}
		// NOTE: condition (3) compares a participant-supplied `msg.timestamp` against a server-maintained
		// `rec.lastPing` (set from whichever cohort member last touched the record, using its own clock) — two
		// different machines' clocks. In normal operation a genuine leave/failover post-dates the last ping, so
		// `timestamp > lastPing` holds. If a participant's clock lags the server that set `lastPing`, a
		// legitimate reattach can be rejected; the failure is soft (returns `primary_moved`, so the failover
		// loop tries the next backup / re-runs the d_max lookup — a delayed failover, not data loss). If
		// cross-node skew is ever observed to stall failovers, relax (3) to strict `<` (accept `timestamp ==
		// lastPing`); the `maxAge` window still backstops the replay-after-re-registration attack.
		if (msg.timestamp <= rec.lastPing) {
			return false; // replay / non-monotonic against the live record
		}
		return true;
	}

	onRenew(msg: RenewV1, now: number): RenewReplyV1 {
		const topicId = b64(msg.topicId);
		const participantId = b64(msg.participantId);
		const rec = this.deps.store.getByParticipant(topicId, participantId);
		if (rec === undefined) {
			return { v: 1, result: "unknown_registration" };
		}
		const key = recordKey(topicId, participantId);

		if (msg.withdraw === true) {
			// Signed leave attestation. A forged/missing signature must never evict someone else's
			// registration → ignore, revealing nothing (`unknown_registration`, the same opaque answer a
			// non-existent record gets). The gate is absent in key-less unit mode, matching reattach.
			// `withdraw` is checked before the slot/primary computation: a withdraw needs no slot or
			// primary check (any holder evicts its replica), and it takes precedence over a (malformed)
			// co-set `reattach` — a record being withdrawn is gone regardless of a promotion request.
			if (this.deps.verifyParticipantSig?.(msg) === false) {
				return { v: 1, result: "unknown_registration" };
			}
			// Freshness gate: a signed withdraw is valid forever without this, so a captured one could be
			// replayed after the victim's record TTL-expires and re-registers, evicting the *fresh* record.
			// Reject a stale/replayed frame with the same opaque `unknown_registration` the forged-sig branch
			// returns above — indistinguishable from an untrusted frame — and never delete.
			if (!this.isFreshPrivileged(msg, rec, now)) {
				return { v: 1, result: "unknown_registration" };
			}
			this.deps.store.delete(topicId, participantId);
			this.failoverServing.delete(key); // mirror sweepStale: drop any crash-failover override
			this.deps.gossip.evicted(rec);
			return { v: 1, result: "withdrawn" };
		}

		const { members, cohortEpoch } = this.deps.cohort();
		const { primary, backups } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
		const self = this.deps.self;

		if (msg.reattach === true) {
			// Crash-failover promotion request (participant attests primary unreachable). The signed
			// `reattach` flag is what a backup trusts to promote itself, so a missing/forged signature
			// must never escalate: fall through to a plain redirect (never promote).
			if (this.deps.verifyParticipantSig?.(msg) === false) {
				return this.primaryMoved(primary, backups, cohortEpoch);
			}
			// Freshness gate: a signed reattach is valid forever without this, so a captured one could be
			// replayed to force bogus primary re-stamps. Reject a stale/replayed frame with the same redirect
			// the forged-sig branch returns above — revealing nothing — and never promote.
			if (!this.isFreshPrivileged(msg, rec, now)) {
				return this.primaryMoved(primary, backups, cohortEpoch);
			}
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
		// NOTE: plain pings are deliberately NOT run through the privileged freshness gate (isFreshPrivileged).
		// A replayed ping is low-harm — it can only re-touch a record's `lastPing`, never delete or usurp — and
		// the strict `timestamp <= lastPing` monotonic check would risk rejecting a legitimate ping that arrives
		// slightly out of order or under minor participant-clock non-monotonicity. If plain-ping replay ever
		// becomes a concern (e.g. touch-driven traffic accounting is abused), gate it here too.
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
			// Drop any crash-failover override for an evicted record. Otherwise it leaks (the record gets
			// no more pings, so the plain-ping housekeeping that would clear it never runs) and — if the
			// same `(topic, participant)` re-registers under the unchanged epoch — could wrongly make a
			// non-primary member keep serving via the stale override.
			this.failoverServing.delete(recordKey(rec.topicId, rec.participantId));
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
