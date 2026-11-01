import type { Action, ActionId } from '../collection/action.js';
import type { EntryId } from '../collection/segments.js';
import type { CollectionId, InFlightAttempt } from '../collection/struct.js';
import type { WriteDurability } from '../network/struct.js';
import type { EntryStatus } from './status.js';

/**
 * The port a durable journal fills (docs/offline-sync.md §Persistence): the queue calls it at every
 * moment the design's write ordering names — after sealing and before `queued` is emitted, before
 * each send, after a partial commit, after an identity renewal, and before each terminal status —
 * so a journal can save queued entries to disk without the drain knowing where. It speaks the
 * queue's vocabulary only (entry ids, collection ids, actions, `InFlightAttempt`s): a journal over a
 * key-value store, which also has to name tables, lives with the Quereus plugin, and a `Tree` or
 * `Diary` application with no SQL can journal through this port too. A queue built without a
 * journal behaves exactly as before.
 */

/** One entry as the journal records it at enqueue, written once (docs/offline-sync.md §What is
 * journaled). */
export type JournalEntryRecord = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt?: number;
	/** One per collection the entry sealed a segment in, in sealing order: the segment's actions,
	 * verbatim — the array the segment holds, which the journal serialises and never mutates. */
	readonly segments: readonly { readonly collectionId: CollectionId; readonly actions: readonly Action<unknown>[] }[];
};

/** The drive state of an entry: everything that changes between sends and must be on disk before
 * the next one (docs/offline-sync.md §Identity across attempts). */
export type JournalDriveState = {
	/** The action id the next submission runs under (renewed after `torn-not-saved`). */
	readonly actionId: ActionId;
	/** The attempts recorded under `actionId` and not yet resolved, per collection — the ones a later
	 * cycle resumes from. Empty right after a renewal. */
	readonly attempts: ReadonlyMap<CollectionId, InFlightAttempt>;
	/** The collections a partial commit has already committed, with who holds each. */
	readonly committed: ReadonlyMap<CollectionId, WriteDurability | undefined>;
};

/** The two terminal statuses, as the journal is told them before they are emitted. */
export type JournalSettledStatus = Extract<EntryStatus, { kind: 'committed' | 'failed' }>;

export interface IOfflineJournal {
	/** Before the entry's `queued` status is emitted and before `enqueue` resolves. A throw or
	 * rejection fails the enqueue: the segments are unsealed and nothing is queued. The journal must
	 * flush before resolving. */
	queued(record: JournalEntryRecord): Promise<void>;
	/** Before each send, with the attempts about to go; again after a partial commit and after an
	 * identity renewal. Before a send, a throw aborts the cycle with nothing sent (the entry stays
	 * queued, not in doubt, re-driven after the backoff). After a partial commit or a renewal a throw
	 * is logged (`offline:journal-write-failed`) and the drain goes on; the next send's write repeats
	 * the state. The journal must flush before resolving. */
	driving(entryId: EntryId, state: JournalDriveState): Promise<void>;
	/** The entry's terminal status, before it is emitted. A throw is logged, never thrown into the
	 * drain: the outcome stands, and a restart resolves the stale record
	 * (docs/offline-sync.md §Restore after a restart). */
	settled(status: JournalSettledStatus): Promise<void>;
}
