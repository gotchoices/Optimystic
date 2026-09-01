import type { BlockId, ActionId } from "@optimystic/db-core";
import type { StoreIdentity } from "./store-identity.js";

/**
 * Bytes-valued, per-logical-store driver surface. Each backend implements the
 * six block-storage stores (metadata, revisions, pending, transactions,
 * materialized, proofs) over its native mechanism (LevelDB tag-ranges, six SQLite
 * tables, six IndexedDB object stores, six filesystem subdirectories, six
 * in-memory maps). `KvRawStorage` layers all JSON serialization and call
 * orchestration on top — drivers never (de)serialize values and never see the
 * `BlockMetadata`/`Transform`/`IBlock` types. Drivers speak only
 * `Uint8Array`/`BlockId`/`ActionId`/`number`.
 *
 * ### Iteration semantics (drain-before-yield)
 *
 * `rangeRevisions` and `listPendingActionIds` return an `AsyncIterable`, but a
 * driver MUST drain its native cursor/iterator into memory BEFORE yielding to
 * the consumer. A live LevelDB iterator, IndexedDB transaction, or SQLite
 * cursor must not straddle the consumer's `await`s: IndexedDB auto-commits an
 * idle transaction, SQLite would hold its mutex slot, and LevelDB pins native
 * resources. The kernel encodes this as a contract (not a shared implementation)
 * because the drain is backend-specific. The conformance suite exercises it by
 * interleaving other awaits between yielded items.
 *
 * ### Promote atomicity
 *
 * `promote` is the ONLY cross-key atomic operation the kernel requires. Every
 * other write is a single put/delete. Each backend satisfies `promote` with its
 * native atomic mechanism (LevelDB batch, SQLite transaction, IndexedDB
 * readwrite transaction, filesystem rename); the kernel never assumes an
 * atomicity a backend cannot deliver.
 */
export interface RawStoreDriver {
	// metadata store — keyed by blockId
	getMetadata(blockId: BlockId): Promise<Uint8Array | undefined>;
	putMetadata(blockId: BlockId, value: Uint8Array): Promise<void>;

	// revisions store — keyed by (blockId, rev), ORDERED BY rev
	getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined>;
	putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void>;
	/**
	 * Yield `[rev, value]` for every present rev in `[lo, hi]` (both inclusive),
	 * ascending when `reverse` is false, descending when `reverse` is true. The
	 * driver MUST drain any native cursor into memory before yielding — see the
	 * "drain-before-yield" contract above.
	 */
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]>;

	// pending store — keyed by (blockId, actionId)
	getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deletePending(blockId: BlockId, actionId: ActionId): Promise<void>;
	/** Yield each present pending actionId for the block. MUST drain before yielding (see above). */
	listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId>;

	// transactions store — keyed by (blockId, actionId)
	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;

	/**
	 * proofs store — keyed by (blockId, rev), the same key shape as the revisions
	 * store. A revision's `BlockCommitProof` lives here and NOWHERE in the
	 * transactions store: an action id is chosen by whoever originates a write
	 * (a client's `pend`, a peer's restore archive) and is never re-derived or
	 * format-checked, so any reserved action-id convention could be collided with
	 * by an ordinary write. Separate keyspaces make the collision unrepresentable.
	 *
	 * There is deliberately NO `deleteProof`: a proof lives and dies with its
	 * REVISION record, and no revision-delete site exists today (`RawStoreDriver`
	 * has no revision delete at all — invalidations write compensating FORWARD
	 * revisions). Whatever ever deletes a revision record must delete its proof;
	 * until such a site exists this is a contract note, not a wired path.
	 */
	getProof(blockId: BlockId, rev: number): Promise<Uint8Array | undefined>;
	putProof(blockId: BlockId, rev: number, value: Uint8Array): Promise<void>;

	// materialized store — keyed by (blockId, actionId)
	getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * Atomically move `pending(blockId, actionId)` → `transactions(blockId, actionId)`:
	 * write the transactions entry and remove the pending entry as one indivisible
	 * step (batch / DB transaction / rename). A crash must leave exactly one of the
	 * two states, never both/neither. Throw
	 * `Pending action <actionId> not found for block <blockId>` when no pending
	 * entry exists. This is the ONLY cross-key atomic operation the kernel requires.
	 */
	promote(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * Optional — a stable, process-scoped string naming what this driver is backed by (a
	 * resolved directory, an open database handle). Passed through by the kernel and by every
	 * wrapper, so a cache and the storage it fronts name the same store.
	 *
	 * Contract — note it is ONE-DIRECTIONAL; read both halves before consuming it:
	 * - Two drivers over DIFFERENT locations MUST NOT return equal strings. So **equality
	 *   proves sameness**, and a consumer may merge on it. (The fs driver documents one exotic
	 *   Windows exception at its own site.)
	 * - Two drivers over the SAME location SHOULD return equal strings, but this is
	 *   best-effort and several backends knowingly under-approximate: two handles opened over
	 *   one database, or two spellings of one directory that cannot be collapsed synchronously,
	 *   read as two identities. So **inequality proves nothing** — never treat it as evidence
	 *   that two drivers are distinct stores. Each backend's `NOTE:` states its own gaps.
	 * - Every string is scheme-prefixed so backends cannot collide: `file:`, `sqlite-handle:`,
	 *   `idb-handle:`, `leveldb-handle:`. Compared for equality only — never parsed.
	 * - Stable for the driver object's whole life; fixed at construction.
	 * - OPTIONAL BY DESIGN. A driver that cannot honour the contract omits the method entirely
	 *   and callers fall back to per-object behavior. Never install a stub that returns
	 *   `undefined` — feature-detection (`typeof driver.storeIdentity === 'function'`) must see
	 *   the driver's true capability.
	 * - It identifies the STORE, not its contents.
	 */
	storeIdentity?(): StoreIdentity;

	/**
	 * Optional — present (and only ever `true`) when a write-through read cache
	 * (`CachedStoreDriver`) sits AT or BELOW this driver, so a composition seam can ask
	 * "is this already read-cached?" of the composition itself instead of guessing from a
	 * concrete class name. Set unconditionally by `CachedStoreDriver` (it *is* the cache) and
	 * passed up by every wrapper that fronts a driver, the same way `storeIdentity` is.
	 *
	 * A property, not a method: there is no behavior to invoke, only a fact to report.
	 *
	 * OPTIONAL BY DESIGN, and typed as the literal `true` so "present and false" is
	 * unrepresentable — truthiness IS the feature detection. Never install a `false` stub: an
	 * uncached driver must omit the property entirely, exactly as `storeIdentity` /
	 * `listBlockIds` / `approximateBytesUsed` are omitted when unsupported.
	 */
	readCached?: true;

	/** Optional — enumerate block ids with durable metadata (startup seed). Passed through by the kernel. */
	listBlockIds?(): AsyncIterable<BlockId>;
	/** Optional — best cheap byte estimate. Passed through by the kernel. */
	approximateBytesUsed?(): Promise<number>;
	/** Optional — release the underlying handle. */
	close?(): Promise<void>;
}
