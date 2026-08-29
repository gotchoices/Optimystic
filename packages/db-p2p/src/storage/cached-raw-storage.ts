import type { BlockId, ActionId } from "@optimystic/db-core";
import type { IRawStorage } from "./i-raw-storage.js";
import type { RawStoreDriver } from "./raw-store-driver.js";
import { KvRawStorage } from "./kv-raw-storage.js";
import { CachedStoreDriver } from "./cached-store-driver.js";
import type { SharedCachePool } from "./shared-cache-pool.js";
import type { StoreIdentity } from "./store-identity.js";
import { encodeJson, decodeJson, encodeActionId, decodeActionId } from "./raw-store-codec.js";

/**
 * Presents a plain {@link IRawStorage} as a {@link RawStoreDriver}, so the
 * {@link CachedStoreDriver} (and the `KvRawStorage` kernel above it) can wrap a backend
 * that does NOT expose its driver — the composition {@link CachedRawStorage} uses.
 *
 * Every value crossing this adapter is re-encoded to bytes on read and re-decoded on
 * write, on top of whatever (de)serialization the inner storage does itself. For a
 * kernel-backed inner storage that is a double codec pass per COLD miss — cache hits
 * never reach this adapter. Wrapping the backend's `RawStoreDriver` directly with
 * `CachedStoreDriver` avoids the double pass entirely; prefer that when the driver is
 * reachable, and this adapter when only the `IRawStorage` surface is.
 */
export class RawStorageDriverAdapter implements RawStoreDriver {
	/**
	 * Optional passthroughs wired only when the inner storage provides them, mirroring
	 * `KvRawStorage`'s constructor: feature-detection above must observe the inner
	 * storage's true capability. `IRawStorage` has no `close`/`approximateBytesUsed`
	 * driver names — they map from `listBlockIds`/`getApproximateBytesUsed`.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;
	storeIdentity?: () => StoreIdentity;

	constructor(private readonly inner: IRawStorage) {
		if (inner.getStoreIdentity) {
			this.storeIdentity = () => inner.getStoreIdentity!();
		}
		if (inner.listBlockIds) {
			this.listBlockIds = () => inner.listBlockIds!();
		}
		if (inner.getApproximateBytesUsed) {
			this.approximateBytesUsed = () => inner.getApproximateBytesUsed!();
		}
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		const meta = await this.inner.getMetadata(blockId);
		return meta === undefined ? undefined : encodeJson(meta);
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		await this.inner.saveMetadata(blockId, decodeJson(value));
	}

	// --- revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		const actionId = await this.inner.getRevision(blockId, rev);
		return actionId === undefined ? undefined : encodeActionId(actionId);
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.inner.saveRevision(blockId, rev, decodeActionId(value));
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		// `listRevisions` derives direction from bound order (start > end ⇒ descending);
		// map (lo, hi, reverse) back onto that. Drain before yielding — the inner
		// iterable already drained per its own contract, but the consumer's awaits must
		// not straddle OUR loop over it either.
		const startRev = reverse ? hi : lo;
		const endRev = reverse ? lo : hi;
		const drained: [number, Uint8Array][] = [];
		for await (const { rev, actionId } of this.inner.listRevisions(blockId, startRev, endRev)) {
			drained.push([rev, encodeActionId(actionId)]);
		}
		yield* drained;
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const transform = await this.inner.getPendingTransaction(blockId, actionId);
		return transform === undefined ? undefined : encodeJson(transform);
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.inner.savePendingTransaction(blockId, actionId, decodeJson(value));
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.inner.deletePendingTransaction(blockId, actionId);
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const drained: ActionId[] = [];
		for await (const id of this.inner.listPendingTransactions(blockId)) {
			drained.push(id);
		}
		yield* drained;
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const transform = await this.inner.getTransaction(blockId, actionId);
		return transform === undefined ? undefined : encodeJson(transform);
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.inner.saveTransaction(blockId, actionId, decodeJson(value));
	}

	// --- proofs ---

	// The inner storage owns the proofs keyspace (`IRawStorage.getBlockProof` /
	// `saveBlockProof`), so this adapter only re-encodes across the byte boundary the
	// way its sibling methods do. Deliberately no delete — see RawStoreDriver.getProof.

	async getProof(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		const proof = await this.inner.getBlockProof(blockId, rev);
		return proof === undefined ? undefined : encodeJson(proof);
	}

	async putProof(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.inner.saveBlockProof(blockId, rev, decodeJson(value));
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const block = await this.inner.getMaterializedBlock(blockId, actionId);
		return block === undefined ? undefined : encodeJson(block);
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.inner.saveMaterializedBlock(blockId, actionId, decodeJson(value));
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.inner.saveMaterializedBlock(blockId, actionId, undefined);
	}

	// --- promote ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.inner.promotePendingTransaction(blockId, actionId);
	}
}

/**
 * Write-through cached view over a plain {@link IRawStorage} — the wrapper form for a
 * backend whose {@link RawStoreDriver} is not reachable. Composition:
 *
 * ```
 * KvRawStorage kernel → CachedStoreDriver → RawStorageDriverAdapter → inner IRawStorage
 * ```
 *
 * All caching semantics (write-through coherence, proven-absence negatives, list
 * completeness, promote mirroring) live in {@link CachedStoreDriver}; see its class doc
 * and `packages/db-p2p/docs/storage.md` § "Write-through raw-storage cache" for the invariants this relies
 * on — including the single-process-owner precondition.
 *
 * Prefer wrapping the backend's driver directly — `new KvRawStorage(new
 * CachedStoreDriver(driver))` — when the driver is available: it skips this adapter's
 * extra codec pass on cold misses. Do not wrap `MemoryRawStorage` in production wiring
 * (already in-memory; the cache adds bookkeeping with nothing to save) — tests do, to
 * prove semantics are identical through the full composition.
 *
 * By default the cache joins the process-wide shared pool (`defaultCachePool()`), so
 * every workspace's cache competes inside ONE memory budget; pass a specific
 * {@link SharedCachePool} only for isolation (tests) or host-specific sizing, and a
 * `label` to make this store recognizable in the pool's `stats()`.
 */
export class CachedRawStorage extends KvRawStorage {
	private readonly cacheDriver: CachedStoreDriver;

	constructor(inner: IRawStorage, pool?: SharedCachePool, label?: string) {
		const cacheDriver = new CachedStoreDriver(new RawStorageDriverAdapter(inner), pool, label);
		super(cacheDriver);
		this.cacheDriver = cacheDriver;
	}

	/** Drop every cached entry. Always safe — the cache is clean (write-through, never write-behind). */
	clearCache(): void {
		this.cacheDriver.clear();
	}

	/**
	 * Release this storage's cache registration with the shared pool (drops all entries,
	 * retires the store id). Call when the workspace departs; a skipped dispose leaks only
	 * cold entries the pool will evict under pressure, but the polite release keeps a
	 * long-lived process's occupancy honest. `IRawStorage` itself has no close, so this is
	 * the wrapper's own lifecycle method.
	 */
	async dispose(): Promise<void> {
		await this.cacheDriver.close();
	}
}
