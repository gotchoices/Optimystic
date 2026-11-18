/**
 * The builder's references against the ones IPFS tools give the same bytes.
 *
 * Content byte i is `i % 251`. The expected references were produced with kubo 0.43.1:
 *
 *   npm i kubo@0.43.1                      (in an empty directory)
 *   IPFS_PATH=<dir> ipfs init
 *   ipfs add --cid-version 1 --only-hash -Q <file>      (per file)
 *
 * The JavaScript importer (`ipfs-unixfs-importer@17.1.1` with `cidVersion: 1`, `rawLeaves: true`,
 * `reduceSingleLeafToSelf: true`, `fixedSize({ chunkSize: 262144 })`,
 * `balanced({ maxChildrenPerNode: 174 })`) gives the same six; it is not a dependency.
 */
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as dagPb from '@ipld/dag-pb';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { equals } from 'uint8arrays/equals';
import {
	BLOB_PIECE_BYTES,
	BlobDigestError,
	BlobTreeAssembler,
	buildBlob,
	checkBlobDigest,
	cidOfPiece,
	defaultBlobDigest,
	DAG_PB_CODEC,
	pieceIdOfCid,
	RAW_CODEC,
	SHA2_256_CODE,
	type BlobDigest,
	type PieceId,
	type PieceSink,
} from '../src/index.js';
import { selectBlobDigest, type SubtleDigest } from '../src/blob/digest.js';

use(chaiAsPromised);

const PERIOD = 251;
const FEED_CHUNK = 100_003;

const VECTORS: readonly { size: number; ref: string }[] = [
	{ size: 0, ref: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
	{ size: 1_000, ref: 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu' },
	{ size: 262_144, ref: 'bafkreibruh455iawsviqslif5c7uurdcfdemh22mtnytyzvnzn75kpejxy' },
	{ size: 262_145, ref: 'bafybeiexg2oqkfnj56l7fcmawswqbijt5shq4b5rg6a546uwpkqqzwjioi' },
	{ size: 174 * 262_144, ref: 'bafybeihpe5snhzneq7xs53nivmsopto5lrogo3wjynauqylqeym5a3irbm' },
	{ size: 175 * 262_144 + 1, ref: 'bafybeihzhgkxa5ea4r5cr73r73tsf3ppwpstcxnsuyqxio3vy7xpikkhmi' },
];

/** One period-aligned pattern long enough to cut any feed chunk from. */
const PATTERN = Uint8Array.from({ length: Math.max(FEED_CHUNK, BLOB_PIECE_BYTES) + PERIOD }, (_, i) => i % PERIOD);

/** `length` bytes of the content starting at byte `offset`. */
function contentAt(offset: number, length: number): Uint8Array {
	const start = offset % PERIOD;
	return PATTERN.subarray(start, start + length);
}

/** The content of a `size`-byte file in `FEED_CHUNK`-byte chunks. */
async function* content(size: number): AsyncIterable<Uint8Array> {
	for (let offset = 0; offset < size; offset += FEED_CHUNK) {
		yield contentAt(offset, Math.min(FEED_CHUNK, size - offset));
	}
}

/** Remembers what was put, and every list piece put before a piece it names. */
class RecordingSink implements PieceSink {
	readonly pieces = new Map<PieceId, Uint8Array>();
	readonly putBeforeChildren: PieceId[] = [];

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		if (cidOfPiece(id).code === DAG_PB_CODEC) {
			const missing = dagPb.decode(bytes).Links.some(link => !this.pieces.has(pieceIdOfCid(link.Hash)));
			if (missing) this.putBeforeChildren.push(id);
		}
		this.pieces.set(id, bytes);
	}

	/** Pieces whose kept bytes no longer hash to their id: a builder that reused an array it had put. */
	async changedSincePut(): Promise<PieceId[]> {
		const digest = defaultBlobDigest();
		const changed: PieceId[] = [];
		for (const [id, bytes] of this.pieces) {
			if (!equals(await digest(bytes), cidOfPiece(id).multihash.digest)) changed.push(id);
		}
		return changed;
	}
}

describe('buildBlob', () => {
	for (const vector of VECTORS) {
		it(`gives kubo's reference for ${vector.size} bytes`, async () => {
			const sink = new RecordingSink();
			const result = await buildBlob(content(vector.size), sink);
			expect(result).to.deep.equal({ ref: vector.ref, size: vector.size });
			expect(sink.putBeforeChildren, 'list pieces put before a piece they name').to.deep.equal([]);
			expect(await sink.changedSincePut(), 'pieces changed after they were put').to.deep.equal([]);
		});
	}

	it('gives the same reference however the source is chunked', async () => {
		const size = 262_145;
		const expected = VECTORS.find(v => v.size === size)!.ref;
		const oddly = await buildBlob(oneShot([contentAt(0, 1), new Uint8Array(0), contentAt(1, 262_143), contentAt(262_144, 1)]), new RecordingSink());
		const whole = await buildBlob(oneShot([contentAt(0, size)]), new RecordingSink());
		expect([oddly.ref, whole.ref]).to.deep.equal([expected, expected]);
	});
});

describe('BlobTreeAssembler', () => {
	it('gives the vector reference from leaf links it did not cut', async () => {
		const vector = VECTORS[VECTORS.length - 1]!;
		const assembler = new BlobTreeAssembler(new RecordingSink());
		const digest = defaultBlobDigest();
		for (let offset = 0; offset < vector.size; offset += BLOB_PIECE_BYTES) {
			const leaf = contentAt(offset, Math.min(BLOB_PIECE_BYTES, vector.size - offset));
			const cid = CID.createV1(RAW_CODEC, Digest.create(SHA2_256_CODE, await digest(leaf)));
			await assembler.add({ cid, fileBytes: leaf.byteLength, treeBytes: leaf.byteLength });
		}
		const root = await assembler.finish();
		expect(pieceIdOfCid(root.cid)).to.equal(vector.ref);
		expect(root.fileBytes).to.equal(vector.size);
	});
});

describe('checkBlobDigest', () => {
	it('accepts both default digests and refuses wrong ones', async () => {
		const fallback = selectBlobDigest(undefined);
		const native = selectBlobDigest(globalThis.crypto.subtle as SubtleDigest);
		expect(await checkBlobDigest(fallback)).to.equal(fallback);
		expect(await checkBlobDigest(native)).to.equal(native);

		const wrong: readonly BlobDigest[] = [
			async () => new Uint8Array(32),
			async bytes => (await fallback(bytes)).subarray(0, 31),
			async () => { throw new Error('no hash today'); },
		];
		for (const digest of wrong) {
			await expect(checkBlobDigest(digest)).to.be.rejectedWith(BlobDigestError);
		}
	});
});

async function* oneShot(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}
