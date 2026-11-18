import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { BlobRefError } from './errors.js';

declare const blobRefBrand: unique symbol;
declare const pieceIdBrand: unique symbol;

/** A blob's reference: the CID of its root piece, CIDv1, sha2-256, codec raw or dag-pb, lowercase base32. One spelling per blob, so references compare as strings. */
export type BlobRef = string & { readonly [blobRefBrand]: true };
/** A piece's CID in the same canonical spelling. The key in every piece store and on the wire. */
export type PieceId = string & { readonly [pieceIdBrand]: true };

/** Multicodec of a raw leaf piece. */
export const RAW_CODEC = 0x55;
/** Multicodec of a list piece (a UnixFS file node). */
export const DAG_PB_CODEC = 0x70;
/** Multihash code of SHA-256, the only hash a piece may be named by. */
export const SHA2_256_CODE = 0x12;

/** A canonical reference is 59 characters; the cap keeps a hostile megabyte string out of the decoder. */
const MAX_REFERENCE_CHARS = 128;
const SHA2_256_BYTES = 32;

/** Throws BlobRefError unless `text` is a canonical reference. */
export function parseBlobRef(text: string): BlobRef {
	return parseCanonical(text) as BlobRef;
}

export function isBlobRef(text: unknown): text is BlobRef {
	return 'cid' in judgeCanonical(text);
}

/** Same rule as parseBlobRef; throws BlobRefError. */
export function parsePieceId(text: string): PieceId {
	return parseCanonical(text) as PieceId;
}

/** The root piece of a blob: the same string. */
export function rootPieceId(ref: BlobRef): PieceId {
	return ref as string as PieceId;
}

/** The canonical piece id of a CID that has already passed `isPieceCid`; version 0 is re-spelt as version 1. */
export function pieceIdOfCid(cid: CID): PieceId {
	// toV1 keeps the multihash and the codec, so the re-spelt id names the same bytes.
	return canonicalSpelling(cid.toV1()) as PieceId;
}

/**
 * Encoded from the CID's bytes, never through `CID.toString`: a CID that `CID.parse` made answers
 * `toString` with the very string it was parsed from, so a padded spelling (trailing `=`, which the
 * base32 decoder strips) would come back as itself.
 */
function canonicalSpelling(cid: CID): string {
	return base32.encode(cid.bytes);
}

/** Codec raw or dag-pb, multihash sha2-256 with a 32-byte digest. Version not checked (a link inside a list piece may be CIDv0). */
export function isPieceCid(cid: CID): boolean {
	return (cid.code === RAW_CODEC || cid.code === DAG_PB_CODEC)
		&& cid.multihash.code === SHA2_256_CODE
		&& cid.multihash.digest.byteLength === SHA2_256_BYTES;
}

/** Decode an already-branded id back to a CID (never throws for a branded value). */
export function cidOfPiece(id: PieceId): CID {
	return CID.parse(id, base32);
}

function parseCanonical(text: string): string {
	const verdict = judgeCanonical(text);
	if ('problem' in verdict) {
		throw new BlobRefError(describeInput(text), verdict.problem);
	}
	return text;
}

type CanonicalVerdict = { readonly cid: CID } | { readonly problem: string };

/** The parse rule, in order; each step rejects what the next one must not see. */
function judgeCanonical(text: unknown): CanonicalVerdict {
	if (typeof text !== 'string') {
		return { problem: `not a string but ${typeof text}` };
	}
	if (text.length > MAX_REFERENCE_CHARS) {
		return { problem: `longer than ${MAX_REFERENCE_CHARS} characters` };
	}
	if (!text.startsWith(base32.prefix)) {
		return { problem: `not lowercase base32 (multibase prefix "${base32.prefix}")` };
	}
	const decoded = decodeBase32Cid(text);
	if ('problem' in decoded) {
		return decoded;
	}
	const { cid } = decoded;
	if (cid.version !== 1) {
		return { problem: `CID version ${cid.version}, not 1` };
	}
	if (!isPieceCid(cid)) {
		return { problem: describeNonPieceCid(cid) };
	}
	// Rejects every alternative spelling the decoder tolerates (trailing `=` padding).
	if (canonicalSpelling(cid) !== text) {
		return { problem: 'not the canonical spelling of its CID' };
	}
	return decoded;
}

function decodeBase32Cid(text: string): CanonicalVerdict {
	try {
		return { cid: CID.parse(text, base32) };
	} catch (error) {
		// The decoder reports malformed input by throwing; its message is the detail the caller gets.
		return { problem: error instanceof Error ? error.message : String(error) };
	}
}

function describeNonPieceCid(cid: CID): string {
	if (cid.code !== RAW_CODEC && cid.code !== DAG_PB_CODEC) {
		return `codec 0x${cid.code.toString(16)}, not raw (0x55) or dag-pb (0x70)`;
	}
	return `multihash 0x${cid.multihash.code.toString(16)} of ${cid.multihash.digest.byteLength} bytes, not sha2-256 of 32 bytes`;
}

function describeInput(text: unknown): string {
	return typeof text === 'string' ? text : `<${typeof text}>`;
}
