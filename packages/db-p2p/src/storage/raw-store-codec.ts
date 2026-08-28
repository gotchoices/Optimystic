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

/**
 * Synthetic action-id key under which a revision's `BlockCommitProof` is stored in the
 * TRANSACTIONS store. Riding that store means every existing `RawStoreDriver` backend persists
 * proofs with zero driver changes — the FS driver already percent-encodes `:` in action-id
 * filenames, so the key round-trips on every backend. Nothing enumerates the transactions store
 * (there is no `listTransactions`; `recover()` and `materializeBlock` only probe action ids read
 * from the REVISIONS store), so a proof entry never leaks into a revision walk.
 *
 * `~proof:` is intended as a RESERVED action-id namespace — real action ids are hashes / prefixed
 * forms (`tx:<hash>`, `stamp:<hash>`, `inv:<...>`) and never start with `~`. BUT that reservation
 * is currently a CONVENTION, not an enforced invariant: `StorageRepo.pend` accepts a
 * client-supplied `actionId` verbatim, and `BlockStorage.saveRestored` writes a peer-supplied
 * archive's action id verbatim, so a hostile client or peer can collide with this key and overwrite
 * either a stored proof or a committed transform. Tracked by
 * `reserved-proof-key-collides-with-client-action-ids`; do not rely on the reservation until that
 * lands.
 */
export function blockProofActionKey(rev: number): ActionId {
	return `~proof:${rev}` as ActionId;
}

/** Decode UTF-8 bytes back into an `ActionId` string. */
export function decodeActionId(bytes: Uint8Array): ActionId {
	return decoder.decode(bytes) as ActionId;
}
