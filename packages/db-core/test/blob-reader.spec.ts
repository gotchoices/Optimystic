/**
 * The verified reader: whole and range reads of trees `buildBlob` made, the planner's choice of
 * pieces, every malformed shape a reader refuses, and the walk's handling of absent and repeated
 * pieces. Content byte i is `i % 251` (`blob-content.ts`).
 */
import { expect } from 'chai';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS, type UnixFSType } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { equals } from 'uint8arrays/equals';
import {
	BLOB_PIECE_BYTES,
	BlobCorruptError,
	BlobUnavailableError,
	buildBlob,
	cidOfPiece,
	decodeListPiece,
	defaultBlobDigest,
	DAG_PB_CODEC,
	MAX_BLOB_LIST_DEPTH,
	MAX_BLOB_LIST_LINKS,
	MAX_BLOB_PIECE_BYTES,
	parseBlobRef,
	pieceIdOfCid,
	planBlobRange,
	RAW_CODEC,
	readBlob,
	rootPieceId,
	SHA2_256_CODE,
	walkBlobPieces,
	type BlobCorruptReason,
	type BlobDigest,
	type BlobRef,
	type PieceId,
	type PieceSource,
} from '../src/index.js';
import { content, contentAt } from './blob-content.js';

/** 176 leaves under two list pieces (174 and 2 leaves) under the root. */
const LARGE_SIZE = 175 * BLOB_PIECE_BYTES + 1;
const LARGE_PIECES = 179;

type Pieces = ReadonlyMap<PieceId, Uint8Array>;

/** A map as a piece source, remembering every `get` in order. */
class MapSource implements PieceSource {
	readonly gets: PieceId[] = [];
	readonly verified: boolean;
	readonly has?: (id: PieceId) => Promise<boolean>;

	constructor(private readonly pieces: Pieces, options: { verified?: boolean; has?: boolean } = {}) {
		this.verified = options.verified ?? false;
		if (options.has === true) {
			this.has = async id => this.pieces.has(id);
		}
	}

	async get(id: PieceId): Promise<Uint8Array | undefined> {
		this.gets.push(id);
		return this.pieces.get(id);
	}
}

/** The default digest, counting its calls; given to the reader only. */
function countingDigest(): BlobDigest & { calls: number } {
	const digest = defaultBlobDigest();
	const counted = Object.assign(async (bytes: Uint8Array) => {
		counted.calls++;
		return digest(bytes);
	}, { calls: 0 });
	return counted;
}

async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
	const all: T[] = [];
	for await (const item of items) all.push(item);
	return all;
}

/** Asserts the chunks are exactly the content's `length` bytes from `offset`, without holding them. */
async function expectContent(chunks: AsyncIterable<Uint8Array>, offset: number, length: number): Promise<void> {
	let at = offset;
	for await (const chunk of chunks) {
		expect(equals(chunk, contentAt(at, chunk.byteLength)), `bytes at ${at}`).to.equal(true);
		at += chunk.byteLength;
	}
	expect(at - offset, 'bytes read').to.equal(length);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

/** A hand-made piece store for malformed trees. */
class HandTree {
	readonly pieces = new Map<PieceId, Uint8Array>();

	async raw(bytes: Uint8Array): Promise<CID> {
		return this.put(RAW_CODEC, bytes);
	}

	/** A dag-pb piece over `links`, with UnixFS data `data` (absent when undefined). */
	async node(links: readonly CID[], data: Uint8Array | undefined): Promise<CID> {
		return this.put(DAG_PB_CODEC, dagPb.encode({ Data: data, Links: links.map(Hash => ({ Hash, Name: '', Tsize: 0 })) }));
	}

	/** A well-formed list piece. */
	async list(children: readonly { cid: CID; size: number | bigint }[]): Promise<CID> {
		return this.node(children.map(child => child.cid), fileData(children.map(child => BigInt(child.size))));
	}

	async put(codec: number, bytes: Uint8Array): Promise<CID> {
		const cid = CID.createV1(codec, Digest.create(SHA2_256_CODE, await defaultBlobDigest()(bytes)));
		this.pieces.set(pieceIdOfCid(cid), bytes);
		return cid;
	}
}

function fileData(blockSizes: bigint[], options: { type?: UnixFSType; data?: Uint8Array } = {}): Uint8Array {
	return new UnixFS({ type: options.type ?? 'file', blockSizes, data: options.data }).marshal();
}

function refOf(cid: CID): BlobRef {
	return parseBlobRef(pieceIdOfCid(cid));
}

describe('reading a built blob', () => {
	const large = new Map<PieceId, Uint8Array>();
	let largeRef: BlobRef;

	before(async function () {
		this.timeout(30_000);
		largeRef = (await buildBlob(content(LARGE_SIZE), { put: async (id, bytes) => { large.set(id, bytes); } })).ref;
	});

	it('reads a built blob back whole, hashing each piece once', async () => {
		const digest = countingDigest();
		await expectContent(readBlob(largeRef, new MapSource(large), { digest }), 0, LARGE_SIZE);
		expect(digest.calls).to.equal(LARGE_PIECES);
	});

	it('hashes nothing through a verified source', async () => {
		const digest = countingDigest();
		await expectContent(readBlob(largeRef, new MapSource(large, { verified: true }), { digest }), 0, LARGE_SIZE);
		expect(digest.calls).to.equal(0);
	});

	const ranges: readonly { name: string; offset?: number; length?: number; pieces: number; bytes: number }[] = [
		{ name: 'an empty range', offset: 0, length: 0, pieces: 0, bytes: 0 },
		{ name: 'a range at the end', offset: LARGE_SIZE, length: 5, pieces: 0, bytes: 0 },
		{ name: 'a range past the end, cut at the end', offset: LARGE_SIZE - 10, length: 100, pieces: 2, bytes: 10 },
		{ name: 'a range inside one piece', offset: 100, length: 50, pieces: 1, bytes: 50 },
		{ name: 'a range across a data-piece boundary', offset: BLOB_PIECE_BYTES - 1, length: 2, pieces: 2, bytes: 2 },
		{ name: 'a range across a list-piece boundary', offset: 174 * BLOB_PIECE_BYTES - 1, length: 2, pieces: 2, bytes: 2 },
		{ name: 'everything after an offset', offset: LARGE_SIZE - 1, pieces: 1, bytes: 1 },
	];
	for (const range of ranges) {
		it(`plans and reads ${range.name}`, async () => {
			const options = { offset: range.offset, length: range.length };
			expect(await drain(planBlobRange(largeRef, new MapSource(large), options))).to.have.length(range.pieces);
			await expectContent(readBlob(largeRef, new MapSource(large), options), range.offset ?? 0, range.bytes);
		});
	}

	const refused: readonly { name: string; offset?: number; length?: number; requested: number }[] = [
		{ name: 'an offset past the end', offset: LARGE_SIZE + 1, requested: 1 },
		{ name: 'a negative offset', offset: -1, requested: 0 },
		{ name: 'a fractional length', offset: 0, length: 1.5, requested: 0 },
	];
	for (const range of refused) {
		it(`refuses ${range.name} with RangeError`, async () => {
			const source = new MapSource(large);
			expect(await rejection(drain(readBlob(largeRef, source, { offset: range.offset, length: range.length })))).to.be.instanceOf(RangeError);
			expect(source.gets, 'pieces requested').to.have.length(range.requested);
		});
	}

	it('requests only the path of a range across a list-piece boundary', async () => {
		const root = decodeListPiece(rootPieceId(largeRef), large.get(rootPieceId(largeRef))!);
		const [first, second] = root.children.map(child => decodeListPiece(child.id, large.get(child.id)!));
		const [rootId, firstId, secondId] = [rootPieceId(largeRef), root.children[0]!.id, root.children[1]!.id];
		const options = { offset: 174 * BLOB_PIECE_BYTES - 1, length: 2 };

		const planner = new MapSource(large);
		await drain(planBlobRange(largeRef, planner, options));
		expect(planner.gets, 'planner').to.deep.equal([rootId, firstId, secondId]);

		const reader = new MapSource(large);
		await drain(readBlob(largeRef, reader, options));
		expect(reader.gets, 'reader').to.deep.equal([rootId, firstId, first!.children[173]!.id, secondId, second!.children[0]!.id]);
	});

	it('names the piece a source lacks', async () => {
		const tree = new Map(large);
		const second = decodeListPiece(rootPieceId(largeRef), large.get(rootPieceId(largeRef))!).children[1]!.id;
		const leaf = decodeListPiece(second, large.get(second)!).children[1]!.id;
		tree.delete(leaf);
		const error = await rejection(drain(readBlob(largeRef, new MapSource(tree), { offset: LARGE_SIZE - 1 })));
		expect(error).to.be.instanceOf(BlobUnavailableError);
		expect(error).to.include({ reason: 'not-here', pieceId: leaf, ref: largeRef });
	});

	it('walks around an absent list piece without reading data pieces', async () => {
		const pieces = new Map(large);
		const [lost, kept] = decodeListPiece(rootPieceId(largeRef), pieces.get(rootPieceId(largeRef))!).children;
		pieces.delete(lost!.id);
		const source = new MapSource(pieces, { has: true });

		const entries = await drain(walkBlobPieces(largeRef, source));
		expect(entries.map(entry => [entry.kind, entry.present])).to.deep.equal([
			['list', true], ['list', false], ['list', true], ['data', true], ['data', true],
		]);
		expect(entries[1]).to.deep.equal({ id: lost!.id, kind: 'list', present: false, fileBytes: 174 * BLOB_PIECE_BYTES });
		expect(entries[2]!.id).to.equal(kept!.id);
		expect(source.gets.filter(id => cidOfPiece(id).code === RAW_CODEC), 'data pieces read').to.deep.equal([]);
	});

	it('walks only the root for an empty range inside the blob', async () => {
		const entries = await drain(walkBlobPieces(largeRef, new MapSource(large), { offset: 100, length: 0 }));
		expect(entries.map(entry => entry.id)).to.deep.equal([rootPieceId(largeRef)]);
	});
});

/** A malformed tree: its reference, and a piece below (or after) the fault that must never be requested. */
interface MalformedTree {
	readonly ref: BlobRef;
	readonly untouched?: PieceId;
}

const LEAF = contentAt(0, 10);

/** Built through `tree`: a root that links `under` with `size`, the shape most rows share. */
async function rootOver(tree: HandTree, under: CID, size: number | bigint): Promise<BlobRef> {
	return refOf(await tree.list([{ cid: under, size }]));
}

const malformed: readonly { name: string; reason: BlobCorruptReason; digestCalls?: number; build: (tree: HandTree) => Promise<MalformedTree> }[] = [
	{
		name: 'a piece above the piece limit, refused before it is hashed',
		reason: 'piece-too-large',
		digestCalls: 1,
		build: async tree => {
			const big = await tree.raw(new Uint8Array(MAX_BLOB_PIECE_BYTES + 1));
			const after = await tree.raw(LEAF);
			return { ref: refOf(await tree.list([{ cid: big, size: MAX_BLOB_PIECE_BYTES }, { cid: after, size: LEAF.byteLength }])), untouched: pieceIdOfCid(after) };
		},
	},
	{
		name: 'bytes that do not hash to their id',
		reason: 'digest-mismatch',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const root = await tree.list([{ cid: leaf, size: LEAF.byteLength }]);
			const other = await tree.list([{ cid: leaf, size: LEAF.byteLength }, { cid: leaf, size: LEAF.byteLength }]);
			tree.pieces.set(pieceIdOfCid(root), tree.pieces.get(pieceIdOfCid(other))!);
			return { ref: refOf(root), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'dag-pb that does not decode',
		reason: 'malformed-encoding',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const whole = dagPb.encode({ Data: fileData([10n]), Links: [{ Hash: leaf, Name: '', Tsize: 10 }] });
			return { ref: refOf(await tree.put(DAG_PB_CODEC, whole.subarray(0, whole.byteLength - 1))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'UnixFS data that does not decode',
		reason: 'malformed-encoding',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: refOf(await tree.node([leaf], Uint8Array.from([0x08, 99]))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a dag-pb piece with no UnixFS data',
		reason: 'not-a-file-node',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: refOf(await tree.node([leaf], undefined)), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a UnixFS node that is not a file',
		reason: 'not-a-file-node',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: refOf(await tree.node([leaf], fileData([10n], { type: 'directory' }))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a list piece with bytes of its own',
		reason: 'list-carries-data',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: refOf(await tree.node([leaf], fileData([10n], { data: Uint8Array.of(1, 2, 3) }))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a list piece with no links',
		reason: 'no-links',
		build: async tree => ({ ref: refOf(await tree.node([], fileData([]))) }),
	},
	{
		name: 'a list piece with too many links',
		reason: 'too-many-links',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const count = MAX_BLOB_LIST_LINKS + 1;
			return { ref: refOf(await tree.list(Array.from({ length: count }, () => ({ cid: leaf, size: LEAF.byteLength })))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'block sizes that differ in count from the links',
		reason: 'size-mismatch',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: refOf(await tree.node([leaf], fileData([10n, 10n]))), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a child declared empty',
		reason: 'empty-child',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: await rootOver(tree, leaf, 0), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a link of a third codec',
		reason: 'unsupported-codec',
		build: async tree => {
			const cbor = CID.createV1(0x71, Digest.create(SHA2_256_CODE, new Uint8Array(32)));
			return { ref: await rootOver(tree, cbor, 10) };
		},
	},
	{
		name: 'a link named by another hash',
		reason: 'unsupported-hash',
		build: async tree => {
			const sha512 = CID.createV1(RAW_CODEC, Digest.create(0x13, new Uint8Array(64)));
			return { ref: await rootOver(tree, sha512, 10) };
		},
	},
	{
		name: 'a leaf declared above the piece limit',
		reason: 'piece-too-large',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			return { ref: await rootOver(tree, leaf, MAX_BLOB_PIECE_BYTES + 1), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'child sizes that do not add up to what the parent declared',
		reason: 'size-mismatch',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const mid = await tree.list([{ cid: leaf, size: LEAF.byteLength }]);
			return { ref: await rootOver(tree, mid, LEAF.byteLength + 1), untouched: pieceIdOfCid(leaf) };
		},
	},
	{
		name: 'a leaf whose length differs from its declared size',
		reason: 'size-mismatch',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const after = await tree.raw(contentAt(10, 10));
			return { ref: refOf(await tree.list([{ cid: leaf, size: LEAF.byteLength - 1 }, { cid: after, size: 10 }])), untouched: pieceIdOfCid(after) };
		},
	},
	{
		name: 'a total above Number.MAX_SAFE_INTEGER',
		reason: 'size-too-large',
		build: async tree => {
			const leaf = await tree.raw(LEAF);
			const mid = await tree.list([{ cid: leaf, size: LEAF.byteLength }]);
			return { ref: refOf(await tree.list([{ cid: mid, size: 2n ** 53n }, { cid: leaf, size: LEAF.byteLength }])), untouched: pieceIdOfCid(mid) };
		},
	},
	{
		name: 'a tree one level too deep',
		reason: 'too-deep',
		build: async tree => {
			let below = await tree.raw(LEAF);
			let deepest: CID | undefined;
			for (let level = MAX_BLOB_LIST_DEPTH + 1; level >= 1; level--) {
				below = await tree.list([{ cid: below, size: LEAF.byteLength }]);
				deepest ??= below;
			}
			return { ref: refOf(below), untouched: pieceIdOfCid(deepest!) };
		},
	},
];

describe('a malformed tree', () => {
	for (const row of malformed) {
		it(`is refused as ${row.reason}: ${row.name}`, async () => {
			const tree = new HandTree();
			const { ref, untouched } = await row.build(tree);
			const source = new MapSource(tree.pieces);
			const digest = countingDigest();
			const error = await rejection(drain(readBlob(ref, source, { digest })));
			expect(error).to.be.instanceOf(BlobCorruptError);
			expect((error as BlobCorruptError).reason).to.equal(row.reason);
			if (untouched !== undefined) {
				expect(source.gets, 'requested').not.to.include(untouched);
			}
			if (row.digestCalls !== undefined) {
				expect(digest.calls, 'digest calls').to.equal(row.digestCalls);
			}
		});
	}

	it('is refused through a verified source too, which skips only the hashing', async () => {
		const tree = new HandTree();
		const leaf = await tree.raw(LEAF);
		const ref = refOf(await tree.list(Array.from({ length: MAX_BLOB_LIST_LINKS + 1 }, () => ({ cid: leaf, size: LEAF.byteLength }))));
		const error = await rejection(drain(readBlob(ref, new MapSource(tree.pieces, { verified: true }))));
		expect((error as BlobCorruptError).reason).to.equal('too-many-links');
	});
});

describe('walkBlobPieces', () => {
	it('expands a repeated list piece once', async () => {
		const tree = new HandTree();
		const leaf = await tree.raw(LEAF);
		const repeated = await tree.list([{ cid: leaf, size: LEAF.byteLength }]);
		const ref = refOf(await tree.list(Array.from({ length: MAX_BLOB_LIST_LINKS }, () => ({ cid: repeated, size: LEAF.byteLength }))));
		const source = new MapSource(tree.pieces);

		const entries = await drain(walkBlobPieces(ref, source));
		expect(entries.map(entry => entry.id)).to.deep.equal([rootPieceId(ref), pieceIdOfCid(repeated), pieceIdOfCid(leaf)]);
		expect(source.gets.filter(id => id === pieceIdOfCid(repeated))).to.have.length(1);
	});
});
