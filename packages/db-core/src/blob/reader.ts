import { rootPieceId, type BlobRef, type PieceId } from './blob-ref.js';
import { defaultBlobDigest, type BlobDigest } from './digest.js';
import { BlobCorruptError, BlobUnavailableError } from './errors.js';
import { MAX_BLOB_LIST_DEPTH } from './limits.js';
import { decodeListPiece, pieceKind, type DecodedChild, type DecodedListPiece, type PieceKind } from './list-piece.js';
import type { PieceSource } from './pieces.js';
import { checkPiece, checkPieceSize } from './verify.js';

export interface BlobReaderOptions {
	/** Defaults to {@link defaultBlobDigest}. */
	digest?: BlobDigest;
}

export interface BlobRangeOptions extends BlobReaderOptions {
	/** First byte of the range; defaults to 0. */
	offset?: number;
	/** Bytes in the range; defaults to everything after `offset`, and a range past the end is cut at the end. */
	length?: number;
}

/** One data piece on a range's path: its id, where it starts in the blob, its declared size, and the slice of it the range wants. */
export interface BlobRangePiece {
	readonly id: PieceId;
	readonly blobOffset: number;
	readonly size: number;
	/** Within the piece, inclusive. */
	readonly start: number;
	/** Within the piece, exclusive; above `start`. */
	readonly end: number;
}

/** One piece met by a walk. */
export interface BlobWalkEntry {
	readonly id: PieceId;
	readonly kind: PieceKind;
	readonly present: boolean;
	/** Declared content bytes under the piece: from its parent for every non-root piece; for the root, the blob's size when the root is a present list piece; otherwise absent. */
	readonly fileBytes?: number;
}

/**
 * The data pieces a range needs, in order. Fetches and checks the root (even when it is a data
 * piece) and the list pieces on the range's path, never a data piece below the root, so a fetcher
 * can learn what to fetch before fetching it. Faults as {@link readBlob}.
 */
export async function* planBlobRange(ref: BlobRef, source: PieceSource, options: BlobRangeOptions = {}): AsyncIterable<BlobRangePiece> {
	for await (const { piece } of planPieces(new PieceLoader(ref, source, options), options)) {
		yield piece;
	}
}

/**
 * The verified bytes of the range, in order, one slice per data piece. Each slice is yielded only
 * once its piece and every list piece above it have passed their checks; a fault throws
 * (BlobCorruptError, BlobUnavailableError with reason 'not-here' for a piece `source` lacks, or
 * whatever `source` throws), and nothing past it is yielded, so a consumer that sees the throw
 * never takes a partial read for a whole one. A range read judges only the pieces on its path.
 * `offset` or `length` not a non-negative safe integer, or `offset` past the end, throws
 * RangeError on the first `next()`.
 *
 * The slices are views of the arrays `source` returned, which a source may share with others: a
 * consumer must not write to them.
 */
export async function* readBlob(ref: BlobRef, source: PieceSource, options: BlobRangeOptions = {}): AsyncIterable<Uint8Array> {
	const loader = new PieceLoader(ref, source, options);
	for await (const { piece, bytes } of planPieces(loader, options)) {
		const whole = bytes ?? await loader.data(piece.id, piece.size);
		yield whole.subarray(piece.start, piece.end);
	}
}

/** The blob's size from its root piece, after the root's checks, or undefined when the root is not in `source`. */
export async function readBlobSize(ref: BlobRef, source: PieceSource, options: BlobReaderOptions = {}): Promise<number | undefined> {
	return (await new PieceLoader(ref, source, options).tryRoot())?.size;
}

/**
 * Every piece of the tree (or of the part covering a range), root first, depth first, a list piece
 * before its children: whether it is in `source`, and its kind. A present list piece is checked and
 * decoded as a read checks it (a malformed one throws BlobCorruptError) and its children walked; an
 * absent one is yielded `present: false` and its subtree skipped. A data piece is never hashed:
 * its presence comes from `source.has`, or from `source.get` with the bytes discarded. A raw root,
 * or an absent root, is the whole walk; the range is judged against the size only when the root is
 * a present list piece, `offset` past the end then throwing RangeError as a read does.
 *
 * A list piece the tree repeats is yielded and walked once (per depth and per slice of it the range
 * covers); a repeated data piece is yielded at each position.
 */
export async function* walkBlobPieces(ref: BlobRef, source: PieceSource, options: BlobRangeOptions = {}): AsyncIterable<BlobWalkEntry> {
	const requested = rangeArguments(options);
	const id = rootPieceId(ref);
	if (pieceKind(id) === 'data') {
		yield { id, kind: 'data', present: await isPresent(source, id) };
		return;
	}
	const loader = new PieceLoader(ref, source, options);
	const root = await loader.tryList(id, undefined, 1);
	if (root === undefined) {
		yield { id, kind: 'list', present: false };
		return;
	}
	const range = clampRange(requested, root.totalBytes);
	yield { id, kind: 'list', present: true, fileBytes: root.totalBytes };
	yield* new TreeWalk(loader, source, range).children(root, 1, 0);
}

/** A range after clamping to the blob: `[start, end)`. */
interface ByteRange {
	readonly start: number;
	readonly end: number;
}

interface RangeArguments {
	readonly offset: number;
	readonly length: number | undefined;
}

/** A planned piece, with its bytes when they were already loaded (only ever a raw root's). */
interface PlannedPiece {
	readonly piece: BlobRangePiece;
	readonly bytes?: Uint8Array;
}

/** A root after its checks: a data piece's bytes, or a list piece decoded. */
type LoadedRoot =
	| { readonly kind: 'data'; readonly bytes: Uint8Array; readonly size: number }
	| { readonly kind: 'list'; readonly list: DecodedListPiece; readonly size: number };

async function* planPieces(loader: PieceLoader, options: BlobRangeOptions): AsyncGenerator<PlannedPiece> {
	const requested = rangeArguments(options);
	const root = await loader.root();
	const range = clampRange(requested, root.size);
	if (range.start === range.end) {
		return;
	}
	if (root.kind === 'data') {
		yield { piece: { id: loader.rootId, blobOffset: 0, size: root.size, ...range }, bytes: root.bytes };
		return;
	}
	for await (const piece of planUnder(loader, root.list, 1, 0, range)) {
		yield { piece };
	}
}

/** The data pieces of `range` under a list piece at `depth` whose content starts at `listOffset`; list pieces outside the range are never requested. */
async function* planUnder(loader: PieceLoader, list: DecodedListPiece, depth: number, listOffset: number, range: ByteRange): AsyncGenerator<BlobRangePiece> {
	for (const { child, offset } of childrenIn(list, listOffset, range)) {
		if (child.kind === 'data') {
			yield sliceOf(child, offset, range);
		} else {
			yield* planUnder(loader, await loader.list(child.id, child.fileBytes, depth + 1), depth + 1, offset, range);
		}
	}
}

function sliceOf(child: DecodedChild, offset: number, range: ByteRange): BlobRangePiece {
	return {
		id: child.id,
		blobOffset: offset,
		size: child.fileBytes,
		start: Math.max(range.start - offset, 0),
		end: Math.min(range.end, offset + child.fileBytes) - offset,
	};
}

/** The children whose content intersects `range`, each with where its content starts in the blob. */
function* childrenIn(list: DecodedListPiece, listOffset: number, range: ByteRange): Generator<{ child: DecodedChild; offset: number }> {
	// An empty range intersects nothing, not even the child whose span it falls inside.
	if (range.start === range.end) {
		return;
	}
	let offset = listOffset;
	for (const child of list.children) {
		if (offset >= range.end) {
			return;
		}
		if (offset + child.fileBytes > range.start) {
			yield { child, offset };
		}
		offset += child.fileBytes;
	}
}

/** Walks a tree's children for {@link walkBlobPieces}, remembering the list pieces it has met. */
class TreeWalk {
	// NOTE: a repeat is neither yielded nor walked again, and so not re-checked against the size its
	// new parent declares: the walk enumerates pieces and serves no bytes, and readBlob checks every
	// occurrence. Depth is in the key because the depth bound judges a piece by where it sits, so the
	// walk and a read agree on whether a tree is too deep. The set holds one key per distinct list
	// piece and depth, plus at most two per level for pieces the range edges cut.
	private readonly met = new Set<string>();

	constructor(private readonly loader: PieceLoader, private readonly source: PieceSource, private readonly range: ByteRange) {}

	async *children(list: DecodedListPiece, depth: number, listOffset: number): AsyncGenerator<BlobWalkEntry> {
		for (const { child, offset } of childrenIn(list, listOffset, this.range)) {
			if (child.kind === 'data') {
				yield { id: child.id, kind: 'data', present: await isPresent(this.source, child.id), fileBytes: child.fileBytes };
			} else if (this.firstMeeting(child, depth + 1, offset)) {
				yield* this.listChild(child, depth + 1, offset);
			}
		}
	}

	private async *listChild(child: DecodedChild, depth: number, offset: number): AsyncGenerator<BlobWalkEntry> {
		const list = await this.loader.tryList(child.id, child.fileBytes, depth);
		yield { id: child.id, kind: 'list', present: list !== undefined, fileBytes: child.fileBytes };
		if (list !== undefined) {
			yield* this.children(list, depth, offset);
		}
	}

	/** True the first time this list piece is met at this depth covering this slice of it. */
	private firstMeeting(child: DecodedChild, depth: number, offset: number): boolean {
		const { start, end } = sliceOf(child, offset, this.range);
		const covered = start === 0 && end === child.fileBytes ? 'whole' : `${start}-${end}`;
		const key = `${child.id} ${depth} ${covered}`;
		if (this.met.has(key)) {
			return false;
		}
		this.met.add(key);
		return true;
	}
}

async function isPresent(source: PieceSource, id: PieceId): Promise<boolean> {
	return source.has !== undefined ? source.has(id) : (await source.get(id)) !== undefined;
}

/**
 * Gets pieces from a source and holds each to the rules for its place in the tree: checked against
 * its id (only its size when the source is `verified`), a list piece decoded and bounded, and every
 * non-root piece's content equal to the size its parent declared.
 */
class PieceLoader {
	readonly rootId: PieceId;
	private readonly digest: BlobDigest;

	constructor(private readonly ref: BlobRef, private readonly source: PieceSource, options: BlobReaderOptions) {
		this.rootId = rootPieceId(ref);
		this.digest = options.digest ?? defaultBlobDigest();
	}

	async root(): Promise<LoadedRoot> {
		return (await this.tryRoot()) ?? this.notHere(this.rootId);
	}

	async tryRoot(): Promise<LoadedRoot | undefined> {
		if (pieceKind(this.rootId) === 'data') {
			const bytes = await this.fetch(this.rootId);
			return bytes === undefined ? undefined : { kind: 'data', bytes, size: bytes.byteLength };
		}
		const list = await this.tryList(this.rootId, undefined, 1);
		return list === undefined ? undefined : { kind: 'list', list, size: list.totalBytes };
	}

	async data(id: PieceId, declaredSize: number): Promise<Uint8Array> {
		const bytes = (await this.fetch(id)) ?? this.notHere(id);
		if (bytes.byteLength !== declaredSize) {
			throw new BlobCorruptError('size-mismatch', id, this.ref, `${bytes.byteLength} bytes where ${declaredSize} were declared`);
		}
		return bytes;
	}

	async list(id: PieceId, declaredSize: number, depth: number): Promise<DecodedListPiece> {
		return (await this.tryList(id, declaredSize, depth)) ?? this.notHere(id);
	}

	/** A list piece at `depth` (the root is 1), or undefined when the source lacks it; `declaredSize` is undefined for the root only. */
	async tryList(id: PieceId, declaredSize: number | undefined, depth: number): Promise<DecodedListPiece | undefined> {
		const bytes = await this.fetch(id);
		if (bytes === undefined) {
			return undefined;
		}
		const list = decodeListPiece(id, bytes, this.ref);
		if (declaredSize !== undefined && list.totalBytes !== declaredSize) {
			throw new BlobCorruptError('size-mismatch', id, this.ref, `children hold ${list.totalBytes} bytes where ${declaredSize} were declared`);
		}
		// Judged before any child is requested and whatever the range, so a range read and a whole
		// read of one tree agree on whether it is too deep.
		if (depth >= MAX_BLOB_LIST_DEPTH && list.children.some(child => child.kind === 'list')) {
			throw new BlobCorruptError('too-deep', id, this.ref, `a list piece at depth ${depth} names list pieces; at most ${MAX_BLOB_LIST_DEPTH} levels are followed`);
		}
		return list;
	}

	/** The piece's bytes once checked against its id, or undefined when the source lacks it. Errors the source throws propagate. */
	private async fetch(id: PieceId): Promise<Uint8Array | undefined> {
		const bytes = await this.source.get(id);
		if (bytes === undefined) {
			return undefined;
		}
		if (this.source.verified === true) {
			checkPieceSize(id, bytes, this.ref);
		} else {
			await checkPiece(id, bytes, this.digest, this.ref);
		}
		return bytes;
	}

	private notHere(id: PieceId): never {
		throw new BlobUnavailableError(this.ref, 'not-here', id);
	}
}

/** Throws RangeError, a caller's bug rather than a blob's fault, unless both are non-negative safe integers. */
function rangeArguments(options: BlobRangeOptions): RangeArguments {
	const { offset = 0, length } = options;
	if (!isByteCount(offset)) {
		throw new RangeError(`Blob range offset ${offset} is not a non-negative safe integer`);
	}
	if (length !== undefined && !isByteCount(length)) {
		throw new RangeError(`Blob range length ${length} is not a non-negative safe integer`);
	}
	return { offset, length };
}

function clampRange({ offset, length }: RangeArguments, size: number): ByteRange {
	if (offset > size) {
		throw new RangeError(`Blob range offset ${offset} is past the end of a ${size}-byte blob`);
	}
	// Compared rather than summed: offset + length can exceed Number.MAX_SAFE_INTEGER.
	const end = length === undefined || length >= size - offset ? size : offset + length;
	return { start: offset, end };
}

function isByteCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}
