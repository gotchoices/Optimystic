import { createLogger } from '../logger.js';
import { armUnrefTimer } from '../unref-timer.js';
import { deferred, type Deferred } from '../deferred.js';
import type { FlushOptions } from './store-durability.js';

const log = createLogger('write-group');

/**
 * Thrown by every write and flush of a {@link WriteGroup} after one of its commits, or a sync it
 * deferred, rejected. The rejection is in `cause`. Rule 5 of the flush contract on
 * `RawStoreDriver.flush`: a retried sync can report success for data the operating system already
 * dropped, so a store that lost a commit refuses everything until it is reopened.
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

/** What a resolved commit hands back. */
export interface CommittedBatch {
	/**
	 * Settles once the batch survives every crash the store's `durability` names. Batches' `durable`
	 * settle in commit order. A rejection is a storage fault: the group latches failed on it.
	 */
	readonly durable: Promise<void>;
}

/** The store under a {@link WriteGroup}: one write, `commit`, and the hasten that makes committed batches durable. */
export interface WriteGroupSink<K> {
	/**
	 * Apply the sealed batch, in order, atomically, so that it survives a crash of this process, and
	 * resolve. `syncWithinMs` is how long the batch may then wait for the sync that makes it survive
	 * every crash the store's `durability` names: 0 means before resolving, with `durable` already
	 * settled and every earlier batch synced too. A sink that cannot defer treats every value as 0.
	 * A rejection latches the group failed.
	 */
	commit(entries: readonly WriteGroupEntry<K>[], options: { readonly syncWithinMs: number }): Promise<CommittedBatch>;
	/** Hasten: resolve once every batch whose commit has resolved survives every crash `durability` names. */
	sync(): Promise<void>;
}

/** Arms a one-shot timer and returns its cancel; defaults to `armUnrefTimer`, injected by tests. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface WriteGroupOptions {
	/**
	 * How long the first write of an open batch may wait for a `flush()` before the group flushes
	 * itself, strictly, so a write made outside any group never sits in memory for ever. Default
	 * {@link DEFAULT_IDLE_FLUSH_MS}.
	 */
	idleFlushMs?: number;
	/**
	 * The most value bytes the overlay may hold for writes not yet durable, the open batch included
	 * (a delete counts 0, a replaced value's bytes are given back), before a seal is committed with
	 * `syncWithinMs` 0 whatever its flushes asked. Default {@link DEFAULT_MAX_UNSYNCED_BYTES}.
	 */
	maxUnsyncedBytes?: number;
	setTimer?: SetTimer;
}

/** What the overlay holds for a key: the bytes a write put, or `null` for a delete not yet durable. */
export type OverlayValue = Uint8Array | null;

interface OverlayEntry<K> {
	readonly key: K;
	readonly value: OverlayValue;
	/** The sequence of the batch holding this write; the overlay entry is dropped when that batch is durable. */
	readonly seq: number;
}

interface OpenEntry<K> {
	readonly canonical: string;
	readonly entry: WriteGroupEntry<K>;
}

/** One `flush()` call: by when its writes must be durable, and whether it waits for that. */
interface FlushRequest {
	readonly deadline: number;
	/** `withinMs` absent or 0: resolves only once the writes are durable. Relaxed otherwise: resolves once they are committed. */
	readonly strict: boolean;
}

/** A flush waiting for the commit in flight to settle before the open batch is sealed with its deadline among the rest. */
interface SealWaiter {
	readonly request: FlushRequest;
	readonly waiter: Deferred;
}

/** A batch whose commit has resolved and whose `durable` has not yet settled. */
interface CommittedRecord {
	readonly seq: number;
	/** Resolved when the batch is durable; rejected with `StoreFailedError` when the group latches failed first. */
	readonly settled: Deferred;
}

/** The two points a sealed batch settles at: a relaxed flush resolves on the first, a strict one on the second. */
interface Settlement {
	readonly committed: Promise<void>;
	readonly durable: Promise<void>;
}

/** {@link WriteGroupOptions.idleFlushMs}'s default. */
export const DEFAULT_IDLE_FLUSH_MS = 1000;
/** {@link WriteGroupOptions.maxUnsyncedBytes}'s default: 64 MiB. */
export const DEFAULT_MAX_UNSYNCED_BYTES = 64 * 1024 * 1024;

const byteLength = (value: OverlayValue | undefined): number => value ? value.byteLength : 0;
const noop = (): void => undefined;

/**
 * The key-agnostic half of group commit: writes are recorded in memory and resolve at once, and
 * `flush()` hands everything recorded so far to one `commit` of the {@link WriteGroupSink}.
 * `WriteGroupDriver` layers the block-storage keys on it; `FileKVStore` uses it over plain string
 * keys.
 *
 * Two structures. The **overlay** maps each written key to its newest write (or a delete), so a
 * read can be served from memory until the write is durable in the store. The **open batch** is
 * the list of writes, in the order they resolved, that the next `flush()` seals. Batches commit one
 * at a time, in sequence, which is what makes what survives a crash a prefix of the resolved writes
 * (rule 3 of the flush contract on `RawStoreDriver.flush`).
 *
 * A flush has a deadline, `Date.now() + withinMs`, and is **strict** when `withinMs` is absent or 0
 * and **relaxed** otherwise. The flushes that share one sealed batch each contribute their deadline,
 * and the batch is committed with `syncWithinMs` the time left to the earliest of them, so the sink
 * may defer the sync of a batch every flush of which allowed it. A relaxed flush resolves when the
 * commit has; a strict one when the batch is durable. With nothing to seal, a strict flush asks the
 * sink to `sync()` whatever is committed and not yet durable, and a relaxed one resolves at once.
 *
 * Each overlay entry carries the sequence of the batch that holds it. When that batch's `durable`
 * settles, exactly the entries of that sequence are dropped: a key written again after the batch
 * was sealed belongs to a later batch and stays in the overlay, so a read never falls through to
 * content older than a write that has already resolved, nor to a store that a crash could still
 * roll back behind the write.
 *
 * Reads are the owner's business: consult {@link lookup} before the store, and take listing
 * snapshots from {@link entries} BEFORE awaiting the store, since a batch becoming durable in
 * between drops entries the store listing was taken without.
 */
export class WriteGroup<K> {
	// NOTE: the overlay holds every write not yet durable: the open batch, the batch in flight, and
	// every committed batch whose sync the sink is still allowed to defer. It is bounded by
	// `maxUnsyncedBytes` — a seal that would leave more than that unsynced commits with `syncWithinMs`
	// 0 — so it holds at most that many value bytes plus the batch in flight. The listing merges in
	// `WriteGroupDriver` scan the whole map, which is fine at that size and would not be at an
	// unbounded one.
	private readonly overlay = new Map<string, OverlayEntry<K>>();
	private open: OpenEntry<K>[] = [];
	/** The sequence the open batch takes when it is sealed. */
	private openSeq = 1;
	/** Value bytes the overlay holds, which is what `maxUnsyncedBytes` bounds. */
	private unsyncedBytes = 0;
	/** The commit running now, if any. */
	private inFlight: Promise<void> | undefined;
	/** The flushes waiting for {@link inFlight} to settle before the open batch is sealed with their deadlines. */
	private sealWaiters: SealWaiter[] | undefined;
	/** Batches committed and not yet durable, in commit order. */
	private readonly notYetDurable: CommittedRecord[] = [];
	/** The sink's `sync()` running now, shared by every strict flush that hastens meanwhile. */
	private syncInFlight: Promise<void> | undefined;
	private fault: { cause: unknown } | undefined;
	private cancelIdleFlush: (() => void) | undefined;
	private readonly idleFlushMs: number;
	private readonly maxUnsyncedBytes: number;
	private readonly setTimer: SetTimer;

	constructor(
		private readonly canonical: (key: K) => string,
		private readonly sink: WriteGroupSink<K>,
		options: WriteGroupOptions = {},
	) {
		this.idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
		if (!(this.idleFlushMs >= 0) || !Number.isFinite(this.idleFlushMs)) {
			throw new RangeError(`idleFlushMs must be a finite number of milliseconds, got ${this.idleFlushMs}`);
		}
		this.maxUnsyncedBytes = options.maxUnsyncedBytes ?? DEFAULT_MAX_UNSYNCED_BYTES;
		if (!(this.maxUnsyncedBytes > 0)) {
			throw new RangeError(`maxUnsyncedBytes must be positive, got ${this.maxUnsyncedBytes}`);
		}
		this.setTimer = options.setTimer ?? armUnrefTimer;
	}

	/** True once a commit or a deferred sync rejected; every write and flush then throws {@link StoreFailedError}. */
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

	/** Record a delete, which hides the key from reads until the key is durably gone from the store. */
	delete(key: K): void {
		this.record(key, null);
	}

	/**
	 * What the overlay holds for the key: bytes, `null` for a delete not yet durable, or
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
	 * Make every write recorded before this call durable, at once or within `options.withinMs`, by
	 * committing the open batch. Rules 4 and 5 of the flush contract on `RawStoreDriver.flush`:
	 *
	 * - Nothing recorded and no commit in flight: a relaxed flush resolves at once; a strict one
	 *   resolves at once when every committed batch is durable, and otherwise has the sink `sync()`
	 *   and resolves when the latest committed batch is durable.
	 * - Nothing recorded while a commit is in flight: waits for it, since its batch holds every write
	 *   recorded before this call, then as above.
	 * - Writes recorded: seals the open batch, after the commit in flight if there is one, and commits
	 *   it with the earliest deadline of every flush sharing the seal; each resolves by its own kind.
	 * - A rejected commit latches the group failed; this and every later flush reject with
	 *   {@link StoreFailedError}, and the overlay keeps serving what the store never took.
	 */
	flush(options?: FlushOptions): Promise<void> {
		const withinMs = options?.withinMs ?? 0;
		if (!(withinMs >= 0) || !Number.isFinite(withinMs)) {
			throw new RangeError(`withinMs must be a finite number of milliseconds at or above 0, got ${withinMs}`);
		}
		return this.settle({ deadline: Date.now() + withinMs, strict: withinMs === 0 });
	}

	/**
	 * Resolves once every write covered by a flush that resolved before this call is durable: the
	 * latest committed batch's `durable`, which covers every earlier one since they settle in order.
	 * Never hastens a sync. Rejects with {@link StoreFailedError} once the group has failed.
	 */
	whenDurable(): Promise<void> {
		if (this.fault) return Promise.reject(new StoreFailedError(this.fault.cause));
		const latest = this.notYetDurable[this.notYetDurable.length - 1];
		return latest ? latest.settled.promise : Promise.resolve();
	}

	/** Flush strictly once more, which syncs everything pending, and cancel the idle timer. The owner closes its store after this resolves. */
	// NOTE: a write recorded after close() resolves is not refused: it sits in the overlay and the
	// open batch with no idle timer, reachable only by another flush() or close(). No caller writes to
	// a closed store today (`CachedStoreDriver.close` does not refuse either); if one ever does, add a
	// closed state here that makes `record` throw, rather than re-arming the timer.
	async close(): Promise<void> {
		this.disarmIdleFlush();
		await this.flush();
		this.disarmIdleFlush();
	}

	private record(key: K, value: OverlayValue): void {
		this.throwIfFailed();
		const canonical = this.canonical(key);
		if (this.open.length === 0) this.armIdleFlush();
		this.unsyncedBytes += byteLength(value) - byteLength(this.overlay.get(canonical)?.value);
		this.overlay.set(canonical, { key, value, seq: this.openSeq });
		this.open.push({ canonical, entry: value === null ? { key } : { key, value } });
	}

	/** Route one flush by what is open and in flight; the doc on {@link flush} lists the cases. */
	private settle(request: FlushRequest): Promise<void> {
		if (this.fault) return Promise.reject(new StoreFailedError(this.fault.cause));
		if (this.open.length > 0) {
			if (this.inFlight) return this.joinNextSeal(request);
			const sealed = this.sealAndCommit([request.deadline]);
			return request.strict ? sealed.durable : sealed.committed;
		}
		if (this.inFlight) {
			return request.strict ? this.inFlight.then(() => this.hastenLatest()) : this.inFlight;
		}
		return request.strict ? this.hastenLatest() : Promise.resolve();
	}

	/** Seal the open batch and commit it. Precondition: no commit in flight. */
	private sealAndCommit(deadlines: readonly number[]): Settlement {
		this.disarmIdleFlush();
		const batch = this.open;
		const seq = this.openSeq;
		this.open = [];
		this.openSeq += 1;
		const durable = deferred();
		const committed = this.runCommit(batch, seq, this.syncWithinFor(deadlines), durable);
		// A seal whose every flush is strict awaits `durable` alone, which the commit's rejection also
		// reaches, so nothing would observe it on `committed`; this only marks it observed.
		committed.catch(noop);
		this.inFlight = committed;
		return { committed, durable: durable.promise };
	}

	/**
	 * How long the sealed batch may wait for its sync: until the earliest deadline among the flushes
	 * sharing the seal, or not at all when the overlay would otherwise hold more than
	 * `maxUnsyncedBytes` of writes not yet durable.
	 */
	private syncWithinFor(deadlines: readonly number[]): number {
		if (this.unsyncedBytes > this.maxUnsyncedBytes) return 0;
		return Math.max(0, Math.min(...deadlines) - Date.now());
	}

	private async runCommit(batch: readonly OpenEntry<K>[], seq: number, syncWithinMs: number, durable: Deferred): Promise<void> {
		try {
			const committed = await this.sink.commit(batch.map(open => open.entry), { syncWithinMs });
			this.awaitDurable(batch, seq, committed.durable, durable);
		} catch (err) {
			const failure = this.latch(err);
			durable.reject(failure);
			throw failure;
		} finally {
			// Cleared before this promise settles, so every waiter on it finds no commit in flight.
			this.inFlight = undefined;
		}
	}

	/** Keep the batch readable from the overlay until the sink says it is durable; a rejection latches the group. */
	private awaitDurable(batch: readonly OpenEntry<K>[], seq: number, durable: Promise<void>, settled: Deferred): void {
		const record: CommittedRecord = { seq, settled };
		this.notYetDurable.push(record);
		durable.then(
			() => {
				this.dropDurable(batch, seq);
				const at = this.notYetDurable.indexOf(record);
				if (at >= 0) this.notYetDurable.splice(at, 1);
				settled.resolve();
			},
			(err: unknown) => this.latchDurableFailure(err),
		);
	}

	/** Drop the overlay entries the durable batch holds, leaving any a later write replaced. */
	private dropDurable(batch: readonly OpenEntry<K>[], seq: number): void {
		for (const { canonical } of batch) {
			const held = this.overlay.get(canonical);
			if (held?.seq === seq) {
				this.overlay.delete(canonical);
				this.unsyncedBytes -= byteLength(held.value);
			}
		}
	}

	/**
	 * A strict flush with nothing to seal: have the sink sync what is committed, and resolve once the
	 * latest committed batch is durable. Nothing committed and not yet durable means nothing to do.
	 */
	private hastenLatest(): Promise<void> {
		if (this.fault) return Promise.reject(new StoreFailedError(this.fault.cause));
		const latest = this.notYetDurable[this.notYetDurable.length - 1];
		if (!latest) return Promise.resolve();
		return Promise.all([this.syncOnce(), latest.settled.promise]).then(() => undefined);
	}

	/** One `sink.sync()` at a time: strict flushes hastening while one runs share it. A rejection latches the group. */
	private syncOnce(): Promise<void> {
		if (!this.syncInFlight) {
			const sync = this.sink.sync().then(
				() => undefined,
				(err: unknown) => { throw this.latch(err); },
			);
			this.syncInFlight = sync.finally(() => { this.syncInFlight = undefined; });
		}
		return this.syncInFlight;
	}

	/**
	 * One waiter list per in-flight commit: every flush arriving while it runs is settled together
	 * once it has, by {@link settleWaiters}.
	 */
	private joinNextSeal(request: FlushRequest): Promise<void> {
		const waiter = deferred();
		if (!this.sealWaiters) {
			const waiters: SealWaiter[] = [];
			this.sealWaiters = waiters;
			this.inFlight!.then(
				() => {
					this.sealWaiters = undefined;
					this.settleWaiters(waiters);
				},
				(err: unknown) => {
					this.sealWaiters = undefined;
					for (const held of waiters) held.waiter.reject(err);
				},
			);
		}
		this.sealWaiters.push({ request, waiter });
		return waiter.promise;
	}

	/**
	 * Runs once the commit the waiters arrived under has settled: the open batch is sealed with every
	 * waiter's deadline, and each waiter resolves by its own kind. A flush that arrived in the instant
	 * between that commit settling and this continuation, and sealed the batch itself, leaves nothing
	 * open; its commit holds the waiters' writes, so each waiter then settles as a flush with nothing
	 * open would.
	 */
	private settleWaiters(waiters: readonly SealWaiter[]): void {
		if (this.open.length > 0 && !this.inFlight && !this.fault) {
			const sealed = this.sealAndCommit(waiters.map(({ request }) => request.deadline));
			for (const { request, waiter } of waiters) {
				(request.strict ? sealed.durable : sealed.committed).then(waiter.resolve, waiter.reject);
			}
			return;
		}
		for (const { request, waiter } of waiters) {
			this.settle(request).then(waiter.resolve, waiter.reject);
		}
	}

	/**
	 * Latch the group failed on its first fault and reject every batch still waiting to be durable,
	 * so no strict flush or `whenDurable()` waits on a sync the store will not make. Returns the
	 * error to throw or reject with.
	 */
	private latch(err: unknown): StoreFailedError {
		// A sink that has already latched itself throws its own StoreFailedError; the group's cause is
		// the fault underneath it, not a wrapper naming a wrapper.
		this.fault ??= { cause: err instanceof StoreFailedError ? err.cause : err };
		const failure = new StoreFailedError(this.fault.cause);
		for (const record of this.notYetDurable.splice(0)) record.settled.reject(failure);
		return failure;
	}

	/**
	 * A sync the sink deferred failed after the flushes it covered had resolved, so no caller is
	 * waiting on the commit to hear of it: latch, and say so once on `write-group:error`. The next
	 * write, flush or `whenDurable()` reports it.
	 */
	private latchDurableFailure(err: unknown): void {
		const first = this.fault === undefined;
		this.latch(err);
		if (first) {
			log.error('durable-failed: %s', err instanceof Error ? err.message : String(err));
		}
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
