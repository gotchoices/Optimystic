import { WriteGroup, type CommittedBatch, type FlushOptions, type IKVStore, type WriteGroupEntry, type WriteGroupOptions } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';
import { resolveStrictDurability, transactionDurability, type IndexedDBDurabilityOptions } from './durability.js';

/** The write group's options (`idleFlushMs`, `maxUnsyncedBytes`, the test-only `setTimer`), and whether to ask for strict transactions. */
export type IndexedDBKVStoreOptions = WriteGroupOptions & IndexedDBDurabilityOptions;

const encoder = new TextEncoder();
// Built on first use rather than at module load, like every other `TextDecoder` in library source
// (see NO_MODULE_SCOPE_TEXT_DECODER in eslint.config.js).
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

/**
 * IndexedDB-backed `IKVStore` adapter for browser peers.
 *
 * Stored keys are namespaced with `prefix` so the `kv` object store can be shared with the identity
 * helper without collisions. `list(prefix)` uses a range-bounded key cursor — never `getAllKeys()` —
 * so a large `kv` store does not pay an O(n) JS-side filter cost.
 *
 * Writes go through a {@link WriteGroup} over the plain keys, as `FileKVStore` does: a `set` or
 * `delete` resolves into memory, served from there to `get` and `list`, and `flush()` commits
 * everything written since the last flush as ONE `readwrite` transaction on `kv`, strict where the
 * browser supports it (`supportsStrictDurability`), so the writes are on the disk before the flush
 * resolves. Every flush the node makes of this store is strict, and so is the group's own idle
 * flush, so there is no relaxed path to journal: a flush given a window is treated as strict, as a
 * store that cannot defer a sync treats every window. A failed commit latches the store, after which
 * every write and flush throws `StoreFailedError` (rule 5 of the flush contract on
 * `RawStoreDriver.flush`); reads keep serving the overlay.
 */
export class IndexedDBKVStore implements IKVStore {
	private readonly group: WriteGroup<string>;
	private readonly strict: boolean;

	constructor(
		private readonly db: OptimysticWebDBHandle,
		private readonly prefix: string = 'optimystic:txn:',
		options: IndexedDBKVStoreOptions = {},
	) {
		this.strict = resolveStrictDurability(options);
		this.group = new WriteGroup<string>(key => key, {
			commit: entries => this.commit(entries),
			// Every commit is as durable as this store can make it when it resolves, so nothing is ever owed a sync.
			sync: () => Promise.resolve(),
		}, options);
	}

	async get(key: string): Promise<string | undefined> {
		const held = this.group.lookup(key);
		if (held !== undefined) return held === null ? undefined : decoder().decode(held);
		const value = await this.db.get('kv', this.prefix + key);
		return typeof value === 'string' ? value : undefined;
	}

	async set(key: string, value: string): Promise<void> {
		this.group.put(key, encoder.encode(value));
	}

	async delete(key: string): Promise<void> {
		this.group.delete(key);
	}

	/** Every key under `prefix`: the store's, plus those written and not yet flushed, less those deleted and not yet flushed. */
	async list(prefix: string): Promise<string[]> {
		// Taken before awaiting the store: a commit resolving meanwhile drops entries from the overlay
		// that the listing below may have been taken without.
		const held = [...this.group.entries()].filter(([key]) => key.startsWith(prefix));
		const keys = new Set(await this.listStored(prefix));
		for (const [key, value] of held) {
			if (value === null) keys.delete(key);
			else keys.add(key);
		}
		return [...keys];
	}

	/** Make every write resolved before this call durable: one transaction, strict where supported, whatever `options.withinMs` says. The contract is `RawStoreDriver.flush`'s. */
	flush(options?: FlushOptions): Promise<void> {
		return this.group.flush(options);
	}

	/** Resolves once every write covered by a flush that resolved before this call is durable; `RawStoreDriver.whenDurable`'s contract. */
	whenDurable(): Promise<void> {
		return this.group.whenDurable();
	}

	/** Flush what is still held and disarm the idle timer. The host closes the shared handle after this resolves. */
	close(): Promise<void> {
		return this.group.close();
	}

	private async commit(entries: readonly WriteGroupEntry<string>[]): Promise<CommittedBatch> {
		const tx = this.db.transaction('kv', 'readwrite', { durability: transactionDurability(this.strict) });
		// Queued synchronously and awaited together with the transaction: IndexedDB commits a transaction that is left idle.
		const requests = entries.map(({ key, value }) => value === undefined
			? tx.store.delete(this.prefix + key)
			: tx.store.put(decoder().decode(value), this.prefix + key));
		await Promise.all([...requests, tx.done]);
		return { durable: Promise.resolve() };
	}

	private async listStored(prefix: string): Promise<string[]> {
		const fullPrefix = this.prefix + prefix;
		// '￿' is the highest BMP code unit; appending it produces a string
		// that is >= every string starting with `fullPrefix`. IndexedDB compares
		// strings by UTF-16 code units, so this bound is exact.
		const range = IDBKeyRange.bound(fullPrefix, fullPrefix + '￿');
		const tx = this.db.transaction('kv', 'readonly');
		const store = tx.objectStore('kv');
		const keys: string[] = [];
		let cursor = await store.openKeyCursor(range);
		while (cursor) {
			const fullKey = cursor.key as string;
			keys.push(fullKey.slice(this.prefix.length));
			cursor = await cursor.continue();
		}
		await tx.done;
		return keys;
	}
}
