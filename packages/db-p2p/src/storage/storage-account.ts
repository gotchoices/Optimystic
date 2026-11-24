import type { IPieceStore } from '../blob/piece-store.js';
import type { IRawStorage } from './i-raw-storage.js';
import type { NodeStorage } from './node-storage.js';
import { blockStoreCountsPieces } from './store-coverage.js';
import { createLogger } from '../logger.js';

const log = createLogger('storage:account');

/** Default lifetime (ms) of the memoized scan. `0` disables caching. */
const DEFAULT_USED_BYTES_CACHE_TTL_MS = 60_000;

/**
 * How much of this machine the operator gave the network, and the two seams the memoized
 * measurement is tested through. `NodeOptions.storageAllotment`.
 */
export interface StorageAllotmentOptions {
	/**
	 * How many bytes of this machine the operator gave the network. Absent means "as much as the
	 * disk has", and then the effective total is whatever the backend reports. Anything but an
	 * integer above 0 throws at node construction rather than being clamped.
	 */
	bytes?: number;

	/**
	 * Lifetime (ms) of the memoized scan. Default {@link DEFAULT_USED_BYTES_CACHE_TTL_MS} (60_000);
	 * `0` disables caching, so every call scans (the opt-out tests use). The cached value may lag
	 * reality by up to the TTL; that staleness is acceptable because the consumer (ring selection)
	 * is EWMA-smoothed, dead-banded, and gated by a 10-minute dwell — see `docs/repository.md`.
	 */
	usedBytesCacheTtlMs?: number;

	/**
	 * Injectable clock (Unix ms), used only for the memoization TTL. Defaults to `Date.now`;
	 * mirrors `RingSelector`'s injectable clock so TTL expiry is testable without sleeping on wall
	 * time.
	 */
	now?: () => number;
}

/**
 * What one node may store and what it has stored, as of one scan. Three of the five figures are
 * optional because a node genuinely may not know them: an operator that configured no allotment and
 * a backend that cannot ask its platform how much room is left leave the total unknown, and
 * {@link StorageAccount}'s consumers are required to say what they do in that case rather than
 * substituting a number (see `RingSelector`).
 */
export interface StorageCapacity {
	/** The operator's allotment, absent when none was configured. */
	readonly allotmentBytes?: number;
	/**
	 * What this location will hold at all: the measured use plus the free space the backend reports.
	 * Absent when the backend reports no free space, or the read failed on this scan.
	 */
	readonly locationBytes?: number;
	/** The smaller of the two above over whichever are present; absent when neither is. */
	readonly totalBytes?: number;
	/**
	 * What was measured, unclamped; 0 when nothing can be measured. A node over its allotment
	 * reports MORE used than its total, which is the signal a consumer acts on — so every consumer
	 * must tolerate `usedBytes > totalBytes`.
	 */
	readonly usedBytes: number;
	/** `max(0, totalBytes - usedBytes)`; absent exactly when {@link totalBytes} is. */
	readonly availableBytes?: number;
}

/**
 * The effective total: the smaller of the two figures over whichever are present, `undefined` when
 * neither is. An allotment larger than the disk is bounded by the disk, so an operator's
 * over-promise is never believed; a disk larger than the allotment is bounded by the allotment, so
 * the node keeps to what it was given.
 */
export function effectiveTotalBytes(allotmentBytes?: number, locationBytes?: number): number | undefined {
	if (allotmentBytes === undefined) return locationBytes;
	if (locationBytes === undefined) return allotmentBytes;
	return Math.min(allotmentBytes, locationBytes);
}

/** One scan's figures, memoized together so they can never come from different moments. */
interface StorageScan {
	usedBytes: number;
	/** Absent when the backend reports no free space, or the read failed on this scan — never 0. */
	locationBytes: number | undefined;
}

/**
 * The one accounting of a node's disk: how many bytes the operator gave it, how many its location
 * will still hold, how many it has used, and the effective total those first two imply. Built once
 * per node on either role, so ring selection, the blob cache budget and an operator's dashboard all
 * read ONE measurement rather than each forming its own opinion.
 *
 * `usedBytes` is the block store's `getApproximateBytesUsed` plus the piece store's `bytesUsed()`,
 * the latter left out when {@link blockStoreCountsPieces} says the block store already measured the
 * pieces. That one figure is the whole of what the node stores — including its key-value store and
 * its transaction state, which report no bytes of their own — because every platform factory has
 * asserted its three stores share the location the block store measures whole
 * (`assertOneMeasuredLocation`, `packages/db-p2p/docs/storage.md` §8).
 *
 * **Cost and cadence.** One {@link capacity} call costs one block-store scan (a directory walk, a
 * `PRAGMA`, an origin estimate or a key iteration, depending on backend), one free-space call, and
 * on a hand-built or memory storage the piece store's figure — all behind one memo of
 * `usedBytesCacheTtlMs` (default 60 s) with single-flight, because ring selection asks several
 * times per operation.
 */
export class StorageAccount {
	private readonly blocks: IRawStorage;
	/** The piece store whose figure is added to the block store's; undefined when the block store counts it. */
	private readonly uncountedPieces: IPieceStore | undefined;
	private readonly allotmentBytes: number | undefined;
	private readonly ttlMs: number;
	private readonly now: () => number;
	/** Memoized scan; undefined until the first scan resolves, then re-armed each miss. */
	private scanCache: { value: StorageScan; expiresAt: number } | undefined;
	/** In-flight scan Promise so concurrent misses share one scan (single-flight). */
	private inFlightScan: Promise<StorageScan> | undefined;

	constructor(storage: NodeStorage, options: StorageAllotmentOptions = {}) {
		this.blocks = storage.blocks;
		// Fixed at construction, as both identities are: the decision is made once.
		this.uncountedPieces = blockStoreCountsPieces(storage.blocks, storage.pieces) ? undefined : storage.pieces;
		this.allotmentBytes = options.bytes;
		this.ttlMs = options.usedBytesCacheTtlMs ?? DEFAULT_USED_BYTES_CACHE_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
	}

	async capacity(): Promise<StorageCapacity> {
		const { usedBytes, locationBytes } = await this.cachedScan();
		const totalBytes = effectiveTotalBytes(this.allotmentBytes, locationBytes);
		return {
			allotmentBytes: this.allotmentBytes,
			locationBytes,
			totalBytes,
			usedBytes,
			// Floored, where `usedBytes` is not: a node over its allotment has nothing available,
			// and a negative figure would read as room.
			availableBytes: totalBytes === undefined ? undefined : Math.max(0, totalBytes - usedBytes)
		};
	}

	/**
	 * The scan behind a short TTL cache + single-flight. Within the TTL a cached value is returned;
	 * on a cold/expired cache exactly one scan runs even under concurrent callers, and the result is
	 * memoized until `now() + ttl`. A rejected scan is neither cached nor left wedged in the
	 * single-flight slot, so the next call retries.
	 */
	private async cachedScan(): Promise<StorageScan> {
		// Caching disabled: every call scans (the opt-out tests use).
		if (this.ttlMs <= 0) {
			return this.scan();
		}

		if (this.scanCache !== undefined && this.now() < this.scanCache.expiresAt) {
			return this.scanCache.value;
		}

		// Single-flight: concurrent misses share one scan instead of launching several.
		if (this.inFlightScan !== undefined) {
			return this.inFlightScan;
		}

		const scan = this.scan()
			.then((value) => {
				this.scanCache = { value, expiresAt: this.now() + this.ttlMs };
				return value;
			})
			.finally(() => {
				// Clear on both resolve and reject: a failed scan must not wedge the slot.
				this.inFlightScan = undefined;
			});

		this.inFlightScan = scan;
		return scan;
	}

	/** One scan: every figure is measured together, and a rejection of the use reads rejects the scan. */
	private async scan(): Promise<StorageScan> {
		const [blockBytes, pieceBytes, freeBytes] = await Promise.all([
			this.blocks.getApproximateBytesUsed?.(),
			this.uncountedPieces?.bytesUsed(),
			this.freeBytes()
		]);
		// Floored because a backend that reported a negative figure would otherwise make the
		// location look larger than it is (the location figure adds the free space to this one).
		const usedBytes = Math.max(0, (blockBytes ?? 0) + (pieceBytes ?? 0));
		return { usedBytes, locationBytes: freeBytes === undefined ? undefined : usedBytes + freeBytes };
	}

	/**
	 * The location's free space, or undefined when this backend reports none. A rejection is caught
	 * and logged — once, since this runs once per scan — and leaves the location unknown for that
	 * scan rather than reading as 0: 0 means "full", and a transient failure read as full would make
	 * a node shed responsibility it did not need to shed (`IRawStorage.getApproximateBytesFree`).
	 */
	private async freeBytes(): Promise<number | undefined> {
		if (typeof this.blocks.getApproximateBytesFree !== 'function') return undefined;
		try {
			return await this.blocks.getApproximateBytesFree();
		} catch (err) {
			log('free-space read failed; this scan leaves the location figure unknown: %e', err);
			return undefined;
		}
	}
}
