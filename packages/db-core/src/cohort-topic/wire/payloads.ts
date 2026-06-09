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
 * Optional fields are normalized to a fixed placeholder (`bootstrap`→`false`, `appPayload`→`null`,
 * `reattach`→`false`) so an absent optional and a present-but-default optional can never disagree
 * across the wire round-trip.
 */

import type { RegisterV1, RenewV1 } from "./types.js";

const utf8 = new TextEncoder();

/** A `RegisterV1` minus its `signature` envelope — the bytes the participant peer-key-signs. */
export type RegisterSignable = Omit<RegisterV1, "signature">;

/** A `RenewV1` minus its `signature` envelope — the bytes the participant peer-key-signs. */
export type RenewSignable = Omit<RenewV1, "signature">;

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
		body.timestamp,
		body.correlationId,
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
	]));
}
