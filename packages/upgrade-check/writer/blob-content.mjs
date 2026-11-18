/**
 * The bytes of the blobs the upgrade check stores: `BLOB_BYTES` bytes from a seeded xorshift
 * generator, so a fixture regenerated from one release holds the same blob, and no two of its
 * pieces are equal, so they do not collapse into one. The writer stores one through `node.blobs.put`
 * and records it in the manifest; the reader stores another over the older data.
 *
 * Plain JavaScript because the writer copies it beside itself into a published build's scratch
 * install, and the reader imports the same file (typed by `blob-content.d.mts`), as with
 * `classic-level.mjs`.
 */

/** 600 KiB: three data pieces at the 256 KiB piece size, and the list piece naming them. */
export const BLOB_BYTES = 600 * 1024;

/** `size` bytes of xorshift32 output from `seed`, a nonzero integer. */
export function blobContent(seed, size = BLOB_BYTES) {
	const bytes = new Uint8Array(size);
	let state = seed >>> 0;
	if (state === 0) {
		throw new RangeError('xorshift needs a nonzero seed');
	}
	for (let i = 0; i < size; i++) {
		state = (state ^ (state << 13)) >>> 0;
		state = (state ^ (state >>> 17)) >>> 0;
		state = (state ^ (state << 5)) >>> 0;
		bytes[i] = state & 0xff;
	}
	return bytes;
}
