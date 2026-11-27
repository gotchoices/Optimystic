import { expect } from 'chai';
import { sha256 } from 'multiformats/hashes/sha2';
import { BLOB_PIECE_BYTES, MAX_BLOB_PIECE_BYTES, rawPieceIdOfDigest, type PieceId } from '@optimystic/db-core';
import { offersFiles, type ImportedPiece, type IPieceStore, type IPieceStoreFiles } from '../blob/piece-store.js';

/** What `makeStore` hands each conformance case; see {@link runPieceStoreConformance}. */
export interface PieceStoreHarness {
	store: IPieceStore;
	/** Release everything the case used, including the store `reopen` returned. */
	cleanup: () => Promise<void>;
	/**
	 * A fresh store over the same location; the suite has already called `close` on the first when
	 * it has one. Required, and read only, under `{ persistent: true }`.
	 */
	reopen?: () => Promise<IPieceStore>;
	/**
	 * Reading and writing ordinary files, for the cases over {@link IPieceStoreFiles}. Required of a
	 * harness whose store offers that capability, and never read otherwise. The suite asks rather
	 * than reaching for `node:fs` itself because it runs in a browser and on a phone too.
	 */
	files?: PieceStoreFileHarness;
}

/** {@link PieceStoreHarness.files}: the file access the import and export cases need of their host. */
export interface PieceStoreFileHarness {
	/** Write `bytes` to a new file and return its path. */
	write(bytes: Uint8Array): Promise<string>;
	/** A path where no file exists yet, in a directory the store may write. */
	freshPath(): Promise<string>;
	/** The file's bytes, or undefined when there is none. */
	read(path: string): Promise<Uint8Array | undefined>;
}

/** How a backend's suite is registered; see {@link runPieceStoreConformance}. */
export interface PieceStoreConformanceOptions {
	/**
	 * The backend keeps what it stores across a reopen. Registers the flush-then-reopen case, which
	 * fails (rather than skipping) when the harness supplies no `reopen`.
	 */
	persistent?: true;
}

/**
 * Per-piece overhead a backend may add to `bytesUsed` (a database row, a page's slack). Memory and
 * files are exact; the slack keeps the bound honest for the backends that are not.
 */
const BYTES_USED_SLACK = 4096;

/**
 * The raw piece id of `bytes`: CIDv1, codec raw, sha2-256, in the canonical spelling. Hashed here
 * rather than with the blob builder, which never cuts a raw piece above 256 KiB; the id is spelt by
 * the one function every store that names its own pieces spells them with.
 */
export async function conformancePieceId(bytes: Uint8Array): Promise<PieceId> {
	return rawPieceIdOfDigest((await sha256.digest(bytes)).digest);
}

/** `length` bytes whose content differs by `seed`, so pieces of one length get distinct ids. */
function pieceBytes(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) & 0xff;
	return bytes;
}

/** Element-wise, so a backend returning a `Buffer` compares equal to a plain `Uint8Array`. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
	if (a === undefined || a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < b.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

async function piece(length: number, seed: number): Promise<{ id: PieceId; bytes: Uint8Array }> {
	const bytes = pieceBytes(length, seed);
	return { id: await conformancePieceId(bytes), bytes };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/**
 * Registers a `describe(name, ...)` block asserting that a piece-store backend keeps the
 * {@link IPieceStore} contract. Each backend calls it from its own `test/` with a factory for a
 * fresh, empty store per case; a backend that keeps its pieces across a reopen passes
 * `{ persistent: true }`, which adds the flush-then-reopen case.
 */
export function runPieceStoreConformance(
	name: string,
	makeStore: () => Promise<PieceStoreHarness>,
	options: PieceStoreConformanceOptions = {}
): void {
	describe(name, () => {
		let harness: PieceStoreHarness;
		let store: IPieceStore;

		beforeEach(async () => {
			harness = await makeStore();
			store = harness.store;
		});

		afterEach(async () => {
			await harness.cleanup();
		});

		it('get and has on a missing id answer undefined and false', async () => {
			const { id } = await piece(16, 1);
			expect(await store.get(id)).to.equal(undefined);
			expect(await store.has(id)).to.equal(false);
		});

		it('put then get returns the same bytes, and has is true', async () => {
			const { id, bytes } = await piece(1000, 2);
			await store.put(id, bytes);
			expect(sameBytes(await store.get(id), bytes), 'bytes read back').to.equal(true);
			expect(await store.has(id)).to.equal(true);
		});

		it('a second put of a present id writes nothing, whatever its bytes', async () => {
			const { id, bytes } = await piece(100, 3);
			await store.put(id, bytes);
			await store.put(id, pieceBytes(200, 4));
			expect(sameBytes(await store.get(id), bytes), 'the first bytes stay').to.equal(true);
		});

		it('two concurrent puts of one id both resolve, with the piece stored once', async () => {
			const { id, bytes } = await piece(5000, 5);
			await Promise.all([store.put(id, bytes), store.put(id, bytes)]);
			expect(sameBytes(await store.get(id), bytes), 'bytes read back').to.equal(true);
			expect(await collect(store.list())).to.deep.equal([id]);
		});

		it('a zero-length piece round-trips and has is true', async () => {
			const { id, bytes } = await piece(0, 0);
			await store.put(id, bytes);
			expect(await store.has(id)).to.equal(true);
			expect(sameBytes(await store.get(id), bytes), 'an empty piece, not an absent one').to.equal(true);
		});

		it('delete removes the piece, and deleting an absent id resolves', async () => {
			const { id, bytes } = await piece(100, 6);
			await store.put(id, bytes);
			await store.delete(id);
			expect(await store.has(id)).to.equal(false);
			expect(await store.get(id)).to.equal(undefined);
			await store.delete(id);
			await store.delete((await piece(100, 7)).id);
		});

		it('list yields every stored id exactly once, and nothing once all are deleted', async () => {
			const pieces = await Promise.all([piece(10, 8), piece(20, 9), piece(30, 10)]);
			for (const { id, bytes } of pieces) await store.put(id, bytes);
			const ids = pieces.map(p => p.id).sort();
			expect((await collect(store.list())).sort()).to.deep.equal(ids);

			for (const { id } of pieces) await store.delete(id);
			expect(await collect(store.list())).to.deep.equal([]);
		});

		it('list tolerates awaits interleaved between yields (drain-before-yield)', async () => {
			const pieces = await Promise.all([piece(10, 11), piece(20, 12), piece(30, 13)]);
			for (const { id, bytes } of pieces) await store.put(id, bytes);
			const listed: PieceId[] = [];
			for await (const id of store.list()) {
				listed.push(id);
				// A read of another piece between yields would invalidate a native cursor that
				// straddled the await, if the backend failed to drain first.
				const other = pieces.find(p => p.id !== id)!;
				expect(sameBytes(await store.get(other.id), other.bytes), 'read between yields').to.equal(true);
			}
			expect(listed.sort()).to.deep.equal(pieces.map(p => p.id).sort());
		});

		it('bytesUsed rises by a put piece\'s length and falls back when it is deleted', async () => {
			const { id, bytes } = await piece(10_000, 14);
			const before = await store.bytesUsed();
			await store.put(id, bytes);
			const during = await store.bytesUsed();
			expect(during - before, 'rise after the put').to.be.within(bytes.byteLength, bytes.byteLength + BYTES_USED_SLACK);
			await store.delete(id);
			const after = await store.bytesUsed();
			expect(Math.abs(after - before), 'distance from the start after the delete').to.be.at.most(BYTES_USED_SLACK);
		});

		it('the caller\'s buffers are not the store\'s', async () => {
			const { id, bytes } = await piece(100, 15);
			const original = bytes.slice();
			await store.put(id, bytes);
			bytes[0] = (bytes[0]! + 1) & 0xff;
			expect(sameBytes(await store.get(id), original), 'after modifying the bytes put').to.equal(true);

			const read = (await store.get(id))!;
			read[0] = (read[0]! + 1) & 0xff;
			expect(sameBytes(await store.get(id), original), 'after modifying a buffer get returned').to.equal(true);
		});

		it('a 256 KiB piece and a 1 MiB piece round-trip', async () => {
			for (const length of [BLOB_PIECE_BYTES, MAX_BLOB_PIECE_BYTES]) {
				const { id, bytes } = await piece(length, 16);
				await store.put(id, bytes);
				expect(sameBytes(await store.get(id), bytes), `${length}-byte piece`).to.equal(true);
			}
		});

		registerFileCases(name, () => harness);

		if (options.persistent) {
			it('every put and delete resolved before flush() is read back by a fresh store over the same location', async () => {
				if (!harness.reopen) {
					throw new Error(`${name} is registered { persistent: true } but its harness supplies no reopen()`);
				}
				const pieces = await Promise.all([piece(10, 17), piece(20, 18), piece(30, 19), piece(40, 20)]);
				for (const { id, bytes } of pieces) await store.put(id, bytes);
				const [removed, ...kept] = pieces;
				await store.delete(removed!.id);
				await store.flush();
				// Closed before the second store opens, so nothing the first held in memory is read.
				await store.close?.();

				const reopened = await harness.reopen();

				for (const { id, bytes } of kept) {
					expect(sameBytes(await reopened.get(id), bytes), `piece ${id}`).to.equal(true);
				}
				expect(await reopened.has(removed!.id), 'deleted piece').to.equal(false);
				expect((await collect(reopened.list())).sort()).to.deep.equal(kept.map(p => p.id).sort());
			});
		}
	});
}

/** File lengths an import must cut exactly as a stream put would; the blob builder's own vectors. */
const FILE_LENGTHS: readonly number[] = [0, 1000, BLOB_PIECE_BYTES, BLOB_PIECE_BYTES + 1, 3 * BLOB_PIECE_BYTES + 5];

/**
 * `length` bytes whose every leaf is a piece of its own. `pieceBytes` repeats with period 256,
 * which divides the piece size, so every FULL leaf of one of its buffers has the same bytes and so
 * one id — and over such a file a store that reported or joined its leaves in any order would pass
 * these cases. One byte per leaf carrying the leaf's number is enough to separate them.
 */
function fileBytes(length: number, seed: number): Uint8Array {
	const bytes = pieceBytes(length, seed);
	for (let offset = 0; offset < length; offset += BLOB_PIECE_BYTES) {
		bytes[offset] = (bytes[offset]! + (offset / BLOB_PIECE_BYTES) + 1) & 0xff;
	}
	return bytes;
}

/**
 * The cases for a store that offers {@link IPieceStoreFiles} (docs/blobs.md §Putting and reading by
 * file path). Registered for every backend and skipped for a store that does not offer it, since
 * whether it does is known only once one has been made; a store that DOES offer it and whose harness
 * supplies no {@link PieceStoreHarness.files} fails, rather than quietly testing none of this.
 */
function registerFileCases(name: string, current: () => PieceStoreHarness): void {
	describe('file import and export', () => {
		let store: IPieceStore & IPieceStoreFiles;
		let files: PieceStoreFileHarness;

		// A `function` body, not an arrow: `this.skip()` is how a case decides at run time that it
		// does not apply to the backend under test.
		beforeEach(function () {
			const harness = current();
			if (!offersFiles(harness.store)) {
				this.skip();
				return;
			}
			if (harness.files === undefined) {
				throw new Error(`${name} offers IPieceStoreFiles but its harness supplies no files helpers`);
			}
			store = harness.store;
			files = harness.files;
		});

		for (const length of FILE_LENGTHS) {
			it(`imports ${length} bytes as the leaves a stream put would store`, async () => {
				const bytes = fileBytes(length, 21);
				const imported = await store.importFile(await files.write(bytes), BLOB_PIECE_BYTES);
				const slices = leafSlices(bytes);
				expect(reported(imported), 'the ids and sizes').to.deep.equal(await expectedLeaves(slices));
				for (const [index, slice] of slices.entries()) {
					expect(sameBytes(await store.get(imported[index]!.id), slice), `leaf ${index}`).to.equal(true);
				}
			});
		}

		it('importing one file twice stores each piece once', async () => {
			const path = await files.write(fileBytes(BLOB_PIECE_BYTES + 100, 22));
			const first = await store.importFile(path, BLOB_PIECE_BYTES);
			const again = await store.importFile(path, BLOB_PIECE_BYTES);
			expect(reported(again), 'the second import').to.deep.equal(reported(first));
			expect((await collect(store.list())).sort(), 'stored ids').to.deep.equal(first.map(leaf => leaf.id).sort());
		});

		it('exports the pieces joined in order', async () => {
			const bytes = fileBytes(3 * BLOB_PIECE_BYTES + 5, 23);
			const imported = await store.importFile(await files.write(bytes), BLOB_PIECE_BYTES);
			const target = await files.freshPath();
			await store.exportFile(imported.map(leaf => leaf.id), target);
			expect(sameBytes(await files.read(target), bytes), 'the joined bytes').to.equal(true);
		});

		it('exports no pieces as an empty file', async () => {
			const target = await files.freshPath();
			await store.exportFile([], target);
			expect(sameBytes(await files.read(target), new Uint8Array(0)), 'an empty file, not an absent one').to.equal(true);
		});

		it('exporting over an existing file replaces it', async () => {
			const bytes = fileBytes(1000, 24);
			const imported = await store.importFile(await files.write(bytes), BLOB_PIECE_BYTES);
			const target = await files.write(fileBytes(5000, 25));
			await store.exportFile(imported.map(leaf => leaf.id), target);
			expect(sameBytes(await files.read(target), bytes), 'the replaced file').to.equal(true);
		});

		it('exporting a missing piece rejects and leaves nothing it did not find there', async () => {
			const held = await piece(1000, 26);
			await store.put(held.id, held.bytes);
			const absent = (await piece(1000, 27)).id;

			const fresh = await files.freshPath();
			await rejects(() => store.exportFile([held.id, absent], fresh), 'exporting to a fresh path');
			expect(await files.read(fresh), 'nothing left at the fresh path').to.equal(undefined);

			const kept = fileBytes(300, 28);
			const existing = await files.write(kept);
			await rejects(() => store.exportFile([absent], existing), 'exporting over an existing file');
			expect(sameBytes(await files.read(existing), kept), 'the existing file unchanged').to.equal(true);
		});
	});
}

/** Only the two fields the contract is about, so a store carrying extra ones still compares. */
function reported(leaves: readonly ImportedPiece[]): { id: PieceId; size: number }[] {
	return leaves.map(({ id, size }) => ({ id, size }));
}

/** The 256 KiB slices a stream put cuts `bytes` into; one empty leaf for no bytes at all. */
function leafSlices(bytes: Uint8Array): Uint8Array[] {
	const slices: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += BLOB_PIECE_BYTES) {
		slices.push(bytes.subarray(offset, Math.min(offset + BLOB_PIECE_BYTES, bytes.byteLength)));
	}
	return slices.length > 0 ? slices : [new Uint8Array(0)];
}

async function expectedLeaves(slices: readonly Uint8Array[]): Promise<{ id: PieceId; size: number }[]> {
	return Promise.all(slices.map(async slice => ({ id: await conformancePieceId(slice), size: slice.byteLength })));
}

/** chai-as-promised is not a dependency of every package that runs this suite, so the assertion is spelt out. */
async function rejects(work: () => Promise<unknown>, what: string): Promise<void> {
	try {
		await work();
	} catch {
		return;
	}
	throw new Error(`${what} resolved where it should have rejected`);
}
