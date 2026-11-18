import { KeyBound, KeyRange } from '../btree/key-range.js';
import { isBlobRef, type BlobRef } from './blob-ref.js';
import { BlobRefError } from './errors.js';

/**
 * Separates the reference from the referrer in a reference-tree key. No reference contains it (a
 * reference is lowercase base32: `b`, then `a`–`z` and `2`–`7`), so the first one in a key ends the
 * reference, and the referrer after it may be any string, this character included.
 *
 * The keys compare as the tree's default comparator compares strings, by UTF-16 code unit. For
 * references `R1 < R2`, either they differ at a position inside both, where the keys compare as the
 * references do, or `R1` is a prefix of `R2`, where `R1`'s separator meets a reference character of
 * `R2` and every key of `R1` sorts first. So the keys of one reference are one contiguous run
 * ({@link blobReferenceRange}), and the runs are in reference order.
 */
export const BLOB_REFERENCE_SEPARATOR = '\u0000';
/** One past the separator: the exclusive upper bound of one reference's entries. A longer
 * reference beginning with `R` has a reference character after `R`, above this, so none of its
 * keys falls in `[R + separator, R + this)`. */
const AFTER_SEPARATOR = '\u0001';

/** `ref + BLOB_REFERENCE_SEPARATOR + referrer`. `referrer` is opaque and may be empty.
 * @throws BlobRefError when `ref` is not a reference, so a cast string can never break the framing. */
export function blobReferenceKey(ref: BlobRef, referrer: string): string {
	if (!isBlobRef(ref)) {
		throw new BlobRefError(String(ref), 'cannot frame a reference-tree key around a non-reference');
	}
	return ref + BLOB_REFERENCE_SEPARATOR + referrer;
}

/** The inverse of {@link blobReferenceKey}: split at the FIRST separator.
 * @throws BlobRefError when the key has no separator or its prefix is not a reference. */
export function decodeBlobReferenceKey(key: string): { ref: BlobRef; referrer: string } {
	const at = key.indexOf(BLOB_REFERENCE_SEPARATOR);
	if (at < 0) {
		throw new BlobRefError(key, 'a reference-tree key with no separator');
	}
	const ref = key.slice(0, at);
	if (!isBlobRef(ref)) {
		throw new BlobRefError(ref, 'a reference-tree key whose prefix is not a reference');
	}
	return { ref, referrer: key.slice(at + 1) };
}

/** The inclusive lower and exclusive upper key of `ref`'s entries, for a caller walking a path.
 * Does not validate `ref`. */
export function blobReferenceBounds(ref: BlobRef): { lower: string; upper: string } {
	return { lower: ref + BLOB_REFERENCE_SEPARATOR, upper: ref + AFTER_SEPARATOR };
}

/** The keys of `ref`'s entries, `[ref + separator, ref + one past it)`, as a range a tree scans.
 * Does not validate `ref`. */
export function blobReferenceRange(ref: BlobRef): KeyRange<string> {
	const { lower, upper } = blobReferenceBounds(ref);
	return new KeyRange(new KeyBound(lower, true), new KeyBound(upper, false));
}
