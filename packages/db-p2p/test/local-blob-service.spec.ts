import { expect } from 'chai';
import { BlobRefError, BlobUnavailableError, buildBlob, rootPieceId, walkBlobPieces, type BlobRef, type PieceId } from '@optimystic/db-core';
import { BLOB_RECORD_KEY_PREFIX, DEFAULT_BLOB_OWNER, type BlobRecord } from '../src/blob/blob-record.js';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { localPieceSource } from '../src/blob/local-piece-source.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import type { IKVStore } from '../src/storage/i-kv-store.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { PowerLossKVStore } from '../src/testing/power-loss-kv-store.js';
import { PowerLossPieceStore } from '../src/testing/power-loss-piece-store.js';

const PIECE = 256 * 1024;

/** A service whose scheduled sweeps never fire, so every sweep in a test is the one it calls. */
function serviceOver(pieces: IPieceStore, kv: IKVStore): LocalBlobService {
	return new LocalBlobService({ pieces, kv, setTimer: () => () => undefined });
}

/** Deterministic bytes that differ by `seed`. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		whole.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return whole;
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const read: Uint8Array[] = [];
	for await (const chunk of chunks) {
		read.push(chunk);
	}
	return concat(read);
}

async function listed(pieces: IPieceStore): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	for await (const id of pieces.list()) {
		ids.push(id);
	}
	return ids;
}

/** The reference of a one-piece blob of `bytes`, which is that piece's id. */
async function refOf(bytes: Uint8Array): Promise<BlobRef> {
	return (await buildBlob(streamOf(bytes), { put: async () => undefined })).ref;
}

async function pieceIdOf(bytes: Uint8Array): Promise<PieceId> {
	return rootPieceId(await refOf(bytes));
}

async function dataPiecesOf(ref: BlobRef, pieces: IPieceStore): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	for await (const entry of walkBlobPieces(ref, localPieceSource(pieces))) {
		if (entry.kind === 'data' && entry.id !== rootPieceId(ref)) {
			ids.push(entry.id);
		}
	}
	return ids;
}

interface Gate {
	readonly promise: Promise<void>;
	open(): void;
}

function gate(): Gate {
	let open!: () => void;
	const promise = new Promise<void>(resolve => { open = resolve; });
	return { promise, open };
}

/**
 * A source that yields `first`, then waits for `hold` before yielding `rest`. `reached` opens once
 * the builder has asked for more after `first`, which it does only after storing every piece cut
 * from it.
 */
function heldSource(first: Uint8Array, hold: Promise<void>, rest: Uint8Array): { source: AsyncIterable<Uint8Array>; reached: Promise<void> } {
	const reached = gate();
	async function* source(): AsyncIterable<Uint8Array> {
		yield first;
		reached.open();
		await hold;
		yield rest;
	}
	return { source: source(), reached: reached.promise };
}

/** A key-value store whose `list` takes the inner store's answer, then waits for `release` before returning it. */
class HeldListKVStore implements IKVStore {
	private readonly waiting = gate();

	constructor(private readonly inner: IKVStore, private readonly release: Promise<void>) {}

	/** Opens once a `list` holds its answer. */
	get listWaiting(): Promise<void> {
		return this.waiting.promise;
	}

	get(key: string): Promise<string | undefined> {
		return this.inner.get(key);
	}

	set(key: string, value: string): Promise<void> {
		return this.inner.set(key, value);
	}

	delete(key: string): Promise<void> {
		return this.inner.delete(key);
	}

	async list(prefix: string): Promise<string[]> {
		const answer = await this.inner.list(prefix);
		this.waiting.open();
		await this.release;
		return answer;
	}
}

/** A memory piece store whose next `get` of an armed id waits for a release the test holds. */
class HeldGetPieceStore extends MemoryPieceStore {
	/** Every id a `get` asked for, in order. */
	readonly asked: PieceId[] = [];
	private hold: { readonly id: PieceId; readonly reached: Gate; readonly release: Promise<void> } | undefined;

	/** Arms the hold; the returned promise opens once a `get` of `id` is waiting on `release`. */
	holdNextGet(id: PieceId, release: Promise<void>): Promise<void> {
		const reached = gate();
		this.hold = { id, reached, release };
		return reached.promise;
	}

	override async get(id: PieceId): Promise<Uint8Array | undefined> {
		this.asked.push(id);
		const hold = this.hold;
		if (hold?.id === id) {
			this.hold = undefined;
			hold.reached.open();
			await hold.release;
		}
		return super.get(id);
	}
}

/** Every piece of the blob `content` builds, by id, without storing any of them. */
async function piecesOf(content: Uint8Array): Promise<{ ref: BlobRef; pieces: Map<PieceId, Uint8Array> }> {
	const pieces = new Map<PieceId, Uint8Array>();
	const { ref } = await buildBlob(streamOf(content), { put: async (id, bytes) => { pieces.set(id, bytes.slice()); } });
	return { ref, pieces };
}

async function recordOf(kv: IKVStore, ref: BlobRef): Promise<BlobRecord | undefined> {
	return new BlobRecordStore(kv).get(ref);
}

describe('LocalBlobService', () => {
	it('a put is stored, read whole and by range, and held under `default` until unpinned', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		const content = bytesOf(600 * 1024, 1);

		const { ref, size } = await service.put(streamOf(content.subarray(0, 100_000), content.subarray(100_000)));

		expect(size).to.equal(content.byteLength);
		expect(await service.stat(ref)).to.deep.include({ ref, size: content.byteLength, locality: 'here', heldBytes: content.byteLength });
		expect(await readAll(service.read(ref))).to.deep.equal(content);
		const offset = PIECE - 100;
		expect(await readAll(service.read(ref, { offset, length: 200 }))).to.deep.equal(content.subarray(offset, offset + 200));
		const record = await recordOf(kv, ref);
		expect(record?.holds).to.have.length(1);
		expect(record?.holds[0]).to.deep.include({ kind: 'pin', owner: DEFAULT_BLOB_OWNER });

		await service.unpin(ref, DEFAULT_BLOB_OWNER);
		expect(await service.sweep()).to.deep.include({ kind: 'swept', deleted: 4 });

		expect(await service.stat(ref)).to.deep.include({ locality: 'unknown', heldBytes: 0 });
		expect(await listed(pieces)).to.deep.equal([]);
	});

	it('the empty blob', async () => {
		const pieces = new MemoryPieceStore();
		const service = serviceOver(pieces, new MemoryKVStore());

		const { ref, size } = await service.put(streamOf());

		expect(size).to.equal(0);
		expect(await service.stat(ref)).to.deep.include({ locality: 'here', size: 0, heldBytes: 0 });
		expect(await readAll(service.read(ref))).to.have.length(0);
		expect(await listed(pieces)).to.deep.equal([rootPieceId(ref)]);
	});

	it('a sweep while a put is in progress keeps its pieces', async () => {
		const pieces = new MemoryPieceStore();
		const service = serviceOver(pieces, new MemoryKVStore());
		const content = bytesOf(2 * PIECE + 5000, 2);
		const hold = gate();
		const { source, reached } = heldSource(content.subarray(0, 2 * PIECE), hold.promise, content.subarray(2 * PIECE));

		const put = service.put(source);
		await reached;
		expect(await listed(pieces)).to.have.length(2);
		// Both pieces are candidates, and only `inProgress` protects them: no record names them yet.
		expect(await service.sweep()).to.deep.include({ kind: 'swept', deleted: 0, kept: 2 });
		hold.open();
		const { ref } = await put;

		expect(await readAll(service.read(ref))).to.deep.equal(content);
	});

	it('a put that completes after the sweep read the records keeps its pieces', async () => {
		const pieces = new MemoryPieceStore();
		const releaseList = gate();
		const kv = new HeldListKVStore(new MemoryKVStore(), releaseList.promise);
		const service = serviceOver(pieces, kv);
		const content = bytesOf(2 * PIECE + 5000, 3);
		const holdSource = gate();
		const { source, reached } = heldSource(content.subarray(0, 2 * PIECE), holdSource.promise, content.subarray(2 * PIECE));

		const put = service.put(source);
		await reached;
		const sweep = service.sweep();
		// The pieces listing came first, so the put's two pieces are already candidates.
		await kv.listWaiting;
		holdSource.open();
		const { ref } = await put;
		releaseList.open();

		// The records listing predates the put's record and `inProgress` is empty again: only the
		// re-walk of records changed during the sweep keeps the two pieces.
		expect(await sweep).to.deep.include({ kind: 'swept', deleted: 0 });
		expect(await readAll(service.read(ref))).to.deep.equal(content);
	});

	it('a piece present when a sweep first walked its held blob survives once its parent arrives', async () => {
		const pieces = new HeldGetPieceStore();
		const service = serviceOver(pieces, new MemoryKVStore());
		const store = service.fetchStore();
		const fetched = await piecesOf(bytesOf(2 * PIECE + 5000, 15));
		const listPiece = rootPieceId(fetched.ref);
		const orphan = [...fetched.pieces.keys()].find(id => id !== listPiece)!;
		await pieces.put(orphan, fetched.pieces.get(orphan)!);
		await store.holdCached(fetched.ref);
		// Its record is written after the fetched blob's, so the records pass walks it second.
		const other = await service.put(streamOf(bytesOf(PIECE + 1000, 16)));
		const releaseWalk = gate();
		const walkingOther = pieces.holdNextGet(rootPieceId(other.ref), releaseWalk.promise);

		const sweep = service.sweep();
		await walkingOther;
		// The fetched blob's walk has ended at its absent list piece, without reaching the orphan.
		expect(pieces.asked, 'the records pass walked the fetched blob first').to.include(listPiece);
		await store.storePiece(fetched.ref, listPiece, fetched.pieces.get(listPiece)!);
		releaseWalk.open();

		expect(await sweep).to.deep.include({ kind: 'swept', deleted: 0 });
		expect(await pieces.has(orphan)).to.equal(true);
	});

	it('a change refused for a string that is not a reference leaves a running sweep unharmed', async () => {
		const releaseList = gate();
		const kv = new HeldListKVStore(new MemoryKVStore(), releaseList.promise);
		const service = serviceOver(new MemoryPieceStore(), kv);

		const sweep = service.sweep();
		await kv.listWaiting;
		const pinned = await service.pin('not-a-reference' as BlobRef, 'a').catch((error: unknown) => error);
		releaseList.open();

		expect(pinned).to.be.instanceOf(BlobRefError);
		expect(await sweep).to.deep.include({ kind: 'swept' });
	});

	it('deleting a record schedules a sweep that removes its pieces, and stop waits for it', async () => {
		const pieces = new MemoryPieceStore();
		const timers: Array<() => void> = [];
		const service = new LocalBlobService({ pieces, kv: new MemoryKVStore(), setTimer: fn => { timers.push(fn); return () => undefined; } });
		const { ref } = await service.put(streamOf(bytesOf(PIECE + 1000, 14)));
		expect(timers).to.have.length(0);

		await service.unpin(ref, DEFAULT_BLOB_OWNER);
		expect(timers).to.have.length(1);
		timers[0]!();
		await service.stop();

		expect(await listed(pieces)).to.deep.equal([]);
	});

	it('an aborted put leaves pieces the next sweep removes', async () => {
		const pieces = new MemoryPieceStore();
		const service = serviceOver(pieces, new MemoryKVStore());
		const controller = new AbortController();
		async function* source(): AsyncIterable<Uint8Array> {
			yield bytesOf(PIECE, 4);
			controller.abort(new Error('the host gave up'));
			yield bytesOf(PIECE, 5);
		}

		let failure: unknown;
		await service.put(source(), { signal: controller.signal }).catch((error: unknown) => { failure = error; });

		expect(failure).to.be.instanceOf(Error).with.property('message', 'the host gave up');
		expect(await listed(pieces)).to.not.be.empty;
		await service.sweep();
		expect(await listed(pieces)).to.deep.equal([]);
	});

	it('two puts of the same content keep one set of pieces and both pins', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		const content = bytesOf(PIECE + 1000, 6);

		const [a, b] = await Promise.all([
			service.put(streamOf(content), { owner: 'a' }),
			service.put(streamOf(content), { owner: 'b' }),
		]);

		expect(a.ref).to.equal(b.ref);
		expect(await kv.list(BLOB_RECORD_KEY_PREFIX)).to.have.length(1);
		const owners = (await recordOf(kv, a.ref))?.holds.map(hold => (hold.kind === 'pin' ? hold.owner : hold.kind));
		expect(owners).to.have.members(['a', 'b']);
		await service.unpin(a.ref, 'a');
		await service.sweep();
		expect(await service.stat(a.ref)).to.deep.include({ locality: 'here' });
		await service.unpin(a.ref, 'b');
		await service.sweep();
		expect(await listed(pieces)).to.deep.equal([]);
	});

	it('a piece shared by two blobs survives unpinning one', async () => {
		const pieces = new MemoryPieceStore();
		const service = serviceOver(pieces, new MemoryKVStore());
		const shared = bytesOf(PIECE, 7);
		const q = bytesOf(1000, 8);
		const r = bytesOf(1000, 9);

		const a = await service.put(streamOf(shared, q));
		const b = await service.put(streamOf(shared, r));
		await service.unpin(a.ref, DEFAULT_BLOB_OWNER);
		await service.sweep();

		expect(await readAll(service.read(b.ref))).to.deep.equal(concat([shared, r]));
		expect(await pieces.has(await pieceIdOf(shared)), 'the shared piece').to.equal(true);
		expect(await pieces.has(await pieceIdOf(q)), "A's own piece").to.equal(false);
		expect(await pieces.has(rootPieceId(a.ref)), "A's list piece").to.equal(false);
	});

	it('a missing piece fails a local read and corrects the record', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		const content = bytesOf(600 * 1024, 10);
		const { ref } = await service.put(streamOf(content));
		await pieces.delete((await dataPiecesOf(ref, pieces))[1]!);

		const here = await readAll(service.read(ref, { from: 'here' })).catch((error: unknown) => error);
		const anywhere = await readAll(service.read(ref)).catch((error: unknown) => error);

		expect(here).to.be.instanceOf(BlobUnavailableError).with.property('reason', 'not-here');
		expect(anywhere).to.be.instanceOf(BlobUnavailableError).with.property('reason', 'cohort-unreachable');
		const stat = await service.stat(ref);
		expect(stat).to.deep.include({ locality: 'partial', size: content.byteLength });
		expect(stat.heldBytes).to.equal(content.byteLength - PIECE);
		expect((await recordOf(kv, ref))?.whole).to.equal(false);
	});

	it('records and pins survive a restart; pieces are checked, not assumed', async () => {
		const pieces = new PowerLossPieceStore();
		const kv = new PowerLossKVStore();
		const content = bytesOf(PIECE + 1000, 11);
		const { ref } = await serviceOver(pieces, kv).put(streamOf(content));
		pieces.powerLoss();
		kv.powerLoss();
		const reopenedPieces = pieces.reopen();
		const reopenedKv = kv.reopen();

		const onEmptyPieces = serviceOver(new MemoryPieceStore(), reopenedKv);
		expect(await onEmptyPieces.stat(ref)).to.deep.include({ locality: 'unknown', size: content.byteLength });
		expect((await recordOf(reopenedKv, ref))?.whole).to.equal(false);

		const restarted = serviceOver(reopenedPieces, reopenedKv);
		expect(await restarted.stat(ref)).to.deep.include({ locality: 'here', heldBytes: content.byteLength });
		expect((await recordOf(reopenedKv, ref))?.whole).to.equal(true);
		expect(await readAll(restarted.read(ref))).to.deep.equal(content);
		await restarted.unpin(ref, DEFAULT_BLOB_OWNER);
		expect(await recordOf(reopenedKv, ref)).to.equal(undefined);
	});

	it('a malformed record stops the sweep', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		const orphan = bytesOf(1000, 12);
		const orphanId = await pieceIdOf(orphan);
		await pieces.put(orphanId, orphan);
		const recorded = await refOf(bytesOf(1000, 13));
		await kv.set(BLOB_RECORD_KEY_PREFIX + recorded, 'garbage');

		expect(await service.sweep()).to.deep.equal({ kind: 'aborted', reason: 'record-unreadable', ref: recorded });
		expect(await pieces.has(orphanId)).to.equal(true);
	});
});
