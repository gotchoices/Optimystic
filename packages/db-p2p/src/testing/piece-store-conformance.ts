import { expect } from 'chai';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { BLOB_PIECE_BYTES, MAX_BLOB_PIECE_BYTES, RAW_CODEC, pieceIdOfCid, type PieceId } from '@optimystic/db-core';
import type { IPieceStore } from '../blob/piece-store.js';

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
 * The raw piece id of `bytes`: CIDv1, codec raw, sha2-256, in the canonical spelling. Built here
 * rather than with the blob builder, which never cuts a raw piece above 256 KiB.
 */
export async function conformancePieceId(bytes: Uint8Array): Promise<PieceId> {
	return pieceIdOfCid(CID.createV1(RAW_CODEC, await sha256.digest(bytes)));
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
