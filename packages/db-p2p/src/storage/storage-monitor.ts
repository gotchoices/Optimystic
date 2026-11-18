import type { IPieceStore } from '../blob/piece-store.js';
import type { IRawStorage } from './i-raw-storage.js';

export interface StorageCapacity {
	total: number;
	used: number;
	available: number;
}

/** Default lifetime (ms) of the memoized used-bytes scan. `0` disables caching. */
const DEFAULT_USED_BYTES_CACHE_TTL_MS = 60_000;

export interface StorageMonitorConfig {
	totalBytes?: number;
	usedBytes?: number;
	availableBytes?: number;

	/**
	 * Lifetime (ms) of the memoized used-bytes scan. `getApproximateBytesUsed` is a full-store scan
	 * (LevelDB iterates every key+value, the fs adapter stats the whole tree), and ring selection
	 * calls `getCapacity` several times per operation, so the scan is memoized for this window.
	 * Default {@link DEFAULT_USED_BYTES_CACHE_TTL_MS} (60_000). `0` disables caching — every call
	 * scans (the pre-cache behavior; opt-out for tests). The cached value may lag reality by up to
	 * the TTL; that staleness is acceptable because the consumer (ring selection) is EWMA-smoothed,
	 * dead-banded, and gated by a 10-minute dwell — see `docs/repository.md`.
	 */
	usedBytesCacheTtlMs?: number;

	/**
	 * Injectable clock (Unix ms), used only for the used-bytes cache TTL. Defaults to `Date.now`;
	 * mirrors `RingSelector`'s injectable clock so TTL expiry is testable without sleeping on
	 * wall time.
	 */
	now?: () => number;
}

/**
 * Whether `storage`'s `getApproximateBytesUsed` already measures `pieces`' bytes. Every disk block
 * store measures its whole directory or database, so a piece store inside the same location is
 * counted there and adding its own figure would count it twice. Decided by store identity, whose
 * contract is one-directional: equal identities prove one location, so the piece bytes are left
 * out; anything else (either identity absent, two different strings, or a block store with no
 * `getApproximateBytesUsed`, which measures nothing) adds them.
 */
// NOTE: two spellings of one location read as two identities, so a piece store over a differently
// spelled path to the block store's directory is counted twice. That errs toward reporting the node
// fuller than it is, which delays nothing and moves a ring outward at worst; revisit if a host reports it.
export function blockStoreCountsPieces(storage: IRawStorage, pieces: IPieceStore): boolean {
	if (typeof storage.getApproximateBytesUsed !== 'function') return false;
	const blockIdentity = storage.getStoreIdentity?.();
	return blockIdentity !== undefined && blockIdentity === pieces.storeIdentity?.();
}

/**
 * Monitors storage capacity for ring selection.
 * Provides estimates based on storage backend or supplied overrides. Used bytes are the block
 * store's figure plus the piece store's, unless {@link blockStoreCountsPieces} says the block store
 * already measured the pieces.
 */
export class StorageMonitor {
	private readonly now: () => number;
	/** The piece store whose figure is added to the block store's; undefined when the block store counts it, or there is none. */
	private readonly uncountedPieces: IPieceStore | undefined;
	/** Memoized used-bytes scan; undefined until the first scan resolves, then re-armed each miss. */
	private usedBytesCache: { value: number; expiresAt: number } | undefined;
	/** In-flight scan Promise so concurrent misses share one scan (single-flight). */
	private inFlightScan: Promise<number> | undefined;

	constructor(
		private readonly storage: IRawStorage,
		private readonly config: StorageMonitorConfig = {},
		pieces?: IPieceStore
	) {
		this.now = config.now ?? ((): number => Date.now());
		// Both identities are fixed at construction, so the decision is made once.
		this.uncountedPieces = pieces && !blockStoreCountsPieces(storage, pieces) ? pieces : undefined;
	}

	async getCapacity(): Promise<StorageCapacity> {
		const defaultTotal = 10 * 1024 * 1024 * 1024; // 10GB default
		const total = this.config.totalBytes ?? defaultTotal;
		const usedOverride = this.config.usedBytes;
		const availableOverride = this.config.availableBytes;

		// Only short-circuit the backend when used/available is explicitly supplied;
		// a bare `totalBytes` is just the disk-size hint and should still let the
		// backend report actual used bytes. The override path never scans, so the
		// cache is bypassed entirely (nothing to cache, nothing to serve).
		const rawUsed = usedOverride
			?? (availableOverride !== undefined ? total - availableOverride : await this.getCachedUsedBytes());
		const used = Math.min(total, Math.max(0, rawUsed));
		const available = availableOverride !== undefined
			? Math.max(0, Math.min(total, availableOverride))
			: Math.max(0, total - used);

		return {
			total,
			used,
			available
		};
	}

	/**
	 * Used-bytes with a short TTL cache + single-flight. Within the TTL a cached value is returned;
	 * on a cold/expired cache exactly one scan runs even under concurrent callers, and the result is
	 * memoized until `now() + ttl`. A rejected scan is neither cached nor left wedged in the
	 * single-flight slot, so the next call retries.
	 */
	private async getCachedUsedBytes(): Promise<number> {
		const ttl = this.config.usedBytesCacheTtlMs ?? DEFAULT_USED_BYTES_CACHE_TTL_MS;

		// Caching disabled: every call scans (the pre-cache behavior; opt-out for tests).
		if (ttl <= 0) {
			return this.estimateUsedSpace();
		}

		if (this.usedBytesCache !== undefined && this.now() < this.usedBytesCache.expiresAt) {
			return this.usedBytesCache.value;
		}

		// Single-flight: concurrent misses share one scan instead of launching several.
		if (this.inFlightScan !== undefined) {
			return this.inFlightScan;
		}

		const scan = this.estimateUsedSpace()
			.then((value) => {
				this.usedBytesCache = { value, expiresAt: this.now() + ttl };
				return value;
			})
			.finally(() => {
				// Clear on both resolve and reject: a failed scan must not wedge the slot.
				this.inFlightScan = undefined;
			});

		this.inFlightScan = scan;
		return scan;
	}

	/** One scan: both figures are memoized together, and a rejection of either rejects the scan. */
	private async estimateUsedSpace(): Promise<number> {
		const [blockBytes, pieceBytes] = await Promise.all([
			this.storage.getApproximateBytesUsed?.(),
			this.uncountedPieces?.bytesUsed()
		]);
		return (blockBytes ?? 0) + (pieceBytes ?? 0);
	}
}

