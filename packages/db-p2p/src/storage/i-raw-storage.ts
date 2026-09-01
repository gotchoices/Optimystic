import type { BlockId, ActionId, ActionRev, Transform, IBlock } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";
import type { BlockMetadata } from "./struct.js";
import type { StoreIdentity } from "./store-identity.js";

export interface IRawStorage {
	// Metadata operations
	getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
	saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;

	// Revision operations
	getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
	saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void>;
	/** List revisions in ascending or descending order, depending on startRev and endRev - startRev and endRev are inclusive */
	listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev>;

	// Action operations
	getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
	savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
	deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
	listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId>;

	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
	saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;

	/**
	 * The commit proof stored for a revision, if one was retained. Keyed by revision: the proof lives
	 * and dies with the REVISION record, not the materialization, so the checkpoint sweep
	 * (`pruneSupersededMaterialization`) never touches it — that is what lets it outlive the
	 * 60-second in-memory commit-cert TTL. Whatever deletes a revision record must delete its proof;
	 * no such site exists today (`RawStoreDriver` has no revision delete at all — invalidations write
	 * compensating FORWARD revisions), so this is a contract note, not a wired path.
	 */
	getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined>;
	saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void>;

	// Block materialization operations
	getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
	saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;

	// Promote a pending action to a committed action
	promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * A stable, process-scoped string naming what this storage is ultimately backed by (a
	 * resolved directory, an open database handle). Wrappers pass it through from whatever they
	 * wrap, so a cache and the storage it fronts name the same store — e.g.
	 * `new CachedRawStorage(new FileRawStorage(dir)).getStoreIdentity()` is `'file:<resolved dir>'`.
	 *
	 * Contract — note it is ONE-DIRECTIONAL; read both halves before consuming it:
	 * - Two storages over DIFFERENT locations MUST NOT return equal strings. So **equality
	 *   proves sameness**, and a consumer may merge on it. (The fs backend documents one exotic
	 *   Windows exception at its own site.)
	 * - Two storages over the SAME location SHOULD return equal strings, but this is
	 *   best-effort and several backends knowingly under-approximate: two handles opened over
	 *   one database, or two spellings of one directory that cannot be collapsed synchronously,
	 *   read as two identities. So **inequality proves nothing** — never treat it as evidence
	 *   that two storages are distinct stores. Each backend's `NOTE:` states its own gaps.
	 * - Every string is scheme-prefixed so backends cannot collide: `file:`, `sqlite-handle:`,
	 *   `idb-handle:`, `leveldb-handle:`. Compared for equality only — never parsed.
	 * - Stable for the storage object's whole life; fixed at construction.
	 * - OPTIONAL BY DESIGN. A backend that cannot honour the contract omits the method entirely
	 *   and callers fall back to per-object behavior. Never install a stub that returns
	 *   `undefined` — feature-detection (`typeof storage.getStoreIdentity === 'function'`) must
	 *   see the backend's true capability, the same trap `KvRawStorage`'s class doc calls out
	 *   for `listBlockIds`.
	 * - It identifies the STORE, not its contents.
	 */
	getStoreIdentity?(): StoreIdentity;

	/**
	 * Optional — present (and only ever `true`) when a write-through read cache
	 * (`CachedStoreDriver`) sits BELOW this storage, whichever of the two documented
	 * constructions built it: `new CachedRawStorage(inner)` or
	 * `new KvRawStorage(new CachedStoreDriver(driver))`. Both contain a `CachedStoreDriver`,
	 * and both report this marker; `withReadCache` reads it to decide whether to attach a
	 * cache, so neither shape is misread as uncached.
	 *
	 * A property, not a method: there is no behavior to invoke, only a fact to report.
	 *
	 * OPTIONAL BY DESIGN, and typed as the literal `true` so "present and false" is
	 * unrepresentable — truthiness IS the feature detection. Never install a `false` stub: an
	 * uncached storage must omit the property entirely, exactly as `getStoreIdentity` /
	 * `listBlockIds` / `getApproximateBytesUsed` are omitted when unsupported.
	 */
	readCached?: true;

	/**
	 * Approximate bytes currently stored by this backend.
	 *
	 * Used by `StorageMonitor` to feed real used-space figures into ring selection.
	 * Implementations should return their best cheap estimate (e.g. on-disk size for
	 * filesystem backends, tracked footprint for in-memory backends). The result is
	 * advisory — `StorageMonitor` treats a missing implementation as 0.
	 */
	getApproximateBytesUsed?(): Promise<number>;

	/**
	 * Enumerate the block ids that currently have durable state in this backend —
	 * one id per block with ANY durable metadata. That includes a block whose only
	 * durable state is an uncommitted pending transform, since
	 * `BlockStorage.savePendingTransaction` writes metadata for a block that has none
	 * before storing the transform. Implementations enumerate metadata keys only; they
	 * must NOT read or decode each block's metadata to filter by committed revision
	 * (that would turn a cheap key scan into a per-block read).
	 *
	 * Used at node startup to seed the resilience monitors' owned-block tracked set
	 * from blocks already on disk from a previous run, so churn-spread / rebalance
	 * protection covers them without waiting for each to be touched again. See the
	 * NOTE in `seedOwnedBlocksFromStorage` for why the over-inclusion is accepted.
	 *
	 * Streamed (AsyncIterable) so a large store does not force the whole id list
	 * into memory at once. Order is unspecified. Optional: a backend that omits it
	 * (or an in-memory backend with nothing durable across a restart) simply yields
	 * no seed — the monitors still populate over time via the live change feed.
	 */
	listBlockIds?(): AsyncIterable<BlockId>;
}
