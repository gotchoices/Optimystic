import type { BlockId, ActionId } from "@optimystic/db-core";
import type { RawStoreDriver } from "./raw-store-driver.js";

/**
 * In-memory {@link RawStoreDriver}: the five logical block-storage stores as
 * `Map`s of `Uint8Array` values. `KvRawStorage` hands this driver bytes produced
 * by `JSON`-encode and reads them back via `JSON`-decode, so every get yields a
 * fresh object and every save stored an independent byte snapshot BY
 * CONSTRUCTION — the old `structuredClone`-on-every-get/put discipline is now
 * structural, not a rule a maintainer has to remember. The driver therefore
 * stores the byte reference directly: those bytes are never mutated by the
 * kernel or exposed to callers as a mutable handle.
 */
export class MemoryStoreDriver implements RawStoreDriver {
	private readonly metadata = new Map<BlockId, Uint8Array>();
	private readonly revisions = new Map<string, Uint8Array>(); // `${blockId}:${rev}` -> actionId bytes
	private readonly pending = new Map<string, Uint8Array>();    // `${blockId}:${actionId}` -> transform bytes
	private readonly transactions = new Map<string, Uint8Array>();
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

	// --- optional passthroughs ---

	async *listBlockIds(): AsyncIterable<BlockId> {
		// Snapshot the keys before yielding so a concurrent putMetadata during the scan
		// doesn't invalidate a live map iterator. Fresh in-memory storage is empty, so at
		// real process startup this yields nothing — it exists so the seed path can be
		// unit-tested against a pre-populated store.
		for (const blockId of Array.from(this.metadata.keys())) {
			yield blockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		let total = 0;
		for (const [blockId, value] of this.metadata) {
			total += blockId.length + value.byteLength;
		}
		for (const store of [this.revisions, this.pending, this.transactions, this.materialized]) {
			for (const [key, value] of store) {
				total += key.length + value.byteLength;
			}
		}
		return total;
	}
}
