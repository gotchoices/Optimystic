import type { BlobRef, PieceId } from './blob-ref.js';

/** How much of a rejected string a message repeats; the whole of it stays on `text`. */
const QUOTED_CHARS = 80;

/** The string is not a blob reference (or piece id) in its one canonical spelling. */
export class BlobRefError extends Error {
	constructor(readonly text: string, readonly detail: string) {
		super(`Not a blob reference: ${quote(text)} (${detail})`);
		this.name = 'BlobRefError';
	}
}

/**
 * Why a blob's bytes are not here. All four mean "not yet"; the blob counterpart of
 * `BlockUnavailableReason`. The meanings are docs/blobs.md §The node's blob service.
 */
export type BlobUnavailableReason =
	/** The read asked for this node's copy only (`from: 'here'`), and it is not whole here. */
	| 'not-here'
	/** Every holder asked answered that it does not have it. */
	| 'not-held'
	/** Some of the holders asked did not answer. */
	| 'peers-unreachable'
	/** None of the blob's cohort could be asked. */
	| 'cohort-unreachable';

export class BlobUnavailableError extends Error {
	constructor(readonly ref: BlobRef, readonly reason: BlobUnavailableReason, readonly pieceId?: PieceId) {
		super(`Blob ${ref} is not available (${reason})${pieceId === undefined ? '' : `: piece ${pieceId}`}`);
		this.name = 'BlobUnavailableError';
	}
}

export type BlobCorruptReason =
	/** Bytes do not hash to the CID that named them. */
	| 'digest-mismatch'
	/** A piece, or a declared leaf size, above MAX_BLOB_PIECE_BYTES. */
	| 'piece-too-large'
	/** A link to a codec other than raw or dag-pb. */
	| 'unsupported-codec'
	/** A link whose multihash is not sha2-256 with 32 bytes. */
	| 'unsupported-hash'
	/** dag-pb or UnixFS bytes that do not decode. */
	| 'malformed-encoding'
	/** A dag-pb piece with no UnixFS Data, or a UnixFS type other than file. */
	| 'not-a-file-node'
	/** A UnixFS file node with bytes of its own. */
	| 'list-carries-data'
	/** A list piece with no children. */
	| 'no-links'
	/** Above MAX_BLOB_LIST_LINKS. */
	| 'too-many-links'
	/** A list piece below MAX_BLOB_LIST_DEPTH list levels. */
	| 'too-deep'
	/** A declared child size of zero. */
	| 'empty-child'
	/** Block sizes and links disagree in count, child sizes do not add up to what the parent declared, or a leaf's length differs from its declared size. */
	| 'size-mismatch'
	/** A total above Number.MAX_SAFE_INTEGER. */
	| 'size-too-large';

/**
 * The blob is malformed, or a holder served bytes that fail verification and no other holder
 * could supply them. `ref` is optional because a single piece can be checked without knowing
 * which blob asked for it.
 */
export class BlobCorruptError extends Error {
	constructor(readonly reason: BlobCorruptReason, readonly pieceId: PieceId, readonly ref?: BlobRef, detail?: string) {
		super(`${ref === undefined ? 'Blob piece' : `Blob ${ref}, piece`} ${pieceId} is corrupt (${reason})${detail === undefined ? '' : `: ${detail}`}`);
		this.name = 'BlobCorruptError';
	}
}

/** Why a piece store's file import was refused; see {@link BlobImportError}. */
export type BlobImportReason =
	/** The store reported no leaves at all. Even an empty file has one, so this is a broken store. */
	| 'no-pieces'
	/** A reported id is not a raw-codec SHA-256 piece id in its canonical spelling. */
	| 'not-a-raw-piece'
	/** A reported leaf length is not one that cutting the file at the service's piece size gives. */
	| 'size-mismatch'
	/** A reported leaf is not in the store, so the import did not store what it said it had. */
	| 'piece-missing'
	/** A reported leaf's stored bytes do not hash to the id the store gave it (mode `verify` only). */
	| 'digest-mismatch';

/**
 * A piece store's `importFile` reported leaves this node will not build a reference from
 * (docs/blobs.md §Putting and reading by file path): the reference would not be the one a stream
 * put of the same bytes gives, so the put fails rather than naming bytes by a hash nothing else
 * would agree with. Whatever the import stored is left for the piece sweep.
 */
export class BlobImportError extends Error {
	constructor(readonly reason: BlobImportReason, detail: string, readonly pieceId?: PieceId) {
		super(`Blob file import refused (${reason})${pieceId === undefined ? '' : `, piece ${pieceId}`}: ${detail}`);
		this.name = 'BlobImportError';
	}
}

/** A digest function gave a wrong answer, or threw, on a known SHA-256 input. */
export class BlobDigestError extends Error {
	constructor(detail: string, options?: ErrorOptions) {
		super(`Not a SHA-256 digest: ${detail}`, options);
		this.name = 'BlobDigestError';
	}
}

function quote(text: string): string {
	return text.length > QUOTED_CHARS
		? `${JSON.stringify(text.slice(0, QUOTED_CHARS))}… (${text.length} characters)`
		: JSON.stringify(text);
}
