import { Collection, type CollectionInitOptions, type CollectionId, type CollectionSnapshot, type ReadViewOptions } from "../../collection/index.js";
import type { ITransactor, BlockId, BlockStore, IBlock, ActionId, WriteDurability } from "../../index.js";
import { BTree, type Path, type KeyRange } from "../../btree/index.js";
import { CollectionTrunk } from "./collection-trunk.js";
import { structuralEquals } from "../../utility/structural-equals.js";
import { BLOCK_TARGET_BYTES } from "../../network/block-size.js";
import { ZeroTally } from "../../collection/action.js";
import type { AlreadyAppliedTally } from "../../collection/action.js";
import {
	TreeHeaderBlockType, TreeDeleteGuardKindError, TreeEntryChangedError, TreeKeyTakenError,
	TreeRangeTakenError, TreeUpsertGuardKindError, type TreeEntryGuard, type TreeReplaceAction,
} from "./struct.js";

/** What a guard decided for its element: write it, skip it with no claim about equality
 * (`keepExisting` found the key occupied), or skip it because a rival already made exactly this
 * change — the already-applied acceptance a `TreeAlreadyAppliedGuard` kind makes, which is the one
 * skip the handler counts (`alreadyApplied` on the {@link AlreadyAppliedTally}). */
type GuardVerdict = 'proceed' | 'skip' | 'already-applied';

/**
 * Enforce a guard carried by an UPSERT element against the CURRENT content of `actionTree` —
 * the same Atomic store the upsert writes to, so it sees what earlier elements of this same
 * replay already staged or deleted (an UPDATE's delete-old half runs before its guarded insert
 * half). Throws the guard's refusal, which discards the whole action's staged writes. `entry` is the
 * element's own entry, the post-image the `…OrEqual` kinds compare against.
 *
 * @returns `'skip'` when the element must be left unwritten (`keepExisting` found the key
 * 	occupied — the INSERT OR IGNORE disposition), `'already-applied'` when an already-applied kind
 * 	found the rival had made this change, `'proceed'` otherwise.
 */
async function enforceUpsertGuard<TKey, TEntry>(
	actionTree: BTree<TKey, TEntry>,
	id: CollectionId,
	key: TKey,
	entry: TEntry,
	guard: TreeEntryGuard<TKey, TEntry>,
	keyFromEntry: (entry: TEntry) => TKey,
	compare: (a: TKey, b: TKey) => number,
): Promise<GuardVerdict> {
	switch (guard.kind) {
		case 'absentRange': {
			// Secondary-UNIQUE: the claimed range (a unique index's framed value prefix) must hold
			// no entry other than this action's own key. Two short descents (range start and end)
			// plus an early-exit walk. The guard is plain data (it is serialized into the log with
			// its action), and BTree.range reads the range's fields only — so a KeyRange that has
			// round-tripped through JSON is scanned exactly like a live instance.
			for await (const path of actionTree.range(guard.range)) {
				const occupant = actionTree.at(path);
				if (occupant === undefined) continue;
				const occupantKey = keyFromEntry(occupant);
				if (compare(occupantKey, key) === 0) continue;	// self-exclusion
				throw new TreeRangeTakenError(id, key, guard.range, occupantKey);
			}
			return 'proceed';
		}
		case 'unchanged': {
			assertEntryUnchanged(id, key, guard.expected, actionTree.at(await actionTree.find(key)));
			return 'proceed';
		}
		case 'absent':
		case 'keepExisting': {
			if (!(await actionTree.find(key)).on) return 'proceed';
			if (guard.kind === 'absent') throw new TreeKeyTakenError(id, key);
			// keepExisting: leave the present (rival's) entry in place and skip this element.
			return 'skip';
		}
		case 'absentOrEqual': {
			const actual = actionTree.at(await actionTree.find(key));
			if (actual === undefined) return 'proceed';
			if (structuralEquals(actual, entry)) return 'already-applied';
			throw new TreeKeyTakenError(id, key);
		}
		case 'unchangedOrEqual': {
			const actual = actionTree.at(await actionTree.find(key));
			// `expected` first: a no-op update (expected equals entry) writes and counts as applied.
			if (actual !== undefined && structuralEquals(actual, guard.expected)) return 'proceed';
			if (actual !== undefined && structuralEquals(actual, entry)) return 'already-applied';
			throw new TreeEntryChangedError(id, key, guard.expected, actual);
		}
		case 'unchangedOrAbsent': {
			throw new TreeUpsertGuardKindError(id, key, guard.kind);
		}
	}
}

/**
 * Enforce a guard carried by a DELETE element against the entry found at its path. Throws the
 * guard's refusal, or {@link TreeDeleteGuardKindError} for a kind no delete can act on — the element
 * type already says so ({@link TreeDeleteElement}), but a replayed log entry is deserialized data
 * that no type policed, so the handler re-checks rather than silently ignoring a guard the writer
 * believed was being enforced.
 *
 * @returns `'already-applied'` when `unchangedOrAbsent` found the key already gone (nothing to
 * 	delete), `'proceed'` otherwise.
 */
function enforceDeleteGuard<TKey, TEntry>(
	id: CollectionId,
	key: TKey,
	guard: TreeEntryGuard<TKey, TEntry>,
	actual: TEntry | undefined,
): Exclude<GuardVerdict, 'skip'> {
	switch (guard.kind) {
		case 'unchanged': {
			assertEntryUnchanged(id, key, guard.expected, actual);
			return 'proceed';
		}
		case 'unchangedOrAbsent': {
			if (actual === undefined) return 'already-applied';
			assertEntryUnchanged(id, key, guard.expected, actual);
			return 'proceed';
		}
		default: {
			throw new TreeDeleteGuardKindError(id, key, guard.kind);
		}
	}
}

/** Whether a write under `guard` counts as `applied` on the tally (see {@link AlreadyAppliedTally}):
 * the three already-applied kinds, whose skips are the `alreadyApplied` side, and the two exact-key
 * base kinds that write whenever they do not refuse — `absent` and `unchanged`, which the SQL layer
 * stages on every main-table element and never on an index tree — so an entry with a plain insert
 * beside an already-applied update reads `applied`, as a host taking `already-applied` for "none of
 * my changes landed" needs. Not counted: `keepExisting` (its skip says nothing about equality),
 * `absentRange` and an unguarded element, the shapes an index tree's entries take, whose writes
 * under an already-applied entry are rewrites of what the rival's row already implies. */
function countsWrite<TKey, TEntry>(guard: TreeEntryGuard<TKey, TEntry>): boolean {
	return guard.kind === 'absent' || guard.kind === 'unchanged'
		|| guard.kind === 'absentOrEqual' || guard.kind === 'unchangedOrEqual' || guard.kind === 'unchangedOrAbsent';
}

/** A tally over one handler run, mutable while the run counts. */
class TallyBuilder {
	private alreadyApplied = 0;
	private applied = 0;

	/** Count `verdict` for an element carrying `guard`. Only an already-applied kind answers
	 * `'already-applied'`; a write counts when {@link countsWrite} says so. */
	count<TKey, TEntry>(guard: TreeEntryGuard<TKey, TEntry>, verdict: GuardVerdict): void {
		if (verdict === 'already-applied') this.alreadyApplied++;
		else if (verdict === 'proceed' && countsWrite(guard)) this.applied++;
	}

	result(): AlreadyAppliedTally {
		return this.alreadyApplied === 0 && this.applied === 0
			? ZeroTally
			: { alreadyApplied: this.alreadyApplied, applied: this.applied };
	}
}

/** The lost-update check shared by guarded upserts and guarded deletes: the committed entry must
 *  be present AND structurally equal to what the staged write read. Absence counts as changed —
 *  see {@link TreeUnchangedGuard} for why that is the contract on both dispositions. */
function assertEntryUnchanged<TKey, TEntry>(
	id: CollectionId,
	key: TKey,
	expected: TEntry,
	actual: TEntry | undefined,
): void {
	if (actual === undefined || !structuralEquals(actual, expected)) {
		throw new TreeEntryChangedError(id, key, expected, actual);
	}
}

/**
 * Read-only surface of a tree: every navigation/lookup method a reader needs, with
 * none of the mutation (stage/sync) or network-refresh (update) entry points. Both
 * the live {@link Tree} and the committed view returned by {@link Tree.readView}
 * structurally satisfy this, so a consumer can read through either uniformly.
 */
export interface TreeReadView<TKey, TEntry> {
	first(): Promise<Path<TKey, TEntry>>;
	find(key: TKey): Promise<Path<TKey, TEntry>>;
	get(key: TKey): Promise<TEntry | undefined>;
	at(path: Path<TKey, TEntry>): TEntry | undefined;
	range(range: KeyRange<TKey>): AsyncIterableIterator<Path<TKey, TEntry>>;
	entriesIn(range: KeyRange<TKey>): Promise<TEntry[]>;
	ascending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>>;
	isValid(path: Path<TKey, TEntry>): boolean;
}

/** Carries the read {@link BTree} from wherever it gets built (the `createHeaderBlock`
 * callback on the create path, {@link Tree.attach} on the open path) to the collection's
 * `onViewChanged` callback, which needs the live instance to invalidate outstanding paths. */
interface BTreeHolder<TKey, TEntry> {
	btree?: BTree<TKey, TEntry>;
}

/** The collection options a tree's opener may set — the ones that are not the tree's own to
 * decide. Today that is the sealed-segment refusal callback the offline-sync queue installs
 * (see {@link CollectionInitOptions.onSealedRefused}). */
export type TreeCollectionOptions = Pick<CollectionInitOptions<unknown>, 'onSealedRefused'>;

export class Tree<TKey, TEntry> implements TreeReadView<TKey, TEntry> {

	private constructor(
		private readonly collection: Collection<TreeReplaceAction<TKey, TEntry>>,
		private readonly btree: BTree<TKey, TEntry>,
		/** Captured so {@link readView} can rebuild a BTree over a committed tracker. */
		private readonly keyFromEntry: (entry: TEntry) => TKey,
		private readonly compare: (a: TKey, b: TKey) => number,
	) {
	}

	/** Open an EXISTING tree, or resolve to `undefined` when no header block has ever been
	 * committed under this id. Never brings a tree into existence — nothing is staged into the
	 * collection's tracker on the absent path, so a caller that ignores the `undefined` cannot
	 * later sync a phantom tree. Use on pure read paths; see {@link Collection.open}. */
	static async open<TKey, TEntry>(
		network: ITransactor,
		id: CollectionId,
		keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0,
		/** See {@link Tree.createOrOpen}'s `nodeCapacity`. */
		nodeCapacity?: number,
		/** See {@link Tree.createOrOpen}'s `options`. */
		options?: TreeCollectionOptions,
	): Promise<Tree<TKey, TEntry> | undefined> {
		const held: BTreeHolder<TKey, TEntry> = {};
		const init = Tree.buildInit(id, keyFromEntry, compare, nodeCapacity, held, options);
		const collection = await Collection.open<TreeReplaceAction<TKey, TEntry>>(network, id, init);
		return collection ? Tree.attach(collection, held, keyFromEntry, compare, nodeCapacity) : undefined;
	}

	static async createOrOpen<TKey, TEntry>(
		network: ITransactor,
		id: CollectionId,
		keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0,
		/** B-tree node fan-out. Defaults to the BTree default (64). Exposed mainly so tests can
		 *  force a multi-level tree with few entries (a small capacity), which is what exercises the
		 *  interior-navigation read-exclusion path — with the default you would need thousands of
		 *  entries before a descent has any interior branch between root and leaf.
		 *
		 *  NOTE: fan-out is NOT persisted in the collection header — it is a per-call construction
		 *  param. Creating a tree with a non-default capacity and later reopening it (a separate
		 *  createOrOpen call) without the SAME capacity silently uses 64, so subsequent writes split
		 *  at a fan-out the existing nodes were not built for. Fine today (only tests pass it, and
		 *  they pass it consistently); if a persisted tree ever needs a custom fan-out, persist it in
		 *  the header and read it back on reopen rather than trusting the caller to re-supply it. */
		nodeCapacity?: number,
		/** Collection options the opener sets rather than the tree: the sealed-segment refusal
		 *  callback (see {@link TreeCollectionOptions}). Omit for a tree nothing seals. */
		options?: TreeCollectionOptions,
	): Promise<Tree<TKey, TEntry>> {
		const held: BTreeHolder<TKey, TEntry> = {};
		const init = Tree.buildInit(id, keyFromEntry, compare, nodeCapacity, held, options);
		const collection = await Collection.createOrOpen<TreeReplaceAction<TKey, TEntry>>(network, id, init);
		return Tree.attach(collection, held, keyFromEntry, compare, nodeCapacity);
	}

	/** The collection wiring both open paths share. `held` carries the read btree between the
	 * `createHeaderBlock` callback (which must build it to obtain the root id) and {@link attach}. */
	private static buildInit<TKey, TEntry>(
		id: CollectionId,
		keyFromEntry: (entry: TEntry) => TKey,
		compare: (a: TKey, b: TKey) => number,
		nodeCapacity: number | undefined,
		held: BTreeHolder<TKey, TEntry>,
		options: TreeCollectionOptions | undefined,
	): CollectionInitOptions<TreeReplaceAction<TKey, TEntry>> {
		return {
			...options,
			modules: {
				"replace": async ({ data: actions }, trx): Promise<AlreadyAppliedTally> => {
					// Write through the Atomic store the handler is handed (`trx`), NOT the captured
					// read btree, so `internalTransact`'s all-or-nothing wrapper actually governs this
					// action: if any entry throws, `atomic.commit()` is skipped and every staged node
					// write from this action is discarded (whole-action rollback) — identically for
					// freshly created and reopened trees. Binding a throwaway BTree to `trx` reuses the
					// public constructor; no btree API change needed.
					const actionTree = new BTree<TKey, TEntry>(
						trx,
						new CollectionTrunk(trx, id),
						keyFromEntry,
						compare,
						nodeCapacity,	// keep the write btree's fan-out in lock-step with the read btree
						BLOCK_TARGET_BYTES,	// and its node size rule: every node is a block that must stay copyable
					);
					const tally = new TallyBuilder();
					for (const [key, entry, guard] of actions) {
						// NOTE: an element is a DELETE when its entry slot is falsy, not when it is
						// strictly `undefined`. That is deliberate and load-bearing: JSON encodes the
						// empty slot of `[key, undefined]` as `null`, so a replayed log entry arrives
						// as `[key, null]` and a `!== undefined` test would upsert `null` over the row.
						// JSON really is the live encoding, not just a hypothetical: the p2p repo
						// protocol stringifies and parses every message (`protocol-client.ts` and
						// `repo/service.ts` in `packages/db-p2p/src/`). The in-process test transactors
						// use `structuredClone`, which preserves `undefined` — so no test that goes
						// only through them can reach this shape; the round-trip spec below stages the
						// JSON shape explicitly for that reason.
						// The cost is that a falsy-but-real entry (`''`, `0`, `false`) reads as a
						// delete. No entry type in this repo is falsy today (rows encode to a non-empty
						// string or Uint8Array; index entries are arrays); if one ever is, this needs an
						// explicit delete marker in the tuple rather than a tighter comparison.
						if (entry) {
							// Enforce the entry's guard (if any) on EVERY handler run — initial staging
							// and every conflict replay — so the decision is re-made against the newest
							// adopted committed state, not just the stage-time snapshot. A throw here
							// discards the whole action's staged writes (Atomic wrapper).
							// Truthiness, not `!== undefined`, for the same round-trip reason as the entry
							// slot above: an explicitly-passed `undefined` guard (the shape every unguarded
							// index write stages) comes back from JSON as `null`, and reading `.kind` off it
							// would throw a TypeError mid-replay instead of meaning "no guard".
							if (guard) {
								const verdict = await enforceUpsertGuard(actionTree, id, key, entry, guard, keyFromEntry, compare);
								tally.count(guard, verdict);
								if (verdict !== 'proceed') continue;
							}
							await actionTree.upsert(entry);
						} else {
							// The path is found once and reused: the guard check reads it and `deleteAt`
							// consumes it, with no mutation in between to invalidate it.
							const path = await actionTree.find(key);
							if (guard) {
								const verdict = enforceDeleteGuard(id, key, guard, actionTree.at(path));
								tally.count(guard, verdict);
								if (verdict === 'already-applied') continue;
							}
							await actionTree.deleteAt(path);
						}
					}
					return tally.result();
				}
			},
			// Mutations land in `trx` and in the collection's cache, never through the read btree, so
			// its version counter would never move on its own. The collection says when what its reads
			// see changes — a staged action landing, a replay, a restore, a refresh, a commit folded in
			// — and the bump invalidates every Path handed out before, and tells a point read or a
			// range scan's setup part-way through a descent to read again (docs/btree.md §Reads under
			// a concurrent change).
			onViewChanged: () => held.btree?.invalidatePaths(),
			createHeaderBlock: (hid: BlockId, store: BlockStore<IBlock>) => {	// Only called if the collection does not exist
				// Tricky bootstrapping here:
				// We need the root id to initialize the collection header, so we create the btree here.
				let rootId: BlockId;
				held.btree = BTree.create<TKey, TEntry>(store, (_s, r) => {
						rootId = r;
						return new CollectionTrunk(store, hid);
					}, keyFromEntry, compare, nodeCapacity, undefined, BLOCK_TARGET_BYTES);
				return {
					header: store.createBlockHeader(TreeHeaderBlockType, hid),
					rootId: rootId!,
				}
			}
		};
	}

	/** Bind an opened collection to its read btree. On the create path `createHeaderBlock` already
	 * built one (it needed the root id for the header); on the open path it never ran, so build it
	 * over the collection's existing tracker. Either way the result is written back into `held` so
	 * the collection's path-invalidation (`onViewChanged`) targets the very btree reads go through. */
	private static attach<TKey, TEntry>(
		collection: Collection<TreeReplaceAction<TKey, TEntry>>,
		held: BTreeHolder<TKey, TEntry>,
		keyFromEntry: (entry: TEntry) => TKey,
		compare: (a: TKey, b: TKey) => number,
		nodeCapacity: number | undefined,
	): Tree<TKey, TEntry> {
		held.btree = held.btree
			?? new BTree<TKey, TEntry>(collection.tracker, new CollectionTrunk(collection.tracker, collection.id), keyFromEntry, compare, nodeCapacity, BLOCK_TARGET_BYTES);
		return new Tree<TKey, TEntry>(collection, held.btree, keyFromEntry, compare);
	}

	/** Stage a mutation and flush it. Forwards the collection's answer verbatim — see
	 * {@link Collection.sync} for what `undefined` means and why a torn commit's `torn` list must
	 * survive the trip. This layer never interprets the value.
	 *
	 * A call that throws leaves nothing staged (see {@link Collection.actAndSync}), so the mutation
	 * cannot ride along with a later `replace`. Whether it reached STORAGE is what the error says:
	 * a `TornActionError` with `final: true` means it did not and submitting it again stores it
	 * once; `final: false` means that could not be established. A `SyncRetryExhaustedError` is not
	 * a promise either way — the write path's last budgeted attempt, and a deadline, are not
	 * followed by the refresh that would have settled it (see `Collection.syncAttempts`). */
	async replace(data: TreeReplaceAction<TKey, TEntry>): Promise<WriteDurability | undefined> {
			return await this.collection.actAndSync([{ type: "replace", data }]);
	}

	/** Stage a mutation into the collection's tracker WITHOUT flushing it to the
	 * transactor. Reads through this same Tree instance see the staged change;
	 * call {@link sync} to persist it, or {@link snapshot}/{@link restore} to drop it. This
	 * is the deferred counterpart to {@link replace}, which stages and flushes in
	 * one step — use {@link stage} when the persist/discard decision belongs to a
	 * surrounding transaction's commit/rollback. */
	async stage(data: TreeReplaceAction<TKey, TEntry>): Promise<void> {
			await this.collection.act({ type: "replace", data });
	}

	/** Flush all staged (and any other pending) changes to the transactor.
	 * Equivalent to the flush half of {@link replace}. */
	async sync(): Promise<WriteDurability | undefined> {
			return await this.collection.updateAndSync();
	}

	/** Whether {@link sync} has anything to push — see
	 * {@link Collection.hasUnsyncedChanges}. `false` means the commit half of
	 * {@link sync} is a no-op, so a caller flushing several trees can skip the ones
	 * with nothing staged and avoid their (cache-bypassing) refresh. */
	hasUnsyncedChanges(): boolean {
			return this.collection.hasUnsyncedChanges();
	}

	/** Capture the current staged state so it can be restored via {@link restore}.
	 * Take this BEFORE staging a unit of work that may be rolled back. The snapshot
	 * is opaque; pass the exact value back to {@link restore}. */
	snapshot(): CollectionSnapshot<TreeReplaceAction<TKey, TEntry>> {
			return this.collection.snapshotPending();
	}

	/** Restore the staged state captured by {@link snapshot}, discarding mutations
	 * staged since. Counterpart to {@link stage} for transaction rollback —
	 * preserves a never-synced collection's header/root rather than wiping it.
	 * Resolves once the restore is complete: a restore across a change to the
	 * collection's sealed segments replays them, which runs the action handlers
	 * (see {@link Collection.restorePending}). */
	async restore(snapshot: CollectionSnapshot<TreeReplaceAction<TKey, TEntry>>): Promise<void> {
			await this.collection.restorePending(snapshot);
	}

	/** Build a read-only view of this tree as captured by an earlier {@link snapshot}
	 * — typically the pre-transaction state recorded before any DML was staged. The
	 * view reads through a FRESH tracker seeded with the snapshot's transforms over a
	 * PRIVATE, revision-pinned read path (see {@link Collection.createReadTracker}),
	 * so it observes exactly the snapshot's state from first read to last: it never
	 * sees mutations staged into the live tree after the snapshot, it is untouched by
	 * commits folding into (or clearing) the live tree's cache while it is walked, and
	 * it does not disturb the live tree. This is how a `committed.*` scan reads the
	 * pre-transaction snapshot while the live tree still holds this transaction's
	 * in-flight inserts — and keeps reading it even if the live tree commits mid-scan.
	 *
	 * By default the view records no read dependencies into the collection's conflict
	 * set; pass `{ recordReads: true }` to opt in (see {@link ReadViewOptions}).
	 *
	 * The view pins to the snapshot's OWN committed boundary ({@link CollectionSnapshot.context}),
	 * not the collection's current one — so a snapshot captured before a commit yields a
	 * coherent pre-commit view even when this tree has already flushed that commit (a
	 * mid-sweep multi-tree commit). A snapshot with no recorded boundary (an invented
	 * collection, or a hand-built snapshot) falls back to the current context, which is
	 * the pre-boundary behaviour.
	 *
	 * `snapshot` is the opaque value returned by {@link snapshot}; pass it back
	 * verbatim. */
	readView(
		snapshot: CollectionSnapshot<TreeReplaceAction<TKey, TEntry>>,
		options?: ReadViewOptions,
	): TreeReadView<TKey, TEntry> {
			const effectiveOptions: ReadViewOptions = {
				...options,
				pinContext: options?.pinContext ?? snapshot.context,
			};
			const tracker = this.collection.createReadTracker(snapshot.transforms, effectiveOptions);
			return new BTree<TKey, TEntry>(
				tracker,
				new CollectionTrunk(tracker, this.collection.id),
				this.keyFromEntry,
				this.compare,
			);
	}

	/** The underlying {@link Collection} this tree stages mutations into.
	 *
	 * Exposed (package-internal intent) so a transaction coordinator can register
	 * and read the very tracker this tree mutates: session-mode commit reads
	 * `collection.tracker.transforms` directly, so the coordinator's collection
	 * map must hold the same instance the tree stages into. Prefer this accessor
	 * over reaching through `tree['collection']`. */
	getCollection(): Collection<TreeReplaceAction<TKey, TEntry>> {
			return this.collection;
	}

	/** This tree's collection id, as a plain string. Used by consumers that flush
	 * several trees together (e.g. the Quereus adapter's legacy commit sweep) to
	 * name a specific tree in diagnostics when a partial flush leaves trees out of
	 * sync. Structurally satisfies the adapter's `DirtyTree.describe()`. */
	describe(): string {
			return String(this.collection.id);
	}

	/** The committed revision this tree's collection READS at — see
	 * {@link Collection.committedRevision}. `undefined` means the collection was
	 * invented locally and has never adopted a committed revision.
	 *
	 * Diagnostic only. Consumers holding several trees (the Quereus adapter holds a
	 * table tree plus one per maintained index) use it to state the revision gap
	 * between them as a number instead of inferring it — the trees refresh through
	 * different call sites, so they routinely sit at different revisions.
	 * Structurally satisfies the adapter's optional `DirtyTree.committedRevision()`. */
	committedRevision(): number | undefined {
			return this.collection.committedRevision();
	}

	/** The action id that produced this tree's current committed revision, or `undefined`
	 * when there is none to report — see {@link Collection.committedActionId} for what the
	 * value means, when it is absent, and why it is diagnostic-only. Structurally satisfies
	 * the Quereus adapter's optional `DirtyTree.committedActionId()`. */
	committedActionId(): ActionId | undefined {
			return this.collection.committedActionId();
	}

	/**
	 * Update the local state from the network.
	 * Call this before reading to ensure you have the latest data.
	 */
	async update(): Promise<void> {
		await this.collection.update();
	}

	// Read actions

	async first(): Promise<Path<TKey, TEntry>> {
		return await this.btree.first();
	}

	async last(): Promise<Path<TKey, TEntry>> {
		return await this.btree.last();
	}

	async find(key: TKey): Promise<Path<TKey, TEntry>> {
		return await this.btree.find(key);
	}

	async get(key: TKey): Promise<TEntry | undefined> {
		return await this.btree.get(key);
	}

	at(path: Path<TKey, TEntry>): TEntry | undefined {
		return this.btree.at(path);
	}

	range(range: KeyRange<TKey>): AsyncIterableIterator<Path<TKey, TEntry>> {
		return this.btree.range(range);
	}

	async entriesIn(range: KeyRange<TKey>): Promise<TEntry[]> {
		return await this.btree.entriesIn(range);
	}

	ascending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		return this.btree.ascending(path);
	}

	descending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		return this.btree.descending(path);
	}

	async getCount(from?: { path: Path<TKey, TEntry>, ascending?: boolean }): Promise<number> {
		return await this.btree.getCount(from);
	}

	async next(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
		return await this.btree.next(path);
	}

	async moveNext(path: Path<TKey, TEntry>): Promise<void> {
		await this.btree.moveNext(path);
	}

	async prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
		return await this.btree.prior(path);
	}

	async movePrior(path: Path<TKey, TEntry>): Promise<void> {
		await this.btree.movePrior(path);
	}

	isValid(path: Path<TKey, TEntry>): boolean {
		return this.btree.isValid(path);
	}
}
