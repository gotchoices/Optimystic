import { LruMap, assertValidActionId, assertValidBlockId, assertValidRevision, type BlockId, type ActionId, type ActionRev, type Transform, type IBlock } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";
import { createLogger } from "../logger.js";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage, ProofRef, StoredProofEntry } from "./i-raw-storage.js";
import type { RawStoreDriver } from "./raw-store-driver.js";
import type { StoreIdentity } from "./store-identity.js";
import type { FlushOptions, StoreDurability } from "./store-durability.js";
import { resolveValueCodec, type StoredValue, type ValueCodec, type ValueCodecArgument } from "./raw-store-codec.js";

const log = createLogger('storage');

/**
 * How many message hashes one kernel remembers as stored in the commit proofs store. A commit of N
 * blocks saves one proof N times in quick succession; the memo turns N reads of the shared record
 * into one. A forgotten hash costs one read on its next save, nothing more.
 */
const KNOWN_COMMIT_PROOFS = 1024;

function isProofRef(entry: StoredProofEntry): entry is ProofRef {
	return typeof (entry as Partial<ProofRef>).proofRef === 'string';
}

/**
 * Shared ordered-KV storage kernel. Implements the full {@link IRawStorage}
 * surface over a {@link RawStoreDriver}, owning all value (de)serialization and
 * call orchestration so each backend only has to expose its seven logical stores
 * as maps of stored values over its native mechanism.
 *
 * A store's values are `V`, the driver's representation, and every encode and decode goes through
 * the {@link ValueCodec} the store was built with. A bytes driver may leave the codec out (every
 * existing `new KvRawStorage(driver)`); any other representation must name one, or the
 * constructor call does not compile.
 *
 * The genuinely-shared logic lives ABOVE the storage primitive: the JSON/string
 * codec for the value types, `listRevisions`' lo/hi/reverse bound computation,
 * `saveMaterializedBlock`'s put-or-delete branch, and the passthroughs. Key
 * layout / storage topology stays in the driver, because the backends do NOT
 * share one — LevelDB is a single ordered byte keyspace, SQLite seven relational
 * tables, IndexedDB seven object stores, the filesystem a directory tree.
 *
 * **It is also where every identifier is checked.** Three names reach a driver from whoever
 * originated the write, a peer across the network included — the **block id**, which the filesystem
 * backend uses raw as a relative path; the **action id**, which it uses raw as a filename; and the
 * **revision number**, which it uses raw as a filename and the LevelDB backend writes as an unsigned
 * fixed-width key suffix. An unchecked one of any of the three lets a peer make this node write
 * outside its own store, or read a file outside it. Every method here that takes one passes it
 * through {@link checkedId}, {@link checkedActionId} or {@link checkedRev} before it reaches the
 * driver — reads included, so a name outside the store cannot be read either. The rules themselves
 * are `isValidBlockId`, `isValidActionId` and `isValidRevision` in db-core; this is their single
 * enforcement point, which is what lets every key and path builder below the driver boundary trust
 * the names it is given. The checks, which deliberately match the call shape (the escapes keep this
 * very comment from matching):
 *
 * >     grep -rnE "this\.driver\.[a-zA-Z]+\(blockId" packages/db-p2p/src
 * >     grep -rnE "this\.driver\.[a-zA-Z]+\(.*, (actionId|rev)[,)]" packages/db-p2p/src
 *
 * Both must return nothing — every forward below names `this.checkedId(blockId)` and, where it takes
 * one, `this.checkedActionId(actionId)` / `this.checkedRev(rev)`. A hit means a method has started
 * handing the driver an unchecked name: the second pattern is the *bare* argument spelling (`, rev)`,
 * `, actionId,`), which a wrapped one (`, this.checkedRev(rev)`) cannot produce. An action id or a rev
 * is never a driver call's FIRST argument — the block id is — so that pattern needs no
 * leading-position case. The one forward it cannot see is `listRevisions`, which names the locals
 * `lo`/`hi`; those are assigned FROM `checkedRev` on the lines above the call. The complementary check, that nothing
 * serves an `IRawStorage` WITHOUT passing through this kernel:
 *
 * >     grep -rnE "implements\s+IRawStorage" --include=*.ts --exclude-dir=dist --exclude-dir=test packages
 *
 * That must return exactly one line — this class. Every shipping backend (`MemoryRawStorage`,
 * `FileRawStorage`, `IndexedDBRawStorage`, `LevelDBRawStorage`, `SqliteRawStorage`) and the read
 * cache `extends` it rather than implementing the interface itself, so there is no composition on a
 * node path that reaches a driver around the check. A driver or `BatchBackend` constructed and
 * driven directly — only specs do that today — is outside it, which is fine where the spec names
 * its own ids.
 */
export class KvRawStorage<V extends StoredValue = Uint8Array> implements IRawStorage {
	/**
	 * Optional passthroughs are wired in the constructor ONLY when the driver
	 * provides them, so a `StorageAccount` / owned-block seed that feature-detects
	 * (`typeof storage.listBlockIds === 'function'`) sees the driver's true
	 * capability instead of a stub that silently reports 0 / no seed. The same rule
	 * governs `getStoreIdentity`: a stub returning `undefined` would make every store
	 * look identity-less to consumers that dedupe on it. `readCached` follows the same rule
	 * for the same reason: it is set only when the driver reports a read cache at or below
	 * itself, so `withReadCache` sees whether this composition is REALLY already cached
	 * rather than inferring it from a concrete class name (see {@link IRawStorage.readCached}).
	 * `close` likewise: only a driver with something to close gets one here.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	getApproximateBytesUsed?: () => Promise<number>;
	getApproximateBytesFree?: () => Promise<number>;
	getStoreIdentity?: () => StoreIdentity;
	readCached?: true;
	close?: () => Promise<void>;

	/** Copied from the driver once, at construction — a store's durability never changes over its life. */
	readonly durability: StoreDurability;

	private readonly codec: ValueCodec<V>;

	/**
	 * Message hash → the save that put (or found) its proof in the commit proofs store: in flight, or
	 * settled. Joining an in-flight save is what keeps two concurrent saves of one message — a commit's
	 * apply and a certified push of another of its blocks, under different block latches — to one write.
	 * A save that rejects is dropped, so the next save of that message retries. An entry evicted while
	 * still in flight (1024 other messages saved meanwhile) costs the next save of its message a second
	 * read, and at worst a second write of that message's record; every reference still names it.
	 *
	 * Never stale: nothing deletes a commit proof, and a store that faults refuses every later write
	 * until it is reopened, which builds a new kernel with an empty memo.
	 */
	private readonly storedCommitProofs = new LruMap<string, Promise<void>>(KNOWN_COMMIT_PROOFS);

	constructor(private readonly driver: RawStoreDriver<V>, ...codec: ValueCodecArgument<V>) {
		this.codec = resolveValueCodec(codec);
		this.durability = driver.durability;
		if (driver.storeIdentity) {
			this.getStoreIdentity = () => driver.storeIdentity!();
		}
		if (driver.listBlockIds) {
			this.listBlockIds = () => driver.listBlockIds!();
		}
		if (driver.approximateBytesUsed) {
			this.getApproximateBytesUsed = () => driver.approximateBytesUsed!();
		}
		if (driver.approximateBytesFree) {
			this.getApproximateBytesFree = () => driver.approximateBytesFree!();
		}
		if (driver.readCached) {
			this.readCached = true;
		}
		if (driver.close) {
			this.close = () => driver.close!();
		}
	}

	/**
	 * The id, once it is known to name a location inside the store; see `isValidBlockId` in db-core
	 * for the rule and the class comment above for why this is the one place it is applied. Called
	 * before the driver is touched, so a refused id rejects that one call and leaves the store usable
	 * — a throw from inside a write group would instead latch the store failed and refuse every later
	 * write until it is reopened (the flush contract's rule 5, `RawStoreDriver.flush`), which is
	 * exactly what a peer naming a bad id must not be able to do to a node.
	 */
	private checkedId(blockId: BlockId): BlockId {
		assertValidBlockId(blockId);
		return blockId;
	}

	/**
	 * The action id, once it is known to name one record inside the store; see `isValidActionId` in
	 * db-core for the rule. Same placement and same reason as {@link checkedId}: the filesystem
	 * backend spells an action id into a record's FILENAME, so an id carrying `../` reaches the
	 * write-ahead log's containment guard on the live commit path, where a throw latches the store
	 * instead of refusing one request.
	 */
	private checkedActionId(actionId: ActionId): ActionId {
		assertValidActionId(actionId);
		return actionId;
	}

	/**
	 * The revision number, once it is known to name a location inside the store; see `isValidRevision`
	 * in db-core for the rule. Same placement and same reason as {@link checkedId}: a rev is spelled
	 * into a filename by the filesystem backend and into an unsigned fixed-width key suffix by the
	 * LevelDB one, and both fail from inside their write path — a latch rather than a refusal.
	 */
	private checkedRev(rev: number): number {
		assertValidRevision(rev);
		return rev;
	}

	// --- Metadata ---

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		const value = await this.driver.getMetadata(this.checkedId(blockId));
		return value === undefined ? undefined : this.codec.decodeJson<BlockMetadata>(value);
	}

	// NOTE: every value write funnels through the driver put/delete calls in the
	// methods below (saveMetadata / saveRevision / save*Transaction /
	// saveProofEntry / saveCommitProof / storeCommitProofIfAbsent / saveMaterializedBlock). This is the single choke point where an incremental
	// byte counter would hook in, replacing the per-driver full-scan
	// getApproximateBytesUsed. The chosen capacity-estimate mechanism is instead a
	// short-TTL cache over the full scan in StorageAccount (see storage-account.ts
	// `usedBytesCacheTtlMs`) — backend-agnostic, no write-path changes, and ring
	// selection tolerates the bounded staleness by design. The counter remains a
	// future option only if TTL staleness ever proves insufficient; do NOT
	// implement it here — leave the write path a single seam.
	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.driver.putMetadata(this.checkedId(blockId), this.codec.encodeJson(metadata));
	}

	// --- Revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		const value = await this.driver.getRevision(this.checkedId(blockId), this.checkedRev(rev));
		return value === undefined ? undefined : this.codec.decodeActionId(value);
	}

	/**
	 * The action id is checked even though it is stored as this record's VALUE rather than spelled into
	 * its key: `materializeBlock` reads a revision record and then asks for the materialization under
	 * the id it found, so an id written here unchecked is one a later `getMaterializedBlock` turns
	 * into a path.
	 */
	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.driver.putRevision(this.checkedId(blockId), this.checkedRev(rev), this.codec.encodeActionId(this.checkedActionId(actionId)));
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		// Both bounds inclusive; ordering follows startRev→endRev direction. Empty
		// revs are skipped by the driver's range. Preserves the exact semantics of
		// every existing backend.
		const ascending = startRev <= endRev;
		const lo = this.checkedRev(ascending ? startRev : endRev);
		const hi = this.checkedRev(ascending ? endRev : startRev);
		for await (const [rev, value] of this.driver.rangeRevisions(this.checkedId(blockId), lo, hi, !ascending)) {
			yield { rev, actionId: this.codec.decodeActionId(value) };
		}
	}

	// --- Pending transactions ---

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const value = await this.driver.getPending(this.checkedId(blockId), this.checkedActionId(actionId));
		return value === undefined ? undefined : this.codec.decodeJson<Transform>(value);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.driver.putPending(this.checkedId(blockId), this.checkedActionId(actionId), this.codec.encodeJson(transform));
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.driver.deletePending(this.checkedId(blockId), this.checkedActionId(actionId));
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		yield* this.driver.listPendingActionIds(this.checkedId(blockId));
	}

	// --- Committed transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const value = await this.driver.getTransaction(this.checkedId(blockId), this.checkedActionId(actionId));
		return value === undefined ? undefined : this.codec.decodeJson<Transform>(value);
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.driver.putTransaction(this.checkedId(blockId), this.checkedActionId(actionId), this.codec.encodeJson(transform));
	}

	// --- Commit proofs (their OWN (blockId, rev)-keyed store — see RawStoreDriver.getProof) ---
	//
	// Proofs deliberately do NOT share the transactions keyspace. Action ids are
	// chosen by whoever originates a write and are never re-derived by the storing
	// node, so no reserved action-id prefix can be relied on: a client
	// pending an action literally named `~proof:5`, or a peer's restore archive naming
	// one, used to land on the same key as revision 5's proof and silently overwrite it
	// (or be overwritten by it). Separate stores make that collision unrepresentable.
	//
	// `isValidActionId` (applied by {@link checkedActionId}) does not retire that decision. It is a
	// CONTAINMENT rule — an id must name one record inside the store and must not alias another id —
	// and it reserves no prefix and imposes no format, so `~proof:5` is still a legal action id and a
	// writer may still choose a name this node has no way to predict.
	//
	// A revision's entry names the proof by its message hash rather than holding it: one proof covers
	// every block its commit changed and lists them all, so a copy per block grew a commit's stored
	// bytes with the square of its block count (GitHub #60).

	async getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		const entry = await this.getProofEntry(blockId, rev);
		if (entry === undefined || !isProofRef(entry)) {
			// NOTE: an entry holding a whole proof was written by a build before proofs were stored once
			// per message. It is read, never rewritten as a reference; if a deployed store ever needs that
			// space back, add a pass that rewrites such entries as references.
			return entry;
		}
		const proof = await this.getCommitProof(entry.proofRef);
		if (proof === undefined) {
			// Unreachable while `saveBlockProof` writes the target first and a crash keeps a prefix of
			// the writes in order. No proof is an answer every reader already handles.
			log('proof-ref-dangling blockId=%s rev=%d messageHash=%s', blockId, rev, entry.proofRef);
		}
		return proof;
	}

	async saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void> {
		// Checked HERE, not only by `saveProofEntry` below: a refused name must cost the store nothing,
		// and `ensureCommitProof` would by then have written — and memoized — a proof body for a block
		// that can never hold a reference to it. The rev gets the same treatment, for the same reason.
		const checked = this.checkedId(blockId);
		const checkedRev = this.checkedRev(rev);
		const ref: ProofRef = { proofRef: proof.messageHash };
		// The shared record before the reference: by the flush contract's prefix rule (rule 3 at
		// `RawStoreDriver.flush`) the reference then never survives a crash without its target.
		await this.ensureCommitProof(proof);
		await this.saveProofEntry(checked, checkedRev, ref);
	}

	async getProofEntry(blockId: BlockId, rev: number): Promise<StoredProofEntry | undefined> {
		const value = await this.driver.getProof(this.checkedId(blockId), this.checkedRev(rev));
		return value === undefined ? undefined : this.codec.decodeJson<StoredProofEntry>(value);
	}

	async saveProofEntry(blockId: BlockId, rev: number, entry: StoredProofEntry): Promise<void> {
		await this.driver.putProof(this.checkedId(blockId), this.checkedRev(rev), this.codec.encodeJson(entry));
	}

	/** Resolves once the commit proofs store holds a proof under `proof.messageHash`; see {@link storedCommitProofs}. */
	private ensureCommitProof(proof: BlockCommitProof): Promise<void> {
		const messageHash = proof.messageHash;
		const known = this.storedCommitProofs.get(messageHash);
		if (known !== undefined) {
			return known;
		}
		const storing = this.storeCommitProofIfAbsent(messageHash, this.codec.encodeJson(proof));
		this.storedCommitProofs.set(messageHash, storing);
		storing.catch(() => {
			if (this.storedCommitProofs.peek(messageHash) === storing) {
				this.storedCommitProofs.delete(messageHash);
			}
		});
		return storing;
	}

	/**
	 * First writer wins: a proof already stored under the hash is kept.
	 *
	 * NOTE: accepted tradeoff — two proofs of one message can carry different signature sets (this
	 * node's own record, and a later verified push), and the first stored serves every block of that
	 * commit; a later verified proof is not preferred over it. The only known way the first fails
	 * verification is an older-build member whose own record carried a late promise (docs/internals.md,
	 * *Mixed versions* under *Both consensus rounds carry the coordinator's own member's vote*), which
	 * already makes that member's own proof its own loss — now also for a block whose entry was empty
	 * and later back-filled. Revisit if such proofs are seen in the field.
	 */
	private async storeCommitProofIfAbsent(messageHash: string, encoded: V): Promise<void> {
		if (await this.driver.getCommitProof(messageHash) === undefined) {
			await this.driver.putCommitProof(messageHash, encoded);
		}
	}

	// --- Commit proofs by message hash (see RawStoreDriver.getCommitProof) ---

	async getCommitProof(messageHash: string): Promise<BlockCommitProof | undefined> {
		const value = await this.driver.getCommitProof(messageHash);
		return value === undefined ? undefined : this.codec.decodeJson<BlockCommitProof>(value);
	}

	async saveCommitProof(messageHash: string, proof: BlockCommitProof): Promise<void> {
		await this.driver.putCommitProof(messageHash, this.codec.encodeJson(proof));
	}

	// --- Materialized blocks ---

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		const value = await this.driver.getMaterialized(this.checkedId(blockId), this.checkedActionId(actionId));
		return value === undefined ? undefined : this.codec.decodeJson<IBlock>(value);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		// Present ⇒ put the materialized block; absent ⇒ delete (tombstone / truncation).
		if (block) {
			await this.driver.putMaterialized(this.checkedId(blockId), this.checkedActionId(actionId), this.codec.encodeJson(block));
		} else {
			await this.driver.deleteMaterialized(this.checkedId(blockId), this.checkedActionId(actionId));
		}
	}

	// --- Promote (the only cross-key atomic op; driver owns atomicity) ---

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.driver.promote(this.checkedId(blockId), this.checkedActionId(actionId));
	}

	// --- Delete a whole block (the driver owns the ordering; see RawStoreDriver.deleteBlock) ---

	/**
	 * Nothing to compose: there is no value to encode, and the ordering the operation needs — the
	 * metadata record removed and durable before any content store is touched — cannot be composed
	 * here. The kernel has no metadata DELETE to call (every invalidation writes a compensating
	 * forward revision instead), and it cannot enumerate a block's revisions to remove them one by
	 * one: `rangeRevisions` is a bounded scan and the top revision is only knowable from the very
	 * metadata the operation removes. Each backend has a cheap native answer for "everything under
	 * this block" — three of the four do the whole thing in one atomic transaction or batch, which is
	 * stronger than the ordering the contract asks for — so the operation is theirs and this is a
	 * delegation.
	 *
	 * No change notification is emitted, deliberately: the block's CONTENT has not changed, this node
	 * has merely stopped holding it, and a change event would send trackers and the reactivity layer
	 * to re-read a block this node is no longer the place to ask. See
	 * `packages/db-p2p/docs/storage.md` § *Deleting a block*.
	 */
	async deleteBlock(blockId: BlockId): Promise<void> {
		await this.driver.deleteBlock(this.checkedId(blockId));
	}

	// --- Flush (what a flush does is the driver's; see RawStoreDriver.flush for the contract) ---

	flush(options?: FlushOptions): Promise<void> {
		return this.driver.flush(options);
	}

	whenDurable(): Promise<void> {
		return this.driver.whenDurable();
	}
}
