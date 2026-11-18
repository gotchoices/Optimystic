import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { cidOfPiece, DAG_PB_CODEC, isPieceCid, pieceIdOfCid, RAW_CODEC, type BlobRef, type PieceId } from './blob-ref.js';
import { BlobCorruptError, type BlobCorruptReason } from './errors.js';
import { MAX_BLOB_LIST_LINKS, MAX_BLOB_PIECE_BYTES } from './limits.js';

/** One child of a list piece: the piece it names and the sizes kubo records for it. */
export interface ListChild {
	readonly cid: CID;
	/** Bytes of blob content under the child (its leaf length, or the sum of its own children's). */
	readonly fileBytes: number;
	/** Bytes of every piece under the child, the child included: a leaf's length, or a list piece's own encoded length plus its children's `treeBytes`. */
	readonly treeBytes: number;
}

/** A data piece is a raw leaf; a list piece is a dag-pb UnixFS file node. */
export type PieceKind = 'data' | 'list';

/** A list piece's children, in order, after every bound in {@link decodeListPiece} has held. */
export interface DecodedListPiece {
	readonly children: readonly DecodedChild[];
	/** Bytes of blob content under the piece: the sum of its children's `fileBytes`. */
	readonly totalBytes: number;
}

export interface DecodedChild {
	readonly id: PieceId;
	readonly kind: PieceKind;
	/** Bytes of blob content under the child, as the list piece declares; at least one. */
	readonly fileBytes: number;
}

/**
 * dag-pb bytes of a UnixFS file node over `children`, in order, exactly as kubo writes it. Three
 * details decide the bytes and the vectors in `test/blob-builder.spec.ts` pin them: every link
 * carries an empty `Name` (an absent name encodes differently), `Tsize` is the child's cumulative
 * size, and `marshal` writes `filesize` as the sum of `blockSizes` with no mode or mtime.
 */
export function encodeListPiece(children: readonly ListChild[]): Uint8Array {
	const data = new UnixFS({ type: 'file', blockSizes: children.map(child => BigInt(child.fileBytes)) });
	return dagPb.encode({
		Data: data.marshal(),
		Links: children.map(child => ({ Hash: child.cid, Name: '', Tsize: child.treeBytes })),
	});
}

/** The kind of piece an id names, read off its codec. */
export function pieceKind(id: PieceId): PieceKind {
	return kindOfCid(cidOfPiece(id));
}

/**
 * Decode and bound a dag-pb piece whose bytes are already checked against `id`; throws
 * BlobCorruptError naming the first rule that fails. The only function that interprets a list
 * piece's bytes: admitting another kind of node is a change here and in the walk
 * (docs/blobs.md §Extending toward a file system). Link `Name` and `Tsize` are not read, since
 * neither decides which bytes are served.
 */
// NOTE: `filesize` is not read, because `ipfs-unixfs` does not keep it (`fileSize()` recomputes from
// `blockSizes`). A root is sized by the sum of its `blockSizes`, each checked against what is under
// it, so the bytes served are exactly the verified bytes; a root whose `filesize` disagrees is read
// by its `blockSizes` where kubo would report the other size. Revisit if `ipfs-unixfs` exposes it.
// NOTE: accepted tradeoff — a UnixFS `Data` with no `type` field is read as a file node (the
// library's default) where kubo refuses it; the bytes served are still exactly the verified bytes.
// Revisit with the `filesize` note.
export function decodeListPiece(id: PieceId, bytes: Uint8Array, ref?: BlobRef): DecodedListPiece {
	const fault: Fault = (reason, detail) => new BlobCorruptError(reason, id, ref, detail);
	const node = decodeNode(bytes, fault);
	const blockSizes = fileBlockSizes(node.Data, fault);
	checkLinkCount(node.Links.length, blockSizes.length, fault);
	const kinds = node.Links.map((link, index) => judgeChild(link.Hash, blockSizes[index]!, index, fault));
	const total = blockSizes.reduce((sum, size) => sum + size, 0n);
	if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw fault('size-too-large', `${total} bytes`);
	}
	// Each size is at most the total, so every conversion below is exact.
	const children = node.Links.map((link, index): DecodedChild => ({
		id: pieceIdOfCid(link.Hash),
		kind: kinds[index]!,
		fileBytes: Number(blockSizes[index]!),
	}));
	return { children, totalBytes: Number(total) };
}

type Fault = (reason: BlobCorruptReason, detail?: string) => BlobCorruptError;

function decodeNode(bytes: Uint8Array, fault: Fault): dagPb.PBNode {
	try {
		return dagPb.decode(bytes);
	} catch (error) {
		// The codec reports malformed input only by throwing; its message is the detail.
		throw fault('malformed-encoding', `dag-pb: ${messageOf(error)}`);
	}
}

/** The block sizes of a UnixFS file node with no bytes of its own. */
function fileBlockSizes(data: Uint8Array | undefined, fault: Fault): readonly bigint[] {
	if (data === undefined) {
		throw fault('not-a-file-node', 'no UnixFS Data');
	}
	const file = unmarshal(data, fault);
	if (file.type !== 'file') {
		throw fault('not-a-file-node', `UnixFS type ${file.type}`);
	}
	if (file.data !== undefined && file.data.byteLength > 0) {
		throw fault('list-carries-data', `${file.data.byteLength} bytes of its own`);
	}
	return file.blockSizes;
}

function unmarshal(data: Uint8Array, fault: Fault): UnixFS {
	try {
		return UnixFS.unmarshal(data);
	} catch (error) {
		throw fault('malformed-encoding', `UnixFS: ${messageOf(error)}`);
	}
}

function checkLinkCount(links: number, blockSizes: number, fault: Fault): void {
	if (links === 0) {
		throw fault('no-links');
	}
	if (links > MAX_BLOB_LIST_LINKS) {
		throw fault('too-many-links', `${links} links, above ${MAX_BLOB_LIST_LINKS}`);
	}
	if (blockSizes !== links) {
		throw fault('size-mismatch', `${blockSizes} block sizes for ${links} links`);
	}
}

/** A child's kind, once its CID names a piece and its declared size is one a reader can follow. */
function judgeChild(cid: CID, size: bigint, index: number, fault: Fault): PieceKind {
	if (!isPieceCid(cid)) {
		throw cid.code !== RAW_CODEC && cid.code !== DAG_PB_CODEC
			? fault('unsupported-codec', `link ${index}: codec 0x${cid.code.toString(16)}`)
			: fault('unsupported-hash', `link ${index}: multihash 0x${cid.multihash.code.toString(16)} of ${cid.multihash.digest.byteLength} bytes`);
	}
	const kind = kindOfCid(cid);
	// A zero-size child is not harmless: a tree could repeat one list piece at every position and
	// cost MAX_BLOB_LIST_LINKS ^ MAX_BLOB_LIST_DEPTH requests while declaring no bytes. With every
	// child at least one byte, a full read visits at most the declared size times the depth.
	if (size === 0n) {
		throw fault('empty-child', `link ${index}`);
	}
	if (kind === 'data' && size > BigInt(MAX_BLOB_PIECE_BYTES)) {
		throw fault('piece-too-large', `link ${index} declares ${size} bytes, above ${MAX_BLOB_PIECE_BYTES}`);
	}
	return kind;
}

function kindOfCid(cid: CID): PieceKind {
	return cid.code === RAW_CODEC ? 'data' : 'list';
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
