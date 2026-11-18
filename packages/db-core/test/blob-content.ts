/** The content the blob specs build and read: byte i is `i % 251`, as in the kubo vectors of `blob-builder.spec.ts`. */
import { BLOB_PIECE_BYTES } from '../src/index.js';

const PERIOD = 251;
/** A source chunk length that divides no piece boundary. */
const FEED_CHUNK = 100_003;

/** One period-aligned pattern long enough to cut any feed chunk or whole piece from. */
const PATTERN = Uint8Array.from({ length: Math.max(FEED_CHUNK, BLOB_PIECE_BYTES) + PERIOD }, (_, i) => i % PERIOD);

/** `length` bytes of the content starting at byte `offset`; `length` at most one piece. */
export function contentAt(offset: number, length: number): Uint8Array {
	const start = offset % PERIOD;
	return PATTERN.subarray(start, start + length);
}

/** The content of a `size`-byte file in `FEED_CHUNK`-byte chunks. */
export async function* content(size: number): AsyncIterable<Uint8Array> {
	for (let offset = 0; offset < size; offset += FEED_CHUNK) {
		yield contentAt(offset, Math.min(FEED_CHUNK, size - offset));
	}
}
