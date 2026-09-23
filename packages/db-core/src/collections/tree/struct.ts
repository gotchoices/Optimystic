import type { BlockId, CollectionHeaderBlock, CollectionId } from "../../index.js";
import type { KeyRange } from "../../btree/index.js";
import { registerBlockType } from "../../blocks/block-types.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
import { nameof } from "../../utility/nameof.js";

export const TreeHeaderBlockType = registerBlockType("TRE", "TreeHeaderBlock");

registerCollectionType({
	blockType: TreeHeaderBlockType,
	name: "Tree",
});

export type TreeCollectionHeaderBlock = CollectionHeaderBlock & {
	rootId: BlockId;
};

export const rootId$ = nameof<TreeCollectionHeaderBlock>("rootId");

/**
 * Serializable statement of the INTENT behind a staged tree entry, enforced by the
 * `replace` handler every time it runs — at initial staging AND at every conflict
 * replay against a newly adopted committed revision. Without a guard, staging is a
 * bare upsert, and a conflict replay silently overwrites whatever a rival writer
 * committed at the same key (the concurrent-INSERT lost-uniqueness bug).
 *
 * - `absent` — the key must not exist (SQL INSERT): a hit throws {@link TreeKeyTakenError},
 *   discarding the whole action's staged writes.
 * - `keepExisting` — if the key exists, skip this entry silently. No SQL statement stages
 *   it any more (INSERT OR IGNORE is guarded `absent`, because skipping only the main-table
 *   entry would leave the statement's index entries beside a rival's row — see the
 *   `unchanged` paragraph in docs/internals.md); kept as a serialized log form.
 * - `absentRange` — no entry OTHER THAN this action's own key may exist in `range`
 *   (secondary-UNIQUE enforcement, where uniqueness is a property of a framed key
 *   PREFIX rather than one exact key: an index tree keys `indexKey ‖ primaryKey`, so
 *   two rows sharing a unique value sit at different keys inside one prefix range). A
 *   foreign hit throws {@link TreeRangeTakenError}. The entry being staged lands inside
 *   its own range, so the scan excludes its exact key — otherwise every guarded
 *   re-stage of a present key (a replay after a clean refresh) would refuse itself.
 * - `unchanged` — see {@link TreeUnchangedGuard}: the only kind that says something must
 *   still BE here, rather than that nothing may be.
 *
 * MIXED VERSIONS: a peer running a build that predates guards destructures `[key, entry]`
 * and ignores the third slot — its replays revert to today's silent overwrite. No version
 * gating exists yet (see backlog ticket `debt-mixed-version-identify-incompatibility`).
 */
export type TreeEntryGuard<TKey, TEntry = unknown> =
	| { kind: 'absent' }
	| { kind: 'keepExisting' }
	| { kind: 'absentRange', range: KeyRange<TKey> }
	| TreeUnchangedGuard<TEntry>;

/**
 * "The entry I am replacing must still be exactly the one I read" — the optimistic-concurrency
 * (lost-update) guard, and the only {@link TreeEntryGuard} kind that also applies to a DELETE.
 * The entry at the key must be PRESENT and structurally equal to `expected` (`structuralEquals`
 * in `packages/db-core/src/utility/structural-equals.ts`); otherwise the handler throws
 * {@link TreeEntryChangedError}.
 *
 * ABSENT COUNTS AS CHANGED. The staged effect was computed from an entry image that no longer
 * exists, so re-applying it is never right: an upsert would resurrect a row a rival deleted, and
 * a delete would be the second of two racing deletes. Refusing both is the optimistic answer —
 * the writer read a row that is now gone, and an application-level retry then affects zero rows
 * sequentially. If tolerating absence on deletes is ever genuinely wanted, add a separate
 * `unchangedOrAbsent` kind rather than weakening this one's contract.
 *
 * `expected` is the entry AS STORED, not a digest: a guard rides in the log beside its action
 * under the same encoding entries already use, so a full copy round-trips by construction and no
 * digest scheme has to be invented, versioned, or kept in sync with the entry encoding.
 *
 * NOTE: that choice roughly doubles the row bytes of every guarded log entry (the new entry plus
 * a full copy of the old one). If log volume ever becomes the binding constraint, replace
 * `expected` with a content digest — the block-digest utilities under
 * `packages/db-core/src/transaction/` are the starting point — and accept the versioning burden
 * that comes with it.
 */
export type TreeUnchangedGuard<TEntry = unknown> = {
	kind: 'unchanged',
	/** The entry image the staged write read, as stored. */
	expected: TEntry,
};

/** An element that writes (inserts or replaces) an entry. Any {@link TreeEntryGuard} kind is
 *  meaningful here. */
export type TreeUpsertElement<TKey, TEntry> = [
	// The key to write at
	key: TKey,
	// The entry to write
	entry: TEntry,
	// Optional intent, re-checked on every handler run (see TreeEntryGuard). Absent = plain
	// upsert, so existing callers and previously committed log entries deserialize and replay
	// unchanged.
	guard?: TreeEntryGuard<TKey, TEntry>,
];

/** An element that deletes the entry at a key. Only {@link TreeUnchangedGuard} says anything a
 *  delete can act on — the other kinds all assert that nothing is present, which would make the
 *  delete a no-op by construction. The handler rejects any other kind at runtime too, since a
 *  replayed log entry is deserialized data that this type never policed. */
export type TreeDeleteElement<TKey, TEntry> = [
	// The key to delete
	key: TKey,
	// Always empty: the absent entry is what marks this element a delete
	entry?: undefined,
	// Optional lost-update guard: refuse the delete unless the entry is still the one that was read
	guard?: TreeUnchangedGuard<TEntry>,
];

/** Represents a unit of change to a tree collection. */
export type TreeReplaceAction<TKey, TEntry> = (
	| TreeUpsertElement<TKey, TEntry>
	| TreeDeleteElement<TKey, TEntry>
)[];

/**
 * Base of every refusal a {@link TreeEntryGuard} raises out of the tree `replace` handler — at
 * initial staging, or (the load-bearing case) at conflict replay after a rival writer's commit
 * was adopted. One contract, stated once for every subclass:
 *
 * - The throw **discards the whole action's staged writes** — the handler runs inside an
 *   all-or-nothing Atomic wrapper, so not one entry of a multi-entry action lands.
 * - It is **not a `StaleFailure`**, so neither `Collection.sync`'s retry loop nor
 *   `TransactionCoordinator.commit`'s stale-loss re-drive absorbs it; it propagates out of the
 *   losing commit, and it must never be downgraded to a retryable condition.
 *
 * Subclasses split by WHAT was refused, because consumers map them differently: a
 * {@link TreeKeyTakenError} is a uniqueness violation (the Quereus bridge renders it as
 * `UNIQUE constraint failed` and raises the engine's `ConstraintError`), while a
 * {@link TreeEntryChangedError} is a lost update (the bridge raises its
 * `ConcurrentModificationError`, status code BUSY, which is not a constraint error). Catch
 * this base to treat any guard refusal uniformly; catch a subclass to say which happened.
 */
export class TreeGuardRefusedError<TKey = unknown> extends Error {
	constructor(
		/** The collection whose tree refused the entry. */
		public readonly collectionId: CollectionId,
		/** The key whose staged entry was refused. */
		public readonly key: TKey,
		message: string,
	) {
		super(message);
		this.name = 'TreeGuardRefusedError';
	}
}

/**
 * Thrown when an entry guarded `absent` finds its key already present: a duplicate-key
 * refusal. See {@link TreeGuardRefusedError} for the contract every guard refusal shares.
 */
export class TreeKeyTakenError<TKey = unknown> extends TreeGuardRefusedError<TKey> {
	constructor(
		collectionId: CollectionId,
		/** The key some other writer already committed (for the `absentRange` subclass: the
		 * key this action was staging, whose claimed range a rival occupies). */
		key: TKey,
		/** Subclass override of the rendered message; the default names the exact-key refusal. */
		message?: string,
	) {
		super(collectionId, key,
			message ?? `Tree collection ${collectionId}: key ${renderKey(key)} is already taken by a committed entry`);
		this.name = 'TreeKeyTakenError';
	}
}

/**
 * The `absentRange` refusal: the guarded entry's key is free, but some OTHER committed
 * entry (`occupant`) sits inside the range the entry claims exclusively — for a unique
 * index tree, a rival's row carrying the same unique value under a different primary
 * key. A subclass of {@link TreeKeyTakenError} on purpose: every consumer that treats a
 * key refusal as a non-retryable uniqueness failure (the sync/commit retry loops let it
 * escape; the Quereus bridge maps it by `collectionId` to a `ConstraintError` carrying the
 * `UNIQUE constraint failed` message) handles this one identically without a second arm.
 * `collectionId` is the
 * discriminator that names WHICH constraint fired — each unique index is its own
 * collection — so the bridge needs nothing beyond it.
 */
export class TreeRangeTakenError<TKey = unknown> extends TreeKeyTakenError<TKey> {
	constructor(
		collectionId: CollectionId,
		/** The key this action was staging (free — it is the range that is contested). */
		key: TKey,
		/** The range the entry claimed exclusively. */
		public readonly range: KeyRange<TKey>,
		/** The committed key found inside `range` that is not `key`. */
		public readonly occupant: TKey,
	) {
		super(collectionId, key,
			`Tree collection ${collectionId}: key ${renderKey(key)} is guarded unique over a key range `
			+ `already occupied by committed entry ${renderKey(occupant)}`);
		this.name = 'TreeRangeTakenError';
	}
}

/**
 * The {@link TreeUnchangedGuard} refusal: the entry at `key` is no longer the one the staged
 * write read — a rival committed a different entry there, or removed it (`actual` is
 * `undefined`). A lost update, NOT a uniqueness violation, which is why this deliberately does
 * NOT subclass {@link TreeKeyTakenError}: the Quereus bridge renders every `TreeKeyTakenError`
 * as that collection's registered `UNIQUE constraint failed` message and raises the engine's
 * `ConstraintError` for it (`mapCommitRefusal` in
 * `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`), and reporting a
 * concurrent-update refusal as a uniqueness failure would mislead every client that reads it.
 * The bridge raises its own `ConcurrentModificationError` (status code BUSY) for this one instead.
 * The shared contract lives on {@link TreeGuardRefusedError}.
 */
export class TreeEntryChangedError<TKey = unknown, TEntry = unknown> extends TreeGuardRefusedError<TKey> {
	constructor(
		collectionId: CollectionId,
		/** The key whose entry the staged write was replacing or deleting. */
		key: TKey,
		/** The entry image the staged write read, as carried by its guard. */
		public readonly expected: TEntry,
		/** What is committed at `key` now; `undefined` when the entry is gone entirely. */
		public readonly actual: TEntry | undefined,
	) {
		super(collectionId, key,
			`Tree collection ${collectionId}: the entry at key ${renderKey(key)} was `
			+ `${actual === undefined ? 'removed' : 'changed'} by another writer since this change read it`);
		this.name = 'TreeEntryChangedError';
	}
}

/**
 * A DELETE element carries a guard kind no delete can act on. NOT a concurrency refusal and
 * deliberately not a {@link TreeGuardRefusedError}: every other kind asserts that nothing is
 * present, which would make the delete a no-op by construction, so this is a malformed action —
 * a caller bug, or a log entry written by a build whose element types disagree with this one.
 * The handler raises it rather than ignoring the guard (the pre-guard behaviour) so a writer
 * never believes an unenforceable guard is being enforced.
 */
export class TreeDeleteGuardKindError<TKey = unknown> extends Error {
	constructor(
		/** The collection whose tree rejected the element. */
		public readonly collectionId: CollectionId,
		/** The key the malformed delete named. */
		public readonly key: TKey,
		/** The `kind` that was carried; only `'unchanged'` is meaningful on a delete. */
		public readonly guardKind: string,
	) {
		super(`Tree collection ${collectionId}: the delete of key ${renderKey(key)} carries a `
			+ `'${guardKind}' guard; only 'unchanged' is meaningful on a delete`);
		this.name = 'TreeDeleteGuardKindError';
	}
}

/** String keys render JSON-quoted so framing control bytes stay visible/escaped in logs;
 * everything else via String() — JSON.stringify would throw on a bigint key, and an error
 * constructor must never be the second failure. Module-private on purpose: every tree message
 * renders a key the same way because every one of them is constructed in this file. */
function renderKey(key: unknown): string {
	return typeof key === 'string' ? JSON.stringify(key) : String(key);
}

