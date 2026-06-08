import { Collection, type CollectionInitOptions, type CollectionId, type CollectionSnapshot } from "../../collection/index.js";
import type { ITransactor, BlockId, BlockStore, IBlock } from "../../index.js";
import { BTree, type Path, type KeyRange } from "../../btree/index.js";
import { CollectionTrunk } from "./collection-trunk.js";
import { TreeHeaderBlockType, type TreeReplaceAction } from "./struct.js";

export class Tree<TKey, TEntry> {

	private constructor(
		private readonly collection: Collection<TreeReplaceAction<TKey, TEntry>>,
		private readonly btree: BTree<TKey, TEntry>,
	) {
	}

	static async createOrOpen<TKey, TEntry>(
		network: ITransactor,
		id: CollectionId,
		keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0,
	): Promise<Tree<TKey, TEntry>> {
		// Tricky bootstrapping here:
		// We need the root id to initialize the collection header, so we create the btree in the create collection header callback.
		let btree: BTree<TKey, TEntry> | undefined;
		const init: CollectionInitOptions<TreeReplaceAction<TKey, TEntry>> = {
			modules: {
				"replace": async ({ data: actions }, _trx) => {
					for (const [key, entry] of actions) {
						if (entry) {
							await btree!.upsert(entry);
						} else {
							await btree!.deleteAt((await btree!.find(key)));
						}
					}
				}
			},
			createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => {	// Only called if the collection does not exist
				let rootId: BlockId;
				btree = BTree.create<TKey, TEntry>(store, (_s, r) => {
						rootId = r;
						return new CollectionTrunk(store, id);
					}, keyFromEntry, compare);
				return {
					header: store.createBlockHeader(TreeHeaderBlockType, id),
					rootId: rootId!,
				}
			}
		};

		const collection = await Collection.createOrOpen<TreeReplaceAction<TKey, TEntry>>(network, id, init);
		btree = btree ?? new BTree<TKey, TEntry>(collection.tracker, new CollectionTrunk(collection.tracker, collection.id), keyFromEntry, compare);
		return new Tree<TKey, TEntry>(collection, btree);
	}

	async replace(data: TreeReplaceAction<TKey, TEntry>): Promise<void> {
			await this.collection.act({ type: "replace", data });
			await this.collection.updateAndSync();
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
	async sync(): Promise<void> {
			await this.collection.updateAndSync();
	}

	/** Capture the current staged state so it can be restored via {@link restore}.
	 * Take this BEFORE staging a unit of work that may be rolled back. The snapshot
	 * is opaque; pass the exact value back to {@link restore}. */
	snapshot(): CollectionSnapshot<TreeReplaceAction<TKey, TEntry>> {
			return this.collection.snapshotPending();
	}

	/** Restore the staged state captured by {@link snapshot}, discarding mutations
	 * staged since. Counterpart to {@link stage} for transaction rollback —
	 * preserves a never-synced collection's header/root rather than wiping it. */
	restore(snapshot: CollectionSnapshot<TreeReplaceAction<TKey, TEntry>>): void {
			this.collection.restorePending(snapshot);
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
