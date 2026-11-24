import type { BlockId, ActionId } from "@optimystic/db-core";
import type { RawStoreDriver } from "./raw-store-driver.js";
import type { FlushOptions, StoreDurability } from "./store-durability.js";

/**
 * In-memory {@link RawStoreDriver}: the seven logical block-storage stores as
 * `Map`s of `Uint8Array` values. `KvRawStorage` hands this driver bytes produced
 * by `JSON`-encode and reads them back via `JSON`-decode, so every get yields a
 * fresh object and every save stored an independent byte snapshot BY
 * CONSTRUCTION — the old `structuredClone`-on-every-get/put discipline is now
 * structural, not a rule a maintainer has to remember. The driver therefore
 * stores the byte reference directly: those bytes are never mutated by the
 * kernel or exposed to callers as a mutable handle.
 */
export class MemoryStoreDriver implements RawStoreDriver {
	// Nothing in a Map survives a restart.
	readonly durability: StoreDurability = 'none';

	private readonly metadata = new Map<BlockId, Uint8Array>();
	private readonly revisions = new Map<string, Uint8Array>(); // `${blockId}:${rev}` -> actionId bytes
	private readonly pending = new Map<string, Uint8Array>();    // `${blockId}:${actionId}` -> transform bytes
	private readonly transactions = new Map<string, Uint8Array>();
	private readonly proofs = new Map<string, Uint8Array>();       // `${blockId}:${rev}` -> proof bytes
	private readonly commitProofs = new Map<string, Uint8Array>(); // messageHash -> proof bytes
	private readonly materialized = new Map<string, Uint8Array>();

	private revisionKey(blockId: BlockId, rev: number): string {
		return `${blockId}:${rev}`;
	}

	private actionKey(blockId: BlockId, actionId: ActionId): string {
		return `${blockId}:${actionId}`;
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		return this.metadata.get(blockId);
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		this.metadata.set(blockId, value);
	}

	// --- revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.revisions.get(this.revisionKey(blockId, rev));
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		this.revisions.set(this.revisionKey(blockId, rev), value);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		// Drain into an array before yielding (drain-before-yield contract): the
		// consumer awaits between yields, and a Map has no live cursor to pin, but
		// this keeps the memory driver's semantics identical to the native backends.
		const results: [number, Uint8Array][] = [];
		for (let rev = lo; rev <= hi; rev++) {
			const value = this.revisions.get(this.revisionKey(blockId, rev));
			if (value !== undefined) {
				results.push([rev, value]);
			}
		}
		if (reverse) {
			results.reverse();
		}
		for (const result of results) {
			yield result;
		}
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.pending.get(this.actionKey(blockId, actionId));
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.pending.set(this.actionKey(blockId, actionId), value);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.pending.delete(this.actionKey(blockId, actionId));
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const prefix = `${blockId}:`;
		// Snapshot before yielding (drain-before-yield): a concurrent putPending during
		// the scan must not invalidate a live map iterator.
		const ids: ActionId[] = [];
		for (const key of Array.from(this.pending.keys())) {
			if (key.startsWith(prefix)) {
				ids.push(key.substring(prefix.length) as ActionId);
			}
		}
		for (const id of ids) {
			yield id;
		}
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.transactions.get(this.actionKey(blockId, actionId));
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.transactions.set(this.actionKey(blockId, actionId), value);
	}

	// --- proofs (keyed like revisions, NOT like actions — see RawStoreDriver.getProof) ---

	async getProof(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.proofs.get(this.revisionKey(blockId, rev));
	}

	async putProof(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		this.proofs.set(this.revisionKey(blockId, rev), value);
	}

	// --- commit proofs (keyed by message hash alone) ---

	async getCommitProof(messageHash: string): Promise<Uint8Array | undefined> {
		return this.commitProofs.get(messageHash);
	}

	async putCommitProof(messageHash: string, value: Uint8Array): Promise<void> {
		this.commitProofs.set(messageHash, value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.materialized.get(this.actionKey(blockId, actionId));
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.materialized.set(this.actionKey(blockId, actionId), value);
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.materialized.delete(this.actionKey(blockId, actionId));
	}

	// --- promote (atomic move; synchronous Map ops make it indivisible here) ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		const key = this.actionKey(blockId, actionId);
		const value = this.pending.get(key);
		if (value === undefined) {
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		this.transactions.set(key, value);
		this.pending.delete(key);
	}

	// --- delete a whole block (see RawStoreDriver.deleteBlock) ---

	/**
	 * Drop the block's entries from the six block-scoped maps, leaving {@link commitProofs} alone.
	 * Synchronous map operations with no `await` between them, so the ordering the contract asks for
	 * (metadata first, durably) is met trivially: no observer can see a half-done delete, and with
	 * `durability` `'none'` there is nothing to make durable. Idempotent: a missing key deletes
	 * nothing.
	 */
	// NOTE: the key-scoped maps are matched by the `${blockId}:` prefix, which is not length-prefixed,
	// so block `a`'s prefix also matches block `a:b`'s keys and this would take them too. That needs a
	// block id CONTAINING A COLON, and none does: ids are base64url, or `/`-separated names like
	// `default/app/Ledger`, whose nested child `default/app/Ledger/index` keys as
	// `default/app/Ledger/index:<rev>` and so does NOT match `default/app/Ledger:`. The `/`-nesting
	// hazard the filesystem backend's raw-id directory layout really has (`BLOCK_STORE_DIRS` in
	// `packages/db-p2p-storage-fs/src/file-batch-backend.ts`) is therefore NOT shared here — do not
	// read the two as one limit. If a block id ever carries a colon, key these maps through
	// `canonicalStoreKey`, which length-prefixes as the batch backends do.
	async deleteBlock(blockId: BlockId): Promise<void> {
		this.metadata.delete(blockId);
		const prefix = `${blockId}:`;
		for (const store of [this.revisions, this.pending, this.transactions, this.proofs, this.materialized]) {
			for (const key of Array.from(store.keys())) {
				if (key.startsWith(prefix)) store.delete(key);
			}
		}
	}

	// --- flush ---

	// No-op: with durability 'none' there is nothing for a flush, or a deferred sync, to protect.
	flush(_options?: FlushOptions): Promise<void> {
		return Promise.resolve();
	}

	whenDurable(): Promise<void> {
		return Promise.resolve();
	}

	// --- optional passthroughs ---

	// Deliberately NO storeIdentity(): two MemoryStoreDrivers hold two independent Maps and are
	// genuinely two different stores, so there is no shared "location" for them to name.
	//
	// NOTE: one driver object shared by two `KvRawStorage` wrappers is NOT covered. `withReadCache`
	// falls back to keying on the STORAGE object, not the driver, so those two wrappers are two
	// keys and get two read caches over one Map — the divergence dedupe exists to remove. Harmless
	// today: this driver is a test fixture and every shipping backend's driver reports an identity,
	// so the identity-less path only ever sees genuinely distinct stores. If a host ever wires
	// `new KvRawStorage(oneSharedDriver)` as the `blocks` store for two consumers, give this
	// driver `identityForHandle('memory', this)` (store-identity.ts) — that makes the two wrappers
	// name one store — and re-premise `local-transactor-read-cache.spec.ts`, which currently
	// asserts the non-dedupe.

	async *listBlockIds(): AsyncIterable<BlockId> {
		// Snapshot the keys before yielding so a concurrent putMetadata during the scan
		// doesn't invalidate a live map iterator. Fresh in-memory storage is empty, so at
		// real process startup this yields nothing — it exists so the seed path can be
		// unit-tested against a pre-populated store.
		for (const blockId of Array.from(this.metadata.keys())) {
			yield blockId;
		}
	}

	// NOTE: no `approximateBytesFree`, for the reason there is no `storeIdentity` either — there is no
	// location. The free space of a `Map` is the heap, which is not a storage allotment: a node that
	// read it as one would size its responsibility by how much memory the process happens to have
	// left. Omitted entirely rather than stubbed, so a consumer's feature detection sees that.
	async approximateBytesUsed(): Promise<number> {
		let total = 0;
		for (const [blockId, value] of this.metadata) {
			total += blockId.length + value.byteLength;
		}
		for (const store of [this.revisions, this.pending, this.transactions, this.proofs, this.commitProofs, this.materialized]) {
			for (const [key, value] of store) {
				total += key.length + value.byteLength;
			}
		}
		return total;
	}
}
