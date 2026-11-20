import {
	BlobUnavailableError,
	buildBlob,
	defaultBlobDigest,
	parseBlobRef,
	readBlob,
	rootPieceId,
	walkBlobPieces,
	type BlobDigest,
	type BlobDurability,
	type BlobDurabilityEvent,
	type BlobFetchOptions,
	type BlobProgressEvent,
	type BlobPutOptions,
	type BlobPutResult,
	type BlobReadOptions,
	type BlobRef,
	type BlobScope,
	type BlobService,
	type BlobStat,
	type PieceId,
	type PieceSink,
	type PieceSource,
} from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import type { IKVStore } from '../storage/i-kv-store.js';
import { armUnrefTimer } from '../unref-timer.js';
import { blobScopeProblem } from './blob-protocol.js';
import { BlobRecordFormatError, DEFAULT_BLOB_OWNER, type BlobHold, type BlobRecord } from './blob-record.js';
import { BlobRecordStore, type BlobRecordChange } from './blob-record-store.js';
import { localPieceSource } from './local-piece-source.js';
import { InProgressPieces, PieceSweeper, type BlobSweepResult } from './piece-sweeper.js';
import type { IPieceStore } from './piece-store.js';
import { SweepGate } from './sweep-gate.js';

const log = createLogger('blob:store');

/**
 * What the blob fetcher may do to this node's store (docs/blobs.md §Holds): every piece and record
 * change a fetch makes goes through the one record store, sweep gate and sweeper `LocalBlobService`
 * owns, which is what keeps a running sweep from deleting a fetch's progress.
 *
 * Nothing here flushes. After a crash the stored pieces and the hold may or may not be on disk: the
 * next sweep may remove pieces whose record did not survive, and the next fetch brings them again.
 */
export interface BlobFetchStore {
	/** This node's pieces, `verified` (`localPieceSource`). */
	readonly source: PieceSource;
	/** The hashing port this store's pieces are named with; the fetcher checks every fetched piece with it, so the two cannot differ. */
	readonly digest: BlobDigest;
	/** Adds a `cached` hold to the record, creating it (`whole: false`) when there is none; a record already holding `cached` is unchanged. Not flushed. */
	holdCached(ref: BlobRef): Promise<void>;
	/**
	 * Stores a piece of `ref`'s tree that the caller has checked against `id`: inside one shared hold
	 * of the sweep gate, noting `ref` as changed for a running sweep, then `pieces.put`. Not flushed.
	 * The caller holds `ref` (`holdCached`) before its first piece and stores a list piece before the
	 * pieces it names, which is what the sweep relies on (`PieceSweeper`).
	 */
	storePiece(ref: BlobRef, id: PieceId, bytes: Uint8Array): Promise<void>;
	/** Sets `whole: true` and `size` on the existing record; never creates a record, and a failure is logged, not thrown. Not flushed. */
	markWhole(ref: BlobRef, size: number): Promise<void>;
	/**
	 * Sets `size` on the existing record and the `whole` hint to false: the size of a blob this node
	 * holds only part of. Never creates a record; a failure is logged, not thrown. Not flushed.
	 *
	 * The caller holds `ref` (`holdCached`) first. `whole: false` is what the record already says, and
	 * `markWhole` sets it back once every piece is here. A range that completed over a blob of one
	 * piece is the case this leaves understating what is held — the safe direction {@link holdsWhole}
	 * describes, corrected by the next read or `stat`.
	 */
	markPartial(ref: BlobRef, size: number): Promise<void>;
}

/**
 * What the blob copy drain needs of this node's blob records; `LocalBlobService` is it.
 *
 * A door rather than a second `BlobRecordStore` over the same `IKVStore`: two instances keep separate
 * per-ref queues, so the drain's durability write and the service's hold write could lose one another,
 * and the drain's writes would also bypass the sweep gate that `changeRecord` takes.
 */
export interface BlobOwedRecords {
	/** Add the `owed` hold, creating the record (`whole: false`) when there is none. Every other hold is kept. Flushed: a lost hold would let a restart sweep a blob this node is announcing. */
	holdOwed(ref: BlobRef): Promise<void>;
	/** Remove the `owed` hold; a record left with no hold is deleted and the blob swept. No record, or no such hold, is a no-op. Flushed. */
	releaseOwed(ref: BlobRef): Promise<void>;
	/** Write the record's `durability`, flushed. Never creates a record: a record deleted meanwhile stays deleted. */
	setDurability(ref: BlobRef, durability: BlobDurability): Promise<void>;
	/** The record's stored `durability`, or undefined. */
	durabilityOf(ref: BlobRef): Promise<BlobDurability | undefined>;
	/**
	 * Whether this node's record says every piece is here.
	 *
	 * The record's `whole` hint rather than a census, so a pass over many entries costs one `get` each.
	 * The hint is corrected by every read and every `stat` (`correctRecord`). A stale `false` only
	 * under-counts this node, which keeps the blob — the safe direction; a stale `true` is corrected by
	 * the next read.
	 */
	holdsWhole(ref: BlobRef): Promise<boolean>;
	/** Tell this service's `onDurability` listeners. Each listener is called in a `try`; a throw is logged (`durability:listener-threw`) and does not stop the others, as `NodeBlobService.emitProgress` does. */
	emitDurability(event: BlobDurabilityEvent): void;
}

/** One cache-only blob as the cache budget sees it. */
export interface CachedBlob {
	readonly ref: BlobRef;
	/**
	 * The record's `size`, or undefined when the record carries none: this node holds part of the blob
	 * and never learned how big the whole is, so it cannot say what it is spending here. Not the same
	 * as a 0-byte blob, whose record carries `size: 0` — the budget counts that one and evicts the
	 * unsized one (`chooseEvictions`).
	 */
	readonly bytes: number | undefined;
	/** When the blob was last read here: the record's `lastReadAt`, else its `cached` hold's `at` ({@link lastReadOf}). */
	readonly lastReadAt: number;
}

/**
 * What the cache budget needs of this node's blob records and pieces; `LocalBlobService` is it
 * (docs/blobs.md §Lifetime).
 *
 * A door rather than a second `BlobRecordStore` over the same `IKVStore`, for the reason
 * {@link BlobOwedRecords} gives: two instances keep separate per-ref queues, and a write that
 * bypassed `changeRecord` would also bypass the sweep gate and `PieceSweeper.noteRecordChange`,
 * which is what keeps a running sweep from deleting a concurrent write's pieces.
 */
export interface BlobCacheRecords {
	/** Every blob whose record holds `cached` and no other hold. A record that does not decode is
	 *  logged (`record:unreadable`) and skipped, as `responsibleRefs` does, so one unreadable record
	 *  cannot fail an enforcement — and a blob whose record cannot be read is never evicted. */
	cachedBlobs(): Promise<CachedBlob[]>;
	/** Remove `ref`'s `cached` hold, but only while that is still its only hold; `true` when it did.
	 *  A record left with no hold is deleted and its pieces left for the sweep. Not flushed: a hold
	 *  removal a crash undoes is made again by the next enforcement. */
	releaseCached(ref: BlobRef): Promise<boolean>;
	/** {@link LocalBlobService.inUse}. */
	inUse(ref: BlobRef): boolean;
	/** {@link LocalBlobService.sweep}. */
	sweep(): Promise<BlobSweepResult>;
}

/**
 * Reading this machine's pins by owner. Not part of `BlobService`: enumeration is a property of a
 * store, not of the service contract.
 *
 * Serves a caller that must find pins it does not remember — the SQL plugin reads its transactions'
 * pins back off the machine after a restart, and finds the pin an earlier owner took on a reference a
 * transaction is taking over (docs/blobs.md §Holds).
 */
export interface BlobPinIndex {
	/** The owner labels pinned on `ref`, in no promised order; `[]` when this machine holds no readable record for it. */
	pinsOf(ref: BlobRef): Promise<string[]>;
	/** Every (reference, owner) pin whose owner label starts with `ownerPrefix`, in no promised order. */
	listPins(ownerPrefix: string): AsyncIterable<{ ref: BlobRef; owner: string }>;
}

/** Supplies a piece the local store lacks; resolves with its verified bytes or rejects with why it cannot. */
export type MissingPiece = (id: PieceId) => Promise<Uint8Array>;

/** How long after a trigger a scheduled sweep runs, by default. */
export const DEFAULT_SWEEP_DELAY_MS = 5_000;

/** How stale a record's `lastReadAt` may be; a read writes the record only when it is older than this. */
export const LAST_READ_RESOLUTION_MS = 60_000;

export interface LocalBlobServiceInit {
	readonly pieces: IPieceStore;
	readonly kv: IKVStore;
	/** Default `defaultBlobDigest()`. */
	readonly digest?: BlobDigest;
	/** Default DEFAULT_SWEEP_DELAY_MS. */
	readonly sweepDelayMs?: number;
	/** Default Date.now. */
	readonly now?: () => number;
	/** Default armUnrefTimer. */
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

/**
 * A `BlobService` that answers from this machine alone (docs/blobs.md §The node's blob service):
 * puts, describes, reads, pins and unpins blobs over the node's piece store and its blob records.
 * It is the single-machine service underneath `NodeBlobService`, which is what `node.blobs` is and
 * which fetches from other machines through `readThrough` and `fetchStore`; used on its own it never
 * asks another machine. It owns the records the copy drain changes and the `onDurability` listeners it
 * emits through ({@link BlobOwedRecords}); announcing is `NodeBlobService`'s, since this service has
 * no cohort. It also reads its own pins back ({@link BlobPinIndex}) and offers the cache budget its
 * door onto the blobs held only for reads ({@link BlobCacheRecords}).
 */
export class LocalBlobService implements BlobService, BlobOwedRecords, BlobPinIndex, BlobCacheRecords {
	private readonly pieces: IPieceStore;
	private readonly records: BlobRecordStore;
	private readonly gate = new SweepGate();
	private readonly inProgress = new InProgressPieces();
	private readonly sweeper: PieceSweeper;
	private readonly digest: BlobDigest;
	private readonly source: PieceSource;
	private readonly sweepDelayMs: number;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	private cancelScheduledSweep: (() => void) | undefined;
	/** A sweep whose timer has fired, until it ends. */
	private scheduledRun: Promise<void> | undefined;
	private readonly progressListeners = new Set<(event: BlobProgressEvent) => void>();
	private readonly durabilityListeners = new Set<(event: BlobDurabilityEvent) => void>();
	private readonly fetchDoor: BlobFetchStore;
	/** Reads and fetches in flight, by reference; an entry exists only while its count is above zero. */
	private readonly uses = new Map<BlobRef, number>();

	constructor(init: LocalBlobServiceInit) {
		this.pieces = init.pieces;
		this.records = new BlobRecordStore(init.kv);
		this.digest = init.digest ?? defaultBlobDigest();
		this.source = localPieceSource(init.pieces);
		this.sweepDelayMs = init.sweepDelayMs ?? DEFAULT_SWEEP_DELAY_MS;
		this.now = init.now ?? Date.now;
		this.setTimer = init.setTimer ?? armUnrefTimer;
		this.sweeper = new PieceSweeper({ pieces: this.pieces, records: this.records, gate: this.gate, inProgress: this.inProgress, digest: this.digest, inUseRefs: () => this.inUseRefs() });
		this.fetchDoor = {
			source: this.source,
			digest: this.digest,
			holdCached: ref => this.holdCached(ref),
			storePiece: (ref, id, bytes) => this.storeFetchedPiece(ref, id, bytes),
			markWhole: (ref, size) => this.correctRecord(ref, true, size),
			markPartial: (ref, size) => this.correctRecord(ref, false, size),
		};
	}

	/** The door `BlobFetcher` uses into this node's store; built once, the same object every call. */
	fetchStore(): BlobFetchStore {
		return this.fetchDoor;
	}

	/** Schedules the start-up sweep, which removes the orphans of a put a crash interrupted. */
	start(): void {
		this.scheduleSweep();
	}

	/** Cancels a scheduled sweep and waits for a running one. Every method still works afterwards. */
	async stop(): Promise<void> {
		this.cancelScheduledSweep?.();
		this.cancelScheduledSweep = undefined;
		await this.scheduledRun;
		await this.sweeper.idle();
	}

	/** Runs a sweep now, or joins the one running. */
	sweep(): Promise<BlobSweepResult> {
		return this.sweeper.run();
	}

	/**
	 * Whether a read or a fetch of `ref` is running on this node (docs/blobs.md §Holds). A caller that
	 * is about to take a blob's last hold away asks this first; the sweep asks `inUseRefs`.
	 */
	inUse(ref: BlobRef): boolean {
		return this.uses.has(ref);
	}

	/** Every ref with a use in flight, in no promised order. */
	inUseRefs(): BlobRef[] {
		return [...this.uses.keys()];
	}

	// NOTE: a use ends only when its holder releases it, so an iterator abandoned without `return` —
	// neither drained by `for await` nor closed by hand — keeps its blob out of every sweep for the
	// life of the process. Harmless while consumers use `for await` or call `return`; if a node is ever
	// seen keeping blobs nothing is reading, put a time limit on a use.
	/**
	 * Counts a use of `ref` until the returned function is called; a second call does nothing, so a
	 * `finally` reached twice (a generator that throws while returning) cannot take another reader's
	 * protection away. Synchronous and gate-free, so it can be the first statement of a generator
	 * body, before any `await`.
	 */
	beginUse(ref: BlobRef): () => void {
		this.uses.set(ref, (this.uses.get(ref) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const count = this.uses.get(ref) ?? 0;
			if (count <= 1) {
				this.uses.delete(ref);
			} else {
				this.uses.set(ref, count - 1);
			}
		};
	}

	/**
	 * Stores the stream as a blob, pinned for `owner` (`DEFAULT_BLOB_OWNER` when none is given; an
	 * empty owner throws RangeError). Resolves once every piece and the record naming them are
	 * durable here, in that order. Two concurrent puts of one content store one set of pieces and
	 * leave one record with both pins.
	 */
	async put(source: AsyncIterable<Uint8Array>, options: BlobPutOptions = {}): Promise<BlobPutResult> {
		const owner = options.owner ?? DEFAULT_BLOB_OWNER;
		assertOwner(owner);
		const mine = new Set<PieceId>();
		try {
			const result = await buildBlob(source, this.sinkFor(mine), { digest: this.digest, signal: options.signal });
			await this.pieces.flush();
			await this.changeRecord(result.ref, current => recordAfterPut(current, result, owner, this.now()));
			await this.records.flush();
			log('put:stored ref=%s size=%d', result.ref, result.size);
			return result;
		} catch (error) {
			if (mine.size > 0) {
				this.scheduleSweep();
			}
			log('put:failed reason=%s', describe(error));
			throw error;
		} finally {
			this.inProgress.release(mine);
		}
	}

	/**
	 * What this node holds of the blob, from its record and its pieces: `here`, `partial` or `unknown`,
	 * never `elsewhere`. `probe` is ignored: asking the blob's cohort is `NodeBlobService.stat`'s, which
	 * calls this first. `durability` is the record's, as the copy drain last computed it. A record found
	 * wrong about whether the blob is whole is corrected (`record:corrected`). A malformed tree throws
	 * BlobCorruptError.
	 */
	async stat(ref: BlobRef, _options: { probe?: boolean } = {}): Promise<BlobStat> {
		const record = await this.records.get(ref);
		if (!(await this.pieces.has(rootPieceId(ref)))) {
			// Also how a node restarted on a memory piece store over a persistent key-value store reports honestly.
			if (record?.whole === true) {
				await this.correctRecord(ref, false);
			}
			return { ref, size: record?.size, locality: 'unknown', heldBytes: 0, durability: record?.durability };
		}
		if (record?.whole === true && record.size !== undefined) {
			return { ref, size: record.size, locality: 'here', heldBytes: record.size, durability: record.durability };
		}
		const census = await this.census(ref, record?.size);
		if (census.whole) {
			await this.correctRecord(ref, true, census.size);
		}
		return { ref, size: census.size, locality: census.whole ? 'here' : 'partial', heldBytes: census.heldBytes, durability: record?.durability };
	}

	/**
	 * The verified bytes, or a range of them, from this node's pieces alone. A piece that is not here
	 * fails the read with BlobUnavailableError, reason `not-here` when `from` is `'here'` and otherwise
	 * `cohort-unreachable`, since this service asks nobody; `waitMs` is ignored. A set `signal` ends the
	 * read between chunks with `signal.reason`. `NodeBlobService.read` is the read that fetches.
	 */
	read(ref: BlobRef, options: BlobReadOptions = {}): AsyncIterable<Uint8Array> {
		const reason = options.from === 'here' ? 'not-here' : 'cohort-unreachable';
		return this.readThrough(ref, options, async id => {
			throw new BlobUnavailableError(ref, reason, id);
		});
	}

	/**
	 * `read`, with a piece that is not here asked of `missing` rather than failing the read. The bytes
	 * `missing` supplies are taken as verified, as a local piece is, so it must supply only bytes the
	 * fetcher has checked against their id. A BlobUnavailableError out of the read corrects the record
	 * to not whole, as `read`'s does.
	 */
	async *readThrough(ref: BlobRef, options: BlobReadOptions, missing: MissingPiece): AsyncIterable<Uint8Array> {
		// The first statement of the body, before any `await`, so every read that has started reaching
		// for bytes is counted; the body does not run at all until the first `next()`, so a read created
		// and never iterated counts nothing. `finally` runs on completion, on a throw, and when a
		// `for await` consumer breaks out (which calls this generator's `return`).
		const endUse = this.beginUse(ref);
		try {
			yield* this.readChunks(ref, options, missing);
		} finally {
			endUse();
		}
	}

	/** The read itself, split out so the use `readThrough` counts is visibly the first thing its body does. */
	private async *readChunks(ref: BlobRef, options: BlobReadOptions, missing: MissingPiece): AsyncIterable<Uint8Array> {
		const { signal } = options;
		signal?.throwIfAborted();
		void this.touchLastRead(ref);
		const source = this.readSource(missing);
		try {
			for await (const chunk of readBlob(ref, source, { offset: options.offset, length: options.length, digest: this.digest })) {
				yield chunk;
				signal?.throwIfAborted();
			}
		} catch (error) {
			if (error instanceof BlobUnavailableError) {
				await this.correctRecord(ref, false);
			}
			throw error;
		}
	}

	/** Resolves when the blob is whole here; this service asks nobody, so otherwise it rejects with `cohort-unreachable`. `NodeBlobService.fetch` fetches. */
	async fetch(ref: BlobRef, _options: BlobFetchOptions = {}): Promise<void> {
		// A use even though this only stats: every public read and fetch holds one, and a path exempt by
		// accident is the hole this mechanism exists to close.
		const endUse = this.beginUse(ref);
		try {
			if ((await this.stat(ref)).locality !== 'here') {
				throw new BlobUnavailableError(ref, 'cohort-unreachable');
			}
		} finally {
			endUse();
		}
	}

	/**
	 * Holds the blob for `owner` (an empty owner throws RangeError), creating its record when there is
	 * none, and makes the pin durable: a lost pin would let a restart sweep the blob.
	 */
	async pin(ref: BlobRef, owner: string): Promise<void> {
		assertOwner(owner);
		const at = this.now();
		await this.changeRecord(ref, current => recordAfterPin(current, ref, owner, at));
		await this.records.flush();
	}

	/** Releases `owner`'s pin; a blob left with no hold loses its record and is swept. No record, or no such pin, is a no-op. */
	async unpin(ref: BlobRef, owner: string): Promise<void> {
		await this.changeRecord(ref, current => recordAfterUnpin(current, owner));
		await this.records.flush();
	}

	/** {@link BlobPinIndex.pinsOf}. A record that does not decode reads as absent, so one unreadable record cannot fail a caller's pass — the rule `durabilityOf` and `responsibleRefs` already apply. */
	async pinsOf(ref: BlobRef): Promise<string[]> {
		return pinOwnersOf(await this.readableRecord(ref));
	}

	/**
	 * {@link BlobPinIndex.listPins}. A record that does not decode is logged (`record:unreadable`) and
	 * skipped, as in `responsibleRefs`, so that blob's pins are invisible rather than fatal.
	 *
	 * NOTE: scans every blob record ({@link readableRecords}); if a machine ever holds enough blobs for a
	 * prefix query to show up, index pins by owner prefix.
	 */
	async *listPins(ownerPrefix: string): AsyncIterable<{ ref: BlobRef; owner: string }> {
		for await (const { ref, record } of this.readableRecords()) {
			for (const owner of pinOwnersOf(record)) {
				if (owner.startsWith(ownerPrefix)) {
					yield { ref, owner };
				}
			}
		}
	}

	/**
	 * Holds the blob because this node is responsible for it and found it referenced under `scope`:
	 * adds the `responsible` hold, or replaces an existing one's scope and `at`, creating the record
	 * (`whole: false`) when there is none. Every other hold is kept. A scope `blobScopeProblem` refuses
	 * throws RangeError, so a hold can never carry a scope the re-announce would refuse to send.
	 * Flushed before it resolves: a lost hold would let a restart sweep a blob this node told an
	 * announcer it is pulling.
	 *
	 * NOTE: `at` is "last verified", so every call writes and flushes even when the scope is unchanged.
	 * If a caller ever re-verifies every responsible blob on a schedule, give it a way to skip the write.
	 */
	async holdResponsible(ref: BlobRef, scope: BlobScope): Promise<void> {
		assertScope(scope);
		const at = this.now();
		await this.changeRecord(ref, current => recordAfterResponsibleHold(current, ref, scope, at));
		await this.records.flush();
	}

	/** The scope of `ref`'s `responsible` hold, or undefined. A malformed record throws BlobRecordFormatError. */
	async responsibleScope(ref: BlobRef): Promise<BlobScope | undefined> {
		return responsibleHoldOf(await this.records.get(ref))?.scope;
	}

	/**
	 * Every ref whose record holds `responsible`. A record that fails to decode is logged
	 * (`record:unreadable`) and skipped.
	 *
	 * NOTE: reads every record ({@link readableRecords}), which is acceptable for the start-up
	 * enumeration this serves. If the record count ever makes start-up slow, keep an index of the hold
	 * kinds each record carries.
	 */
	async responsibleRefs(): Promise<BlobRef[]> {
		const refs: BlobRef[] = [];
		for await (const { ref, record } of this.readableRecords()) {
			if (responsibleHoldOf(record) !== undefined) {
				refs.push(ref);
			}
		}
		return refs;
	}

	/** {@link BlobOwedRecords.holdOwed}. */
	async holdOwed(ref: BlobRef): Promise<void> {
		const at = this.now();
		await this.changeRecord(ref, current => recordAfterOwedHold(current, ref, at));
		await this.records.flush();
	}

	/** {@link BlobOwedRecords.releaseOwed}. */
	async releaseOwed(ref: BlobRef): Promise<void> {
		await this.changeRecord(ref, recordAfterOwedRelease);
		await this.records.flush();
	}

	/** {@link BlobOwedRecords.setDurability}. */
	async setDurability(ref: BlobRef, durability: BlobDurability): Promise<void> {
		await this.changeRecord(ref, current => recordWithDurability(current, durability));
		await this.records.flush();
	}

	/** {@link BlobOwedRecords.durabilityOf}. A record that does not decode reads as absent, so a drain pass is not failed by one. */
	async durabilityOf(ref: BlobRef): Promise<BlobDurability | undefined> {
		return (await this.readableRecord(ref))?.durability;
	}

	/** {@link BlobOwedRecords.holdsWhole}. A record that does not decode reads as absent, which under-counts this node — the safe direction. */
	async holdsWhole(ref: BlobRef): Promise<boolean> {
		return (await this.readableRecord(ref))?.whole === true;
	}

	/** {@link BlobCacheRecords.cachedBlobs}. Reads every record ({@link readableRecords}), as `responsibleRefs` and `listPins` do; the `NOTE:` at `BlobCacheBudget.runOnce` carries that cost's tripwire. */
	async cachedBlobs(): Promise<CachedBlob[]> {
		const blobs: CachedBlob[] = [];
		for await (const { ref, record } of this.readableRecords()) {
			if (cacheOnly(record)) {
				blobs.push({ ref, bytes: record.size, lastReadAt: lastReadOf(record) });
			}
		}
		return blobs;
	}

	/**
	 * {@link BlobCacheRecords.releaseCached}. The change function is itself the condition, applied at
	 * this reference's turn in the record store's per-ref queue: a blob that gained a pin, an `owed` or
	 * a `responsible` hold since the enumeration keeps every hold, and this reports `false`.
	 */
	async releaseCached(ref: BlobRef): Promise<boolean> {
		const result = await this.changeRecord(ref, recordAfterCacheEviction);
		// The change function either deletes the record — `cached` was its only hold — or returns it
		// untouched, so a `before` with no `after` is exactly an eviction that happened.
		return result.before !== undefined && result.after === undefined;
	}

	/** {@link BlobOwedRecords.emitDurability}. */
	emitDurability(event: BlobDurabilityEvent): void {
		for (const listener of [...this.durabilityListeners]) {
			try {
				listener(event);
			} catch (error) {
				log('durability:listener-threw ref=%s error=%s', event.ref, describe(error));
			}
		}
	}

	/** This service has no cohort: announcing is `NodeBlobService.announce`'s, which drives the copy drain. */
	async announce(_ref: BlobRef, _scope: BlobScope): Promise<void> {
		throw new Error('announcing a blob to its cohort is not built yet (feat-blob-owed-copies-are-drained)');
	}

	/** Never fires: this service fetches nothing. `NodeBlobService.onProgress` reports the fetches it starts. */
	onProgress(listener: (event: BlobProgressEvent) => void): () => void {
		return subscribe(this.progressListeners, listener);
	}

	/** The blob copy drain emits through `emitDurability`, which is this set; `NodeBlobService.onDurability` is this call. */
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void {
		return subscribe(this.durabilityListeners, listener);
	}

	// NOTE: a blob whose `cached` hold goes while something is still reading or fetching it is protected
	// by the uses `readThrough`, `fetch` and every `NodeBlobService` fetch session hold, which the sweep
	// takes as roots (`inUseRefs`); an evicting caller skips such a blob by asking `inUse`.
	private async holdCached(ref: BlobRef): Promise<void> {
		const at = this.now();
		await this.changeRecord(ref, current => recordAfterCachedHold(current, ref, at));
	}

	/**
	 * Noting `ref` inside the same shared hold as the `put` is what keeps a piece that was an orphan
	 * when a sweep first walked `ref` (its parent list piece absent then) from being deleted once this
	 * call stores the parent: the decide step runs after this hold ends and walks `ref` again. A
	 * string that is not a canonical reference throws BlobRefError before it is noted, as in
	 * `changeRecord`.
	 */
	private storeFetchedPiece(ref: BlobRef, id: PieceId, bytes: Uint8Array): Promise<void> {
		parseBlobRef(ref);
		return this.gate.shared(async () => {
			this.sweeper.noteRecordChange(ref);
			await this.pieces.put(id, bytes);
		});
	}

	/** Where the builder puts a put's pieces: each id joins `inProgress` before its piece is stored, inside one shared hold. */
	private sinkFor(mine: Set<PieceId>): PieceSink {
		return {
			put: (id, bytes) => this.gate.shared(async () => {
				// An id repeated within one blob is counted once.
				if (!mine.has(id)) {
					mine.add(id);
					this.inProgress.add(id);
				}
				await this.pieces.put(id, bytes);
			}),
		};
	}

	/**
	 * The one path every record change takes; a record's deletion schedules a sweep. A string that is
	 * not a canonical reference throws BlobRefError before it is noted, since a running sweep re-reads
	 * every noted ref and would fail on it.
	 */
	private async changeRecord(ref: BlobRef, change: (current: BlobRecord | undefined) => BlobRecord | undefined): Promise<BlobRecordChange> {
		parseBlobRef(ref);
		const result = await this.gate.shared(() => {
			this.sweeper.noteRecordChange(ref);
			return this.records.update(ref, change);
		});
		if (result.before !== undefined && result.after === undefined) {
			this.scheduleSweep();
		}
		return result;
	}

	/**
	 * Every blob with a record this node can read, in `listRefs` order: the one pass behind `listPins`,
	 * `responsibleRefs` and `cachedBlobs`, each of which filters it. A record that does not decode is
	 * logged (`record:unreadable`) and left out, so one unreadable record cannot fail a caller's pass.
	 *
	 * NOTE: one `get` per record, and the three callers above each walk the lot. If a machine ever holds
	 * enough blobs for these passes to show up in a profile, index the records by what each pass asks
	 * about (hold kinds, pin owners) rather than widening this one.
	 */
	private async *readableRecords(): AsyncIterable<{ ref: BlobRef; record: BlobRecord }> {
		for (const ref of await this.records.listRefs()) {
			const record = await this.readableRecord(ref);
			if (record !== undefined) {
				yield { ref, record };
			}
		}
	}

	/** The record of `ref`, or undefined when there is none or it does not decode (logged). */
	private async readableRecord(ref: BlobRef): Promise<BlobRecord | undefined> {
		try {
			return await this.records.get(ref);
		} catch (error) {
			if (!(error instanceof BlobRecordFormatError)) {
				throw error;
			}
			log('record:unreadable ref=%s error=%s', ref, error.message);
			return undefined;
		}
	}

	/** Sets an existing record's `whole` (and `size`, when given); never creates one. A failure is logged, not thrown: the record is a hint. */
	private async correctRecord(ref: BlobRef, whole: boolean, size?: number): Promise<void> {
		try {
			const result = await this.changeRecord(ref, current => recordCorrected(current, whole, size));
			if (result.after !== result.before) {
				log('record:corrected ref=%s whole=%s size=%s', ref, whole, size ?? result.after?.size);
			}
		} catch (error) {
			log('record:correct-failed ref=%s whole=%s error=%s', ref, whole, describe(error));
		}
	}

	/** Sets `lastReadAt` on an existing record when it is absent or older than LAST_READ_RESOLUTION_MS; unflushed, since a lost read time costs only eviction order. */
	private async touchLastRead(ref: BlobRef): Promise<void> {
		const at = this.now();
		try {
			await this.changeRecord(ref, current => recordAfterRead(current, at));
		} catch (error) {
			log('record:touch-failed ref=%s error=%s', ref, describe(error));
		}
	}

	/** The local source, with a piece that is not here asked of `missing`. */
	private readSource(missing: MissingPiece): PieceSource {
		const local = this.source;
		return {
			verified: true,
			get: async id => (await local.get(id)) ?? missing(id),
		};
	}

	/**
	 * Walks the tree for what is here. The size is the list root's, else the record's, else a raw
	 * root's own length. `heldBytes` sums the present data pieces below the root, a repeated piece at
	 * each position, so it equals the size exactly when every piece is here.
	 */
	private async census(ref: BlobRef, recordSize: number | undefined): Promise<BlobCensus> {
		const rootId = rootPieceId(ref);
		let size = recordSize;
		let heldBytes = 0;
		let whole = true;
		let rawRootPresent = false;
		for await (const entry of walkBlobPieces(ref, this.source, { digest: this.digest })) {
			whole &&= entry.present;
			if (entry.id === rootId && entry.kind === 'list' && entry.fileBytes !== undefined) {
				size = entry.fileBytes;
			} else if (entry.id === rootId && entry.kind === 'data') {
				rawRootPresent = entry.present;
			} else if (entry.present && entry.kind === 'data') {
				heldBytes += entry.fileBytes ?? 0;
			}
		}
		if (rawRootPresent) {
			size ??= (await this.pieces.get(rootId))?.byteLength;
			heldBytes = size ?? 0;
		}
		return { size, heldBytes, whole };
	}

	/** Arms the sweep timer unless it is already armed. A timer firing during a run sweeps again after it. */
	private scheduleSweep(): void {
		if (this.cancelScheduledSweep !== undefined) {
			return;
		}
		this.cancelScheduledSweep = this.setTimer(() => {
			this.cancelScheduledSweep = undefined;
			const run = this.runScheduledSweep().finally(() => {
				if (this.scheduledRun === run) {
					this.scheduledRun = undefined;
				}
			});
			this.scheduledRun = run;
		}, this.sweepDelayMs);
	}

	private async runScheduledSweep(): Promise<void> {
		try {
			// A sweep already running may have read the records before the change that scheduled this one.
			await this.sweeper.idle();
			await this.sweeper.run();
		} catch (error) {
			log('sweep:failed error=%s', describe(error));
		}
	}
}

interface BlobCensus {
	readonly size: number | undefined;
	readonly heldBytes: number;
	readonly whole: boolean;
}

function assertOwner(owner: string): void {
	if (owner === '') {
		throw new RangeError('A blob pin owner must be a non-empty string');
	}
}

/** The wire's scope rule, applied at the store's entrance: a stored scope exists only to be re-announced. */
function assertScope(scope: BlobScope): void {
	const problem = blobScopeProblem(scope);
	if (problem !== undefined) {
		throw new RangeError(`A blob hold has ${problem}`);
	}
}

function responsibleHoldOf(record: BlobRecord | undefined): Extract<BlobHold, { kind: 'responsible' }> | undefined {
	return record?.holds.find((hold): hold is Extract<BlobHold, { kind: 'responsible' }> => hold.kind === 'responsible');
}

/** Every owner the record pins for; `flatMap` rather than `filter` so the hold's kind narrows to the one carrying an owner. */
function pinOwnersOf(record: BlobRecord | undefined): string[] {
	return (record?.holds ?? []).flatMap(hold => hold.kind === 'pin' ? [hold.owner] : []);
}

function pinnedBy(record: BlobRecord, owner: string): boolean {
	return record.holds.some(hold => hold.kind === 'pin' && hold.owner === owner);
}

function withPin(holds: readonly BlobHold[], owner: string, at: number): readonly BlobHold[] {
	return [...holds, { kind: 'pin', owner, at }];
}

/** The owner's pin added unless it already pins it, the size set and the blob whole; every other hold and field kept. */
function recordAfterPut(current: BlobRecord | undefined, { ref, size }: BlobPutResult, owner: string, at: number): BlobRecord {
	const holds = current?.holds ?? [];
	return {
		...current,
		v: 1,
		ref,
		size,
		whole: true,
		holds: current !== undefined && pinnedBy(current, owner) ? holds : withPin(holds, owner, at),
	};
}

/** With no record, a new one that knows nothing of the pieces yet (`stat` finds out what is here). */
function recordAfterPin(current: BlobRecord | undefined, ref: BlobRef, owner: string, at: number): BlobRecord {
	if (current === undefined) {
		return { v: 1, ref, whole: false, holds: withPin([], owner, at) };
	}
	return pinnedBy(current, owner) ? current : { ...current, holds: withPin(current.holds, owner, at) };
}

/** With no record, a new one holding `cached` that knows nothing of the pieces yet; a record already holding `cached` unchanged. */
function recordAfterCachedHold(current: BlobRecord | undefined, ref: BlobRef, at: number): BlobRecord {
	const cached: BlobHold = { kind: 'cached', at };
	if (current === undefined) {
		return { v: 1, ref, whole: false, holds: [cached] };
	}
	return current.holds.some(hold => hold.kind === 'cached') ? current : { ...current, holds: [...current.holds, cached] };
}

/** With no record, a new one holding `responsible` that knows nothing of the pieces yet; otherwise the `responsible` hold replaced, every other hold kept. */
function recordAfterResponsibleHold(current: BlobRecord | undefined, ref: BlobRef, scope: BlobScope, at: number): BlobRecord {
	const responsible: BlobHold = { kind: 'responsible', at, scope };
	if (current === undefined) {
		return { v: 1, ref, whole: false, holds: [responsible] };
	}
	return { ...current, holds: [...current.holds.filter(hold => hold.kind !== 'responsible'), responsible] };
}

/** With no record, a new one holding `owed` that knows nothing of the pieces yet; a record already holding `owed` unchanged. */
function recordAfterOwedHold(current: BlobRecord | undefined, ref: BlobRef, at: number): BlobRecord {
	const owed: BlobHold = { kind: 'owed', at };
	if (current === undefined) {
		return { v: 1, ref, whole: false, holds: [owed] };
	}
	return current.holds.some(hold => hold.kind === 'owed') ? current : { ...current, holds: [...current.holds, owed] };
}

/** The current record unchanged when there is nothing to release, so `BlobRecordStore.apply` writes nothing. */
function recordAfterOwedRelease(current: BlobRecord | undefined): BlobRecord | undefined {
	if (current === undefined) {
		return undefined;
	}
	const holds = current.holds.filter(hold => hold.kind !== 'owed');
	return holds.length === current.holds.length ? current : { ...current, holds };
}

/** Held for reads and nothing else: the only blobs the cache budget counts and evicts (docs/blobs.md §Lifetime). */
function cacheOnly(record: BlobRecord): boolean {
	return record.holds.length > 0 && record.holds.every(hold => hold.kind === 'cached');
}

/**
 * When the blob was last read here, for the cache budget's eviction order: the record's `lastReadAt`,
 * else the `cached` hold's `at`.
 *
 * The fallback covers the ordinary case rather than an edge one. `touchLastRead` runs at the start of
 * a read and never creates a record, so the read that fetches a blob for the first time finds no
 * record to write `lastReadAt` to — the hold the fetch then takes carries the only time the record
 * has. Reading the record's own `lastReadAt` alone would date every freshly fetched blob to the epoch
 * and evict it ahead of blobs read long ago, which is the cache throwing away exactly what it just
 * paid the network for.
 */
function lastReadOf(record: BlobRecord): number {
	// `?? 0` for the type: every record this is asked about holds `cached` (`cacheOnly`).
	return record.lastReadAt ?? record.holds.find(hold => hold.kind === 'cached')?.at ?? 0;
}

/** The current record unchanged unless `cached` is still its only hold, in which case dropping that hold leaves no holds and `BlobRecordStore.update` deletes it. */
function recordAfterCacheEviction(current: BlobRecord | undefined): BlobRecord | undefined {
	if (current === undefined || !cacheOnly(current)) {
		return current;
	}
	return { ...current, holds: current.holds.filter(hold => hold.kind !== 'cached') };
}

/** Never creates a record: a record deleted while the drain was classifying stays deleted. */
function recordWithDurability(current: BlobRecord | undefined, durability: BlobDurability): BlobRecord | undefined {
	return current === undefined ? undefined : { ...current, durability };
}

function recordAfterUnpin(current: BlobRecord | undefined, owner: string): BlobRecord | undefined {
	if (current === undefined) {
		return undefined;
	}
	const holds = current.holds.filter(hold => !(hold.kind === 'pin' && hold.owner === owner));
	return holds.length === current.holds.length ? current : { ...current, holds };
}

function recordCorrected(current: BlobRecord | undefined, whole: boolean, size: number | undefined): BlobRecord | undefined {
	if (current === undefined || (current.whole === whole && (size === undefined || current.size === size))) {
		return current;
	}
	return size === undefined ? { ...current, whole } : { ...current, whole, size };
}

function recordAfterRead(current: BlobRecord | undefined, at: number): BlobRecord | undefined {
	if (current === undefined || (current.lastReadAt !== undefined && at - current.lastReadAt <= LAST_READ_RESOLUTION_MS)) {
		return current;
	}
	return { ...current, lastReadAt: at };
}

function subscribe<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
