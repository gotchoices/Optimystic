import type { ActionId } from "@optimystic/db-core";

/**
 * Value codec shared by every `KvRawStorage`-backed store. Values cross the
 * `RawStoreDriver` boundary as `Uint8Array`, so this module is the single place
 * that turns `BlockMetadata`/`Transform`/`IBlock` (via JSON) and the `ActionId`
 * string (via UTF-8) into bytes and back.
 *
 * Because a get always decodes fresh bytes into a NEW object and a save always
 * encodes an independent byte copy, the clone-on-store / clone-on-read invariant
 * that in-memory storage used to enforce by hand (`structuredClone`) is now
 * structural for kernel-backed stores — see docs/internals.md "Storage Returns
 * References".
 *
 * Round-trip fidelity matters for `BlockMetadata`: an open-ended `RevisionRange`
 * is encoded `[E]` (one element, upper bound `undefined`). `JSON.stringify([5])`
 * → `"[5]"` → `JSON.parse` → `[5]`, so the open-ended encoding survives byte-exact.
 * Do NOT normalize ranges here.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON-encode a value (`BlockMetadata` / `Transform` / `IBlock`) to UTF-8 bytes. */
export function encodeJson<T>(value: T): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

/** Decode UTF-8 JSON bytes back into a value. Callers guard the miss (`undefined`) first. */
export function decodeJson<T>(bytes: Uint8Array): T {
	return JSON.parse(decoder.decode(bytes)) as T;
}

/** Encode an `ActionId` string to UTF-8 bytes (stored as the revisions-store value). */
export function encodeActionId(actionId: ActionId): Uint8Array {
	return encoder.encode(actionId);
}

/** Decode UTF-8 bytes back into an `ActionId` string. */
export function decodeActionId(bytes: Uint8Array): ActionId {
	return decoder.decode(bytes) as ActionId;
}
