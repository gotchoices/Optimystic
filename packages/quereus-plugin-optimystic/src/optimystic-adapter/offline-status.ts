import type { EntryWaitingFor, OfflineQueueState, QueuedFailureReason } from '@optimystic/db-core';
import type { SqlCommitDurability } from './commit-durability.js';

/**
 * What `plugin.offline` reports about each locally acknowledged transaction (docs/offline-sync.md
 * §Following transactions): the db-core queue's `EntryStatus` with tables (`schema.table`) in place
 * of collection ids and the transaction's `StampId()` in place of the entry id. The fields later
 * stages add there (`persisted`, `outlook`, `effect`) are absent until they land.
 */

export type { QueuedFailureReason } from '@optimystic/db-core';

export type QueuedTransactionStatus =
	| {
		kind: 'queued';
		/** What `StampId()` returned inside the transaction: the queue entry's id. */
		transactionId: string;
		/** Per database, monotonic: the order transactions were queued in, which is the order they drain in. */
		seq: number;
		/** The tables the transaction changed, each once, in the order their collections were sealed. */
		tables: readonly string[];
		queuedAt: number;
		/** Submissions made so far. */
		attempts: number;
		/** Whether an attempt may have landed: such a transaction can neither be discarded nor expired,
		 * and is re-sent only under its own action id. */
		inDoubt: boolean;
		waitingFor: EntryWaitingFor | undefined;
		/** What the last attempt failed with, when one has. */
		lastError?: unknown;
		/** The tables already durably committed, once a submission committed part of the transaction
		 * (docs/offline-sync.md §Partial commits); absent while none is. */
		committedTables?: readonly string[];
	}
	| { kind: 'submitting'; transactionId: string; attempt: number }
	/** The same report `onCommitDurability` listeners received for this commit, which they did, before
	 * this status was delivered. */
	| ({ kind: 'committed' } & SqlCommitDurability)
	| {
		kind: 'partially-committed';
		transactionId: string;
		committedTables: readonly string[];
		pendingTables: readonly string[];
		cause: Error;
	}
	| {
		kind: 'failed';
		transactionId: string;
		reason: QueuedFailureReason;
		/** The error an online commit would have thrown for the same refusal, mapped through
		 * `TransactionBridge.mapCommitRefusal` (a `ConstraintError`, a `ConcurrentModificationError`),
		 * with the db-core refusal reachable through `cause`. */
		error: Error;
		/** The earlier transaction whose removal made this one fail (docs/offline-sync.md §Removing an entry). */
		causedBy?: string;
		/** The tables whose visible rows this removal changed — those the transaction still had a
		 * sealed segment in when it was removed. */
		changedTables: readonly string[];
		/** Set only when part of the transaction had committed before the rest failed. */
		committedTables?: readonly string[];
	};

/** A terminal status, as `plugin.offline.outcomes()` retains it. */
export type TransactionOutcome = Extract<QueuedTransactionStatus, { kind: 'committed' | 'failed' }>;

/** One queued transaction as `plugin.offline.entries()` lists it: its identity and its current status. */
export type QueuedTransaction = {
	readonly transactionId: string;
	readonly seq: number;
	readonly queuedAt: number;
	readonly tables: readonly string[];
	/** As on the `queued` status: the tables already committed, once part of the transaction is. */
	readonly committedTables?: readonly string[];
	readonly status: QueuedTransactionStatus;
};

/** Queue-wide state, for a status bar: the db-core queue's, plus which mode the database is in and
 * whether the last live read was served from this machine's own copy because the cohort could not be
 * reached (docs/offline-sync.md §Reads in offline mode). */
export type OfflineModeState = OfflineQueueState & {
	readonly mode: 'offline' | 'online';
	readonly readsServedLocally: boolean;
};
