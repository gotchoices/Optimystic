/**
 * The byte budget over the blobs this machine kept only because it read them (docs/blobs.md
 * §Lifetime): once they take more space than the budget allows, the least recently read of them lose
 * their `cached` hold and the piece sweep removes what no remaining hold needs. Local, and it needs no
 * agreement with anyone.
 *
 * It is independent of the reference pass that releases `responsible` and `owed` holds; the two share
 * the `blob:reclaim` log namespace.
 */

import type { BlobRef } from '@optimystic/db-core';
import type { Logger } from '../logger.js';
import type { BlobCacheRecords, CachedBlob } from './local-blob-service.js';

/** 256 MiB: a phone's worth. A host with room sets more through `NodeOptions.blobs.cacheBudgetBytes`. */
export const DEFAULT_BLOB_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** What one enforcement did. */
export interface CacheEnforcement {
	/** The total of every cache-only blob, before eviction. */
	readonly cachedBytes: number;
	readonly evicted: readonly BlobRef[];
	/** How many blobs the budget would otherwise have evicted but left alone because a read or fetch of them was running. */
	readonly skippedInUse: number;
}

/** What `chooseEvictions` decided. */
export interface CacheEvictionChoice {
	readonly evict: readonly BlobRef[];
	/** The total of every blob given, before eviction. */
	readonly cachedBytes: number;
	readonly skippedInUse: number;
}

export interface BlobCacheBudgetDeps {
	readonly records: BlobCacheRecords;
	readonly budgetBytes: number;
	readonly log: Logger;
}

/** An enforcement that did nothing, which is what a stopped budget reports. */
const NOTHING_ENFORCED: CacheEnforcement = { cachedBytes: 0, evicted: [], skippedInUse: 0 };

/**
 * Which of `blobs` to evict to bring their total within `budgetBytes`, least recently read first
 * (ties by reference ascending, so the choice is deterministic), skipping any `inUse` reports true
 * for. Pure: it reads nothing and writes nothing.
 *
 * A blob with no recorded size contributes 0 bytes and is evicted like any other once the walk
 * reaches it — dropping a blob nobody has read, whose contents this node knows nothing about, is
 * free. A budget the walk cannot reach because every remaining blob is in use leaves the cache over
 * budget; the next enforcement tries again, and nothing retries on a timer.
 */
export function chooseEvictions(blobs: readonly CachedBlob[], budgetBytes: number, inUse: (ref: BlobRef) => boolean): CacheEvictionChoice {
	const cachedBytes = blobs.reduce((total, blob) => total + blob.bytes, 0);
	const evict: BlobRef[] = [];
	let evictedBytes = 0;
	let skippedInUse = 0;
	for (const blob of [...blobs].sort(leastRecentlyReadFirst)) {
		if (cachedBytes - evictedBytes <= budgetBytes) {
			break;
		}
		if (inUse(blob.ref)) {
			skippedInUse++;
			continue;
		}
		evict.push(blob.ref);
		evictedBytes += blob.bytes;
	}
	return { evict, cachedBytes, skippedInUse };
}

// NOTE: only a read or fetch that pulled something triggers an enforcement, so a blob that becomes
// cache-only when some other hold is released — an `unpin`, and the `responsible` and `owed` releases
// `feat-unreferenced-blobs-are-reclaimed` will add — can leave the cache over budget until the next
// read that fetches or the next restart. If a node is ever seen sitting over budget with its reads
// idle, call `request()` from those releases too.
/**
 * Keeps the blobs held only for reads within a byte budget (docs/blobs.md §Lifetime). Enforced after
 * a read or fetch that pulled anything and once when the node has built its blob service — there is
 * no timer, because the cache grows only through reads that fetch and each of those triggers an
 * enforcement.
 */
export class BlobCacheBudget {
	private readonly records: BlobCacheRecords;
	private readonly budgetBytes: number;
	private readonly log: Logger;
	/** The run in flight, absent while none runs. */
	private running: Promise<CacheEnforcement> | undefined;
	/** The one run promised to every call that arrived while `running` ran. */
	private queued: Promise<CacheEnforcement> | undefined;
	private stopping = false;

	constructor(deps: BlobCacheBudgetDeps) {
		this.records = deps.records;
		this.budgetBytes = deps.budgetBytes;
		this.log = deps.log;
	}

	/**
	 * Enumerate the cache-only records, choose, remove each chosen blob's `cached` hold, then sweep
	 * once if anything was evicted.
	 *
	 * Single-flight with one queued follow-on rather than joining the run in flight: that run
	 * enumerated the records before this call's read cached anything, so joining it would
	 * under-enforce. Several calls during one run share the single follow-on. A failing
	 * `releaseCached` or `sweep` rejects this; `request` is the call that logs rather than rejects.
	 */
	enforce(): Promise<CacheEnforcement> {
		if (this.running === undefined) {
			return this.start();
		}
		this.queued ??= this.startAfter(this.running);
		return this.queued;
	}

	/** `void enforce()` with a logged catch, for the call sites that must not wait. */
	request(): void {
		void this.enforce().catch((error: unknown) => this.log('cache:enforce-failed - %e', error));
	}

	/** Refuse further runs and wait for the one in flight, so nothing writes a record or sweeps after the node's blob service has stopped. */
	async stop(): Promise<void> {
		this.stopping = true;
		// The follow-on resolves after the run it waits on, so awaiting it awaits both.
		const inFlight = this.queued ?? this.running;
		await inFlight?.then(noop, noop);
	}

	/** Awaits the run in flight however it ended, then starts the follow-on; `queued` is cleared first so a call during the follow-on queues another. */
	private async startAfter(running: Promise<CacheEnforcement>): Promise<CacheEnforcement> {
		await running.then(noop, noop);
		this.queued = undefined;
		return this.start();
	}

	private start(): Promise<CacheEnforcement> {
		if (this.stopping) {
			return Promise.resolve(NOTHING_ENFORCED);
		}
		const run = this.runOnce().finally(() => {
			if (this.running === run) {
				this.running = undefined;
			}
		});
		this.running = run;
		return run;
	}

	// NOTE: each enforcement reads every blob record (`LocalBlobService.cachedBlobs`). If record counts
	// reach the tens of thousands and enforcement shows up in a profile, keep a running total of
	// cache-only bytes in the record store — the same tripwire `responsibleRefs` and `listPins` carry.
	private async runOnce(): Promise<CacheEnforcement> {
		const blobs = await this.records.cachedBlobs();
		const { evict, cachedBytes, skippedInUse } = chooseEvictions(blobs, this.budgetBytes, ref => this.records.inUse(ref));
		const byRef = new Map(blobs.map(blob => [blob.ref, blob]));
		const evicted: BlobRef[] = [];
		let skipped = skippedInUse;
		for (const ref of evict) {
			// Asked again immediately before the write, so a read that started after `chooseEvictions`
			// ran keeps its blob.
			if (this.records.inUse(ref)) {
				skipped++;
				continue;
			}
			if (await this.records.releaseCached(ref)) {
				const blob = byRef.get(ref);
				evicted.push(ref);
				this.log('cache:evicted ref=%s bytes=%d lastReadAt=%d', ref, blob?.bytes ?? 0, blob?.lastReadAt ?? 0);
			}
		}
		if (evicted.length > 0) {
			await this.records.sweep();
		}
		if (cachedBytes > this.budgetBytes) {
			this.log('cache:enforced cachedBytes=%d budget=%d evicted=%d skippedInUse=%d', cachedBytes, this.budgetBytes, evicted.length, skipped);
		}
		return { cachedBytes, evicted, skippedInUse: skipped };
	}
}

/** Eviction order: least recently read first, ties by reference ascending so the choice is deterministic. */
function leastRecentlyReadFirst(left: CachedBlob, right: CachedBlob): number {
	if (left.lastReadAt !== right.lastReadAt) {
		return left.lastReadAt - right.lastReadAt;
	}
	return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
}

function noop(): void {
	// Waiting for an enforcement to end, not for what it found.
}
