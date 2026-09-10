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
 * - `keepExisting` — if the key exists, skip this entry silently (SQL INSERT OR IGNORE).
 * - `absentRange` — no OTHER entry may exist in `range` (secondary-UNIQUE enforcement,
 *   where uniqueness is a property of a framed key PREFIX rather than one exact key).
 *   Defined here for serialization stability; the handler arm is wired up by the
 *   secondary-unique guard work and REFUSES (throws) if encountered before then.
 *
 * MIXED VERSIONS: a peer running a build that predates guards destructures `[key, entry]`
 * and ignores the third slot — its replays revert to today's silent overwrite. No version
 * gating exists yet (see backlog ticket `debt-mixed-version-identify-incompatibility`).
 */
export type TreeEntryGuard<TKey> =
	| { kind: 'absent' }
	| { kind: 'keepExisting' }
	| { kind: 'absentRange', range: KeyRange<TKey> };

/** Represents a unit of change to a tree collection. */
export type TreeReplaceAction<TKey, TEntry> = [
	// The key to replace
	key: TKey,
	// The new entry to replace the old entry with (if not provided, the key is deleted)
	entry?: TEntry,
	// Optional uniqueness intent, re-checked on every handler run (see TreeEntryGuard).
	// Absent = plain upsert, so existing callers and previously committed log entries
	// deserialize and replay unchanged.
	guard?: TreeEntryGuard<TKey>,
][];

/**
 * Thrown by the tree `replace` handler when an entry guarded `absent` finds its key
 * already present — at initial staging, or (the load-bearing case) at conflict replay
 * after a rival writer's commit was adopted. The throw discards the whole action's
 * staged writes (the handler runs inside an all-or-nothing Atomic wrapper) and
 * propagates out of the sync/commit retry loops: it is not a StaleFailure, so no
 * retry absorbs it, and it must never be downgraded to a retryable condition.
 */
export class TreeKeyTakenError<TKey = unknown> extends Error {
	constructor(
		/** The collection whose tree refused the entry. */
		public readonly collectionId: CollectionId,
		/** The key some other writer already committed. */
		public readonly key: TKey,
	) {
		// String keys render JSON-quoted so framing control bytes stay visible/escaped in
		// logs; everything else via String() — JSON.stringify would throw on a bigint key,
		// and an error constructor must never be the second failure.
		super(`Tree collection ${collectionId}: key ${typeof key === 'string' ? JSON.stringify(key) : String(key)} is already taken by a committed entry`);
		this.name = 'TreeKeyTakenError';
	}
}

