import type { BlockId, ActionId, ActionRev, Transform, IBlock } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";
import type { BlockMetadata } from "./struct.js";
import type { StoreIdentity } from "./store-identity.js";
import type { FlushOptions, StoreDurability } from "./store-durability.js";

/** A revision's entry in the proofs store: the `messageHash` of the proof held in the commit proofs store. */
export type ProofRef = { proofRef: string };

/**
 * What a proofs-store entry may hold: a {@link ProofRef}, or — written by a build before proofs were
 * stored once per consensus message — the whole proof.
 */
export type StoredProofEntry = ProofRef | BlockCommitProof;

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
	 * The commit proof stored for a revision, if one was retained. Keyed by revision: the entry lives
	 * and dies with the REVISION record, not the materialization, so the checkpoint sweep
	 * (`pruneSupersededMaterialization`) never touches it — that is what lets it outlive the
	 * 60-second in-memory commit-cert TTL. The one site that removes a revision record removes a
	 * whole block's, {@link deleteBlock}, and it removes this store's ENTRIES for that block with
	 * them; there is no narrower revision delete (invalidations write compensating FORWARD
	 * revisions), so a single revision's entry is never removed on its own.
	 *
	 * Composed: the revision's entry ({@link getProofEntry}) is usually a {@link ProofRef}, resolved
	 * through {@link getCommitProof}; an entry holding a whole proof (an earlier build's) is returned
	 * as it is. A reference whose target is missing answers `undefined`.
	 */
	getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined>;

	/**
	 * Retain `proof` for a revision. Composed: the proof is stored once under its `messageHash` in
	 * the commit proofs store, before the revision's entry is written as a {@link ProofRef} to it, so
	 * a reference never survives a crash without its target. A proof already stored under that hash
	 * is kept, not replaced: the first proof stored for a message serves every revision naming it.
	 *
	 * Precondition: `proof.messageHash` is the hash of `proof.message`. Every proof reaching here was
	 * built on this node from its own consensus record, minted by this node, or verified (which
	 * recomputes the hash and refuses a mismatch); nothing here checks it.
	 *
	 * A stored proof is never deleted. {@link deleteBlock} removes the deleted block's ENTRIES in the
	 * proofs store, but not the proof bodies they referred to: a body is keyed by its consensus
	 * message's hash, one per message however many blocks it covered, so it may still certify
	 * revisions of blocks this node keeps, and nothing counts how many revisions name it. A body no
	 * revision names any more therefore stays on disk — the residual the backlog ticket
	 * `debt-unreferenced-commit-proofs-are-never-swept` is about.
	 */
	saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void>;

	/**
	 * The proofs store's raw entry for a revision, undecoded beyond JSON: a {@link ProofRef}, a whole
	 * proof an earlier build wrote, or `undefined`. For a caller that moves entries between stores
	 * (`RawStorageDriverAdapter`) or only asks whether one exists (`IBlockStorage.hasBlockProof`);
	 * everything else reads {@link getBlockProof}.
	 */
	getProofEntry(blockId: BlockId, rev: number): Promise<StoredProofEntry | undefined>;
	/** Write a revision's proofs-store entry as given — no commit proof is stored. See {@link getProofEntry}. */
	saveProofEntry(blockId: BlockId, rev: number, entry: StoredProofEntry): Promise<void>;

	/**
	 * The commit proof stored under a consensus message's hash (`BlockCommitProof.messageHash`), one
	 * per message however many blocks it covers. Raw access only: what to store here and when to read
	 * it is the caller's. No delete exists, and {@link deleteBlock} does not touch this store: a key
	 * names a message, not a block, so one entry may still certify revisions of blocks this node
	 * keeps. See {@link saveBlockProof} for what that leaves behind.
	 */
	getCommitProof(messageHash: string): Promise<BlockCommitProof | undefined>;
	saveCommitProof(messageHash: string, proof: BlockCommitProof): Promise<void>;

	// Block materialization operations
	getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
	saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;

	// Promote a pending action to a committed action
	promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * Remove everything this storage holds for one block — the only operation that takes bytes back
	 * off a node, for a block it has stopped being responsible for. The contract is stated in full on
	 * `RawStoreDriver.deleteBlock` and `BatchBackend.deleteBlock`
	 * (`packages/db-p2p/src/storage/batch-backend.ts`) and holds identically here:
	 *
	 * - It removes the SIX block-scoped stores' records for the block — metadata, revisions,
	 *   pending, transactions, materialized, proofs — and NOT the commit proofs store (see
	 *   {@link getCommitProof}).
	 * - Metadata first and durably, then the rest: a crash in the middle leaves content with no
	 *   metadata, which reads as a block this node does not hold; never the reverse.
	 * - Idempotent, so a sweep may re-run it for the same block id after a restart.
	 * - It emits no change notification: the block's content has not changed, this node has stopped
	 *   holding it.
	 *
	 * Callers go through {@link IBlockStorage.deleteBlock}, which takes the block's write latch —
	 * Invariant 2 of `packages/db-p2p/docs/storage.md`, and a delete is the widest write there is.
	 * Required, not optional, for the reason {@link flush} is: a wrapper that forgot to forward it
	 * would report a block deleted with every byte of it still on disk.
	 */
	deleteBlock(blockId: BlockId): Promise<void>;

	/**
	 * Make every write that resolved before this call survive the crashes {@link durability} names,
	 * at once or within `options.withinMs`. Holds to the flush contract stated in full on
	 * `RawStoreDriver.flush` (`packages/db-p2p/src/storage/raw-store-driver.ts`). Required, not
	 * optional, so a wrapper that forgets to forward it does not type-check.
	 */
	flush(options?: FlushOptions): Promise<void>;

	/**
	 * Resolves once every write covered by a flush that resolved before this call survives every
	 * crash {@link durability} names, without hastening any sync; rejects with `StoreFailedError`
	 * once the storage has failed. The contract is `RawStoreDriver.whenDurable`'s. Required for the
	 * same reason as `flush`.
	 */
	whenDurable(): Promise<void>;

	/**
	 * What a write survives once a `flush()` called after it has resolved. Fixed at construction and
	 * never changes over the storage's life, like {@link getStoreIdentity}; a wrapper reports the value
	 * of the storage it fronts. Required for the same reason as `flush`.
	 */
	readonly durability: StoreDurability;

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
	 * Read by `StorageAccount` as the whole of what the node has stored (its other two stores live
	 * inside what this one measures — see `assertOneMeasuredLocation`), and so as the figure ring
	 * selection prices its coverage against. Implementations should return their best cheap estimate
	 * (e.g. on-disk size for filesystem backends, tracked footprint for in-memory backends). The
	 * result is advisory — `StorageAccount` treats a missing implementation as 0.
	 */
	getApproximateBytesUsed?(): Promise<number>;

	/**
	 * The bytes this storage's LOCATION will still accept, by the backend's cheapest honest
	 * measure — what a node reads to know how much room the disk it was given has left.
	 *
	 * - Advisory and may be stale, exactly as {@link getApproximateBytesUsed} is. It is the
	 *   LOCATION's free space, not this store's share of it, so two stores over one location
	 *   answer the same figure; that is why an accounting of a node's room asks the block store
	 *   and nobody else.
	 * - **A failed read REJECTS; it never answers 0.** 0 means "full", and a transient failure
	 *   that read as full would make a node shed responsibility it did not need to shed. The
	 *   consumer catches, logs, and treats the figure as unknown for that scan.
	 * - Presence is fixed for the storage's life, like {@link getStoreIdentity}.
	 * - OPTIONAL BY DESIGN, under the same rule as every optional member here: a backend that
	 *   cannot ask its platform how much room is left omits the method ENTIRELY and never
	 *   installs a stub answering 0, so feature-detection
	 *   (`typeof storage.getApproximateBytesFree === 'function'`) sees the backend's true
	 *   capability. The filesystem (`statfs`) and browser (`navigator.storage.estimate()`)
	 *   backends have one; the SQLite and LevelDB packages are handed an open handle with no
	 *   path to ask about, and a memory store's "free space" is the heap, which is not a
	 *   storage allotment — all three omit it.
	 */
	getApproximateBytesFree?(): Promise<number>;

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

	/**
	 * Optional — flush whatever the storage still holds in memory and release what it holds open
	 * (a log handle, a lock, a cache registration). The storage is not usable afterwards. Present
	 * only when the storage really has something to close, under the same feature-detection rule as
	 * `listBlockIds`: `KvRawStorage` wires it when its driver has one and never installs a stub, so
	 * `typeof storage.close === 'function'` sees the backend's true capability. A host that was
	 * handed a storage does not close it; the one that built it does.
	 */
	close?(): Promise<void>;
}
