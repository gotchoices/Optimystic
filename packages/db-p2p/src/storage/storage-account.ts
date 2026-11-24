import type { BlobByteRecords, HoldBytes } from '../blob/local-blob-service.js';
import type { IPieceStore } from '../blob/piece-store.js';
import type { BlobHoldKind } from '../blob/blob-record.js';
import type { IRawStorage } from './i-raw-storage.js';
import type { NodeStorage } from './node-storage.js';
import type { StoragePressureThresholds } from './storage-pressure.js';
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
	 * The fractions of the effective total at which this node changes what it does — `reclaimBelow`
	 * (0.40), `shedAbove` (0.85) and `refuseAbove` (0.95) by default. Each must be a finite number
	 * strictly between 0 and 1 and they must be in that order, or node construction throws
	 * (`resolveStoragePressureThresholds`).
	 *
	 * Here, with the allotment they are fractions OF, rather than under `arachnode`: they are about
	 * this machine's disk, and a client node has an allotment and an account exactly as a serving node
	 * does. {@link StorageAccount} itself does not read them — it measures, and `StoragePressure`
	 * (`packages/db-p2p/src/storage/storage-pressure.ts`) is what reads the measurement against them.
	 */
	thresholds?: Partial<StoragePressureThresholds>;

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

	/**
	 * Where {@link StorageAccount.breakdown} reads what each blob hold accounts for. A THUNK, not a
	 * value: the node builds this account before it has a blob service to hand it, and a setter would
	 * make the account mutable for the sake of one report. Answering `undefined` is a value — the
	 * breakdown then leaves `blobBytesByHold` absent rather than reporting four zeros.
	 *
	 * Wiring rather than a host option, as {@link now} and {@link usedBytesCacheTtlMs} are seams: a
	 * host that passes `NodeOptions.storageAllotment` leaves it off.
	 */
	blobRecords?: () => BlobByteRecords | undefined;
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
	/**
	 * The block store's own figure, absent when this backend has no `getApproximateBytesUsed` and so
	 * measures nothing. Kept apart from {@link usedBytes} only so {@link StorageAccount.breakdown}
	 * can tell "the blocks came to 0" from "nothing measured the blocks".
	 */
	blockBytes: number | undefined;
	/**
	 * The piece store's figure when this scan asked for it — which it does exactly when the block
	 * store does NOT already measure the pieces. Absent otherwise, and `breakdown` then asks the
	 * piece store itself: `FileRawStorage`'s walk already covers those bytes, while
	 * `FilePieceStore.bytesUsed` is one `stat` per piece, so a scan ring selection makes several
	 * times per operation must not pay for it.
	 */
	pieceBytes: number | undefined;
}

/**
 * What {@link StorageAccount.breakdown} answers: everything {@link StorageCapacity} reports, plus
 * what the bytes are. Each figure beyond the capacity is optional because a node genuinely may not
 * know it (`packages/db-p2p/docs/storage.md` §9).
 */
export interface StorageBreakdown {
	readonly capacity: StorageCapacity;
	/** The piece store's own figure, whether or not it was added to `capacity.usedBytes`; absent when the read failed. */
	readonly pieceBytes?: number;
	// NOTE: the blocks and the node's bookkeeping (its key-value store and its transaction state) come
	// as ONE figure because no shipping backend separates them cheaply: `FileRawStorage` sizes the whole
	// base directory in one walk, SQLite multiplies `page_count` by `page_size` over the whole file,
	// LevelDB sums entries by key range, and the web backend reads an origin-wide
	// `navigator.storage.estimate().usage` that cannot be split at all. Three of those four could do it
	// with a second scan — the filesystem by classifying paths, SQLite by summing per table, LevelDB by
	// summing per tag range — and the web one could not; build it if an operator ever asks to see blocks
	// apart from bookkeeping.
	/**
	 * The blocks and the node's bookkeeping together: the measured use less {@link pieceBytes}, floored
	 * at 0. Absent when either is unknown — a block store that measures nothing leaves this unknown
	 * rather than 0.
	 */
	readonly blocksAndBookkeepingBytes?: number;
	/**
	 * What each hold accounts for ({@link BlobByteRecords.bytesByHold}); absent when this account was
	 * given no blob records to read. It over-counts and does not reconcile with {@link pieceBytes} —
	 * see that method.
	 */
	readonly blobBytesByHold?: Readonly<Record<BlobHoldKind, HoldBytes>>;
}

/**
 * What the share of the allotment comes to: an eighth. The reason is the two numbers it sits between.
 *
 * 256 MiB is today's default (`DEFAULT_BLOB_CACHE_BUDGET_BYTES` in `packages/db-p2p/src/blob/cache-budget.ts`) and the figure the design chose
 * for a phone. 256 MiB at an eighth is a 2 GiB allotment, so the share only ever LOWERS the budget on
 * an allotment below 2 GiB — a host smaller than the phone the default was written for. Every larger
 * allotment keeps the host's own figure, so no existing deployment's cache shrinks.
 *
 * And an eighth cannot move a ring on its own. The outward transition fires above the default 85 %
 * use (`storageAllotment.thresholds.shedAbove`, which feeds `RingSelectorConfig.thresholds.moveOut`),
 * and 12.5 % of the allotment spent on blobs nobody asked the node to keep cannot reach it. A share
 * large enough to approach that threshold would have the node shedding responsibility to protect a
 * read cache, which inverts what the two are for. An operator who lowers `shedAbove` below an eighth
 * has said the node should shed that early, and the argument is theirs to make.
 */
export const CACHE_ALLOTMENT_SHARE = 1 / 8;

/**
 * What the blobs held only for reads may take: the host's cap, the share of the allotment, and what
 * the allotment leaves after everything else, whichever is smallest, floored at 0.
 *
 * ```
 * min( declaredBytes,
 *      totalBytes * CACHE_ALLOTMENT_SHARE,
 *      totalBytes - (usedBytes - cachedBytes) )     // what is left after everything else
 * ```
 *
 * The third term is what makes cached blobs come OUT of the allotment rather than sit beside it: a
 * node whose other use fills the allotment gets a budget of 0 and evicts every cache-only blob not
 * being read. It subtracts `cachedBytes` first because `usedBytes` already includes the cached blobs'
 * own bytes — without that subtraction the budget would shrink itself toward 0 on every pass. The
 * term can go negative (a node already over its allotment), and the floor at 0 is the furthest this
 * goes: refusing new data is another ticket's.
 *
 * An unknown `totalBytes` answers `declaredBytes` unchanged. A node that cannot measure its storage
 * keeps today's flat budget exactly, which is the only honest answer — and is why a memory storage,
 * which reports no free space, behaves as it always did.
 *
 * Pure, and the result is a whole number of bytes: the share term is fractional for most allotments,
 * and a budget is a count of bytes.
 */
export function cacheBudgetBytes(args: {
	/** `NodeOptions.blobs.cacheBudgetBytes`, already defaulted to `DEFAULT_BLOB_CACHE_BUDGET_BYTES`. */
	declaredBytes: number;
	capacity: StorageCapacity;
	/** What the cache currently accounts for, from the caller's own pass. */
	cachedBytes: number;
}): number {
	const { declaredBytes, capacity, cachedBytes } = args;
	const { totalBytes, usedBytes } = capacity;
	if (totalBytes === undefined) {
		return declaredBytes;
	}
	const leftOverAfterEverythingElse = totalBytes - (usedBytes - cachedBytes);
	return Math.max(0, Math.floor(Math.min(declaredBytes, totalBytes * CACHE_ALLOTMENT_SHARE, leftOverAfterEverythingElse)));
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
 * times per operation. {@link breakdown} costs all of that plus two unmemoized passes; it is for an
 * operator, not for a hot path.
 */
export class StorageAccount {
	private readonly blocks: IRawStorage;
	private readonly pieces: IPieceStore;
	/** The piece store whose figure is added to the block store's; undefined when the block store counts it. */
	private readonly uncountedPieces: IPieceStore | undefined;
	/** {@link StorageAllotmentOptions.blobRecords}, defaulted to "this node has none". */
	private readonly blobRecords: () => BlobByteRecords | undefined;
	private readonly allotmentBytes: number | undefined;
	private readonly ttlMs: number;
	private readonly now: () => number;
	/** Memoized scan; undefined until the first scan resolves, then re-armed each miss. */
	private scanCache: { value: StorageScan; expiresAt: number } | undefined;
	/** In-flight scan Promise so concurrent misses share one scan (single-flight). */
	private inFlightScan: Promise<StorageScan> | undefined;

	constructor(storage: NodeStorage, options: StorageAllotmentOptions = {}) {
		this.blocks = storage.blocks;
		this.pieces = storage.pieces;
		// Fixed at construction, as both identities are: the decision is made once.
		this.uncountedPieces = blockStoreCountsPieces(storage.blocks, storage.pieces) ? undefined : storage.pieces;
		this.blobRecords = options.blobRecords ?? ((): undefined => undefined);
		this.allotmentBytes = options.bytes;
		this.ttlMs = options.usedBytesCacheTtlMs ?? DEFAULT_USED_BYTES_CACHE_TTL_MS;
		this.now = options.now ?? ((): number => Date.now());
	}

	async capacity(): Promise<StorageCapacity> {
		return this.capacityOf(await this.cachedScan());
	}

	/**
	 * Everything {@link capacity} reports, plus what the bytes are: the piece store's own figure, the
	 * blocks and the node's bookkeeping together, and what each blob hold accounts for. For an
	 * operator's dashboard and for `logRingInfo` in reference-peer; NOTHING calls it yet, so its
	 * assembly is unproven against a real backend — the first caller should check the figures it
	 * reports against the store it reports them about. Nothing on a hot path is to call it.
	 *
	 * **Cost.** Everything `capacity()` costs, memoized as it is, plus up to two passes that are NOT
	 * memoized and run on no timer: the piece store's own figure when the memoized scan did not
	 * already ask for it ({@link StorageScan.pieceBytes} says when), and one pass over every blob
	 * record ({@link BlobByteRecords.bytesByHold}).
	 *
	 * The blob attribution over-counts and does not reconcile with {@link StorageBreakdown.pieceBytes}
	 * — see `bytesByHold`. `blobBytesByHold` is left ABSENT, rather than reported as four zeros, when
	 * this account was given no blob records: a node whose blob service is not built yet has not found
	 * zero bytes of blobs, it has not looked.
	 *
	 * Two of the reads are caught and leave their figure unknown (the free space, and the piece figure
	 * this takes itself); the block store's use read and the record pass are not, so this REJECTS when
	 * either of those fails rather than answering a partial report. That is the shape `capacity()`
	 * already has, and `absent` is spoken for — it means "not looked", not "looked and failed". A
	 * caller that would rather show an operator the figures it does have should catch here and say
	 * which half is missing, not widen these fields.
	 *
	 * The figures are as close to one moment as they are cheap to make: the capacity comes from one
	 * memoized scan, while a piece figure that scan did not take is read now and so may be newer than
	 * the use it is subtracted from by up to the memo's TTL. A report that already over-counts the
	 * blobs is not made honest by a third scan.
	 */
	async breakdown(): Promise<StorageBreakdown> {
		const scan = await this.cachedScan();
		const capacity = this.capacityOf(scan);
		const pieceBytes = scan.pieceBytes ?? await this.ownPieceBytes();
		return {
			capacity,
			pieceBytes,
			// Unknown, not 0, when either half is: see the field.
			blocksAndBookkeepingBytes: scan.blockBytes === undefined || pieceBytes === undefined
				? undefined
				// Floored for the reason `availableBytes` is: a backend that reported a figure smaller
				// than its own pieces' would otherwise read as negative bookkeeping.
				: Math.max(0, capacity.usedBytes - pieceBytes),
			blobBytesByHold: await this.blobRecords()?.bytesByHold()
		};
	}

	private capacityOf({ usedBytes, locationBytes }: StorageScan): StorageCapacity {
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
	 * The piece store's own figure for a breakdown the memoized scan left it out of. Caught and
	 * logged rather than thrown, for the reason {@link freeBytes} gives: one figure that cannot be
	 * read leaves that figure unknown rather than failing an operator's whole report.
	 */
	private async ownPieceBytes(): Promise<number | undefined> {
		try {
			return await this.pieces.bytesUsed();
		} catch (err) {
			log('piece-bytes read failed; this breakdown leaves the piece figure unknown: %e', err);
			return undefined;
		}
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
		return {
			usedBytes,
			locationBytes: freeBytes === undefined ? undefined : usedBytes + freeBytes,
			blockBytes,
			pieceBytes
		};
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
