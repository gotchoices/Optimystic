import type { BlockId, CollectionHeaderBlock, CollectionId } from "../../index.js";
import type { KeyRange } from "../../btree/index.js";
import { registerBlockType } from "../../blocks/block-types.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
import { ActionRefusedError } from "../../collection/struct.js";
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
 * - `absentOrEqual`, `unchangedOrEqual`, `unchangedOrAbsent` — the three ALREADY-APPLIED variants
 *   (see {@link TreeAlreadyAppliedGuard}): each accepts, and SKIPS the element, where a rival has
 *   already made exactly the change this element makes, instead of refusing it.
 *
 * MIXED VERSIONS: a peer running a build that predates guards destructures `[key, entry]`
 * and ignores the third slot — its replays revert to today's silent overwrite. No version
 * gating exists yet (see backlog ticket `debt-mixed-version-identify-incompatibility`).
 */
export type TreeEntryGuard<TKey, TEntry = unknown> =
	| { kind: 'absent' }
	| { kind: 'keepExisting' }
	| { kind: 'absentRange', range: KeyRange<TKey> }
	| TreeUnchangedGuard<TEntry>
	| TreeAlreadyAppliedGuard<TEntry>;

/**
 * The three guard kinds that accept a row another writer already changed the same way, for the
 * offline-sync queue's rebase of a queued entry (docs/offline-sync.md §Guards that make idempotent
 * writes assured). Every guard above refuses when the row is not as the staged write found it, which
 * includes the rival that made exactly the change this write makes: two machines marking one task
 * done, two machines deleting one row. Each variant below has three outcomes, where its base kind has
 * two — it ACCEPTS AND WRITES as the base kind does, it ACCEPTS AS ALREADY APPLIED and skips the
 * element (the final state is the one the write intended), or it REFUSES with the base kind's error:
 *
 * | Kind | Element | Writes when | Skips as already applied when | Refuses with |
 * |---|---|---|---|---|
 * | `absentOrEqual` | upsert | the key is absent | the present entry equals the element's own `entry` | {@link TreeKeyTakenError}, as `absent` does |
 * | `unchangedOrEqual` | upsert | the present entry equals `expected` | the present entry equals the element's own `entry` (checked second, so a no-op update whose `expected` equals its `entry` writes) | {@link TreeEntryChangedError} on absent or any other entry |
 * | `unchangedOrAbsent` | delete | the present entry equals `expected` | the key is absent | {@link TreeEntryChangedError} on any other entry |
 *
 * "Equals" is `structuralEquals` in `packages/db-core/src/utility/structural-equals.ts`, the
 * comparison `unchanged` uses, with the same JSON caveats {@link TreeUnchangedGuard} states. The
 * post-image an upsert variant compares against is the element's own `entry`, not a second copy on
 * the guard: the element already carries it, so the guard stays the size its base kind is.
 *
 * Kinds and elements: `unchangedOrAbsent` is meaningful only on a delete (on an upsert it would mean
 * "resurrect the row"), and the two `…OrEqual` kinds only on an upsert (a delete has no `entry` to
 * compare, and would be a no-op by construction). The handler narrows both ways at runtime: a delete
 * carrying an upsert-only kind throws {@link TreeDeleteGuardKindError}, an upsert carrying the
 * delete-only kind {@link TreeUpsertGuardKindError} — malformed actions, outside the refusal
 * hierarchy, never ignored.
 *
 * Whether an element accepted as already applied changed anything is reported out of the handler
 * as an `AlreadyAppliedTally` (`packages/db-core/src/collection/action.ts`), which the offline queue
 * folds into the `effect` of its `committed` status.
 */
export type TreeAlreadyAppliedGuard<TEntry = unknown> =
	| { kind: 'absentOrEqual' }
	| { kind: 'unchangedOrEqual', /** The entry image the staged write read, as stored. */ expected: TEntry }
	| { kind: 'unchangedOrAbsent', /** The entry image the staged delete read, as stored. */ expected: TEntry };

/** The kinds a {@link TreeUpsertElement} may carry: every kind but the delete-only
 * `unchangedOrAbsent`. */
export type TreeUpsertGuard<TKey, TEntry = unknown> = Exclude<TreeEntryGuard<TKey, TEntry>, { kind: 'unchangedOrAbsent' }>;

/** The kinds a {@link TreeDeleteElement} may carry: the two that say something must still BE at the
 * key — `unchanged`, and `unchangedOrAbsent`, which also accepts the key already gone. */
export type TreeDeleteGuard<TEntry = unknown> = TreeUnchangedGuard<TEntry> | Extract<TreeAlreadyAppliedGuard<TEntry>, { kind: 'unchangedOrAbsent' }>;

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
 * sequentially. A delete that means "gone either way" carries `unchangedOrAbsent` instead, and an
 * upsert that means "equal either way" carries `unchangedOrEqual` ({@link TreeAlreadyAppliedGuard});
 * this kind's contract is not weakened for them.
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

/** An element that writes (inserts or replaces) an entry. Every {@link TreeEntryGuard} kind but the
 *  delete-only `unchangedOrAbsent` is meaningful here ({@link TreeUpsertGuard}). */
export type TreeUpsertElement<TKey, TEntry> = [
	// The key to write at
	key: TKey,
	// The entry to write
	entry: TEntry,
	// Optional intent, re-checked on every handler run (see TreeEntryGuard). Absent = plain
	// upsert, so existing callers and previously committed log entries deserialize and replay
	// unchanged.
	guard?: TreeUpsertGuard<TKey, TEntry>,
];

/** An element that deletes the entry at a key. Only the two kinds that say something must still BE
 *  at the key say anything a delete can act on ({@link TreeDeleteGuard}) — the other kinds all assert
 *  that nothing is present, which would make the delete a no-op by construction. The handler rejects
 *  any other kind at runtime too, since a replayed log entry is deserialized data that this type
 *  never policed. */
export type TreeDeleteElement<TKey, TEntry> = [
	// The key to delete
	key: TKey,
	// Always empty: the absent entry is what marks this element a delete
	entry?: undefined,
	// Optional lost-update guard: refuse the delete unless the entry is still the one that was read
	// (`unchanged`), or unless it is either that or already gone (`unchangedOrAbsent`)
	guard?: TreeDeleteGuard<TEntry>,
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
 *
 * It is the tree's {@link ActionRefusedError}, which is what the collection's segment-aware
 * replay recognises (a refusal from a sealed segment is recorded against that segment rather
 * than thrown — see `Collection.replayActions`); the classifier and the bridge keep matching
 * this class, which the subclass relation leaves unchanged.
 */
export class TreeGuardRefusedError<TKey = unknown> extends ActionRefusedError {
	constructor(
		/** The collection whose tree refused the entry. */
		collectionId: CollectionId,
		/** The key whose staged entry was refused. */
		public readonly key: TKey,
		message: string,
	) {
		super(collectionId, message);
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
 * never believes an unenforceable guard is being enforced. {@link TreeUpsertGuardKindError} is the
 * upsert side of the same check.
 */
export class TreeDeleteGuardKindError<TKey = unknown> extends Error {
	constructor(
		/** The collection whose tree rejected the element. */
		public readonly collectionId: CollectionId,
		/** The key the malformed delete named. */
		public readonly key: TKey,
		/** The `kind` that was carried; only `'unchanged'` and `'unchangedOrAbsent'` are meaningful on
		 * a delete. */
		public readonly guardKind: string,
	) {
		super(`Tree collection ${collectionId}: the delete of key ${renderKey(key)} carries a `
			+ `'${guardKind}' guard; only 'unchanged' and 'unchangedOrAbsent' are meaningful on a delete`);
		this.name = 'TreeDeleteGuardKindError';
	}
}

/**
 * An UPSERT element carries the delete-only guard kind, `unchangedOrAbsent`: on an upsert it would
 * mean "write the row whether or not a rival deleted it", which resurrects a row the staged write
 * never meant to and so is a malformed action, not a concurrency refusal — the mirror of
 * {@link TreeDeleteGuardKindError}, and like it deliberately not a {@link TreeGuardRefusedError}.
 */
export class TreeUpsertGuardKindError<TKey = unknown> extends Error {
	constructor(
		/** The collection whose tree rejected the element. */
		public readonly collectionId: CollectionId,
		/** The key the malformed upsert named. */
		public readonly key: TKey,
		/** The `kind` that was carried. */
		public readonly guardKind: string,
	) {
		super(`Tree collection ${collectionId}: the upsert of key ${renderKey(key)} carries a `
			+ `'${guardKind}' guard, which is meaningful only on a delete`);
		this.name = 'TreeUpsertGuardKindError';
	}
}

/** String keys render JSON-quoted so framing control bytes stay visible/escaped in logs;
 * everything else via String() — JSON.stringify would throw on a bigint key, and an error
 * constructor must never be the second failure. Module-private on purpose: every tree message
 * renders a key the same way because every one of them is constructed in this file. */
function renderKey(key: unknown): string {
	return typeof key === 'string' ? JSON.stringify(key) : String(key);
}

