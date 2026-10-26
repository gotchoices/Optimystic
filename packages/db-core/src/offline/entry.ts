import type { ActionId } from '../collection/action.js';
import type { Collection } from '../collection/collection.js';
import type { EntryId } from '../collection/segments.js';
import type { CollectionId, InFlightAttempt } from '../collection/struct.js';
import type { WriteDurability } from '../network/struct.js';
import type { EntryStatus, EntryWaitingFor, QueuedEntry } from './status.js';
import type { JournalDriveState } from './journal.js';

/** One queued entry, as `OfflineQueue` holds it, and the projections of it the queue reports. */
export type Entry = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt: number | undefined;
	/** The collections the entry sealed a segment in — the ones `sealPending` answered `true` for. */
	readonly collections: readonly Collection<any>[];
	/** One action id for the entry's whole life, with one exception: a `torn-not-saved` outcome mints
	 * a fresh one (the queue's `applyFailure` says why). */
	actionId: ActionId;
	attempts: number;
	/** Whether an attempt may have landed; sticky — see the NOTE at the queue's `recordAttempts`. */
	inDoubt: boolean;
	/** The attempts recorded under `actionId` and not yet resolved, per collection, handed back as
	 * `resume` when the entry is re-driven. Cleared with the action id. */
	readonly retained: Map<CollectionId, InFlightAttempt>;
	/** The collections a partial commit has already committed, with who holds each, accumulated
	 * across submissions (`recordCollectionDurability`); empty until one does. The committed half's
	 * segments are consumed, so the next submission drives only the rest, and the terminal status
	 * reports these beside it. */
	readonly committed: Map<CollectionId, WriteDurability | undefined>;
	phase: 'queued' | 'submitting';
	waitingFor: EntryWaitingFor | undefined;
	lastError: unknown;
	/** The last `queued` status emitted, so a re-check that changes nothing emits nothing. */
	lastQueued: QueuedStatus | undefined;
	/** The `offline:expiry-deferred` line is logged once per entry, not once per re-check. */
	expiryDeferredLogged: boolean;
};

export type QueuedStatus = Extract<EntryStatus, { kind: 'queued' }>;

export function queuedStatus(entry: Entry): QueuedStatus {
	return {
		kind: 'queued',
		entryId: entry.id,
		seq: entry.seq,
		collections: entry.collections.map(collection => collection.id),
		queuedAt: entry.queuedAt,
		attempts: entry.attempts,
		inDoubt: entry.inDoubt,
		waitingFor: entry.waitingFor,
		...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
		...committedField(entry),
	};
}

/** `{ committedCollections }` once part of the entry has committed, `{}` before — the field the
 * `queued` and `failed` statuses and {@link snapshot} carry only when it says something. */
export function committedField(entry: Entry): { committedCollections?: readonly CollectionId[] } {
	return entry.committed.size === 0 ? {} : { committedCollections: [...entry.committed.keys()] };
}

export function currentStatus(entry: Entry): EntryStatus {
	return entry.phase === 'submitting'
		? { kind: 'submitting', entryId: entry.id, attempt: entry.attempts }
		: queuedStatus(entry);
}

/** The entry as `OfflineQueue.entries` lists it. */
export function snapshot(entry: Entry): QueuedEntry {
	return {
		id: entry.id,
		seq: entry.seq,
		queuedAt: entry.queuedAt,
		collections: entry.collections.map(collection => collection.id),
		...committedField(entry),
		status: currentStatus(entry),
	};
}

/** Whether two `queued` statuses differ in anything an application can see. */
export function queuedStatusChanged(previous: QueuedStatus | undefined, status: QueuedStatus): boolean {
	return previous === undefined
		|| previous.waitingFor !== status.waitingFor
		|| previous.attempts !== status.attempts
		|| previous.inDoubt !== status.inDoubt
		|| previous.lastError !== status.lastError
		// The committed set only grows, so its size says whether it changed.
		|| previous.committedCollections?.length !== status.committedCollections?.length;
}

/** The entry's drive state as the journal records it (`IOfflineJournal.driving`): its action id,
 * the attempts retained under it — with `attempts`, the ones about to be sent, laid over them when
 * given — and the collections already committed. Copies, so the journal serialises a state the
 * drain cannot change under it. */
export function driveState(entry: Entry, attempts?: ReadonlyMap<CollectionId, InFlightAttempt>): JournalDriveState {
	return {
		actionId: entry.actionId,
		attempts: new Map([...entry.retained, ...(attempts ?? [])]),
		committed: new Map(entry.committed),
	};
}
