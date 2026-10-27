import type { CollectionId } from '../collection/struct.js';
import type { EntryId } from '../collection/segments.js';
import type { TransactionDurability } from '../transaction/durability.js';

/**
 * The status an offline-sync queue reports for each entry (docs/offline-sync.md §Following
 * transactions), in its db-core form: collections stand in for tables. The plugin's `followed`,
 * `persisted` and `outlook` are its own and never appear here — the outlook needs the catalog's tags
 * and key decoding, which only the plugin has.
 */

/** Why an entry failed. `constraint` and `concurrent-modification` are the two guard refusals
 * (`refusalReason` in `packages/db-core/src/transaction/commit-failure-class.ts`); the other four
 * are the queue's own: a validator judged the write invalid, it can never fit a message, it outlived
 * `OfflineQueueOptions.expireAfterMs`, or the application withdrew it with `OfflineQueue.discard`. */
export type QueuedFailureReason = 'constraint' | 'concurrent-modification' | 'rejected' | 'too-large' | 'expired' | 'discarded';

/** What an entry still queued is waiting on: an earlier entry (the drain is strictly first in,
 * first out), the cohort (the reachability gate said no, or the last attempt could not reach it),
 * or the backoff timer after a transient failure. `undefined` for a head about to be submitted. */
export type EntryWaitingFor = 'earlier-entry' | 'cohort' | 'backoff';

/** What a committed entry did to the rows it wrote (docs/offline-sync.md §Guards that make idempotent
 * writes assured): `already-applied` when every element that carried one of the already-applied guard
 * kinds (`TreeAlreadyAppliedGuard` in `packages/db-core/src/collections/tree/struct.ts`) was skipped
 * because a rival had already made exactly its change, and at least one did — summed over every
 * collection the entry wrote (`AlreadyAppliedTally`); `applied` otherwise, including for an entry with
 * no such element and for one of which any collection's tally was never heard — one a restore found
 * already committed, or one committed before a restart lost the tally. "All, not any": an entry of two
 * guarded updates of which one was already done did change a row, and a host reading
 * `already-applied` as "none of my guarded changes landed" must be right — and a write under `absent`
 * or `unchanged`, the main-table base kinds, counts as applied for the same reason. Says nothing about
 * elements carrying no guard, `keepExisting` or `absentRange`, which are never counted. */
export type CommittedEffect = 'applied' | 'already-applied';

export type EntryStatus =
	| {
		kind: 'queued';
		entryId: EntryId;
		/** Per queue, monotonic: the order entries were queued in, which is the order they drain in. */
		seq: number;
		/** The collections the entry sealed a segment in — every collection it changed. */
		collections: readonly CollectionId[];
		queuedAt: number;
		/** Submissions made so far. */
		attempts: number;
		/** Whether an attempt may have landed (see `OfflineQueue`'s in-doubt rule): such an entry can
		 * neither be discarded nor expired, and is re-sent only under its own action id. */
		inDoubt: boolean;
		waitingFor: EntryWaitingFor | undefined;
		/** What the last attempt failed with, when one has. */
		lastError?: unknown;
		/** The collections of the entry already durably committed, once a submission has committed
		 * part of it (docs/offline-sync.md §Partial commits); absent while none is. */
		committedCollections?: readonly CollectionId[];
	}
	| { kind: 'submitting'; entryId: EntryId; attempt: number }
	| {
		kind: 'committed';
		entryId: EntryId;
		/** Every collection the entry wrote, each with its class — across submissions, so a partly
		 * committed entry's earlier half is listed beside the remainder's. */
		durability: TransactionDurability;
		/** Whether the entry's guarded changes were already in place when it committed
		 * ({@link CommittedEffect}). */
		effect: CommittedEffect;
	}
	| {
		/** A submission committed part of the entry and not the rest (`CoordinatorPartialCommitError`).
		 * Emitted in place of the `queued` status that transition would otherwise report: the entry
		 * stays at the head, in doubt, and the drain drives the pending collections on the next
		 * submission. Between submissions `status` and `entries` report it `queued`, with
		 * `committedCollections` set. */
		kind: 'partially-committed';
		entryId: EntryId;
		/** Every collection of the entry durably committed so far, across submissions. */
		committedCollections: readonly CollectionId[];
		/** The collections in which the entry is still a sealed segment: what the next submission drives. */
		pendingCollections: readonly CollectionId[];
		/** Why the rest did not commit: the partial commit's `reason` when that is an `Error`, otherwise
		 * the partial commit error itself (whose message names the reason). */
		cause: Error;
	}
	| {
		kind: 'failed';
		entryId: EntryId;
		reason: QueuedFailureReason;
		error: Error;
		/** The earlier entry whose removal made this one fail (docs/offline-sync.md §Removing an entry). */
		causedBy?: EntryId;
		/** The collections whose visible content this removal changed — the ones the entry still had a
		 * segment in when it was removed. */
		changedCollections: readonly CollectionId[];
		/** Set only when part of the entry had committed before the rest failed: the network now holds
		 * half of the transaction, which the application has to reconcile (docs/offline-sync.md
		 * §Partial commits). */
		committedCollections?: readonly CollectionId[];
	};

/** Queue-wide state, for a status bar. */
export type OfflineQueueState = {
	depth: number;
	oldestQueuedAt: number | undefined;
	/** A submission is on the network. */
	draining: boolean;
	/** What the head is waiting on, when it is not an earlier entry. */
	waitingFor: 'cohort' | 'backoff' | undefined;
	/** Attempts whose failure the drain could not classify (`offline:unclassified-failure`); such an
	 * entry is retried rather than dropped, so a rising count with a stuck depth is the signal. */
	unclassifiedFailures: number;
};

/** One entry as `OfflineQueue.entries` lists it: its identity and its current status. */
export type QueuedEntry = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly collections: readonly CollectionId[];
	/** As on the `queued` status: the collections already committed, once part of the entry is. */
	readonly committedCollections?: readonly CollectionId[];
	readonly status: EntryStatus;
};

/** Thrown by `OfflineQueue.discard` for an entry that cannot be withdrawn: it has been sent at least
 * once and so may already be saved (`inDoubt`), or it is being submitted right now — and by the
 * plugin's restore after a restart for a journaled entry a pass is putting back right now
 * (`restoring`): withdrawn then, its outcome would be written while the queue goes on to admit and
 * drive it. */
export class EntryNotDiscardableError extends Error {
	constructor(
		readonly entryId: EntryId,
		readonly because: 'in-doubt' | 'submitting' | 'restoring',
	) {
		super(notDiscardableMessage(entryId, because));
		this.name = 'EntryNotDiscardableError';
	}
}

function notDiscardableMessage(entryId: EntryId, because: EntryNotDiscardableError['because']): string {
	switch (because) {
		case 'in-doubt': return `entry ${entryId} has been sent at least once and may already be saved; it cannot be discarded`;
		case 'submitting': return `entry ${entryId} is being submitted; it cannot be discarded`;
		case 'restoring': return `entry ${entryId} is being put back from its journal record; it cannot be discarded until the pass has put it back`;
	}
}

/** Thrown by `OfflineQueue.discard` for an id the queue does not hold — never queued, or already
 * committed or failed. */
export class UnknownEntryError extends Error {
	constructor(readonly entryId: EntryId) {
		super(`entry ${entryId} is not queued`);
		this.name = 'UnknownEntryError';
	}
}

/** Thrown by `OfflineQueue.enqueue` after `dispose`, and the rejection of every `whenDrained` the
 * disposal cut short. */
export class QueueDisposedError extends Error {
	constructor() {
		super('the offline queue has been disposed');
		this.name = 'QueueDisposedError';
	}
}

/** The error a discarded entry fails with (`reason: 'discarded'`): the application withdrew it. */
export class EntryDiscardedError extends Error {
	constructor(readonly entryId: EntryId) {
		super(`entry ${entryId} was discarded before it was sent`);
		this.name = 'EntryDiscardedError';
	}
}

/** The error an expired entry fails with (`reason: 'expired'`). */
export class EntryExpiredError extends Error {
	constructor(
		readonly entryId: EntryId,
		readonly queuedAt: number,
		readonly expiresAt: number,
	) {
		super(`entry ${entryId} queued at ${queuedAt} was not settled by ${expiresAt}`);
		this.name = 'EntryExpiredError';
	}
}
