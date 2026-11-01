import type { BlockId, ActionId } from '@optimystic/db-core';
import type { StoreKey } from '../storage/batch-backend.js';
import type { JournalContents, JournalRecord, JournalStore } from '../storage/journal-batch-backend.js';
import type { StoreDurability } from '../storage/store-durability.js';
import type { StoreIdentity } from '../storage/store-identity.js';

/**
 * Test-only {@link JournalStore} whose reads return text: the bytes store it wraps, with every value
 * its reads return decoded by Node's `TextDecoder`, which is what an engine that decodes UTF-8 in
 * native code hands back. The journal writes and the key listings pass straight through, so a text
 * composition over it persists exactly the bytes a bytes composition would. Optional members are
 * forwarded only when the wrapped store has them.
 */
export class TextReadsJournalStore implements JournalStore<string> {
	readonly durability: StoreDurability;
	storeIdentity?: () => StoreIdentity;
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;
	close?: () => Promise<void>;

	private readonly decoder = new TextDecoder();

	constructor(private readonly store: JournalStore) {
		this.durability = store.durability;
		if (store.storeIdentity) this.storeIdentity = () => store.storeIdentity!();
		if (store.listBlockIds) this.listBlockIds = () => store.listBlockIds!();
		if (store.approximateBytesUsed) this.approximateBytesUsed = () => store.approximateBytesUsed!();
		if (store.close) this.close = () => store.close!();
	}

	async get(key: StoreKey): Promise<string | undefined> {
		const value = await this.store.get(key);
		return value === undefined ? undefined : this.decoder.decode(value);
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, string][]> {
		const rows = await this.store.rangeRevisions(blockId, lo, hi);
		return rows.map(([rev, value]) => [rev, this.decoder.decode(value)]);
	}

	listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		return this.store.listPendingActionIds(blockId);
	}

	appendJournal(record: JournalRecord): Promise<void> {
		return this.store.appendJournal(record);
	}

	applyJournal(apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]): Promise<void> {
		return this.store.applyJournal(apply, appliedThrough, discard);
	}

	readJournal(): Promise<JournalContents> {
		return this.store.readJournal();
	}
}
