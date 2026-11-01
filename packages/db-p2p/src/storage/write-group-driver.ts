import type { BlockId, ActionId } from '@optimystic/db-core';
import type { RawStoreDriver } from './raw-store-driver.js';
import type { FlushOptions, StoreDurability } from './store-durability.js';
import type { StoreIdentity } from './store-identity.js';
import { canonicalStoreKey, type BatchBackend, type BatchEntry, type StoreKey } from './batch-backend.js';
import { WriteGroup, type OverlayValue, type WriteGroupEntry, type WriteGroupOptions, type WriteGroupSink } from './write-group.js';
import { resolveValueCodec, type StoredValue, type ValueCodec, type ValueCodecArgument } from './raw-store-codec.js';

/** The backend's ascending rows with the overlay's puts laid over and its deletes removed, ascending again. */
function mergeRevisions<V extends StoredValue>(backendRows: readonly [number, V][], held: ReadonlyMap<number, OverlayValue<V>>): [number, V][] {
	const rows = new Map(backendRows);
	for (const [rev, value] of held) {
		if (value === null) rows.delete(rev); else rows.set(rev, value);
	}
	return [...rows].sort(([a], [b]) => a - b);
}

/** One overlay write as the backend takes it: the same key, its value as bytes. */
function toBatchEntry<V extends StoredValue>({ key, value }: WriteGroupEntry<StoreKey, V>, codec: ValueCodec<V>): BatchEntry {
	return value === undefined ? { key } : { key, value: codec.toBytes(value) };
}

/**
 * A {@link RawStoreDriver} whose writes wait in memory until the group they belong to is flushed,
 * then reach the {@link BatchBackend} as one `commit` — the shared half of making a backend wait
 * for its disk once per write group instead of once per write, or once per several groups when the
 * flushes allow their sync to wait (`FlushOptions.withinMs`).
 *
 * Every write records its effect in the {@link WriteGroup}'s overlay and open batch and resolves
 * at once, so a write never waits for the disk; `flush()` is the group commit, and `whenDurable()`
 * is the group's. Point reads consult the overlay first (a delete there answers `undefined` without
 * asking the backend), and listings merge the overlay over the backend's rows: overlay puts added,
 * overlay deletes removed, ordered after merging. An entry stays in the overlay until its batch is
 * durable, not merely committed, so over a backend that applies at commit and syncs later a write
 * is briefly in both; every listing merge keys by record, so that duplicate collapses. Every
 * listing takes its overlay snapshot BEFORE awaiting the backend, because a batch becoming durable
 * in between drops entries from the overlay that a backend listing taken before that would not
 * have had — or, for a backend that applies at its sync, would hold only from then on.
 *
 * Values are `V`, bytes by default: the overlay holds them as written, the backend's reads return
 * them, and the kernel above decodes them with the composition's codec. They become bytes in one
 * place — when a sealed group goes to the backend, each value is converted with
 * {@link ValueCodec.toBytes} (the identity for bytes) — so a backend persists bytes whatever this
 * driver holds. A bytes composition may leave the codec out; any other must name it.
 *
 * `promote` is two entries of one batch, which is what makes it atomic and durable on a backend
 * whose `commit` is.
 *
 * The optional members are forwarded exactly as `CachedStoreDriver` forwards them: wired only when
 * the backend has them, never stubbed, so feature detection above sees the backend's true
 * capability; `close` is this driver's own (it flushes first) and is always present.
 */
export class WriteGroupDriver<V extends StoredValue = Uint8Array> implements RawStoreDriver<V> {
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;
	storeIdentity?: () => StoreIdentity;

	/** The backend's: the overlay adds no durability, it only defers the backend's until the flush. */
	readonly durability: StoreDurability;

	private readonly group: WriteGroup<StoreKey, V>;

	constructor(private readonly backend: BatchBackend<V>, options: WriteGroupOptions = {}, ...codecArgument: ValueCodecArgument<V>) {
		const codec = resolveValueCodec(codecArgument);
		this.group = new WriteGroup<StoreKey, V>(canonicalStoreKey, toBytesSink(backend, codec), {
			...options,
			storedBytes: (value: V) => codec.storedBytes(value),
		});
		this.durability = backend.durability;
		if (backend.storeIdentity) {
			this.storeIdentity = () => backend.storeIdentity!();
		}
		if (backend.listBlockIds) {
			this.listBlockIds = () => this.mergedBlockIds();
		}
		if (backend.approximateBytesUsed) {
			this.approximateBytesUsed = () => backend.approximateBytesUsed!();
		}
	}

	// --- metadata ---

	getMetadata(blockId: BlockId): Promise<V | undefined> {
		return this.read({ store: 'metadata', blockId });
	}

	async putMetadata(blockId: BlockId, value: V): Promise<void> {
		this.group.put({ store: 'metadata', blockId }, value);
	}

	// --- revisions ---

	getRevision(blockId: BlockId, rev: number): Promise<V | undefined> {
		return this.read({ store: 'revisions', blockId, rev });
	}

	async putRevision(blockId: BlockId, rev: number, value: V): Promise<void> {
		this.group.put({ store: 'revisions', blockId, rev }, value);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, V]> {
		const held = this.heldRevisions(blockId, lo, hi);
		const backendRows = await this.backend.rangeRevisions(blockId, lo, hi);
		// The backend's rows are already ascending, so only a block the overlay holds revisions of
		// pays for the merge and the sort; `materializeBlock` lists every block it reads.
		const ordered = held.size === 0 ? [...backendRows] : mergeRevisions(backendRows, held);
		if (reverse) ordered.reverse();
		yield* ordered;
	}

	// --- pending ---

	getPending(blockId: BlockId, actionId: ActionId): Promise<V | undefined> {
		return this.read({ store: 'pending', blockId, actionId });
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: V): Promise<void> {
		this.group.put({ store: 'pending', blockId, actionId }, value);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.group.delete({ store: 'pending', blockId, actionId });
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const held = this.heldPendingIds(blockId);
		const ids = new Set(await this.backend.listPendingActionIds(blockId));
		for (const [actionId, value] of held) {
			if (value === null) ids.delete(actionId); else ids.add(actionId);
		}
		yield* ids;
	}

	// --- transactions ---

	getTransaction(blockId: BlockId, actionId: ActionId): Promise<V | undefined> {
		return this.read({ store: 'transactions', blockId, actionId });
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: V): Promise<void> {
		this.group.put({ store: 'transactions', blockId, actionId }, value);
	}

	// --- proofs ---

	getProof(blockId: BlockId, rev: number): Promise<V | undefined> {
		return this.read({ store: 'proofs', blockId, rev });
	}

	async putProof(blockId: BlockId, rev: number, value: V): Promise<void> {
		this.group.put({ store: 'proofs', blockId, rev }, value);
	}

	// --- materialized ---

	getMaterialized(blockId: BlockId, actionId: ActionId): Promise<V | undefined> {
		return this.read({ store: 'materialized', blockId, actionId });
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: V): Promise<void> {
		this.group.put({ store: 'materialized', blockId, actionId }, value);
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.group.delete({ store: 'materialized', blockId, actionId });
	}

	// --- promote ---

	/**
	 * Reads the pending value (overlay, else backend) and records the move as two entries of the
	 * open batch, with no await between them, so no flush can seal one without the other. The value
	 * moves as it was read, unconverted.
	 */
	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.group.throwIfFailed();
		const pending: StoreKey = { store: 'pending', blockId, actionId };
		const value = await this.read(pending);
		if (value === undefined) {
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		this.group.put({ store: 'transactions', blockId, actionId }, value);
		this.group.delete(pending);
	}

	// --- flush / close ---

	flush(options?: FlushOptions): Promise<void> {
		return this.group.flush(options);
	}

	whenDurable(): Promise<void> {
		return this.group.whenDurable();
	}

	/** Flush the remainder once, then close the backend. A commit in flight is waited for first. */
	async close(): Promise<void> {
		try {
			await this.group.close();
		} finally {
			await this.backend.close?.();
		}
	}

	// --- reads ---

	private async read(key: StoreKey): Promise<V | undefined> {
		const held = this.group.lookup(key);
		if (held !== undefined) return held ?? undefined;
		return this.backend.get(key);
	}

	/** The overlay's revision rows for the block inside `[lo, hi]`, snapshotted synchronously. */
	private heldRevisions(blockId: BlockId, lo: number, hi: number): Map<number, OverlayValue<V>> {
		const held = new Map<number, OverlayValue<V>>();
		for (const [key, value] of this.group.entries()) {
			if (key.store === 'revisions' && key.blockId === blockId && key.rev >= lo && key.rev <= hi) {
				held.set(key.rev, value);
			}
		}
		return held;
	}

	/** The overlay's pending puts and deletes for the block, snapshotted synchronously. */
	private heldPendingIds(blockId: BlockId): Map<ActionId, OverlayValue<V>> {
		const held = new Map<ActionId, OverlayValue<V>>();
		for (const [key, value] of this.group.entries()) {
			if (key.store === 'pending' && key.blockId === blockId) {
				held.set(key.actionId, value);
			}
		}
		return held;
	}

	/** Every block whose metadata the overlay holds, snapshotted synchronously (metadata is never deleted). */
	private heldMetadataBlockIds(): Set<BlockId> {
		const held = new Set<BlockId>();
		for (const [key, value] of this.group.entries()) {
			if (key.store === 'metadata' && value !== null) held.add(key.blockId);
		}
		return held;
	}

	/** The backend's block ids as they stream, then the overlay's that the backend did not yield. */
	private async *mergedBlockIds(): AsyncIterable<BlockId> {
		const held = this.heldMetadataBlockIds();
		const seen = new Set<BlockId>();
		for await (const blockId of this.backend.listBlockIds!()) {
			seen.add(blockId);
			yield blockId;
		}
		for (const blockId of held) {
			if (!seen.has(blockId)) yield blockId;
		}
	}
}

/**
 * The write group's sink over `backend`: each sealed group's values converted to bytes on their way
 * to `commit`, since a backend persists bytes whatever the driver holds.
 */
// NOTE: a bytes composition pays one new array of entry objects per commit here, although its
// `toBytes` is the identity and its values are shared; if commit cost ever shows up in profiles, hand
// a bytes group the backend as its sink directly.
function toBytesSink<V extends StoredValue>(backend: BatchBackend<V>, codec: ValueCodec<V>): WriteGroupSink<StoreKey, V> {
	return {
		commit: (entries, options) => backend.commit(entries.map(entry => toBatchEntry(entry, codec)), options),
		sync: () => backend.sync(),
	};
}
