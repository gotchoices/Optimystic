/**
 * key-encoding — order-preserving, injective tuple framing for tree keys.
 *
 * Both the data trees (primary keys) and the index trees are ordered by a plain
 * lexicographic string comparator (see collection-factory.ts `compare`). A composite
 * key is a tuple of column payloads that must survive round-tripping through that raw
 * UTF-16 code-unit ordering. The naive `parts.join('\x00')` this replaces is neither
 * injective (a payload containing the `\x00` separator shifts element boundaries so
 * two distinct tuples collide) nor NULL-safe (a literal value equal to the NULL
 * sentinel is indistinguishable from SQL NULL).
 *
 * This module frames each element (FoundationDB-tuple style, adapted to UTF-16 code
 * units) so the concatenation of framed elements is:
 *
 *   - Injective / delimiter-safe: a raw `\x00` in a payload is escaped to `\x00\xff`,
 *     so a bare `\x00` only ever means "end of element" (or, alone, SQL NULL).
 *   - Order-preserving under raw lexicographic comparison: NULL sorts before any
 *     present value, and present values sort by their payloads (see the ordering
 *     argument on `escapePayload`). This lets it drop in under the *current*
 *     lexicographic tree comparator without first needing a structural comparator.
 *
 * Per-element scheme:
 *
 *   NULL element      -> "\x00"                              (bare tag; sorts first)
 *   present element   -> "\x02" + escape(payload) + "\x00"   (tag, escaped payload, terminator)
 *     where escape replaces every "\x00" -> "\x00\xff".
 *
 * The `payload` is the caller's per-value serialization (a primary-key part from
 * RowCodec, or a secondary-index value from serializeIndexValue) — this module only
 * frames it, it never changes the payload bytes, so number range-ordering (e.g.
 * `toExponential`) is preserved.
 *
 * Type-distinguishing (INTEGER `42` vs TEXT `'42'`) is intentionally out of scope:
 * a key column's type is fixed by schema, so within one column that ambiguity is not
 * reachable. All present values therefore share the one `\x02` tag.
 */

/** Tag for a SQL NULL element. A bare `\x00`; sorts before any present value. */
const NULL_TAG = '\x00';
/** Tag preceding a present (non-null) payload. */
const PRESENT_TAG = '\x02';
/** Terminates a present element. Same code unit as NULL_TAG; disambiguated by position. */
const TERMINATOR = '\x00';
/** Second code unit of an escaped `\x00` (`\x00` -> `\x00\xff`). */
const ESCAPE_HI = '\xff';

/**
 * Exclusive upper-bound suffix for a framed-prefix range scan.
 *
 * To scan every tree key that begins with a complete framed prefix P (e.g. all index
 * entries whose index tuple equals P), the range is `[P, P + KEY_PREFIX_END)`. P ends
 * in a `\x00` (a terminator or the NULL tag); every child key is `P` followed by a
 * further framed element whose first code unit is a tag (`\x00` or `\x02`, both < this
 * marker), so all children sort below `P + KEY_PREFIX_END`. A *different* tuple whose
 * frame merely has P as a prefix can only arise from a value equal to P's value plus a
 * trailing `\x00`+more; its escape puts `\xff` immediately after P — above this marker,
 * so it is correctly excluded. `\x03` is one past the max tag (`\x02`) and below the
 * escape byte (`\xff`).
 */
export const KEY_PREFIX_END = '\x03';

/**
 * Escape a payload so no bare `\x00` survives inside it: `\x00` -> `\x00\xff`.
 *
 * Order-preservation argument (why `\xff`): the only code units that can appear at an
 * element boundary in a framed tuple are the tags `\x00` and `\x02`, both far below
 * `\xff` (0x00ff). When one present value is a prefix of another that continues with a
 * `\x00`, the shorter value's terminator (`\x00`) is compared against the longer
 * value's escaped `\x00\xff`; they share the `\x00`, then the shorter tuple's next code
 * unit is a boundary tag (or end-of-string) while the longer has `\xff`. Since `\xff`
 * exceeds every boundary tag, the shorter (prefix) value sorts first — matching raw
 * payload ordering.
 */
function escapePayload(payload: string): string {
	// Fast path: the vast majority of payloads contain no NUL.
	if (!payload.includes('\x00')) return payload;
	return payload.replace(/\x00/g, '\x00\xff');
}

/**
 * Frame a single element. A `null` payload encodes SQL NULL (bare tag); any string
 * — including the empty string — encodes as a present value distinct from NULL.
 */
export function encodeKeyElement(payload: string | null): string {
	if (payload === null) return NULL_TAG;
	return PRESENT_TAG + escapePayload(payload) + TERMINATOR;
}

/**
 * Concatenate framed elements into one tuple key. Each element self-delimits, so no
 * separator is inserted between them and the result is uniquely decodable.
 */
export function encodeKeyTuple(payloads: Array<string | null>): string {
	let out = '';
	for (const payload of payloads) {
		out += encodeKeyElement(payload);
	}
	return out;
}

/** One decoded tuple element: SQL NULL, or a present value with its original payload. */
export interface DecodedKeyElement {
	isNull: boolean;
	/** The original (unescaped) payload; `''` when `isNull`. */
	payload: string;
}

/**
 * Decode a framed tuple back into its elements. Assumes well-formed input produced by
 * {@link encodeKeyTuple}; a truncated present element (no terminator) is tolerated by
 * emitting whatever payload was accumulated rather than looping forever.
 */
export function splitKeyTuple(encoded: string): DecodedKeyElement[] {
	const elements: DecodedKeyElement[] = [];
	let i = 0;
	const n = encoded.length;
	while (i < n) {
		const tag = encoded[i];
		if (tag === NULL_TAG) {
			elements.push({ isNull: true, payload: '' });
			i += 1;
			continue;
		}
		// PRESENT_TAG (or, defensively, any other leading unit): read up to the terminator.
		i += 1; // consume the tag
		let payload = '';
		while (i < n) {
			const ch = encoded[i];
			if (ch === TERMINATOR) {
				// Bare `\x00` terminates; an escaped null is `\x00\xff`.
				if (encoded[i + 1] === ESCAPE_HI) {
					payload += '\x00';
					i += 2;
					continue;
				}
				i += 1; // consume terminator
				break;
			}
			payload += ch;
			i += 1;
		}
		elements.push({ isNull: false, payload });
	}
	return elements;
}
