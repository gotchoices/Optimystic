import type { BlockId, ActionId, ActionRev, Transform, IBlock } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import type { RawStoreDriver } from "./raw-store-driver.js";
import { encodeJson, decodeJson, encodeActionId, decodeActionId } from "./raw-store-codec.js";

/**
 * Shared ordered-KV storage kernel. Implements the full {@link IRawStorage}
 * surface over a {@link RawStoreDriver}, owning all value (de)serialization and
 * call orchestration so each backend only has to expose its five logical stores
 * as bytes-valued maps over its native mechanism.
 *
 * The genuinely-shared logic lives ABOVE the storage primitive: the JSON/string
 * codec for the four value types, `listRevisions`' lo/hi/reverse bound
 * computation, `saveMaterializedBlock`'s put-or-delete branch, and the
 * passthroughs. Key layout / storage topology stays in the driver, because the
 * backends do NOT share one — LevelDB is a single ordered byte keyspace, SQLite
 * five relational tables, IndexedDB five object stores, the filesystem a
 * directory tree.
 */
export class KvRawStorage implements IRawStorage {
	/**
	 * Optional passthroughs are wired in the constructor ONLY when the driver
	 * provides them, so a `StorageMonitor` / owned-block seed that feature-detects
	 * (`typeof storage.listBlockIds === 'function'`) sees the driver's true
	 * capability instead of a stub that silently reports 0 / no seed.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	getApproximateBytesUsed?: () => Promise<number>;

	constructor(private readonly driver: RawStoreDriver) {
		if (driver.listBlockIds) {
			this.listBlockIds = () => driver.listBlockIds!();
		}
		if (driver.approximateBytesUsed) {
			this.getApproximateBytesUsed = () => driver.approximateBytesUsed!();
		}
	}

	// --- Metadata ---

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		const bytes = await this.driver.getMetadata(blockId);
		return bytes === undefined ? undefined : decodeJson<BlockMetadata>(bytes);
	}

	// NOTE: every value write funnels through the driver put/delete calls in the
	// methods below (saveMetadata / saveRevision / save*Transaction /
	// saveMaterializedBlock). This is the single choke point where the future
	// incremental byte counter (st-storage-sweep-archival-and-capacity-estimate)
	// would hook in, replacing the per-driver full-scan getApproximateBytesUsed.
	// Do NOT implement the counter here — leave the write path a single seam.
	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.driver.putMetadata(blockId, encodeJson(metadata));
	}

	// --- Revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		const bytes = await this.driver.getRevision(blockId, rev);
		return bytes === undefined ? undefined : decodeActionId(bytes);
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.driver.putRevision(blockId, rev, encodeActionId(actionId));
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		// Both bounds inclusive; ordering follows startRev→endRev direction. Empty
		// revs are skipped by the driver's range. Preserves the exact semantics of
		// every existing backend.
		const ascending = startRev <= endRev;
		const lo = ascending ? startRev : endRev;
		const hi = ascending ? endRev : startRev;
		for await (const [rev, bytes] of this.driver.rangeRevisions(blockId, lo, hi, !ascending)) {
			yield { rev, actionId: decodeActionId(bytes) };
		}
	}

	// --- Pending transactions ---

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const bytes = await this.driver.getPending(blockId, actionId);
		return bytes === undefined ? undefined : decodeJson<Transform>(bytes);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.driver.putPending(blockId, actionId, encodeJson(transform));
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.driver.deletePending(blockId, actionId);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		yield* this.driver.listPendingActionIds(blockId);
	}

	// --- Committed transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const bytes = await this.driver.getTransaction(blockId, actionId);
		return bytes === undefined ? undefined : decodeJson<Transform>(bytes);
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.driver.putTransaction(blockId, actionId, encodeJson(transform));
	}

	// --- Materialized blocks ---

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		const bytes = await this.driver.getMaterialized(blockId, actionId);
		return bytes === undefined ? undefined : decodeJson<IBlock>(bytes);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		// Present ⇒ put the materialized block; absent ⇒ delete (tombstone / truncation).
		if (block) {
			await this.driver.putMaterialized(blockId, actionId, encodeJson(block));
		} else {
			await this.driver.deleteMaterialized(blockId, actionId);
		}
	}

	// --- Promote (the only cross-key atomic op; driver owns atomicity) ---

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.driver.promote(blockId, actionId);
	}
}
