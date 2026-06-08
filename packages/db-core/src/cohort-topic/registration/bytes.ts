/**
 * Cohort-topic substrate — byte-array helpers shared by the registration store, sharding, and
 * handoff. Peer ids and topic ids are raw {@link Uint8Array}; these give them stable string map
 * keys, value equality, and the ascending order the sharding hash relies on.
 */

import { compare as compareU8 } from "uint8arrays/compare";
import { equals as equalsU8 } from "uint8arrays/equals";
import { bytesToB64url } from "../wire/codec.js";

/** Stable, collision-free string map key for a byte array (base64url, the package's canonical form). */
export function bytesKey(b: Uint8Array): string {
	return bytesToB64url(b);
}

/** Composite key for a registration, `topicKey|participantKey`. */
export function recordKey(topicId: Uint8Array, participantId: Uint8Array): string {
	return `${bytesKey(topicId)}|${bytesKey(participantId)}`;
}

/** Value equality over byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return equalsU8(a, b);
}

/** Lexicographic byte order — the `sort(... by PeerId ascending)` of §Primary and backup sharding. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
	return compareU8(a, b);
}

/** Concatenate two byte arrays into a fresh buffer (the `participantId ‖ cohortEpoch` hash input). */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
