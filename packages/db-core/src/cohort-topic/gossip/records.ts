/**
 * Cohort-topic substrate — translation between the local {@link RegistrationRecord} (raw bytes)
 * and the wire {@link GossipRecordV1} (base64url). The gossip bus carries record deltas so backups
 * hold the record before the primary fails (per `docs/cohort-topic.md` §Registration record).
 */

import { b64urlToBytes, bytesToB64url } from "../wire/codec.js";
import type { GossipRecordV1 } from "../wire/types.js";
import type { RegistrationRecord } from "../registration/types.js";

/** Encode a local registration record for cross-member gossip. */
export function toGossipRecord(rec: RegistrationRecord): GossipRecordV1 {
	const out: GossipRecordV1 = {
		topicId: bytesToB64url(rec.topicId),
		participantId: bytesToB64url(rec.participantId),
		tier: rec.tier,
		primary: bytesToB64url(rec.primary),
		backups: rec.backups.map(bytesToB64url),
		attachedAt: rec.attachedAt,
		lastPing: rec.lastPing,
		ttl: rec.ttl,
	};
	if (rec.appState !== undefined) {
		out.appState = bytesToB64url(rec.appState);
	}
	return out;
}

/** Decode a gossiped record back into the local store shape. */
export function fromGossipRecord(g: GossipRecordV1): RegistrationRecord {
	const out: RegistrationRecord = {
		topicId: b64urlToBytes(g.topicId),
		participantId: b64urlToBytes(g.participantId),
		tier: g.tier,
		primary: b64urlToBytes(g.primary),
		backups: g.backups.map(b64urlToBytes),
		attachedAt: g.attachedAt,
		lastPing: g.lastPing,
		ttl: g.ttl,
	};
	if (g.appState !== undefined) {
		out.appState = b64urlToBytes(g.appState);
	}
	return out;
}
