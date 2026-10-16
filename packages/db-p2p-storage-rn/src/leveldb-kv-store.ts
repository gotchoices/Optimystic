import { WriteGroup, type CommittedBatch, type FlushOptions, type IKVStore, type WriteGroupEntry, type WriteGroupOptions } from '@optimystic/db-p2p';
import { drain, type LevelDBLike } from './leveldb-like.js';
import { kvKey, kvKeyToString, kvPrefixRange } from './keys.js';

/** The write group's options (`idleFlushMs`, `maxUnsyncedBytes`, the test-only `setTimer`). */
export type LevelDBKVStoreOptions = WriteGroupOptions;

const textEncoder = new TextEncoder();
// Built on first use, not at module load: Hermes (React Native) has no native `TextDecoder`, so a
// module-scope construction fails the import itself whenever it runs ahead of the host's polyfill.
let textDecoderInstance: TextDecoder | undefined;
const textDecoder = (): TextDecoder => textDecoderInstance ??= new TextDecoder();

/**
 * LevelDB-backed `IKVStore` adapter for React Native peers.
 *
 * Shares one `LevelDBLike` database with `LevelDBRawStorage` and the identity
 * helper. KV keys are tagged with `TAG_KV` (and identity with `TAG_IDENTITY`),
 * so the three subsystems can't collide regardless of the user-chosen
 * `prefix`. `list(prefix)` is a range-bounded scan — never a full-database
 * iteration plus JS-side filter — so listing latency stays bounded.
 *
 * Writes go through a {@link WriteGroup} over the plain keys, as `FileKVStore` does: a `set` or
 * `delete` resolves into memory, served from there to `get` and `list`, and `flush()` commits
 * everything written since the last flush as ONE LevelDB batch, synced wherever the handle can
 * sync (`canSync`), so the writes are on the disk before the flush resolves. Every flush the node
 * makes of this store is strict, and so is the group's own idle flush, so there is no relaxed path
 * to journal: a flush given a window is treated as strict, as a store that cannot defer a sync
 * treats every window, and each batch carries its own data. A failed batch latches the store, after
 * which every write and flush throws `StoreFailedError` (rule 5 of the flush contract on
 * `RawStoreDriver.flush`); reads keep serving the overlay.
 */
export class LevelDBKVStore implements IKVStore {
	private readonly group: WriteGroup<string>;

	constructor(
		private readonly db: LevelDBLike,
		private readonly prefix: string = 'optimystic:txn:',
		options: LevelDBKVStoreOptions = {},
	) {
		this.group = new WriteGroup<string>(key => key, {
			commit: entries => this.commit(entries),
			// Every commit is as durable as this store can make it when it resolves, so nothing is ever owed a sync.
			sync: () => Promise.resolve(),
		}, options);
	}

	async get(key: string): Promise<string | undefined> {
		const held = this.group.lookup(key);
		if (held !== undefined) return held === null ? undefined : textDecoder().decode(held);
		const bytes = await this.db.get(kvKey(this.prefix + key));
		if (!bytes) return undefined;
		return textDecoder().decode(bytes);
	}

	async set(key: string, value: string): Promise<void> {
		this.group.put(key, textEncoder.encode(value));
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

	/** Make every write resolved before this call durable: one batch, synced where the handle can, whatever `options.withinMs` says. The contract is `RawStoreDriver.flush`'s. */
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
		const batch = this.db.batch();
		for (const { key, value } of entries) {
			const encoded = kvKey(this.prefix + key);
			if (value === undefined) batch.delete(encoded); else batch.put(encoded, value);
		}
		await batch.write({ sync: this.db.canSync });
		return { durable: Promise.resolve() };
	}

	private async listStored(prefix: string): Promise<string[]> {
		const range = kvPrefixRange(this.prefix + prefix);
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		return entries.map(([rawKey]) => kvKeyToString(rawKey).slice(this.prefix.length));
	}
}
