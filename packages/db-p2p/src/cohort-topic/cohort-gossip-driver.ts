/**
 * Cohort-topic gossip-cadence driver helpers (host-side, gap 5).
 *
 * The {@link import("./host.js").CohortTopicHost} owns a single repeating timer; on each tick it drives
 * every live `CoordEngine`'s gossip round. The per-round work this module factors out — assembling a
 * `CohortGossipV1` and accumulating/draining the registration-record deltas the renewal `touch`/`evicted`
 * hooks emit — is split here so it is unit-testable without the timer or libp2p.
 *
 * db-p2p (not db-core) owns the cadence because the round interval, the peer-key signature on the gossip
 * envelope, and the per-coord inbound routing all live at the FRET/libp2p boundary; db-core supplies the
 * pure substrate (`selfWillingnessBits`, `toCohortTopicSummary`, `toGossipRecord`, the bus merge).
 */

import {
	bytesToB64url,
	toGossipRecord,
	willingnessBitsHex,
	selfWillingnessBits,
	type ChildLinkRefV1,
	type CohortGossipV1,
	type CohortTopicSummary,
	type GossipRecordRefV1,
	type GossipRecordV1,
	type LoadBarometerState,
	type NodeProfile,
	type RegistrationRecord,
} from "@optimystic/db-core";

/**
 * Default gossip-round cadence in ms. There is no dedicated `gossip_round` constant in
 * `docs/cohort-topic.md` §Configuration, so this is a derived, injectable default on the order of one
 * round — a few seconds, aligned with the traffic window / ping cadence (`ping_interval = ttl/3` is
 * 30 s Core, so a sub-round of that). The membership refresh (`T_membership_refresh`, 5 min) and the
 * demotion hysteresis (`T_demote`, 5 min) are gated by elapsed-time **inside** their modules, so the
 * driver can tick fast and let those modules decide when to act.
 */
export const DEFAULT_GOSSIP_INTERVAL_MS = 5_000;

/**
 * Default `T_willingness_heartbeat` (ms): how often a genuinely-**idle** but **willing** engine re-broadcasts
 * a willingness-only heartbeat so a cold cohort can bootstrap (siblings hear it, instantiate, and reciprocate
 * their own willingness) without waiting on a first registration that can never be admitted while the view is
 * empty. See `docs/cohort-topic.md` §Cold-start instantiation / §Configuration.
 *
 * On the order of the ping interval (~30 s, `ttl/3` Core) — a few gossip rounds at the 5 s cadence. A
 * record-carrying (non-idle) round already ships willingness every round and resets this clock, so the
 * throttle governs only engines with nothing else to say. The very first idle round after an engine is
 * created emits immediately (no wait), so bootstrap converges in ~2 rounds; the throttle only paces the
 * steady-state re-broadcast of an idle willing cohort.
 */
export const DEFAULT_WILLINGNESS_HEARTBEAT_MS = 30_000;

/**
 * Per-`CoordEngine` queue of registration-record deltas accumulated between gossip rounds. The renewal
 * cohort side calls {@link PendingDeltas.touch} on every served ping/re-attach and
 * {@link PendingDeltas.evicted} on every TTL sweep; the next round {@link PendingDeltas.drain}s the
 * batch into the gossip frame and clears it — one broadcast per round rather than one per ping.
 */
export interface PendingDeltas {
	/** Upsert a fresh/touched record (keyed by `(topicId, participantId)`; last write wins on `lastPing`). */
	touch(rec: RegistrationRecord): void;
	/** Queue an eviction ref and drop any pending record for the same key (a stale record can't also re-advertise). */
	evicted(rec: RegistrationRecord): void;
	/**
	 * Queue a child-cohort **link** for replication (keyed by `(topicId, childCohortCoord)`; last write wins on
	 * `effectiveAt`). Enqueued by the parent engine only when the local child registry actually changed, so a
	 * stale/no-op record is not re-gossiped. A link and a later unlink for the same child in one round collapse
	 * to whichever carries the newer `effectiveAt`.
	 */
	childLink(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): void;
	/** Queue a child-cohort **unlink** (a released/demoted child) for replication; same key + last-writer-wins as {@link childLink}. */
	childUnlink(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): void;
	/** True iff nothing is queued. */
	isEmpty(): boolean;
	/** Drain the queue into wire-shaped deltas, clearing it. */
	drain(): { records: GossipRecordV1[]; evicted: GossipRecordRefV1[]; childLinks: ChildLinkRefV1[]; childUnlinks: ChildLinkRefV1[] };
}

/** A queued child link/unlink: the wire ref plus whether it is a link (`true`) or an unlink (`false`). */
interface PendingChildDelta {
	ref: ChildLinkRefV1;
	linked: boolean;
}

/** Build an empty {@link PendingDeltas} queue. */
export function createPendingDeltas(): PendingDeltas {
	const records = new Map<string, RegistrationRecord>();
	const evicted = new Map<string, GossipRecordRefV1>();
	const childDeltas = new Map<string, PendingChildDelta>();
	const keyOf = (topicId: Uint8Array, participantId: Uint8Array): string =>
		`${bytesToB64url(topicId)}|${bytesToB64url(participantId)}`;
	// A child delta and its later opposite (link→unlink) share one key so the round drains only the newest.
	const childKeyOf = (topicId: Uint8Array, childCohortCoord: Uint8Array): string =>
		`${bytesToB64url(topicId)}|${bytesToB64url(childCohortCoord)}`;
	const queueChild = (topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number, linked: boolean): void => {
		const key = childKeyOf(topicId, childCohortCoord);
		const held = childDeltas.get(key);
		// Last-writer-wins on effectiveAt: never let an older link/unlink shadow a newer one queued the same round.
		if (held !== undefined && effectiveAt < held.ref.effectiveAt) {
			return;
		}
		childDeltas.set(key, { ref: { topicId: bytesToB64url(topicId), childCohortCoord: bytesToB64url(childCohortCoord), effectiveAt }, linked });
	};
	return {
		touch(rec: RegistrationRecord): void {
			const key = keyOf(rec.topicId, rec.participantId);
			const held = records.get(key);
			// Last-writer-wins on lastPing: never let an older touch shadow a newer one queued the same round.
			if (held === undefined || rec.lastPing >= held.lastPing) {
				records.set(key, rec);
			}
			evicted.delete(key); // a live touch supersedes a pending eviction (eviction-vs-late-touch)
		},
		evicted(rec: RegistrationRecord): void {
			const key = keyOf(rec.topicId, rec.participantId);
			// Stamp the evicted record's lastPing so the receiver can gate the delete on freshness (a stale
			// eviction must not delete a record the participant has since re-registered — see bus.mergeRecords).
			evicted.set(key, { topicId: bytesToB64url(rec.topicId), participantId: bytesToB64url(rec.participantId), lastPing: rec.lastPing });
			records.delete(key);
		},
		childLink(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): void {
			queueChild(topicId, childCohortCoord, effectiveAt, true);
		},
		childUnlink(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): void {
			queueChild(topicId, childCohortCoord, effectiveAt, false);
		},
		isEmpty(): boolean {
			return records.size === 0 && evicted.size === 0 && childDeltas.size === 0;
		},
		drain(): { records: GossipRecordV1[]; evicted: GossipRecordRefV1[]; childLinks: ChildLinkRefV1[]; childUnlinks: ChildLinkRefV1[] } {
			const childLinks: ChildLinkRefV1[] = [];
			const childUnlinks: ChildLinkRefV1[] = [];
			for (const delta of childDeltas.values()) {
				(delta.linked ? childLinks : childUnlinks).push(delta.ref);
			}
			const out = {
				records: [...records.values()].map(toGossipRecord),
				evicted: [...evicted.values()],
				childLinks,
				childUnlinks,
			};
			records.clear();
			evicted.clear();
			childDeltas.clear();
			return out;
		},
	};
}

/** Inputs to {@link buildCohortGossip} — the per-round signals already gathered by the engine. */
export interface GossipFrameInputs {
	/** This member's dialable id, base64url (the `fromMember` / view key). */
	readonly fromMember: string;
	/** This cohort's served coord, base64url (the inbound routing key). */
	readonly coord: string;
	/** This cohort's epoch, base64url. */
	readonly cohortEpoch: string;
	/** This cohort's tree tier `d` — carried on the frame so a cold sibling instantiates at the right tier. */
	readonly treeTier: number;
	/**
	 * True to emit a **willingness-only heartbeat** even when this engine is idle (no resident topics, no
	 * pending deltas) — provided the node is actually willing for some tier. Lets an idle-but-willing engine
	 * still tell siblings it will serve, so a cold cohort can bootstrap (§Cold-start instantiation). The caller
	 * (the gossip round) sets this from the per-engine heartbeat clock; a non-idle round ignores it (it already
	 * ships willingness).
	 */
	readonly heartbeat: boolean;
	/** This node's tier profile (the `∧` half of the willingness vector). */
	readonly profile: NodeProfile;
	/** This member's load barometer (load buckets + the load-shed half of willingness). */
	readonly barometer: LoadBarometerState;
	/** Cohort-wide observation window (seconds) for the rate fields in `topicSummaries`. */
	readonly windowSeconds: number;
	/** Per-resident-topic summaries (own published counts), already frozen for this round. */
	readonly topicSummaries: CohortTopicSummary[];
	/** Drained fresh/touched record deltas for this round. */
	readonly records: GossipRecordV1[];
	/** Drained eviction refs for this round. */
	readonly evicted: GossipRecordRefV1[];
	/** Drained child-cohort link refs for this round (cross-member child-set convergence). */
	readonly childLinks: ChildLinkRefV1[];
	/** Drained child-cohort unlink refs for this round (a released/demoted child). */
	readonly childUnlinks: ChildLinkRefV1[];
	/** Round timestamp, unix ms. */
	readonly timestamp: number;
}

/**
 * Assemble one round's {@link CohortGossipV1}, or `undefined` when this engine has nothing to say. An engine
 * is **idle** when it holds no resident topics and no pending deltas. An idle engine normally builds no frame
 * (idle empty engines cost no gossip) — **except** on a willingness heartbeat ({@link GossipFrameInputs.heartbeat}),
 * where an idle engine that is willing for at least one tier (`selfWillingnessBits !== 0`) still emits a
 * willingness/load-only frame (empty `topicSummaries`, no `records`/`evicted`) so siblings can hear it and a
 * cold cohort can bootstrap (§Cold-start instantiation). An idle-and-unwilling engine stays silent even on a
 * heartbeat (nothing to bootstrap). `willingnessBits` is `profile ∧ load` ({@link selfWillingnessBits}); the
 * `signature` slot is left empty for the host's peer-key signer to fill before broadcast.
 */
export function buildCohortGossip(i: GossipFrameInputs): CohortGossipV1 | undefined {
	const willingness = selfWillingnessBits(i.profile, i.barometer);
	const idle = i.topicSummaries.length === 0 && i.records.length === 0 && i.evicted.length === 0
		&& i.childLinks.length === 0 && i.childUnlinks.length === 0;
	if (idle && !(i.heartbeat && willingness !== 0)) {
		return undefined;
	}
	const g: CohortGossipV1 = {
		v: 1,
		fromMember: i.fromMember,
		coord: i.coord,
		cohortEpoch: i.cohortEpoch,
		treeTier: i.treeTier,
		willingnessBits: willingnessBitsHex(willingness),
		loadBuckets: i.barometer.loadBuckets(),
		windowSeconds: i.windowSeconds,
		topicSummaries: i.topicSummaries,
		timestamp: i.timestamp,
		signature: "",
	};
	if (i.records.length > 0) {
		g.records = i.records;
	}
	if (i.evicted.length > 0) {
		g.evicted = i.evicted;
	}
	if (i.childLinks.length > 0) {
		g.childLinks = i.childLinks;
	}
	if (i.childUnlinks.length > 0) {
		g.childUnlinks = i.childUnlinks;
	}
	return g;
}
