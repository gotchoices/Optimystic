/**
 * The bytes of the blobs the upgrade check stores: `BLOB_BYTES` bytes of numbered ASCII lines that
 * name the seed, so a fixture regenerated from one release holds the same blob, no two of its pieces
 * are equal (they would collapse into one), and blobs of different seeds share no piece. The writer
 * stores one through `node.blobs.put` and records it in the manifest; the reader stores another over
 * the older data.
 *
 * Text rather than random bytes because every fixture keeps the writer's blob: the generator packs a
 * piece that is valid UTF-8 as text, which git compresses, where random bytes would add their
 * base64 to the repository uncompressed with every release. Byte-exact storage of pieces that are not
 * text is each piece store's conformance suite's business, not the upgrade check's.
 *
 * Plain JavaScript because the writer copies it beside itself into a published build's scratch
 * install, and the reader imports the same file (typed by `blob-content.d.mts`), as with
 * `classic-level.mjs`.
 */

/** 300 KiB: two data pieces at the 256 KiB piece size, and the list piece naming them. */
export const BLOB_BYTES = 300 * 1024;

/** `size` bytes of the lines `blob <seed> line <n>`, the last one cut at `size`. */
export function blobContent(seed, size = BLOB_BYTES) {
	const lines = [];
	let length = 0;
	for (let n = 1; length < size; n++) {
		const line = `blob ${seed} line ${String(n).padStart(8, '0')}\n`;
		lines.push(line);
		length += line.length;
	}
	return new TextEncoder().encode(lines.join('')).subarray(0, size);
}
