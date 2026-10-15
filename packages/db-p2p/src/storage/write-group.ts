import { createLogger } from '../logger.js';
import { armUnrefTimer } from '../unref-timer.js';

const log = createLogger('write-group');

/**
 * Thrown by every write and flush of a {@link WriteGroup} after one of its commits rejected. The
 * rejection is in `cause`. Rule 5 of the flush contract on `RawStoreDriver.flush`: a retried sync
 * can report success for data the operating system already dropped, so a store that lost a
 * commit refuses everything until it is reopened.
 */
export class StoreFailedError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`store failed: a commit of its writes rejected (${reason}); every later write and flush is refused until the store is reopened`);
		this.name = 'StoreFailedError';
		this.cause = cause;
	}
}

/** One write of a batch. `value` absent means delete. */
export interface WriteGroupEntry<K> {
	readonly key: K;
	readonly value?: Uint8Array;
}

/**
 * Applies one sealed batch, in order, atomically, as durably as the store promises, before
 * resolving. A rejection latches the group failed.
 */
export type CommitWriteGroup<K> = (entries: readonly WriteGroupEntry<K>[]) => Promise<void>;

/** Arms a one-shot timer and returns its cancel; defaults to `armUnrefTimer`, injected by tests. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface WriteGroupOptions {
	/**
	 * How long the first write of an open batch may wait for a `flush()` before the group flushes
	 * itself, so a write made outside any group never sits in memory for ever. Default 1000 ms.
	 */
	idleFlushMs?: number;
	setTimer?: SetTimer;
}

/** What the overlay holds for a key: the bytes a write put, or `null` for a delete not yet committed. */
export type OverlayValue = Uint8Array | null;

interface OverlayEntry<K> {
	readonly key: K;
	readonly value: OverlayValue;
	/** The sequence of the batch holding this write; the overlay entry is dropped when that batch commits. */
	readonly seq: number;
}

interface OpenEntry<K> {
	readonly canonical: string;
	readonly entry: WriteGroupEntry<K>;
}

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (err: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const DEFAULT_IDLE_FLUSH_MS = 1000;

/**
 * The key-agnostic half of group commit: writes are recorded in memory and resolve at once, and
 * `flush()` hands everything recorded so far to one `commit` call. `WriteGroupDriver` layers the
 * block-storage keys on it; `FileKVStore` uses it over plain string keys.
 *
 * Two structures. The **overlay** maps each written key to its newest write (or a delete), so a
 * read can be served from memory until the write reaches the store. The **open batch** is the list
 * of writes, in the order they resolved, that the next `flush()` seals. Batches commit one at a
 * time, in sequence, which is what makes what survives a crash a prefix of the resolved writes
 * (rule 3 of the flush contract on `RawStoreDriver.flush`).
 *
 * Each overlay entry carries the sequence of the batch that holds it. When that batch's commit
 * resolves, exactly the entries of that sequence are dropped: a key written again after the batch
 * was sealed belongs to a later batch and stays in the overlay, so a read never falls through to
 * content older than a write that has already resolved.
 *
 * Reads are the owner's business: consult {@link lookup} before the store, and take listing
 * snapshots from {@link entries} BEFORE awaiting the store, since a commit resolving in between
 * drops entries the store listing was taken without.
 */
export class WriteGroup<K> {
	// NOTE: the overlay is bounded by the groups not yet flushed, and `StorageRepo` flushes every
	// group, so today it holds at most the writes of the groups in flight plus whatever the idle
	// timer has not yet flushed. A background-flush mode that holds groups back for a window
	// (`durability-window-scales-with-cohort-size`) must bound it, by flushing on size as well as
	// on time. The listing merges in `WriteGroupDriver` scan the whole map, which is fine at that
	// size and would not be at an unbounded one.
	private readonly overlay = new Map<string, OverlayEntry<K>>();
	private open: OpenEntry<K>[] = [];
	/** The sequence the open batch takes when it is sealed. */
	private openSeq = 1;
	/** The commit running now, if any. */
	private inFlight: Promise<void> | undefined;
	/** The flush waiting for {@link inFlight} to settle before it seals the open batch. */
	private sealOnSettle: Deferred | undefined;
	private fault: { cause: unknown } | undefined;
	private cancelIdleFlush: (() => void) | undefined;
	private readonly idleFlushMs: number;
	private readonly setTimer: SetTimer;

	constructor(
		private readonly canonical: (key: K) => string,
		private readonly commit: CommitWriteGroup<K>,
		options: WriteGroupOptions = {},
	) {
		this.idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
		this.setTimer = options.setTimer ?? armUnrefTimer;
	}

	/** True once a commit rejected; every write and flush then throws {@link StoreFailedError}. */
	get failed(): boolean {
		return this.fault !== undefined;
	}

	/** Throws {@link StoreFailedError} when the group has failed, so an owner can refuse before reading. */
	throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	/** Record a put. Resolves at once for the owner: the write is visible to every later read through {@link lookup}. */
	put(key: K, value: Uint8Array): void {
		this.record(key, value);
	}

	/** Record a delete, which hides the key from reads until the batch commits and the store no longer holds it. */
	delete(key: K): void {
		this.record(key, null);
	}

	/**
	 * What the overlay holds for the key: bytes, `null` for a delete not yet committed, or
	 * `undefined` when it holds nothing and the store is to be asked.
	 */
	lookup(key: K): OverlayValue | undefined {
		return this.overlay.get(this.canonical(key))?.value;
	}

	/**
	 * Every key the overlay holds, with what it holds. Synchronous and over the live map: an owner
	 * merging a listing takes what it needs from this before awaiting the store, and never awaits
	 * while iterating.
	 */
	*entries(): IterableIterator<readonly [K, OverlayValue]> {
		for (const held of this.overlay.values()) {
			yield [held.key, held.value];
		}
	}

	/**
	 * Make every write recorded before this call durable, by committing the open batch, and resolve
	 * when that commit has. Rules 4 and 5 of the flush contract on `RawStoreDriver.flush`:
	 *
	 * - Nothing recorded and no commit in flight: resolves at once, so a group that wrote nothing
	 *   costs no sync.
	 * - Nothing recorded while a commit is in flight: waits for it, since its batch holds every write
	 *   recorded before this call.
	 * - Writes recorded while a commit is in flight: waits for it, then seals the open batch and
	 *   commits that, so every flush arriving while one commit runs shares the next.
	 * - A rejected commit latches the group failed; this and every later flush reject with
	 *   {@link StoreFailedError}, and the overlay keeps serving what the store never took.
	 */
	flush(): Promise<void> {
		if (this.fault) return Promise.reject(new StoreFailedError(this.fault.cause));
		if (this.open.length === 0) return this.inFlight ?? Promise.resolve();
		if (this.inFlight) return this.sealAfterInFlight();
		return this.sealAndCommit();
	}

	/** Flush once more and cancel the idle timer. The owner closes its store after this resolves. */
	async close(): Promise<void> {
		this.disarmIdleFlush();
		await this.flush();
		this.disarmIdleFlush();
	}

	private record(key: K, value: OverlayValue): void {
		this.throwIfFailed();
		const canonical = this.canonical(key);
		if (this.open.length === 0) this.armIdleFlush();
		this.overlay.set(canonical, { key, value, seq: this.openSeq });
		this.open.push({ canonical, entry: value === null ? { key } : { key, value } });
	}

	/** Seal the open batch and commit it. Precondition: no commit in flight. */
	private sealAndCommit(): Promise<void> {
		this.disarmIdleFlush();
		const batch = this.open;
		const seq = this.openSeq;
		this.open = [];
		this.openSeq += 1;
		const commit = this.runCommit(batch, seq);
		this.inFlight = commit;
		return commit;
	}

	private async runCommit(batch: readonly OpenEntry<K>[], seq: number): Promise<void> {
		try {
			await this.commit(batch.map(open => open.entry));
			this.dropCommitted(batch, seq);
		} catch (err) {
			// A backend that has already latched itself throws its own StoreFailedError; the group's
			// cause is the fault underneath it, not a wrapper naming a wrapper.
			this.fault ??= { cause: err instanceof StoreFailedError ? err.cause : err };
			throw new StoreFailedError(this.fault.cause);
		} finally {
			// Cleared before this promise settles, so every waiter on it finds no commit in flight.
			this.inFlight = undefined;
		}
	}

	/** Drop the overlay entries the committed batch holds, leaving any a later write replaced. */
	private dropCommitted(batch: readonly OpenEntry<K>[], seq: number): void {
		for (const { canonical } of batch) {
			if (this.overlay.get(canonical)?.seq === seq) this.overlay.delete(canonical);
		}
	}

	/**
	 * One waiter per in-flight commit: every flush arriving while it runs resolves after the ONE
	 * commit sealed once it settles. That seal is a plain `flush()`, so a flush that arrived in the
	 * instant between the commit settling and this continuation running, and sealed the batch
	 * itself, is simply waited for.
	 */
	private sealAfterInFlight(): Promise<void> {
		if (!this.sealOnSettle) {
			const waiter = deferred();
			this.sealOnSettle = waiter;
			this.inFlight!.then(
				() => {
					this.sealOnSettle = undefined;
					this.flush().then(waiter.resolve, waiter.reject);
				},
				(err: unknown) => {
					this.sealOnSettle = undefined;
					waiter.reject(err);
				},
			);
		}
		return this.sealOnSettle.promise;
	}

	private armIdleFlush(): void {
		this.cancelIdleFlush = this.setTimer(() => {
			this.cancelIdleFlush = undefined;
			this.flush().catch((err: unknown) => {
				log.error('idle-flush-failed: %s', err instanceof Error ? err.message : String(err));
			});
		}, this.idleFlushMs);
	}

	private disarmIdleFlush(): void {
		this.cancelIdleFlush?.();
		this.cancelIdleFlush = undefined;
	}
}
