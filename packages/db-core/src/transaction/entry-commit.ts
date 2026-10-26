import type { ActionId, CollectionId } from "../index.js";
import type { ReadDependency, Transaction } from "./transaction.js";
import { clampPriority } from "./transaction.js";
import type { Collection, RefreshReport } from "../collection/collection.js";
import type { HeadCommitHandle } from "../collection/head-commit.js";
import type { EntryId } from "../collection/segments.js";
import type { InFlightAttempt } from "../collection/struct.js";
import type { StagedAttempt } from "../collection/write-attempts.js";
import { retainedAttempt } from "../collection/write-attempts.js";
import { visitEveryThenThrow } from "../utility/visit-every.js";

/**
 * What the coordinator's phases know about the write they are sending — everything they used to
 * read off a `Transaction`: the action id every pend and commit names, the timestamp its log entries
 * carry, the reads recorded on them, and the aged retry priority an unvalidated pend carries.
 * `commit` and `execute` derive one from their transaction ({@link writeContextOf}); the per-entry
 * commit (`TransactionCoordinator.commitEntry`) builds its own, since a queued entry has no
 * transaction. A `TransactionStamp` is deliberately NOT fabricated for it: a stamp carries a peer id,
 * a schema hash and an expiry, all of which would be lies for an entry.
 */
export type WriteContext = {
	readonly actionId: ActionId;
	/** Stamped on every log entry of the write; fixed per write, never per attempt. */
	readonly timestamp: number;
	/** Recorded on every log entry of the write (`ActionEntry.reads`). */
	readonly reads: readonly ReadDependency[];
	/** Already clamped (`clampPriority`); 0 on a first attempt. */
	readonly priority: number;
};

/** The write context of a transaction's attempt, read when the attempt starts: `commitAttempts` ages
 * the transaction's priority between attempts, so it is read per attempt rather than once. */
export function writeContextOf(transaction: Transaction): WriteContext {
	return {
		actionId: transaction.id as ActionId,
		timestamp: transaction.stamp.timestamp,
		reads: transaction.reads,
		priority: clampPriority(transaction.priority),
	};
}

/**
 * One queued entry's commit across the collections it wrote — the input of
 * `TransactionCoordinator.commitEntry` (docs/offline-sync.md §One entry, one network transaction).
 * The queue builds it; the identity fields are the queue's, exactly as `HeadCommitOptions` carries
 * them for a one-collection entry (docs/offline-sync.md §Identity across attempts).
 */
export type EntryCommit = {
	readonly entryId: EntryId;
	/** The action id every attempt of the entry runs under; re-supplied when an entry is re-driven
	 * after an attempt that may have landed, so the opening refresh recognises that attempt's log
	 * entries as the write's own. */
	readonly actionId: ActionId;
	/** The entry's local commit time: every participant's log entry carries it (`WriteIdentity`). */
	readonly timestamp: number;
	/** The collections the entry wrote, each of which must hold `entryId` as its HEAD sealed segment. */
	readonly collectionIds: readonly CollectionId[];
	/** Attempts an earlier `commitEntry` under this action id recorded through {@link recordAttempt}
	 * and did not resolve, per collection (see `HeadCommitOptions.resume`). */
	readonly resume?: ReadonlyMap<CollectionId, InFlightAttempt>;
	/** Write-ahead hook, awaited with every participant's attempt before any latch is released
	 * (see `HeadCommitOptions.recordAttempt`). A throw aborts the cycle with nothing sent. */
	readonly recordAttempt?: (attempts: ReadonlyMap<CollectionId, InFlightAttempt>) => Promise<void>;
};

/** One collection's part in a refresh round between attempts
 * (`TransactionCoordinator.refreshBetweenAttempts`): its refresh, and what to do once that refresh
 * finished the write's own log entry. */
export type RefreshParticipant = {
	readonly collectionId: CollectionId;
	/** The refresh itself — `Collection.refreshInFlight` for a transaction's participant, the
	 * handle's `refresh` for an entry's — with the write's own report. */
	refresh(report: RefreshReport, lastChance: boolean): Promise<void>;
	/** Called after the refresh finished the write's own entry and the round recorded it as saved. */
	saved?(): void;
};

/**
 * The handles of one entry's participants — a `HeadCommitHandle` per collection the entry wrote —
 * and the moves the per-entry commit makes over all of them in lock-step. The handles are opened in
 * SORTED collection-id order, the order `TransactionCoordinator.commitOnce` acquires the same latches
 * in, so a concurrent `commit` over overlapping collections cannot deadlock against this; they are
 * held for the whole cycle and closed in reverse order by {@link close}. A participant leaves the set
 * when it is saved — its refresh finished the entry's own log entry, or an attempt committed it
 * while a sibling was refused — so the set is always what is left to commit.
 */
export class EntryParticipants {
	/** In sorted collection-id order. */
	private readonly handles: Map<CollectionId, HeadCommitHandle>;

	private constructor(private readonly entry: EntryCommit, handles: Map<CollectionId, HeadCommitHandle>) {
		this.handles = handles;
	}

	/**
	 * Open a handle on every collection the entry wrote, in sorted collection-id order, under the
	 * entry's identity and with that collection's recorded attempt, if any, to resume from. Throws
	 * before opening anything — a defect of the caller — when the entry names no collection, names
	 * one twice (opening it twice would deadlock on its own latch) or names one `collections` does
	 * not hold; and closes the handles already opened when a later `openHeadCommit` throws (a
	 * `SealedSegmentsError` precondition, say), so no latch is left held.
	 */
	static async open(collections: ReadonlyMap<CollectionId, Collection<any>>, entry: EntryCommit): Promise<EntryParticipants> {
		if (entry.collectionIds.length === 0) {
			throw new Error(`commitEntry ${entry.entryId}: an entry commit names at least one collection`);
		}
		const sorted = [...new Set(entry.collectionIds)].sort(compareCollectionIds);
		if (sorted.length !== entry.collectionIds.length) {
			throw new Error(`commitEntry ${entry.entryId}: a collection is named twice in ${entry.collectionIds.join(', ')}`);
		}
		const participants = sorted.map(collectionId => {
			const collection = collections.get(collectionId);
			if (!collection) {
				throw new Error(`commitEntry ${entry.entryId}: collection ${collectionId} is not registered with this coordinator`);
			}
			return { collectionId, collection };
		});
		const handles = new Map<CollectionId, HeadCommitHandle>();
		try {
			for (const { collectionId, collection } of participants) {
				handles.set(collectionId, await collection.openHeadCommit(entry.entryId,
					{ actionId: entry.actionId, timestamp: entry.timestamp }, entry.resume?.get(collectionId)));
			}
		} catch (err) {
			closeAll(handles);
			throw err;
		}
		return new EntryParticipants(entry, handles);
	}

	/** How many participants are left to commit. */
	get size(): number {
		return this.handles.size;
	}

	/** The participants left to commit, in sorted order. */
	ids(): CollectionId[] {
		return [...this.handles.keys()];
	}

	/** Every remaining participant as a refresh-round participant: its handle's refresh, and
	 * leaving the set once the refresh finished the entry's own log entry (the handle consumed the
	 * head meanwhile, `Collection.consumeHead`). A snapshot, since a saved participant leaves the
	 * set mid-round. */
	refreshers(): RefreshParticipant[] {
		return [...this.handles].map(([collectionId, handle]) => ({
			collectionId,
			refresh: (report, lastChance) => handle.refresh(report, lastChance),
			saved: () => this.drop(collectionId),
		}));
	}

	/** Build the attempt of every remaining participant, in sorted order, under the latches
	 * (`HeadCommitHandle.stage`). A throw — a participant's recorded refusal, a block too large to
	 * send — leaves nothing sent and nothing on any participant changed: an attempt is built on a
	 * tracker of its own. */
	async stage(): Promise<Map<CollectionId, StagedAttempt>> {
		const staged = new Map<CollectionId, StagedAttempt>();
		for (const [collectionId, handle] of this.handles) {
			staged.set(collectionId, await handle.stage());
		}
		return staged;
	}

	/** Every participant's attempt as the write-ahead hook and the retained attempt carry it. */
	retainedAttempts(staged: ReadonlyMap<CollectionId, StagedAttempt>): Map<CollectionId, InFlightAttempt> {
		return new Map([...staged].map(([collectionId, attempt]) => [collectionId, retainedAttempt(attempt, this.entry.actionId)]));
	}

	/** Release every participant's latch for the network round; see `HeadCommitHandle.release`. */
	release(): void {
		for (const handle of this.handles.values()) {
			handle.release();
		}
	}

	/** Retake every participant's latch, in sorted order, every one even after one throws (a throw
	 * here is a driver defect, and a handle left released is tolerated by {@link close}). */
	retake(): Promise<void> {
		return visitEveryThenThrow(this.handles.values(), handle => handle.retake());
	}

	/**
	 * The local treatment of the participants in `ids`, which an attempt committed: fold every one's
	 * attempt in one await-free pass (`HeadCommitHandle.fold` — the head segment removed, the
	 * attempt's transforms in the cache, its revision adopted), so a committed read observes every
	 * committed participant pre-fold or post-fold, the event-loop atomicity
	 * `TransactionCoordinator.commitOnceLatched`'s success fold promises; then replay each one's
	 * remaining segments over the committed state (`HeadCommitHandle.replay`), every one even after
	 * one throws; then close them, since they are saved and leave the set.
	 */
	async landed(staged: ReadonlyMap<CollectionId, StagedAttempt>, ids: Iterable<CollectionId>): Promise<void> {
		const committed = [...ids].map(collectionId => ({ collectionId, handle: this.handle(collectionId), attempt: staged.get(collectionId) }));
		for (const { collectionId, handle, attempt } of committed) {
			if (attempt === undefined) {
				throw new Error(`commitEntry ${this.entry.entryId}: no attempt was staged for committed participant ${collectionId}`);
			}
			handle.fold(attempt);
		}
		try {
			await visitEveryThenThrow(committed, ({ handle }) => handle.replay());
		} finally {
			for (const { collectionId } of committed) {
				this.drop(collectionId);
			}
		}
	}

	/** The participants in `ids` had their attempt refused: re-check each one's recorded refusal and
	 * retain its attempt for the next refresh to finish from (`HeadCommitHandle.refused`), every one
	 * even after one throws, then throw the first recorded refusal met. */
	refused(staged: ReadonlyMap<CollectionId, StagedAttempt>, ids: Iterable<CollectionId>): void {
		let first: { error: unknown } | undefined;
		for (const collectionId of ids) {
			const attempt = staged.get(collectionId);
			if (attempt === undefined) {
				throw new Error(`commitEntry ${this.entry.entryId}: no attempt was staged for refused participant ${collectionId}`);
			}
			try {
				this.handle(collectionId).refused(attempt);
			} catch (error) {
				first ??= { error };
			}
		}
		if (first !== undefined) {
			throw first.error;
		}
	}

	/** Close every remaining handle, in reverse order. Idempotent, like the handles' own `close`. */
	close(): void {
		closeAll(this.handles);
		this.handles.clear();
	}

	/** A participant leaves the set: its handle is closed (the latch released, the marks cleared). */
	private drop(collectionId: CollectionId): void {
		this.handle(collectionId).close();
		this.handles.delete(collectionId);
	}

	private handle(collectionId: CollectionId): HeadCommitHandle {
		const handle = this.handles.get(collectionId);
		if (handle === undefined) {
			throw new Error(`commitEntry ${this.entry.entryId}: ${collectionId} is not a remaining participant`);
		}
		return handle;
	}
}

/** The latch-acquisition order of `TransactionCoordinator.commitOnce` and `execute`, spelled the
 * same way: a plain string comparison. Change all three together. */
function compareCollectionIds(a: CollectionId, b: CollectionId): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Close `handles` in reverse order of opening — latches are released in the reverse of the order
 * they were taken, as the coordinator's commit span releases its. */
function closeAll(handles: ReadonlyMap<CollectionId, HeadCommitHandle>): void {
	for (const handle of [...handles.values()].reverse()) {
		handle.close();
	}
}
