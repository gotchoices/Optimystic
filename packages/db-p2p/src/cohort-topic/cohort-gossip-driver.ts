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
	/** True iff nothing is queued. */
	isEmpty(): boolean;
	/** Drain the queue into wire-shaped deltas, clearing it. */
	drain(): { records: GossipRecordV1[]; evicted: GossipRecordRefV1[] };
}

/** Build an empty {@link PendingDeltas} queue. */
export function createPendingDeltas(): PendingDeltas {
	const records = new Map<string, RegistrationRecord>();
	const evicted = new Map<string, GossipRecordRefV1>();
	const keyOf = (topicId: Uint8Array, participantId: Uint8Array): string =>
		`${bytesToB64url(topicId)}|${bytesToB64url(participantId)}`;
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
			evicted.set(key, { topicId: bytesToB64url(rec.topicId), participantId: bytesToB64url(rec.participantId) });
			records.delete(key);
		},
		isEmpty(): boolean {
			return records.size === 0 && evicted.size === 0;
		},
		drain(): { records: GossipRecordV1[]; evicted: GossipRecordRefV1[] } {
			const out = {
				records: [...records.values()].map(toGossipRecord),
				evicted: [...evicted.values()],
			};
			records.clear();
			evicted.clear();
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
	/** Round timestamp, unix ms. */
	readonly timestamp: number;
}

/**
 * Assemble one round's {@link CohortGossipV1}, or `undefined` when this engine is **idle** — no resident
 * topics and no pending deltas, so it has nothing for siblings and the host skips the broadcast (idle
 * empty engines cost no gossip). `willingnessBits` is `profile ∧ load` ({@link selfWillingnessBits}); the
 * `signature` slot is left empty for the host's peer-key signer to fill before broadcast.
 */
export function buildCohortGossip(i: GossipFrameInputs): CohortGossipV1 | undefined {
	if (i.topicSummaries.length === 0 && i.records.length === 0 && i.evicted.length === 0) {
		return undefined;
	}
	const g: CohortGossipV1 = {
		v: 1,
		fromMember: i.fromMember,
		coord: i.coord,
		cohortEpoch: i.cohortEpoch,
		willingnessBits: willingnessBitsHex(selfWillingnessBits(i.profile, i.barometer)),
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
	return g;
}
