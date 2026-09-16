/**
 * Deep structural equality over the JSON-shaped values this codebase stores and transports:
 * primitives, plain objects, arrays, and `Uint8Array` (compared by bytes — a byte array survives
 * `structuredClone`, which is the in-process transport the test transactors use).
 *
 * Written for the tree's `unchanged` entry guard (`TreeEntryGuard` in
 * `packages/db-core/src/collections/tree/struct.ts`), which must decide whether the entry
 * currently committed at a key is still the one a staged write read — where one side has
 * usually round-tripped through the log's encoding and the other has not. The three rules
 * that follow from that:
 *
 * - **Object key ORDER is irrelevant.** An encoder may sort keys (see `canonicalJson`); the
 *   value did not change because the bytes were reordered.
 * - **A key whose value is `undefined` counts as ABSENT**, matching what JSON does to it, so
 *   `{ a: 1, b: undefined }` and `{ a: 1 }` compare equal. Without this, an entry carrying an
 *   explicit `undefined` property would refuse itself the moment it crossed a JSON boundary.
 * - **`NaN` equals `NaN`.** A guard that can never accept its own value is a trap, not a check.
 *
 * NOTE: values outside that shape — `Date`, `Map`, `Set`, class instances — fall through to the
 * plain-object arm and are compared by their own enumerable properties, which for two distinct
 * `Date`s (no own properties) reports EQUAL. Entries are JSON-shaped by contract (they are
 * serialized into the log), so nothing reaches that path today; if a richer entry type is ever
 * introduced, this function needs a type tag before it can judge it.
 *
 * NOTE: the `Uint8Array` arm is correct but currently unreachable across the REAL transport. The
 * peer-to-peer repo protocol is JSON both directions (`JSON.stringify` in
 * `packages/db-p2p/src/protocol-client.ts`, `JSON.parse` in `packages/db-p2p/src/repo/service.ts`),
 * and JSON turns a `Uint8Array` into an index-keyed object — which the arm below deliberately
 * reports as NOT equal to the bytes it came from. So an entry type that is genuinely byte-shaped
 * would make an `unchanged` guard refuse an honest write forever, not just once. No such entry
 * type exists: the one candidate is the plugin's `EncodedRow` under `msgpack`, and that encoder
 * throws `not yet implemented` (`packages/quereus-plugin-optimystic/src/schema/row-codec.ts`);
 * under the `json` encoding BLOB columns are base64 strings before they ever reach a tree entry.
 * If a byte-shaped entry type is ever introduced, the guard's `expected` needs a transport-stable
 * encoding (base64, or a tagged wrapper) BEFORE this comparison can be trusted over the wire.
 */
export function structuralEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;	// identical reference, or identical primitive
	if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	if (a instanceof Uint8Array || b instanceof Uint8Array) return bytesEqual(a, b);
	if (Array.isArray(a) || Array.isArray(b)) return arraysEqual(a, b);
	return objectsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

/** Byte-wise comparison. A `Uint8Array` is only equal to another `Uint8Array` — a plain array or
 *  object with the same numeric indices is a DIFFERENT encoding of the value, and treating it as
 *  equal would let an encoding change slip past a guard unnoticed. */
function bytesEqual(a: object, b: object): boolean {
	if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
	return a.every((byte, i) => byte === b[i]);
}

/** Element-wise comparison; position is meaning, so order matters here (unlike object keys). */
function arraysEqual(a: object, b: object): boolean {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	return a.every((value, i) => structuralEquals(value, b[i]));
}

/** Compares the DEFINED own properties of two plain objects, order-independently. Equal counts of
 *  defined keys plus a recursive match on each of `a`'s is sufficient: a key present in `b` but
 *  not `a` would push `b`'s count higher, and a key `a` defines that `b` leaves undefined fails
 *  the recursive compare. */
function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = definedKeys(a);
	if (keys.length !== definedKeys(b).length) return false;
	return keys.every(key => structuralEquals(a[key], b[key]));
}

function definedKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value).filter(key => value[key] !== undefined);
}
