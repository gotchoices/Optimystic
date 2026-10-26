import { OFFLINE_JOURNAL_KEY_PREFIX, type IKVStore } from '@optimystic/db-p2p';
import type {
	Action, ActionId, CollectionId, EntryId, InFlightAttempt, IOfflineJournal, JournalDriveState, JournalEntryRecord,
	JournalSettledStatus, QueuedFailureReason, WriteDurability,
} from '@optimystic/db-core';
import type { QualifiedTableName } from '../schema/table-identity.js';
import type { TransactionOutcome } from './offline-status.js';
import { createLogger } from '../logger.js';

const log = createLogger('offline-journal');

/**
 * The offline queue's journal over an `IKVStore` (docs/offline-sync.md §What is journaled): db-core's
 * `IOfflineJournal` port, filled with three records per transaction under
 * `optimystic-offline/<label>/`, each sub-namespace listed on its own so a listing of one never walks
 * another:
 *
 * | key | written | value |
 * |---|---|---|
 * | `entries/<seq>` | once, at enqueue | {@link EntryRecordV1} |
 * | `drives/<seq>` | before each send, after a partial commit, after an identity renewal | {@link DriveRecordV1} |
 * | `outcomes/<transactionId>` | at a terminal outcome, before the other two are deleted | {@link OutcomeRecordV1} |
 *
 * `<seq>` is zero-padded ({@link seqKey}), so a listing sorted as strings is queue order. Every write
 * the design's ordering depends on is flushed before the port method resolves (docs/offline-sync.md
 * §Write ordering); deletes are not, and a delete a crash loses is resolved on restore by the rule
 * "an entry record whose transaction has an outcome record is settled".
 */

/** The version every record this build writes carries. A reader meeting another refuses it rather
 * than guess at its shape. */
export const JOURNAL_RECORD_VERSION = 1;

/** One key segment every `IKVStore` can hold: `FileKVStore` makes each `/`-separated segment a
 * directory or file name, so nothing a filesystem treats specially. The journal label and every
 * transaction id (a `StampId()`, base64url) have this shape. */
export const JOURNAL_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** One sealed segment as journaled: the db-core segment, plus the table its collection backs, which a
 * restore initializes to reach the collection. */
export type JournaledSegment = {
	readonly collectionId: CollectionId;
	readonly table: QualifiedTableName;
	/** Verbatim, as the queue hands them: `JSON.stringify` is the encoding the log transport already
	 * imposes on actions (the JSON note under the `unchanged` guard in docs/internals.md). */
	readonly actions: readonly Action<unknown>[];
};

export type EntryRecordV1 = {
	readonly v: 1;
	readonly transactionId: string;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt?: number;
	readonly segments: readonly JournaledSegment[];
};

/** `null` stands for a collection saved with its holders unknown — JSON has no `undefined`. */
type DurabilityPair<K> = readonly [K, WriteDurability | null];

export type DriveRecordV1 = {
	readonly v: 1;
	readonly transactionId: string;
	readonly actionId: ActionId;
	readonly attempts: readonly (readonly [CollectionId, InFlightAttempt])[];
	readonly committed: readonly DurabilityPair<CollectionId>[];
};

/** A terminal outcome reduced to what JSON carries: a committed one without `followed` (a restart
 * follows nothing), a failed one with its error as name and message. */
export type PersistedOutcome =
	| {
		readonly kind: 'committed';
		readonly transactionId: string;
		readonly durability: { readonly collections: readonly DurabilityPair<CollectionId>[]; readonly overall?: WriteDurability };
		readonly tables: readonly DurabilityPair<string>[];
	}
	| {
		readonly kind: 'failed';
		readonly transactionId: string;
		readonly reason: QueuedFailureReason;
		readonly error: { readonly name: string; readonly message: string };
		readonly causedBy?: string;
		readonly changedTables: readonly string[];
		readonly committedTables?: readonly string[];
	};

export type OutcomeRecordV1 = {
	readonly v: 1;
	/** When the outcome was settled; the retention window runs from here. */
	readonly at: number;
	readonly status: PersistedOutcome;
};

/** A terminal outcome and when it was settled: what `plugin.offline.outcomes()` retains, and what the
 * journal's outcome record holds. */
export interface RetainedOutcome {
	readonly at: number;
	readonly status: TransactionOutcome;
}

/** What the journal asks of its owner, `OfflineMode`. */
export interface OfflineJournalHooks {
	/** The tables collection `id` backs (`TransactionBridge.tablesOf`). */
	tablesOf(id: CollectionId): ReadonlyMap<string, Readonly<QualifiedTableName>> | undefined;
	/** The SQL-level outcome of a terminal status, translated by the controller — once: it reports a
	 * committed transaction's durability as it translates, and keeps the translation for the status
	 * the queue emits right after. */
	outcomeOf(status: JournalSettledStatus): RetainedOutcome;
}

/** `seq` as a key segment: zero-padded to 12 digits, so string order is numeric order. */
export function seqKey(seq: number): string {
	return String(seq).padStart(12, '0');
}

/** The keys of one label's records. */
export class JournalKeys {
	readonly entries: string;
	readonly drives: string;
	readonly outcomes: string;

	// NOTE: two `Database`s journaling under one label over one store list and delete each other's
	// records, which corrupts both queues, and no `IKVStore` offers a lock that could detect it. Keeping
	// labels apart is the application's (README § Offline mode; docs/offline-sync.md §Which store).
	constructor(label: string) {
		const root = `${OFFLINE_JOURNAL_KEY_PREFIX}${label}/`;
		this.entries = `${root}entries/`;
		this.drives = `${root}drives/`;
		this.outcomes = `${root}outcomes/`;
	}

	entry(seq: number): string {
		return this.entries + seqKey(seq);
	}

	drive(seq: number): string {
		return this.drives + seqKey(seq);
	}

	outcome(transactionId: string): string {
		return this.outcomes + transactionId;
	}
}

export class OfflineJournal implements IOfflineJournal {
	readonly keys: JournalKeys;
	/** Each journaled entry's sequence number, which keys its entry and drive records, from `queued`
	 * until `settled`. */
	private readonly seqs = new Map<EntryId, number>();

	constructor(private readonly store: IKVStore, label: string, private readonly hooks: OfflineJournalHooks) {
		this.keys = new JournalKeys(label);
	}

	/**
	 * The entry record, flushed. A write that fails is taken back (deleted and flushed, best effort),
	 * since the commit it fails rolls the transaction back and a record left behind would bring it
	 * back on restore.
	 */
	async queued(record: JournalEntryRecord): Promise<void> {
		const value = this.entryRecord(record);
		const key = this.keys.entry(record.seq);
		try {
			await this.write(key, value);
		} catch (error) {
			// NOTE: a flush that throws after the store did persist the record leaves it on disk if the
			// take-back fails too (a latched store refuses both); a restore would then bring back a
			// transaction whose commit failed. Revisit if a store that fails its flush without latching
			// ever ships.
			await this.takeBack(key);
			throw error;
		}
		this.seqs.set(record.id, record.seq);
	}

	/** The drive record, flushed, replacing the last one. */
	async driving(entryId: EntryId, state: JournalDriveState): Promise<void> {
		const value: DriveRecordV1 = {
			v: JOURNAL_RECORD_VERSION,
			transactionId: entryId,
			actionId: state.actionId,
			// NOTE: carries every transform of each retained attempt, up to the transaction size limit
			// (7.5 MiB) per collection, rewritten before every send. If journal writes ever show up in
			// profiles, write the transforms once under a content-addressed key and rewrite only this.
			attempts: [...state.attempts],
			committed: durabilityPairs(state.committed),
		};
		await this.write(this.keys.drive(this.seqOf(entryId)), value);
	}

	/**
	 * The outcome record, flushed, then the entry and drive records deleted (not flushed). The deletes
	 * run even when the outcome write throws: the transaction is settled either way, and an entry
	 * record left with no outcome beside it would be restored and driven again — a discarded
	 * transaction sent after all. The write's error is then rethrown, for the queue to log.
	 */
	async settled(status: JournalSettledStatus): Promise<void> {
		const outcome = this.hooks.outcomeOf(status);
		const seq = this.seqs.get(status.entryId);
		this.seqs.delete(status.entryId);
		try {
			const value: OutcomeRecordV1 = { v: JOURNAL_RECORD_VERSION, at: outcome.at, status: encodeOutcome(outcome.status) };
			await this.write(this.keys.outcome(status.entryId), value);
		} finally {
			if (seq !== undefined) {
				await this.store.delete(this.keys.entry(seq));
				await this.store.delete(this.keys.drive(seq));
			}
		}
	}

	/** Delete a retained outcome's record (acknowledged, or past the retention window); not flushed. A
	 * transaction whose outcome was never journaled has no record, and the delete does nothing. */
	async deleteOutcome(transactionId: string): Promise<void> {
		await this.store.delete(this.keys.outcome(transactionId));
	}

	private entryRecord(record: JournalEntryRecord): EntryRecordV1 {
		if (!JOURNAL_KEY_SEGMENT.test(record.id)) {
			throw new Error(`offline journal: transaction id '${record.id}' cannot key its outcome record (letters, digits, '_' and '-' only)`);
		}
		return {
			v: JOURNAL_RECORD_VERSION,
			transactionId: record.id,
			seq: record.seq,
			queuedAt: record.queuedAt,
			...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
			segments: record.segments.map(segment => ({
				collectionId: segment.collectionId,
				table: this.tableOf(segment.collectionId),
				actions: segment.actions,
			})),
		};
	}

	/**
	 * The table a restore initializes to reach `collectionId`: the first the bridge recorded. Any one
	 * that opens the collection serves, so a collection backing two tables is logged and the first
	 * taken; one backing none could never be restored, and fails the commit.
	 */
	private tableOf(collectionId: CollectionId): QualifiedTableName {
		const tables = this.hooks.tablesOf(collectionId);
		const first = tables?.entries().next();
		if (tables === undefined || first === undefined || first.done) {
			throw new Error(`offline journal: collection ${collectionId} backs no table, so a transaction over it could not be restored after a restart`);
		}
		const [name, table] = first.value;
		if (tables.size > 1) {
			log('offline:journal-ambiguous-table collection=%s tables=%o recorded=%s', collectionId, [...tables.keys()], name);
		}
		return { schemaName: table.schemaName, tableName: table.tableName };
	}

	private seqOf(entryId: EntryId): number {
		const seq = this.seqs.get(entryId);
		if (seq === undefined) throw new Error(`offline journal: entry ${entryId} has no entry record in this journal`);
		return seq;
	}

	private async write(key: string, value: EntryRecordV1 | DriveRecordV1 | OutcomeRecordV1): Promise<void> {
		await this.store.set(key, JSON.stringify(value));
		await this.store.flush?.();
	}

	private async takeBack(key: string): Promise<void> {
		try {
			await this.store.delete(key);
			await this.store.flush?.();
		} catch (error) {
			log('offline:journal-take-back-failed key=%s: %o', key, error);
		}
	}
}

/** The outcome as its record holds it ({@link PersistedOutcome}). */
export function encodeOutcome(outcome: TransactionOutcome): PersistedOutcome {
	if (outcome.kind === 'committed') {
		return {
			kind: 'committed',
			transactionId: outcome.transactionId,
			durability: {
				collections: durabilityPairs(outcome.durability.collections),
				...(outcome.durability.overall === undefined ? {} : { overall: outcome.durability.overall }),
			},
			tables: durabilityPairs(outcome.tables),
		};
	}
	return {
		kind: 'failed',
		transactionId: outcome.transactionId,
		reason: outcome.reason,
		error: { name: outcome.error.name, message: outcome.error.message },
		...(outcome.causedBy === undefined ? {} : { causedBy: outcome.causedBy }),
		changedTables: [...outcome.changedTables],
		...(outcome.committedTables === undefined ? {} : { committedTables: [...outcome.committedTables] }),
	};
}

/**
 * The outcome a record holds, as `plugin.offline` reports it — less what the record dropped: a
 * committed one has `followed: false`, and a failed one's `error` is a plain `Error` with the
 * original's name and message and no `cause`.
 */
export function decodeOutcome(persisted: PersistedOutcome): TransactionOutcome {
	if (persisted.kind === 'committed') {
		return Object.freeze({
			kind: 'committed' as const,
			transactionId: persisted.transactionId,
			durability: {
				collections: durabilityMap(persisted.durability.collections),
				...(persisted.durability.overall === undefined ? {} : { overall: persisted.durability.overall }),
			},
			tables: durabilityMap(persisted.tables),
			followed: false,
		});
	}
	const error = new Error(persisted.error.message);
	error.name = persisted.error.name;
	return {
		kind: 'failed',
		transactionId: persisted.transactionId,
		reason: persisted.reason,
		error,
		...(persisted.causedBy === undefined ? {} : { causedBy: persisted.causedBy }),
		changedTables: [...persisted.changedTables],
		...(persisted.committedTables === undefined ? {} : { committedTables: [...persisted.committedTables] }),
	};
}

function durabilityPairs<K>(map: ReadonlyMap<K, WriteDurability | undefined>): DurabilityPair<K>[] {
	return [...map].map(([key, durability]) => [key, durability ?? null]);
}

function durabilityMap<K>(pairs: readonly DurabilityPair<K>[]): Map<K, WriteDurability | undefined> {
	return new Map(pairs.map(([key, durability]) => [key, durability ?? undefined]));
}
