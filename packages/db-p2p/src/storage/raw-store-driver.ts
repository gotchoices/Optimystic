import type { BlockId, ActionId } from "@optimystic/db-core";
import type { StoreIdentity } from "./store-identity.js";
import type { FlushOptions, StoreDurability } from "./store-durability.js";
import type { StoredValue } from "./raw-store-codec.js";

/**
 * Per-logical-store driver surface. Each backend implements the
 * seven block-storage stores (metadata, revisions, pending, transactions,
 * materialized, proofs, commit proofs) over its native mechanism (LevelDB tag-ranges,
 * seven SQLite tables, seven IndexedDB object stores, filesystem subdirectories,
 * seven in-memory maps). `KvRawStorage` layers all JSON serialization and call
 * orchestration on top — drivers never (de)serialize values and never see the
 * `BlockMetadata`/`Transform`/`IBlock` types. Drivers speak only
 * `V`/`BlockId`/`ActionId`/`number`.
 *
 * ### Value representation
 *
 * `V` is how the driver holds a stored value in memory: `Uint8Array` (the default, and every
 * backend but one) or `string`, the text the stored UTF-8 bytes decode to — the same logical
 * value in a different form, for a backend whose platform decodes text natively. Every value
 * position (each `get*` result, each `put*` argument, `rangeRevisions` rows) is `V`. The kernel
 * and every wrapper over the driver share its `V` and its `ValueCodec` (`raw-store-codec.ts`), and
 * the type checker refuses a composition that mixes them.
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
export interface RawStoreDriver<V extends StoredValue = Uint8Array> {
	// metadata store — keyed by blockId
	getMetadata(blockId: BlockId): Promise<V | undefined>;
	putMetadata(blockId: BlockId, value: V): Promise<void>;

	// revisions store — keyed by (blockId, rev), ORDERED BY rev
	getRevision(blockId: BlockId, rev: number): Promise<V | undefined>;
	putRevision(blockId: BlockId, rev: number, value: V): Promise<void>;
	/**
	 * Yield `[rev, value]` for every present rev in `[lo, hi]` (both inclusive),
	 * ascending when `reverse` is false, descending when `reverse` is true. The
	 * driver MUST drain any native cursor into memory before yielding — see the
	 * "drain-before-yield" contract above.
	 */
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, V]>;

	// pending store — keyed by (blockId, actionId)
	getPending(blockId: BlockId, actionId: ActionId): Promise<V | undefined>;
	putPending(blockId: BlockId, actionId: ActionId, value: V): Promise<void>;
	deletePending(blockId: BlockId, actionId: ActionId): Promise<void>;
	/** Yield each present pending actionId for the block. MUST drain before yielding (see above). */
	listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId>;

	// transactions store — keyed by (blockId, actionId)
	getTransaction(blockId: BlockId, actionId: ActionId): Promise<V | undefined>;
	putTransaction(blockId: BlockId, actionId: ActionId, value: V): Promise<void>;

	/**
	 * proofs store — keyed by (blockId, rev), the same key shape as the revisions
	 * store. A revision's `BlockCommitProof` lives here and NOWHERE in the
	 * transactions store: an action id is chosen by whoever originates a write
	 * (a client's `pend`, a peer's restore archive) and is never re-derived by the
	 * storing node, so any reserved action-id convention could be collided with
	 * by an ordinary write. Separate keyspaces make the collision unrepresentable.
	 * `isValidActionId` does not change that: it refuses only an id that would name
	 * a location outside the store or alias another id, reserving no prefix and
	 * imposing no format, so `~proof:5` remains a legal action id.
	 *
	 * There is deliberately no per-revision `deleteProof`: an entry lives and dies with its REVISION
	 * record, and the one site that removes a revision record removes a whole block's —
	 * {@link deleteBlock}, which takes this store's entries for the block alongside the other five
	 * block-scoped stores'. No narrower revision delete exists: invalidations write compensating
	 * FORWARD revisions rather than removing anything, so a single revision's entry is never removed
	 * on its own.
	 */
	getProof(blockId: BlockId, rev: number): Promise<V | undefined>;
	putProof(blockId: BlockId, rev: number, value: V): Promise<void>;

	/**
	 * commit proofs store — one encoded `BlockCommitProof` per consensus message, keyed by the
	 * proof's `messageHash` (the base58btc hash of the consensus message, `computeClusterMessageHash`
	 * in `@optimystic/db-core`), so a proof covering many blocks is stored once rather than once per
	 * block. The key is a hash the caller takes from the proof itself, which is trustworthy only
	 * because every proof that reaches storage was built or verified locally.
	 *
	 * Deliberately NO delete, and {@link deleteBlock} does not touch this store either: a key names a
	 * consensus message, not a block, so one entry may still certify revisions of blocks this node
	 * keeps, and nothing counts how many revisions name it. So `deleteBlock` removes the deleted
	 * block's entries in the PROOFS store and leaves the proof bodies those entries referred to in
	 * place — orphaned when no revision of any kept block names them. Sweeping that residual is the
	 * subject of the backlog ticket `debt-unreferenced-commit-proofs-are-never-swept`.
	 */
	getCommitProof(messageHash: string): Promise<V | undefined>;
	putCommitProof(messageHash: string, value: V): Promise<void>;

	// materialized store — keyed by (blockId, actionId)
	getMaterialized(blockId: BlockId, actionId: ActionId): Promise<V | undefined>;
	putMaterialized(blockId: BlockId, actionId: ActionId, value: V): Promise<void>;
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
	 * Remove everything this driver holds for one block — the only operation that takes bytes back
	 * off a node, for a block it has stopped being responsible for. The full contract, including the
	 * store inventory, the ordering and the idempotence, is stated once on
	 * `BatchBackend.deleteBlock` (`packages/db-p2p/src/storage/batch-backend.ts`) and holds
	 * identically here; in short:
	 *
	 * - It removes the SIX block-scoped stores' records for the block — metadata, revisions,
	 *   pending, transactions, materialized, proofs — and **not** the commit proofs store, which is
	 *   keyed by a consensus message's hash and so holds entries shared with blocks this node keeps
	 *   (see {@link getCommitProof}).
	 * - Metadata first, durably, then the rest: a crash in the middle leaves content with no
	 *   metadata, never metadata whose revision records are gone.
	 * - Idempotent, so a sweep may re-run it for the same block id after a restart.
	 * - The caller holds the block's write latch.
	 *
	 * Required, not optional, for the reason {@link flush} and {@link whenDurable} are: a wrapper
	 * that forgot to forward it would silently leave the bytes on disk, and the type checker refuses
	 * that. Each wrapper has its own work to do first — `WriteGroupDriver` flushes its group so no
	 * overlay put can be applied after the delete and resurrect the block, and `CachedStoreDriver`
	 * drops what it caches for the block so no later read is served content the store no longer has.
	 */
	deleteBlock(blockId: BlockId): Promise<void>;

	/**
	 * Make every write that resolved before this call survive the crashes {@link durability} names,
	 * at once or — `options.withinMs` — within a deadline the store may defer its sync to.
	 *
	 * ### The flush contract
	 *
	 * Stated once, here; `IRawStorage.flush` and `IKVStore.flush` hold to the same five rules.
	 *
	 * 1. A write method resolves once its effect is visible to every later read in this process.
	 * 2. Once a `flush()` called after the write resolved has itself resolved, the write survives a
	 *    crash of this process where `durability` names one; it survives every crash `durability`
	 *    names once `withinMs` has passed since that flush was called (at once, for 0 or absent), or
	 *    once a `whenDurable()` called after the flush resolved has itself resolved.
	 * 3. **What survives any crash is a prefix of the resolved writes, in the order they resolved.**
	 *    No write survives while one that resolved before it is lost. This is what keeps the
	 *    crash-recovery reasoning in `BlockStorage` and `StorageRepo` valid once writes stop being
	 *    synced one at a time — and a deferred sync is exactly when a power cut can take a suffix.
	 * 4. A `flush()` covers every write resolved before it was called, including writes made by
	 *    other callers; concurrent flushes may share one sync. A flush with `withinMs` 0 covers
	 *    every earlier deferred write too, so it hastens their sync.
	 * 5. A rejected `flush()` is a storage fault. After one, the store rejects every later write and
	 *    flush until it is reopened, because a retried sync can report success for data the
	 *    operating system already dropped. A deferred sync that fails latches the store the same
	 *    way, is logged, and is reported by the next write, flush or `whenDurable()`.
	 *
	 * A store that cannot defer a sync treats every `withinMs` as 0. Required, not optional, so a
	 * wrapper that forgets to forward it does not type-check.
	 */
	flush(options?: FlushOptions): Promise<void>;

	/**
	 * Resolves once every write covered by a flush that resolved before this call survives every
	 * crash {@link durability} names. It never hastens a sync: it waits for the deadline the flushes
	 * were given, where a strict flush would sync at once. Rejects with `StoreFailedError` if the
	 * store fails first. Required, like `flush` and `durability`: a wrapper that forgets to forward
	 * it must not compile.
	 */
	whenDurable(): Promise<void>;

	/**
	 * What a write survives once a `flush()` called after it has resolved (see {@link flush}).
	 * Fixed at construction and never changes over the driver's life, like {@link storeIdentity}; a
	 * wrapper reports the value of the driver it fronts. Required for the same reason as `flush`.
	 */
	readonly durability: StoreDurability;

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
	/**
	 * Optional — the LOCATION's free bytes. The whole contract is stated once on
	 * `IRawStorage.getApproximateBytesFree` (`packages/db-p2p/src/storage/i-raw-storage.ts`), which
	 * is the surface this member reaches a consumer through: advisory, the LOCATION's figure rather
	 * than this driver's share of it, **rejecting rather than answering 0** on a failed read, and
	 * omitted ENTIRELY — never stubbed — by a backend that cannot ask its platform. Passed through
	 * by the kernel and by every wrapper, as {@link approximateBytesUsed} is.
	 */
	approximateBytesFree?(): Promise<number>;
	/** Optional — release the underlying handle. */
	close?(): Promise<void>;

	// NOTE: forwarding each optional above is a WRITTEN contract for wrapper drivers, not an
	// enforced one — a wrapper that forgets one silently reports the composition as less capable
	// than it is, and for `readCached` that means a seam attaches a redundant second cache. Fine
	// today: the only two wrapper drivers over a `RawStoreDriver` are `CachedStoreDriver` and
	// `RawStorageDriverAdapter`, both forward deliberately (`CachedStoreDriver` has a `close` of its
	// own rather than a passthrough, and says why at its site), and each has direct tests.
	// `WriteGroupDriver` forwards the same optionals but from a `BatchBackend`, not a driver, so a
	// check over driver-wrapping-driver cannot cover it; it has its own direct test. If a THIRD
	// wrapper over a `RawStoreDriver` appears, replace the per-wrapper tests with one shared
	// conformance check that asserts forwarding of each optional, with an explicit per-wrapper
	// exception list.
	// `flush`, `durability` and `deleteBlock` are REQUIRED for exactly that reason: a wrapper that
	// forgot `flush` would resolve a flush without reaching the store underneath, one that forgot
	// `durability` would leave the composition's guarantee unstated, and one that forgot
	// `deleteBlock` would report a block deleted with every byte of it still on disk — so the type
	// checker refuses all three.
}
