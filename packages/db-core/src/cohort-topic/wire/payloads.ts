/**
 * Cohort-topic substrate — canonical participant-signature payloads.
 *
 * A participant peer-key-signs its outbound `RegisterV1` / `RenewV1` bodies (db-p2p supplies the
 * libp2p peer key); a cohort member recomputes the identical byte image to verify that signature
 * before admitting a register (anti-DoS) or honoring a crash-failover `reattach` attestation (so a
 * stray/MITM'd ping cannot usurp a live primary — `docs/cohort-topic.md` §TTL and renewal).
 *
 * Signer and verifier must agree byte-for-byte. Exactly like {@link import("../sig/payloads.js")}
 * for the threshold-signed notices, determinism comes from encoding an explicitly-ordered JSON
 * array (array order is stable, unlike object key order) as UTF-8 — never the `signature` envelope.
 * Optional fields are normalized to a fixed placeholder (`bootstrap`→`false`, `probe`→`false`,
 * `followOn`→`false`, `appPayload`→`null`, `bootstrapEvidence`→`null` with an empty string treated as
 * absent, `reattach`→`false`, `withdraw`→`false`) so an absent optional and a present-but-default
 * optional can never disagree across the wire round-trip.
 */

import type { CohortGossipV1, RegisterV1, RenewV1 } from "./types.js";

const utf8 = new TextEncoder();

/** A `RegisterV1` minus its `signature` envelope — the bytes the participant peer-key-signs. */
export type RegisterSignable = Omit<RegisterV1, "signature">;

/** A `RenewV1` minus its `signature` envelope — the bytes the participant peer-key-signs. */
export type RenewSignable = Omit<RenewV1, "signature">;

/** Normalize the optional bootstrap-evidence slot: absent and empty-string both map to `null`. */
function normalizeEvidence(bootstrapEvidence: string | undefined): string | null {
	return bootstrapEvidence === undefined || bootstrapEvidence === "" ? null : bootstrapEvidence;
}

/** Canonical signed byte image of a `RegisterV1` body (every field except `signature`). */
export function registerSigningPayload(body: RegisterSignable): Uint8Array {
	return utf8.encode(JSON.stringify([
		"RegisterV1",
		body.v,
		body.topicId,
		body.tier,
		body.treeTier,
		body.participantCoord,
		body.ttl,
		body.bootstrap ?? false,
		body.appPayload ?? null,
		normalizeEvidence(body.bootstrapEvidence),
		body.timestamp,
		body.correlationId,
		// A read-only probe signs `probe: true`; a normal register signs `false`. Both sides recompute
		// this image identically, so a probe and a register over the same fields produce distinct signatures.
		body.probe ?? false,
		// A follow-on cold-start re-issue signs `followOn: true`, everything else `false`. Strictly appended
		// (sibling to `probe`/`withdraw`) so a MITM cannot strip or flip the follow-on assertion and the
		// signer (participant) + verifier (db-p2p cohort) agree byte-for-byte. Safe to append: no register
		// signatures are persisted (each is recomputed per verify), so there is no cross-version image concern.
		body.followOn ?? false,
	]));
}

/** Canonical signed byte image of a `RenewV1` body (every field except `signature`). */
export function renewSigningPayload(body: RenewSignable): Uint8Array {
	return utf8.encode(JSON.stringify([
		"RenewV1",
		body.v,
		body.topicId,
		body.participantId,
		body.correlationId,
		body.timestamp,
		body.reattach ?? false,
		// A withdraw tombstone signs `withdraw: true`, a ping/reattach signs `false`. Strictly appended
		// (array length 7→8) so the reattach-vs-ping distinction is preserved and a third party cannot
		// evict someone else's registration. Signer (participant) + verifier (db-p2p) move together; no
		// signatures are persisted, so there is no cross-version concern.
		body.withdraw ?? false,
	]));
}

/** A `CohortGossipV1` minus its `signature` envelope — the bytes the gossiping member peer-key-signs. */
export type CohortGossipSignable = Omit<CohortGossipV1, "signature">;

/**
 * Canonical signed byte image of a `CohortGossipV1` (every field except `signature`). Intra-cohort
 * gossip is peer-key-signed by the originating member so a receiver can drop a frame whose `fromMember`
 * signature does not verify or that comes from a non-cohort member (it can never spoof willingness/load
 * or replicate forged records). Like the other payload helpers, determinism comes from an
 * explicitly-ordered array — nested records/summaries/evictions are emitted as fixed ordered tuples so
 * the signer and the receiver (which re-derives this image from the validated frame) agree byte-for-byte.
 * Absent optionals (`records`/`evicted`/`childLinks`/`childUnlinks`) normalize to `[]`, and `appState` to
 * `null`. `childLinks`/`childUnlinks` are covered so a MITM cannot strip or inject a child link/unlink.
 */
export function cohortGossipSigningPayload(g: CohortGossipSignable): Uint8Array {
	return utf8.encode(JSON.stringify([
		"CohortGossipV1",
		g.v,
		g.fromMember,
		g.coord,
		g.cohortEpoch,
		g.treeTier,
		g.willingnessBits,
		g.loadBuckets,
		g.windowSeconds,
		g.topicSummaries.map((s) => [
			s.topicId,
			s.tier,
			s.directParticipants,
			s.arrivalsPerMin,
			s.queriesPerMin,
			s.promoted,
			s.childCohortCount,
		]),
		(g.records ?? []).map((r) => [
			r.topicId,
			r.participantId,
			r.tier,
			r.primary,
			r.backups,
			r.attachedAt,
			r.lastPing,
			r.ttl,
			r.appState ?? null,
		]),
		(g.evicted ?? []).map((e) => [e.topicId, e.participantId]),
		(g.childLinks ?? []).map((c) => [c.topicId, c.childCohortCoord, c.effectiveAt]),
		(g.childUnlinks ?? []).map((c) => [c.topicId, c.childCohortCoord, c.effectiveAt]),
		g.timestamp,
	]));
}
