/**
 * Matchmaking — keeping a walking seeker's registration alive (db-p2p).
 *
 * A cohort pushes arrivals only to seekers whose record it still holds, and a seeker record lives
 * `seeker_ttl` (10 s by default) while a walk's patience runs from about a second to minutes. So the walk
 * renews its registration while it hangs out and withdraws it when it leaves a tier
 * (`docs/matchmaking.md` §Push channel, §Hang-out vs. continue). One {@link SeekerKeepAlive} per walk
 * remembers the registration last `accepted` — its tier, the `RegisterV1.correlationId` the cohort
 * accepted, the member that admitted it, and its slot primary — and sends signed {@link RenewV1} frames: a
 * plain ping to the slot primary from {@link SeekerKeepAlive.renew}, a `withdraw` tombstone to the admitting
 * member (then the slot primary) from {@link SeekerKeepAlive.withdraw}.
 *
 * The walk calls `renew` on every hang-out wake (every `requery_interval_ms` on the poll path), so the
 * keep-alive throttles itself to one ping per `ttl / 3`, the substrate's renewal cadence; the `accepted`
 * register counts as the first keep-alive. Neither call throws: a failed keep-alive costs only the push
 * optimisation, never the walk.
 *
 * How a frame reaches a member (a dial over the cohort-topic `register` protocol, or an
 * in-process hook when that member is this node) is injected as {@link SeekerKeepAliveDeps.send}.
 */

import {
	b64urlToBytes,
	bytesToB64url,
	renewSigningPayload,
	type RenewReplyV1,
	type RenewV1,
} from "@optimystic/db-core";
import { bytesToPeerIdString } from "../cohort-topic/peer-codec.js";

type Log = (formatter: string, ...args: unknown[]) => void;

/** Construction inputs for a {@link SeekerKeepAlive}. */
export interface SeekerKeepAliveDeps {
	/** The walk's topic. */
	readonly topicId: Uint8Array;
	/** The seeker's participant id: the UTF-8 bytes of its peer-id string. */
	readonly participantId: Uint8Array;
	/** The seeker registration TTL the walk registers with (ms); renewal runs at a third of it. */
	readonly ttlMs: number;
	/** Sign a {@link renewSigningPayload} image with the seeker's peer key; resolves the base64url signature. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/**
	 * Deliver `renew` to the cohort member `member` (a peer-id string) and resolve its reply, or `undefined`
	 * when no reply could be had (the sender logs why).
	 */
	readonly send: (member: string, renew: RenewV1) => Promise<RenewReplyV1 | undefined>;
	/** Logger (the transport binds its `matchmaking-query` namespace). */
	readonly log: Log;
}

/** The registration a walk holds at its current tier. */
interface LiveRegistration {
	readonly treeTier: number;
	readonly correlationId: string;
	/** Peer-id string of the member that admitted the register: it holds the record from the moment it accepted. */
	readonly admittedBy: string;
	/** Peer-id string of the member a renew goes to; follows `primary_moved`. */
	primary: string;
}

/** One walk's registration keep-alive. See the module header. */
export class SeekerKeepAlive {
	private readonly topicIdB64: string;
	private readonly participantIdB64: string;
	private readonly renewEveryMs: number;
	private readonly log: Log;
	private live: LiveRegistration | undefined;
	private lastKeepAliveAt = 0;

	constructor(private readonly deps: SeekerKeepAliveDeps) {
		this.topicIdB64 = bytesToB64url(deps.topicId);
		this.participantIdB64 = bytesToB64url(deps.participantId);
		this.renewEveryMs = deps.ttlMs / 3;
		this.log = deps.log;
	}

	/**
	 * The cohort accepted the register at `treeTier` that carried `correlationId`; replaces any earlier
	 * registration. `slotPrimary` is the reply's `primary` (a cohort member id, base64url of the peer-id
	 * string); when it is absent or unreadable, renewals go to `routedMember`, the member that admitted it,
	 * whose `primary_moved` names the slot primary.
	 */
	accepted(treeTier: number, correlationId: string, slotPrimary: string | undefined, routedMember: string): void {
		this.live = { treeTier, correlationId, admittedBy: routedMember, primary: this.memberPeerId(slotPrimary) ?? routedMember };
		this.lastKeepAliveAt = Date.now();
	}

	/** Ping the slot primary, at most once per `ttl / 3`; a no-op with no live registration. Never throws. */
	async renew(): Promise<void> {
		const live = this.live;
		const now = Date.now();
		// NOTE: pings go out only when the walk wakes. On the push path that is a push or a safety poll (5 s by
		// default, half the 10 s seeker TTL), so one failed ping can let the record lapse, leaving the rest of that
		// tier to the safety poll. If pushes are measured missing for that reason, ping on the keep-alive's own timer.
		if (live === undefined || now - this.lastKeepAliveAt < this.renewEveryMs) {
			return;
		}
		this.lastKeepAliveAt = now;
		try {
			// One redirect is followed at once: the record goes untouched until a ping reaches the slot primary,
			// and on the push path the next wake can be a whole safety poll away.
			if (await this.ping(live) === "moved") {
				await this.ping(live);
			}
		} catch (err) {
			this.log("matchmaking renew failed (tier %d): %o", live.treeTier, err);
		}
	}

	/**
	 * Send a `withdraw` tombstone for the live registration and forget the registration. Any holder honours a
	 * withdraw and gossips the eviction, so it goes first to the member that admitted the register, which
	 * holds the record even when the walk escalates before admission gossip reaches the slot primary; the slot
	 * primary is tried only if that one did not withdraw it. Best effort; without it the record ages out by TTL.
	 * A no-op with no live registration. Never throws.
	 */
	async withdraw(): Promise<void> {
		const live = this.live;
		if (live === undefined) {
			return;
		}
		this.live = undefined;
		try {
			const frame = await this.frame(live, true);
			for (const holder of new Set([live.admittedBy, live.primary])) {
				const reply = await this.deps.send(holder, frame);
				if (reply?.result === "withdrawn") {
					return;
				}
				if (reply !== undefined) {
					this.log("matchmaking withdraw at tier %d answered %s by %s", live.treeTier, reply.result, holder);
				}
			}
			this.log("matchmaking withdraw at tier %d: no holder withdrew it; the record ages out by TTL", live.treeTier);
		} catch (err) {
			this.log("matchmaking withdraw failed (tier %d); the record ages out by TTL: %o", live.treeTier, err);
		}
	}

	/** Send one plain ping; `moved` when the reply named a new slot primary, now adopted in `live`. */
	private async ping(live: LiveRegistration): Promise<"done" | "moved"> {
		const reply = await this.deps.send(live.primary, await this.frame(live, false));
		switch (reply?.result) {
			case undefined:
			case "ok":
				return "done";
			case "primary_moved":
				return this.adopt(live, reply.newPrimary);
			case "unknown_registration":
				// Expected while the admission has not yet reached the slot primary by gossip (the walk registers
				// through the FRET-routed member, which can differ from it); the next ping lands. The record still
				// exists on the admitting member, so this does not re-register.
				this.log("matchmaking renew at tier %d: %s does not hold the registration yet", live.treeTier, live.primary);
				return "done";
			case "withdrawn":
				this.log("matchmaking renew at tier %d: %s answered a ping as a withdraw", live.treeTier, live.primary);
				return "done";
		}
	}

	private adopt(live: LiveRegistration, newPrimary: string | undefined): "done" | "moved" {
		const moved = this.memberPeerId(newPrimary);
		if (moved === undefined || moved === live.primary) {
			this.log("matchmaking renew at tier %d: %s answered primary_moved with no usable new primary (%s)", live.treeTier, live.primary, newPrimary);
			return "done";
		}
		live.primary = moved;
		return "moved";
	}

	private async frame(live: LiveRegistration, withdraw: boolean): Promise<RenewV1> {
		const body: Omit<RenewV1, "signature"> = {
			v: 1,
			topicId: this.topicIdB64,
			participantId: this.participantIdB64,
			correlationId: live.correlationId,
			timestamp: Date.now(),
			...(withdraw ? { withdraw: true } : {}),
		};
		return { ...body, signature: await this.deps.sign(renewSigningPayload(body)) };
	}

	/** A cohort member id from a reply (base64url of the peer-id string's bytes) as a peer-id string, or `undefined`. */
	private memberPeerId(memberId: string | undefined): string | undefined {
		if (memberId === undefined) {
			return undefined;
		}
		try {
			return bytesToPeerIdString(b64urlToBytes(memberId));
		} catch (err) {
			this.log("matchmaking: unreadable cohort member id %s: %o", memberId, err);
			return undefined;
		}
	}
}
