import type { BlockId, ActionId } from '@optimystic/db-core';
import type { StoreKey } from '../storage/batch-backend.js';
import type { JournalContents, JournalRecord, JournalStore } from '../storage/journal-batch-backend.js';
import type { StoreDurability } from '../storage/store-durability.js';
import { MemoryStoreRows } from './memory-store-rows.js';

export interface MemoryJournalStoreOptions {
	/**
	 * What an apply survives; `'power-loss'` by default, the engine the journal exists for. Anything
	 * less and `JournalBatchBackend` applies every group at once and journals nothing.
	 */
	durability?: StoreDurability;
	/** Runs before each append, with the record. Throwing or rejecting makes the append reject with nothing stored. */
	beforeAppend?: (record: JournalRecord) => void | Promise<void>;
	/**
	 * Runs before each apply, with its arguments. Returning a promise parks the apply until it
	 * resolves; throwing or rejecting makes the apply reject with nothing applied, as an atomic
	 * write that failed leaves nothing behind.
	 */
	beforeApply?: (apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]) => void | Promise<void>;
}

/** One `applyJournal` call {@link MemoryJournalStore} ran, as it was called. */
export interface MemoryJournalApply {
	readonly apply: readonly JournalRecord[];
	readonly appliedThrough: number;
	readonly discard: readonly number[];
}

/**
 * Test-only {@link JournalStore} over maps: the applied stores in one, the journal records in
 * another, and the applied-through mark. {@link appended} and {@link applied} record every call,
 * in order, so a test can count appends and applies and read what each carried; they are
 * recorders, never rewound. {@link powerLoss} is the crash the journal exists for: it drops the
 * journal records not yet applied — all of them, or only the numbered ones, to leave a gap — and
 * keeps the applied stores and the mark, since every apply is synced before it resolves. Open a
 * fresh backend over the store afterwards. Like `MemoryBatchBackend` it reports no
 * `storeIdentity`: two of these are two genuinely different stores.
 */
export class MemoryJournalStore implements JournalStore {
	readonly durability: StoreDurability;
	/** Every record appended, in order. */
	readonly appended: JournalRecord[] = [];
	/** Every apply run, in order, as it was called. */
	readonly applied: MemoryJournalApply[] = [];
	/** True once {@link close} ran. */
	closed = false;

	private readonly rows = new MemoryStoreRows();
	private readonly journal = new Map<number, JournalRecord>();
	private appliedThrough = 0;

	constructor(private readonly options: MemoryJournalStoreOptions = {}) {
		this.durability = options.durability ?? 'power-loss';
	}

	/** The numbers of the journal records present now, ascending: what a fresh backend's open finds. */
	get journalSeqs(): number[] {
		return [...this.journal.keys()].sort((a, b) => a - b);
	}

	/** The applied-through mark as stored. */
	get mark(): number {
		return this.appliedThrough;
	}

	// --- the applied stores ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		return this.rows.get(key);
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		return this.rows.rangeRevisions(blockId, lo, hi);
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		return this.rows.listPendingActionIds(blockId);
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		yield* this.rows.listBlockIds();
	}

	async approximateBytesUsed(): Promise<number> {
		return this.rows.approximateBytesUsed();
	}

	// --- the journal ---

	async appendJournal(record: JournalRecord): Promise<void> {
		await this.options.beforeAppend?.(record);
		this.appended.push(record);
		this.journal.set(record.seq, record);
	}

	async applyJournal(apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]): Promise<void> {
		await this.options.beforeApply?.(apply, appliedThrough, discard);
		for (const record of apply) this.rows.apply(record.entries);
		this.appliedThrough = appliedThrough;
		for (const { seq } of apply) this.journal.delete(seq);
		for (const seq of discard) this.journal.delete(seq);
		this.applied.push({ apply, appliedThrough, discard });
	}

	async readJournal(): Promise<JournalContents> {
		return {
			appliedThrough: this.appliedThrough,
			records: [...this.journal.values()].sort((a, b) => a.seq - b.seq),
		};
	}

	/** The crash: every unapplied journal record is gone, or only the numbered ones; the applied stores and the mark stay. */
	powerLoss({ lose }: { lose?: readonly number[] } = {}): void {
		if (lose === undefined) {
			this.journal.clear();
		} else {
			for (const seq of lose) this.journal.delete(seq);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
