/**
 * Putting and reading a blob by file path (docs/blobs.md §Putting and reading by file path): that a
 * path put ends in the same reference a stream put of the same bytes gives, that `verify` refuses an
 * import the store named wrongly while `trust` accepts it, and that an import cut at another size or
 * named with the wrong codec is refused whatever the mode.
 *
 * The stores below are real `IPieceStoreFiles` implementations over `node:fs` and `node:crypto`,
 * standing in for a host whose native code cuts, hashes and joins files — not doubles of anything
 * this repository owns. The misbehaving ones subclass the honest one, each changing exactly the one
 * thing its case is about.
 */
import { expect } from 'chai';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BLOB_PIECE_BYTES,
	BlobImportError,
	buildBlob,
	DAG_PB_CODEC,
	pieceIdOfCid,
	rawPieceIdOfDigest,
	SHA2_256_CODE,
	type BlobPutResult,
	type PieceId,
} from '@optimystic/db-core';
import { LocalBlobService, type BlobPathMode } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { ImportedPiece, IPieceStore, IPieceStoreFiles } from '../src/blob/piece-store.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { runPieceStoreConformance } from '../src/testing/piece-store-conformance.js';

/** A piece store that cuts, hashes and joins files itself, as a host's native code would. */
class FilePathPieceStore extends MemoryPieceStore implements IPieceStoreFiles {
	/** What the last import reported, so a case can name a piece the store stored under a false id. */
	readonly reported: ImportedPiece[] = [];

	async importFile(path: string, pieceSize: number): Promise<ImportedPiece[]> {
		const bytes = new Uint8Array(await readFile(path));
		this.reported.length = 0;
		let index = 0;
		for (const leaf of this.cut(bytes, pieceSize)) {
			const id = this.nameLeaf(leaf, index++);
			await this.put(id, leaf);
			this.reported.push({ id, size: leaf.byteLength });
		}
		return [...this.reported];
	}

	/** Streamed piece by piece into a temporary name and renamed, so a failure leaves `path` as it was. */
	async exportFile(ids: readonly PieceId[], path: string): Promise<void> {
		const temp = `${path}.incoming`;
		try {
			const handle = await open(temp, 'w');
			try {
				for (const id of ids) {
					const bytes = await this.get(id);
					if (bytes === undefined) {
						throw new Error(`piece ${id} is not stored`);
					}
					await handle.write(bytes);
				}
			} finally {
				await handle.close();
			}
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}

	/** Where this store cuts the file; one empty leaf for an empty file. */
	protected *cut(bytes: Uint8Array, pieceSize: number): Generator<Uint8Array> {
		if (bytes.byteLength === 0) {
			yield new Uint8Array(0);
			return;
		}
		for (let offset = 0; offset < bytes.byteLength; offset += pieceSize) {
			yield bytes.subarray(offset, Math.min(offset + pieceSize, bytes.byteLength));
		}
	}

	/** What this store's own hash names a leaf. */
	protected nameLeaf(leaf: Uint8Array, _index: number): PieceId {
		return rawPieceIdOfDigest(createHash('sha256').update(leaf).digest());
	}
}

/** A store whose native hash is wrong for one leaf: its bytes are stored under an id they do not hash to. */
class WrongIdPieceStore extends FilePathPieceStore {
	constructor(private readonly wrongAt: number) {
		super();
	}

	protected override nameLeaf(leaf: Uint8Array, index: number): PieceId {
		if (index !== this.wrongAt) {
			return super.nameLeaf(leaf, index);
		}
		// Named by other bytes, so the id is not the hash of what is stored under it.
		const other = new Uint8Array(leaf.byteLength + 1);
		other.set(leaf);
		return super.nameLeaf(other, index);
	}
}

/** A store that names a leaf with the list-piece codec: a well-formed piece id, but not a raw leaf's. */
class ListCodecLeafPieceStore extends FilePathPieceStore {
	protected override nameLeaf(leaf: Uint8Array): PieceId {
		const digest = createHash('sha256').update(leaf).digest();
		return pieceIdOfCid(CID.createV1(DAG_PB_CODEC, Digest.create(SHA2_256_CODE, digest)));
	}
}

/** A store that cuts a short leaf in the middle: it disagrees with the builder about where leaves end. */
class ShortMiddleLeafPieceStore extends FilePathPieceStore {
	protected override *cut(bytes: Uint8Array, pieceSize: number): Generator<Uint8Array> {
		yield bytes.subarray(0, pieceSize);
		yield bytes.subarray(pieceSize, 2 * pieceSize - 100);
		yield bytes.subarray(2 * pieceSize - 100);
	}
}

// The one store in this repository that offers file access until `FilePieceStore` gains it, so this
// is what the file cases of the conformance suite are themselves checked against.
runPieceStoreConformance('FilePathPieceStore', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'optimystic-piece-files-'));
	let next = 0;
	const path = (): string => join(directory, `piece-file-${next++}`);
	return {
		store: new FilePathPieceStore(),
		cleanup: () => rm(directory, { recursive: true, force: true }),
		files: {
			write: async bytes => {
				const target = path();
				await writeFile(target, bytes);
				return target;
			},
			freshPath: async () => path(),
			read: async target => {
				try {
					return new Uint8Array(await readFile(target));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						return undefined;
					}
					throw error;
				}
			},
		},
	};
});

/** A service whose scheduled sweeps never fire, so nothing but a case's own call deletes a piece. */
function serviceOver(pieces: IPieceStore, paths: BlobPathMode): LocalBlobService {
	return new LocalBlobService({ pieces, kv: new MemoryKVStore(), setTimer: () => () => undefined, paths });
}

/** Deterministic bytes; content differs by length, so two sizes never share a piece id. */
function contentOf(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index++) {
		bytes[index] = (index * 31 + 7) & 0xff;
	}
	return bytes;
}

async function* streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes;
}

/** What a stream put of `bytes` answers, computed by the builder a stream put uses, keeping no pieces. */
async function streamedPut(bytes: Uint8Array): Promise<BlobPutResult> {
	return buildBlob(streamOf(bytes), { put: async () => undefined });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) {
		return false;
	}
	for (let index = 0; index < b.byteLength; index++) {
		if (a[index] !== b[index]) {
			return false;
		}
	}
	return true;
}

/** Sizes: nothing at all, exactly one leaf, and more leaves than one list piece holds (174). */
const SIZES: readonly number[] = [0, BLOB_PIECE_BYTES, 175 * BLOB_PIECE_BYTES + 1];
const MODES: readonly ('verify' | 'trust')[] = ['verify', 'trust'];

/**
 * The largest size runs under `verify` alone. What it pins is the tree over more leaves than one
 * list piece holds, which the mode has no bearing on, and it is the only case in this package that
 * writes tens of megabytes to disk; `trust` is pinned at the other two sizes.
 */
const sizesFor = (mode: 'verify' | 'trust'): readonly number[] => mode === 'trust' ? SIZES.slice(0, -1) : SIZES;

describe('blob paths', () => {
	let directory: string;
	let next = 0;

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), 'optimystic-blob-paths-'));
	});

	after(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const freshPath = (): string => join(directory, `file-${next++}`);

	async function fileOf(bytes: Uint8Array): Promise<string> {
		const path = freshPath();
		await writeFile(path, bytes);
		return path;
	}

	it('offers path access only where the setting and the store both allow it', async () => {
		expect(serviceOver(new FilePathPieceStore(), 'off').paths, 'the default setting').to.equal(undefined);
		expect(serviceOver(new MemoryPieceStore(), 'trust').paths, 'a store with no file access').to.equal(undefined);
		expect(serviceOver(new FilePathPieceStore(), 'verify').paths?.mode, 'the mode reported').to.equal('verify');
	});

	for (const mode of MODES) {
		for (const size of sizesFor(mode)) {
			it(`puts ${size} bytes from a file under ${mode} as a stream put would, and reads them back`, async () => {
				const bytes = contentOf(size);
				const expected = await streamedPut(bytes);
				const service = serviceOver(new FilePathPieceStore(), mode);
				const paths = service.paths;
				if (paths === undefined) {
					throw new Error('a store offering file access and a mode that is not off must give path access');
				}

				const put = await paths.putFile(await fileOf(bytes));
				expect(put, 'the reference and size').to.deep.equal(expected);
				expect(await service.stat(put.ref), 'what the node holds').to.include({ locality: 'here', size });

				const target = freshPath();
				await paths.readToFile(put.ref, target);
				expect(sameBytes(new Uint8Array(await readFile(target)), bytes), 'the bytes written back').to.equal(true);
			});
		}
	}

	it('verify refuses an import named by a hash that is not its bytes, and removes that piece', async () => {
		const bytes = contentOf(2 * BLOB_PIECE_BYTES + 7);
		const pieces = new WrongIdPieceStore(1);
		const service = serviceOver(pieces, 'verify');

		const refused = await service.paths!.putFile(await fileOf(bytes)).then(() => undefined, (error: unknown) => error);

		expect(refused).to.be.instanceOf(BlobImportError).with.property('reason', 'digest-mismatch');
		expect(await pieces.has(pieces.reported[1]!.id), 'the falsely named piece').to.equal(false);
	});

	it('trust accepts that same import, and its reference is not the one the bytes have', async () => {
		const bytes = contentOf(2 * BLOB_PIECE_BYTES + 7);
		const service = serviceOver(new WrongIdPieceStore(1), 'trust');

		const put = await service.paths!.putFile(await fileOf(bytes));

		expect(put.size, 'the size is still the file\'s').to.equal(bytes.byteLength);
		// The cost the mode buys: nothing here checked the store's hash, so a wrong id becomes a
		// reference that names bytes no other machine would agree these are.
		expect(put.ref, 'the reference').to.not.equal((await streamedPut(bytes)).ref);
	});

	it('refuses an import whose leaf is named with the list-piece codec', async () => {
		const bytes = contentOf(1000);
		const service = serviceOver(new ListCodecLeafPieceStore(), 'verify');

		const refused = await service.paths!.putFile(await fileOf(bytes)).then(() => undefined, (error: unknown) => error);

		// `parsePieceId` accepts a list piece's id too, so the codec is checked on its own; without that
		// check an import could name a leaf with an id the tree would read as a list piece.
		expect(refused).to.be.instanceOf(BlobImportError).with.property('reason', 'not-a-raw-piece');
	});

	for (const mode of MODES) {
		it(`refuses an import cut at another size under ${mode}`, async () => {
			const bytes = contentOf(2 * BLOB_PIECE_BYTES + 500);
			const service = serviceOver(new ShortMiddleLeafPieceStore(), mode);

			const refused = await service.paths!.putFile(await fileOf(bytes)).then(() => undefined, (error: unknown) => error);

			expect(refused).to.be.instanceOf(BlobImportError).with.property('reason', 'size-mismatch');
		});
	}
});
