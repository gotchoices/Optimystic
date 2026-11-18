import { equals } from 'uint8arrays/equals';
import { cidOfPiece, type BlobRef, type PieceId } from './blob-ref.js';
import type { BlobDigest } from './digest.js';
import { BlobCorruptError } from './errors.js';
import { MAX_BLOB_PIECE_BYTES } from './limits.js';

/**
 * Throws BlobCorruptError unless `bytes` are the piece `id` names: 'piece-too-large' before any
 * hashing, so an oversized answer costs no digest, then 'digest-mismatch'.
 */
export async function checkPiece(id: PieceId, bytes: Uint8Array, digest: BlobDigest, ref?: BlobRef): Promise<void> {
	checkPieceSize(id, bytes, ref);
	if (!equals(await digest(bytes), cidOfPiece(id).multihash.digest)) {
		throw new BlobCorruptError('digest-mismatch', id, ref);
	}
}

/** The size test alone, for a source that has already checked digests. */
export function checkPieceSize(id: PieceId, bytes: Uint8Array, ref?: BlobRef): void {
	if (bytes.byteLength > MAX_BLOB_PIECE_BYTES) {
		throw new BlobCorruptError('piece-too-large', id, ref, `${bytes.byteLength} bytes, above ${MAX_BLOB_PIECE_BYTES}`);
	}
}
