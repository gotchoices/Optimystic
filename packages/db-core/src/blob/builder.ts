import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import * as Digest from 'multiformats/hashes/digest';
import { DAG_PB_CODEC, parseBlobRef, pieceIdOfCid, RAW_CODEC, SHA2_256_CODE } from './blob-ref.js';
import { defaultBlobDigest, type BlobDigest } from './digest.js';
import { BLOB_LIST_LINKS, BLOB_PIECE_BYTES } from './limits.js';
import { encodeListPiece, type ListChild } from './list-piece.js';
import type { PieceSink } from './pieces.js';
import type { BlobPutResult } from './service.js';

export interface BuildBlobOptions {
	/** Defaults to {@link defaultBlobDigest}. Not checked here: a host's digest is checked when installed. */
	digest?: BlobDigest;
	signal?: AbortSignal;
}

/**
 * Cuts `source` into 256 KiB raw leaves and builds kubo's balanced tree over them, putting every
 * piece into `sink` after the pieces it names, one `put` at a time (the next piece waits for the
 * previous `put`, which is the back-pressure). The reference is the one `ipfs add --cid-version 1`
 * gives the same bytes.
 *
 * A source that throws, a `put` that rejects or an aborted `signal` propagates and no reference is
 * returned; pieces already put stay in the sink, and protecting or sweeping them is the caller's.
 */
export async function buildBlob(source: AsyncIterable<Uint8Array>, sink: PieceSink, options: BuildBlobOptions = {}): Promise<BlobPutResult> {
	const assembler = new BlobTreeAssembler(sink, options);
	const leaves = new PieceWriter(sink, options);
	const cutter = new LeafCutter(async leaf => {
		const cid = await leaves.put(RAW_CODEC, leaf);
		await assembler.add({ cid, fileBytes: leaf.byteLength, treeBytes: leaf.byteLength });
	});
	for await (const chunk of source) {
		options.signal?.throwIfAborted();
		await cutter.write(chunk);
	}
	await cutter.end();
	const root = await assembler.finish();
	return { ref: parseBlobRef(root.cid.toString(base32)), size: cutter.size };
}

/**
 * The level logic of the balanced tree, apart from how leaves are cut: a later builder can supply
 * leaf links it did not cut from a stream (an append or overwrite reusing an existing blob's pieces,
 * or a chunker with other boundaries) and get the same tree. Holds at most 173 links per level.
 */
export class BlobTreeAssembler {
	/** `levels[0]` holds leaf links; `levels[k]` the links of list pieces k levels up. */
	private readonly levels: ListChild[][] = [];
	private readonly pieces: PieceWriter;
	private finished = false;

	constructor(sink: PieceSink, options: BuildBlobOptions = {}) {
		this.pieces = new PieceWriter(sink, options);
	}

	/** Append one leaf link at level 0. */
	async add(child: ListChild): Promise<void> {
		this.assertOpen();
		await this.append(0, child);
	}

	/**
	 * The root. Every level below the highest is flushed whatever its count, so a trailing group of
	 * one is wrapped in a list piece of its own, as kubo's balanced builder and the JavaScript
	 * importer both do; a lone link at the highest level is the root itself, so one leaf is its own
	 * reference.
	 */
	async finish(): Promise<ListChild> {
		this.assertOpen();
		if (this.highestLevel() < 0) {
			throw new Error('BlobTreeAssembler.finish: no leaf was added');
		}
		this.finished = true;
		for (let level = 0; ; level++) {
			const group = this.levels[level] ?? [];
			if (level === this.highestLevel() && group.length === 1) {
				return group[0]!;
			}
			if (group.length > 0) {
				await this.flush(level);
			}
		}
	}

	private async append(level: number, child: ListChild): Promise<void> {
		const group = (this.levels[level] ??= []);
		group.push(child);
		if (group.length === BLOB_LIST_LINKS) {
			await this.flush(level);
		}
	}

	/** Encode a level's links as one list piece, store it, and append its link one level up. */
	private async flush(level: number): Promise<void> {
		const children = this.levels[level]!;
		this.levels[level] = [];
		const bytes = encodeListPiece(children);
		const cid = await this.pieces.put(DAG_PB_CODEC, bytes);
		await this.append(level + 1, {
			cid,
			fileBytes: sum(children, child => child.fileBytes),
			treeBytes: bytes.byteLength + sum(children, child => child.treeBytes),
		});
	}

	private highestLevel(): number {
		for (let level = this.levels.length - 1; level >= 0; level--) {
			if (this.levels[level]!.length > 0) {
				return level;
			}
		}
		return -1;
	}

	private assertOpen(): void {
		if (this.finished) {
			throw new Error('BlobTreeAssembler: already finished');
		}
	}
}

/** Hashes a piece, names it, and puts it in the sink. */
class PieceWriter {
	private readonly digest: BlobDigest;
	private readonly signal: AbortSignal | undefined;

	constructor(private readonly sink: PieceSink, options: BuildBlobOptions) {
		this.digest = options.digest ?? defaultBlobDigest();
		this.signal = options.signal;
	}

	async put(codec: number, bytes: Uint8Array): Promise<CID> {
		const cid = CID.createV1(codec, Digest.create(SHA2_256_CODE, await this.digest(bytes)));
		this.signal?.throwIfAborted();
		await this.sink.put(pieceIdOfCid(cid), bytes);
		return cid;
	}
}

/**
 * Copies source chunks of any length into fresh 256 KiB leaves. Fresh per leaf because a sink may
 * keep the array it was given; no source chunk is kept past the `write` that copies it.
 */
class LeafCutter {
	private buffer: Uint8Array | undefined;
	private filled = 0;
	private emitted = false;
	/** Total bytes written. */
	size = 0;

	constructor(private readonly emit: (leaf: Uint8Array) => Promise<void>) {}

	async write(chunk: Uint8Array): Promise<void> {
		for (let offset = 0; offset < chunk.byteLength;) {
			const buffer = (this.buffer ??= new Uint8Array(BLOB_PIECE_BYTES));
			const take = Math.min(chunk.byteLength - offset, BLOB_PIECE_BYTES - this.filled);
			buffer.set(chunk.subarray(offset, offset + take), this.filled);
			this.filled += take;
			offset += take;
			if (this.filled === BLOB_PIECE_BYTES) {
				await this.emitBuffered(buffer);
			}
		}
		this.size += chunk.byteLength;
	}

	/** The partial leaf, copied to its own array; or one empty leaf when nothing was written. */
	async end(): Promise<void> {
		if (this.buffer !== undefined && this.filled > 0) {
			await this.emitBuffered(this.buffer.slice(0, this.filled));
		} else if (!this.emitted) {
			await this.emitBuffered(new Uint8Array(0));
		}
	}

	private async emitBuffered(leaf: Uint8Array): Promise<void> {
		this.buffer = undefined;
		this.filled = 0;
		this.emitted = true;
		await this.emit(leaf);
	}
}

function sum(children: readonly ListChild[], size: (child: ListChild) => number): number {
	let total = 0;
	for (const child of children) {
		total += size(child);
	}
	return total;
}
