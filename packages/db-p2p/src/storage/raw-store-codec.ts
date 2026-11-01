import type { ActionId } from "@optimystic/db-core";

/**
 * Value codec shared by every `KvRawStorage`-backed store. Values cross the
 * `RawStoreDriver` boundary as a {@link StoredValue} — bytes unless the driver says
 * otherwise — so this module is the single place that turns
 * `BlockMetadata`/`Transform`/`IBlock`/`BlockCommitProof` (via JSON) and the
 * `ActionId` string into stored values and back. A composition picks its
 * representation once, as a {@link ValueCodec}: {@link bytesValueCodec} (UTF-8 bytes,
 * every backend's default) or {@link textValueCodec} (the text those bytes decode to,
 * for a backend whose platform decodes UTF-8 natively).
 *
 * Because a get always decodes a fresh value into a NEW object and a save always
 * encodes an independent copy (a string is immutable, and a byte array is never
 * written to after encoding), the clone-on-store / clone-on-read invariant that
 * in-memory storage used to enforce by hand (`structuredClone`) is structural for
 * kernel-backed stores — see docs/internals.md "Storage Returns References".
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

/**
 * How a driver holds a stored value in memory: the UTF-8 bytes written to disk, or the text those
 * bytes decode to. Both are the same logical value. A composition is homogeneous — its kernel, its
 * cache, its write group and its backend's reads all use one representation — and nothing branches
 * on which one at run time.
 */
export type StoredValue = Uint8Array | string;

/** How a driver's values are represented in memory, and what the kernel and the wrappers need to know about them. */
export interface ValueCodec<V extends StoredValue> {
	/** JSON-encode a value (`BlockMetadata` / `Transform` / `IBlock` / `BlockCommitProof`). */
	encodeJson<T>(value: T): V;
	/** Decode a stored JSON value into a fresh object. Callers guard the miss (`undefined`) first. */
	decodeJson<T>(value: V): T;
	/** The stored form of an `ActionId` (the revisions-store value). */
	encodeActionId(actionId: ActionId): V;
	decodeActionId(value: V): ActionId;
	/** The bytes the value takes on disk, or an estimate; paces the write group's `maxUnsyncedBytes`. */
	storedBytes(value: V): number;
	/** The bytes the value takes in memory, or an estimate; charged to the read cache's pool. */
	residentBytes(value: V): number;
	/** The value's UTF-8 bytes, for a backend that persists bytes. */
	toBytes(value: V): Uint8Array;
}

/** Values as UTF-8 bytes: every backend's representation unless it names another. */
export const bytesValueCodec: ValueCodec<Uint8Array> = {
	encodeJson,
	decodeJson,
	encodeActionId,
	decodeActionId,
	storedBytes: value => value.byteLength,
	residentBytes: value => value.byteLength,
	toBytes: value => value,
};

/** Bytes per UTF-16 code unit, what a JavaScript string costs in memory per `length`. */
const UTF16_UNIT_BYTES = 2;

/**
 * Values as the text their UTF-8 bytes decode to, for a backend whose platform hands stored values
 * back as strings decoded in native code (React Native's LevelDB binding). Never constructs a
 * `TextDecoder`, which Hermes provides only as a JavaScript polyfill; `TextEncoder`, native in
 * Hermes, turns a value into bytes when a backend persists it ({@link ValueCodec.toBytes}).
 *
 * `storedBytes` is the UTF-16 length: exact for ASCII, which the JSON this layer stores almost
 * entirely is, and an undercount for other characters by at most 3×. It only paces flushes, so an
 * undercount merely delays a size-forced one. `residentBytes` charges two bytes per UTF-16 unit, the
 * read cache's rule for strings.
 */
export const textValueCodec: ValueCodec<string> = {
	encodeJson: value => JSON.stringify(value),
	decodeJson: <T>(value: string): T => JSON.parse(value) as T,
	encodeActionId: actionId => actionId,
	decodeActionId: value => value as ActionId,
	storedBytes: value => value.length,
	residentBytes: value => value.length * UTF16_UNIT_BYTES,
	toBytes: value => encoder.encode(value),
};

/**
 * The codec argument of a constructor over a `RawStoreDriver<V>`: a bytes composition may leave it
 * out, and any other representation must name one, so a text driver built without its codec does
 * not compile. Read it with {@link resolveValueCodec}.
 */
export type ValueCodecArgument<V extends StoredValue> = [V] extends [Uint8Array]
	? [codec?: ValueCodec<V>]
	: [codec: ValueCodec<V>];

/** The codec a {@link ValueCodecArgument} named, or {@link bytesValueCodec} when it named none. */
export function resolveValueCodec<V extends StoredValue>(codec: ValueCodecArgument<V>): ValueCodec<V> {
	// Only a bytes composition can leave the codec out — the argument's type sees to that — so the
	// default is the bytes codec, which TypeScript cannot see through the deferred conditional.
	return codec[0] ?? bytesValueCodec as unknown as ValueCodec<V>;
}
