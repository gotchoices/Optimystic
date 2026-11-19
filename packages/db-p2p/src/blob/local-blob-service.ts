import {
	BlobUnavailableError,
	buildBlob,
	defaultBlobDigest,
	parseBlobRef,
	readBlob,
	rootPieceId,
	walkBlobPieces,
	type BlobDigest,
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
 * asks another machine. Announcing and durability (`feat-a-referenced-blob-is-copied-to-its-cohort`)
 * are a later ticket; their entry points say so.
 */
export class LocalBlobService implements BlobService {
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

	constructor(init: LocalBlobServiceInit) {
		this.pieces = init.pieces;
		this.records = new BlobRecordStore(init.kv);
		this.digest = init.digest ?? defaultBlobDigest();
		this.source = localPieceSource(init.pieces);
		this.sweepDelayMs = init.sweepDelayMs ?? DEFAULT_SWEEP_DELAY_MS;
		this.now = init.now ?? Date.now;
		this.setTimer = init.setTimer ?? armUnrefTimer;
		this.sweeper = new PieceSweeper({ pieces: this.pieces, records: this.records, gate: this.gate, inProgress: this.inProgress, digest: this.digest });
		this.fetchDoor = {
			source: this.source,
			digest: this.digest,
			holdCached: ref => this.holdCached(ref),
			storePiece: (ref, id, bytes) => this.storeFetchedPiece(ref, id, bytes),
			markWhole: (ref, size) => this.correctRecord(ref, true, size),
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
	 * calls this first. `durability` is left absent until `feat-a-referenced-blob-is-copied-to-its-cohort`.
	 * A record found wrong about whether the blob is whole is corrected (`record:corrected`). A malformed
	 * tree throws BlobCorruptError.
	 */
	async stat(ref: BlobRef, _options: { probe?: boolean } = {}): Promise<BlobStat> {
		const record = await this.records.get(ref);
		if (!(await this.pieces.has(rootPieceId(ref)))) {
			// Also how a node restarted on a memory piece store over a persistent key-value store reports honestly.
			if (record?.whole === true) {
				await this.correctRecord(ref, false);
			}
			return { ref, size: record?.size, locality: 'unknown', heldBytes: 0 };
		}
		if (record?.whole === true && record.size !== undefined) {
			return { ref, size: record.size, locality: 'here', heldBytes: record.size };
		}
		const census = await this.census(ref, record?.size);
		if (census.whole) {
			await this.correctRecord(ref, true, census.size);
		}
		return { ref, size: census.size, locality: census.whole ? 'here' : 'partial', heldBytes: census.heldBytes };
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
		if ((await this.stat(ref)).locality !== 'here') {
			throw new BlobUnavailableError(ref, 'cohort-unreachable');
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
	 * NOTE: reads every record, which is acceptable for the start-up enumeration this serves. If the
	 * record count ever makes start-up slow, keep an index of the hold kinds each record carries.
	 */
	async responsibleRefs(): Promise<BlobRef[]> {
		const refs: BlobRef[] = [];
		for (const ref of await this.records.listRefs()) {
			if (responsibleHoldOf(await this.readableRecord(ref)) !== undefined) {
				refs.push(ref);
			}
		}
		return refs;
	}

	async announce(_ref: BlobRef, _scope: BlobScope): Promise<void> {
		throw new Error('announcing a blob to its cohort is not built yet (feat-a-referenced-blob-is-copied-to-its-cohort)');
	}

	/** Never fires: this service fetches nothing. `NodeBlobService.onProgress` reports the fetches it starts. */
	onProgress(listener: (event: BlobProgressEvent) => void): () => void {
		return subscribe(this.progressListeners, listener);
	}

	/** Nothing reports durability until `feat-a-referenced-blob-is-copied-to-its-cohort`. */
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void {
		return subscribe(this.durabilityListeners, listener);
	}

	// NOTE: eviction of cached blobs (`feat-unreferenced-blobs-are-reclaimed`) must skip a blob with a
	// fetch session in flight: a fetch stores pieces only under this hold, and a record deleted under
	// it would leave the fetch's later pieces unprotected from the next sweep.
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
