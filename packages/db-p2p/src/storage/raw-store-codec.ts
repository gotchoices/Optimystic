import type { ActionId } from "@optimystic/db-core";

/**
 * Value codec shared by every `KvRawStorage`-backed store. Values cross the
 * `RawStoreDriver` boundary as `Uint8Array`, so this module is the single place
 * that turns `BlockMetadata`/`Transform`/`IBlock`/`BlockCommitProof` (via JSON)
 * and the `ActionId` string (via UTF-8) into bytes and back.
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

// The encoder stays module-scope: Hermes provides `TextEncoder` natively (React Native 0.74+).
const encoder = new TextEncoder();

// The decoder is built on first use, NOT at module load. Hermes has no native `TextDecoder`, and
// this module is loaded by the React Native entry (`rn.ts`, via `kv-raw-storage.ts`), so a
// module-scope `new TextDecoder()` made the import itself throw whenever it ran ahead of the host's
// polyfill (readme.md § React Native). Memoized, so every call shares one instance as before.
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

/** JSON-encode a value (`BlockMetadata` / `Transform` / `IBlock`) to UTF-8 bytes. */
export function encodeJson<T>(value: T): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

/** Decode UTF-8 JSON bytes back into a value. Callers guard the miss (`undefined`) first. */
export function decodeJson<T>(bytes: Uint8Array): T {
	return JSON.parse(decoder().decode(bytes)) as T;
}

/** Encode an `ActionId` string to UTF-8 bytes (stored as the revisions-store value). */
export function encodeActionId(actionId: ActionId): Uint8Array {
	return encoder.encode(actionId);
}

/** Decode UTF-8 bytes back into an `ActionId` string. */
export function decodeActionId(bytes: Uint8Array): ActionId {
	return decoder().decode(bytes) as ActionId;
}

/**
 * Deep-copy a value this codec decoded (`IBlock` / `Transform`), by the same JSON round-trip the
 * store applies. Used where a caller must mutate a stored value without touching the original, in
 * place of `structuredClone` — which Hermes (React Native) does not provide.
 *
 * Lossless for exactly the values this module hands out: anything `decodeJson` returned is already
 * JSON-shaped, so it carries none of what a JSON round-trip drops or rewrites (an `undefined` array
 * slot, an `undefined`-valued property, a `Date`, a `Uint8Array`) — those were already rewritten when
 * the value was stored. It is NOT a general-purpose `structuredClone` replacement: a live object
 * that never crossed this codec can come back different. `undefined` passes through, since
 * `JSON.parse(JSON.stringify(undefined))` throws.
 */
export function cloneDecoded<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
