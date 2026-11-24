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

/**
 * 256 MiB: a phone's worth, and a CAP rather than the figure. A host with room raises it through
 * `NodeOptions.blobs.cacheBudgetBytes`; what the cache actually gets is the smallest of that cap, a
 * share of the node's allotment, and what the allotment leaves after everything else
 * (`cacheBudgetBytes` in `packages/db-p2p/src/storage/storage-account.ts`).
 */
export const DEFAULT_BLOB_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** What one enforcement did. */
export interface CacheEnforcement {
	/** {@link sizedCacheBytes}, over the cache-only blobs this enforcement enumerated. */
	readonly cachedBytes: number;
	readonly evicted: readonly BlobRef[];
	/** How many blobs the budget would otherwise have evicted but left alone because a read or fetch of them was running. */
	readonly skippedInUse: number;
}

/** What `chooseEvictions` decided. */
export interface CacheEvictionChoice {
	readonly evict: readonly BlobRef[];
	readonly skippedInUse: number;
}

export interface BlobCacheBudgetDeps {
	readonly records: BlobCacheRecords;
	/**
	 * What the cache may take, asked ONCE per enforcement rather than read at construction, so an
	 * allotment the operator lowered — or other use that grew — is seen without a restart
	 * (`cacheBudgetBytes` in `packages/db-p2p/src/storage/storage-account.ts`).
	 *
	 * Given the enforcement's own {@link sizedCacheBytes}, because the rule subtracts the cache's own
	 * bytes from the node's use to see what is left for it, and this pass already has that figure: the
	 * term costs no extra scan, and the budget and the eviction decision see one moment's cache.
	 *
	 * It must ANSWER rather than reject even when the measurement behind it cannot be read: a rejection
	 * rejects the whole enforcement, and an enforcement that does not run is a cache with no bound at
	 * all. `enforcementBudgetBytes` in `libp2p-node-base.ts` falls back to the declared cap.
	 */
	readonly budgetBytes: (cachedBytes: number) => Promise<number>;
	readonly log: Logger;
}

/** An enforcement that did nothing, which is what a stopped budget reports. */
const NOTHING_ENFORCED: CacheEnforcement = { cachedBytes: 0, evicted: [], skippedInUse: 0 };

/**
 * The total of the blobs given whose size this node knows. The unsized ones are left out, which
 * under-counts what the cache really takes — safe only because {@link chooseEvictions} evicts them in
 * the same pass, so the bytes this omits are bytes the node is about to stop holding.
 *
 * Lifted out of `chooseEvictions` so one enforcement computes it once: `runOnce` needs it to ask for
 * the budget (the budget's third term subtracts the cache's own bytes from the node's use) and then
 * hands it back to the choice.
 */
// NOTE: a cache-only blob counts at the blob's full size whether or not every piece is here, which
// over-counts a partly held blob — the direction docs/blobs.md §Lifetime accepts for pieces shared
// between blobs, since it evicts sooner and so uses less storage, not more. While nothing asks for
// byte ranges the over-count is at most the tail of one interrupted download per blob; a caller that
// reads small ranges out of very large blobs would count far more than it holds and evict a cache
// that was never over its real limit. If ranged reads become ordinary, count what is held instead —
// the fetch already knows the bytes it stored — rather than walking each tree, which costs one
// piece-store read per piece per enforcement.
export function sizedCacheBytes(blobs: readonly CachedBlob[]): number {
	return blobs.reduce((total, blob) => total + (blob.bytes ?? 0), 0);
}

/**
 * Which of `blobs` to evict to bring their total within `budgetBytes`, least recently read first
 * (ties by reference ascending, so the choice is deterministic), skipping any `inUse` reports true
 * for. `cachedBytes` is {@link sizedCacheBytes} over the same blobs, computed by the caller. Pure: it
 * reads nothing and writes nothing.
 *
 * A blob whose record carries no size is evicted on its own account, whatever the total, and before
 * the walk: this node holds part of it and never learned how big the whole is, so it cannot bound
 * what it is spending there, and a cost it cannot bound is not one it keeps. Those go first, least
 * recently read among themselves, and then the walk over the sized blobs runs until their total is
 * within budget. A fetch writes the size as soon as it knows it (`BlobFetchStore.markPartial`), so
 * what this reaches is a fetch that never got the blob's root piece and so holds nothing worth
 * keeping, or one a crash caught between that piece arriving and the write. An unsized blob is not
 * the same thing as an empty one: a 0-byte blob's record says `size: 0` and it is counted and walked
 * like any other.
 *
 * A budget the walk cannot reach because every remaining blob is in use leaves the cache over budget;
 * the next enforcement tries again, and nothing retries on a timer.
 */
export function chooseEvictions(blobs: readonly CachedBlob[], cachedBytes: number, budgetBytes: number, inUse: (ref: BlobRef) => boolean): CacheEvictionChoice {
	const ordered = [...blobs].sort(leastRecentlyReadFirst);
	const sized = ordered.filter(isSized);
	const unsized = ordered.filter(blob => !isSized(blob));
	const evict: BlobRef[] = [];
	let skippedInUse = 0;
	/** Whether `blob` was chosen; a blob being read or fetched is left alone and counted as skipped. */
	const choose = (blob: CachedBlob): boolean => {
		if (inUse(blob.ref)) {
			skippedInUse++;
			return false;
		}
		evict.push(blob.ref);
		return true;
	};
	for (const blob of unsized) {
		choose(blob);
	}
	let evictedBytes = 0;
	for (const blob of sized) {
		if (cachedBytes - evictedBytes <= budgetBytes) {
			break;
		}
		if (choose(blob)) {
			evictedBytes += blob.bytes;
		}
	}
	return { evict, skippedInUse };
}

/** A blob whose record carries a size, narrowed so the sized walk can add it up. */
function isSized(blob: CachedBlob): blob is CachedBlob & { readonly bytes: number } {
	return blob.bytes !== undefined;
}

// NOTE: only a read or fetch that pulled something triggers an enforcement, so a blob that becomes
// cache-only when some other hold is released — an `unpin`, or one of the `responsible` and `owed`
// releases `BlobReclaimPass` in `packages/db-p2p/src/blob/reclaim-pass.ts` makes — can leave the cache
// over budget until the next read that fetches or the next restart. If a node is ever seen sitting
// over budget with its reads idle, call `request()` from those releases too.
/**
 * Keeps the blobs held only for reads within a byte budget (docs/blobs.md §Lifetime). Enforced after
 * a read or fetch that pulled anything and once when the node has built its blob service — there is
 * no timer, because the cache grows only through reads that fetch and each of those triggers an
 * enforcement.
 */
export class BlobCacheBudget {
	private readonly records: BlobCacheRecords;
	private readonly budgetBytes: (cachedBytes: number) => Promise<number>;
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
	 * under-enforce. Several calls during one run share the single follow-on. A failing `budgetBytes`,
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
		// Summed, then asked, then chosen — all after the one `cachedBlobs` read above, so the budget's
		// leftover term and the eviction decision see the same cache. A write that lands between them is
		// the pre-existing window the single-flight-with-one-queued-follow-on already covers.
		const cachedBytes = sizedCacheBytes(blobs);
		const budgetBytes = await this.budgetBytes(cachedBytes);
		const { evict, skippedInUse } = chooseEvictions(blobs, cachedBytes, budgetBytes, ref => this.records.inUse(ref));
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
				// `bytes=unsized` rather than 0: the two mean different things here, and the first is why the
				// blob was evicted.
				this.log('cache:evicted ref=%s bytes=%s lastReadAt=%d', ref, blob?.bytes ?? 'unsized', blob?.lastReadAt ?? 0);
			}
		}
		if (evicted.length > 0) {
			await this.records.sweep();
		}
		// `evicted.length` is in the condition because an unsized blob is evicted whatever the total, so a
		// pass that dropped only those would otherwise summarize nothing.
		if (cachedBytes > budgetBytes || evicted.length > 0) {
			this.log('cache:enforced cachedBytes=%d budget=%d evicted=%d skippedInUse=%d', cachedBytes, budgetBytes, evicted.length, skipped);
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
