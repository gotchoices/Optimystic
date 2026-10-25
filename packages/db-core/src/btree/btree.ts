import { Path, PathBranch } from "./path.js";
import type { ITreeTrunk, KeyRange, getTrunkFunc } from "./index.js";
import type { BlockId, BlockOperation, BlockStore } from "../blocks/index.js";
import { apply, get } from "../blocks/index.js";
import { TreeLeafBlockType, TreeBranchBlockType, entries$, nodes$, partitions$ } from "./nodes.js";
import type { BranchNode, ITreeNode, LeafNode } from "./nodes.js";
import type { TreeBlock } from "./tree-block.js";
import { AtomicProxy, type AtomicScope } from "../transform/atomic-proxy.js";
import { jsonEncodedBytes } from "../network/transaction-size.js";

export const NodeCapacity = 64;

/** One change to a leaf's `entries`, the splice `[entries$, index, deleteCount, [entry]]`: an insert
 *  at `index` (`deleteCount` 0) or the replacement of the entry there (`deleteCount` 1). */
type LeafEdit<TEntry> = { index: number; deleteCount: 0 | 1; entry: TEntry };

/**
 * Represents a lightweight B+(ish)Tree (data at leaves, but no linked list of leaves).
 * Allows for efficient storage and retrieval of data in a sorted manner.
 * @template TEntry The type of entries stored in the B-tree.
 * @template TKey The type of keys used for indexing the entries.  This might be an element of TEntry, or TEntry itself.
 */
export class BTree<TKey, TEntry> {
	protected _version = 0;	// only for path invalidation
	private _proxy?: AtomicProxy<ITreeNode>;

	/**
	 * @param [compare=(a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0] a comparison function for keys.  The default uses < and > operators.
	 * @param [keyFromEntry=(entry: TEntry) => entry as unknown as TKey] a function to extract the key from an entry.  The default assumes the key is the entry itself.
	 */
	constructor(
		public readonly store: BlockStore<ITreeNode>,
		public readonly trunk: ITreeTrunk,
		public readonly keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		public readonly compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0 as number,
		public readonly nodeCapacity = NodeCapacity,
		/** When set, a node also splits once its JSON (`jsonEncodedBytes`) would pass this many bytes, and
		 *  a borrow or merge that would take a node past it is refused. A node may exceed it only while
		 *  holding the least a node holds — one entry for a leaf, two children for a branch — so a leaf is
		 *  never larger than the entry that was written into it. Absent, nodes split by count alone and
		 *  are never serialized to be measured. The tree collection sets it to `BLOCK_TARGET_BYTES`; see
		 *  "Node size" in `docs/btree.md`. */
		public readonly nodeTargetBytes?: number,
	) {
	}

	private atomic<T>(fn: (scope?: AtomicScope) => Promise<T>, parent?: AtomicScope): Promise<T> {
		return this._proxy ? this._proxy.atomic(fn, parent) : fn(parent);
	}

	static createRoot(
		store: BlockStore<ITreeNode>
	) {
		return newLeafNode(store, []);
	}

	static create<TKey, TEntry>(
		store: BlockStore<ITreeNode | TreeBlock>,
		createTrunk: getTrunkFunc,
		keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		// `as number` so the inferred param type is a comparator returning any number, matching the
		// constructor above — without it the default narrows to `-1 | 0 | 1` and a perfectly valid
		// `(a, b) => a - b` comparator is rejected here but accepted there.
		compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0 as number,
		nodeCapacity = NodeCapacity,
		newId?: BlockId,
		/** See the constructor's `nodeTargetBytes`. */
		nodeTargetBytes?: number,
	) {
		const proxy = new AtomicProxy(store);
		const root = BTree.createRoot(proxy as BlockStore<TreeBlock>);
		proxy.insert(root);
		const trunk = createTrunk(proxy as BlockStore<TreeBlock>, root.header.id, newId);
		const tree = new BTree(proxy, trunk, keyFromEntry, compare, nodeCapacity, nodeTargetBytes);
		tree._proxy = proxy;
		return tree;
	}

	/** @returns a path to the first entry (on = false if no entries) */
	async first(): Promise<Path<TKey, TEntry>> {
		return await this.getFirst(await this.trunk.get());
	}

	/** @returns a path to the last entry (on = false if no entries) */
	async last(): Promise<Path<TKey, TEntry>> {
		return await this.getLast(await this.trunk.get());
	}

	/** Attempts to find the given key
	 * @returns Path to the key or the "crack" before it.  If `on` is true on the resulting path, the key was found.
	 * 	If `on` is false, next() and prior() can attempt to move to the nearest match.
	 * @param navigate when true, the interior descent nodes are captured as droppable `navigation`
	 * 	reads (see {@link getPath}). DEFAULT false: `find` returns a Path a caller may use to seed a
	 * 	range scan (`ascending`/`next`), whose result depends on tree shape, so its structural reads
	 * 	must stay retained. Only {@link get} — a point lookup with no such escape — opts in. */
	async find(key: TKey, navigate = false): Promise<Path<TKey, TEntry>> {
		return await this.getPath(await this.trunk.get(), key, navigate);
	}

	/** Retrieves the entry for the given key.
	 * Use find instead for a path to the key, the nearest match, or as a basis for navigation.
	 * @returns the entry for the given key if found; undefined otherwise. */
	async get(key: TKey): Promise<TEntry | undefined> {
		// Value-of-key point lookup: the result depends ONLY on the terminal leaf's content, so the
		// interior descent nodes are pure navigation and are dropped from the OCC conflict set. The
		// returned Path is consumed by `at` and discarded — it never seeds a scan — so navigate=true
		// is safe here (unlike the public `find`).
		return this.at(await this.find(key, /* navigate */ true));
	}

	/** @returns the entry for the given path if on an entry; undefined otherwise. */
	at(path: Path<TKey, TEntry>): TEntry | undefined {
		this.validatePath(path);
		return path.on ? this.getEntry(path) : undefined;
	}

	/** Iterates based on the given range
	 * WARNING: mutation during iteration will result in an exception
	*/
	async *range(range: KeyRange<TKey>): AsyncIterableIterator<Path<TKey, TEntry>> {
		const startPath = range.first
			? await this.findFirst(range)
			: (range.isAscending ? await this.first() : await this.last());
		const endPath = range.last
			? await this.findLast(range)
			: (range.isAscending ? await this.last() : await this.first());
		// If the tree is empty or endPath is not on an entry, return early
		if (!endPath.on) {
			return;
		}
		const endKey = this.keyFromPath(endPath);
		const iterable = range.isAscending
			? this.internalAscending(startPath)
			: this.internalDescending(startPath);
		const iter = iterable[Symbol.asyncIterator]();
		const ascendingFactor = range.isAscending ? 1 : -1;
		for await (let path of iter) {
			if (!path.on || this.compare(
				this.keyFromPath(path),
				endKey
			) * ascendingFactor > 0) {
				break;
			}
			yield path;
		}
	}

	/** @returns true if the given path remains valid; false if the tree has been mutated, invalidating the path. */
	isValid(path: Path<TKey, TEntry>) {
		return path.version === this._version;
	}

	/** Bump the version so every Path handed out before now reports invalid (see {@link isValid}).
	 * Needed when the tree's data was mutated through a DIFFERENT store binding than this instance —
	 * e.g. the tree collection's action handler writes through a per-action Atomic store, so this
	 * read-side btree never sees the mutation and must be told to invalidate outstanding paths. */
	invalidatePaths() {
		++this._version;
	}

	/**
	 * Adds a value to the tree.  Be sure to check the result, as the tree does not allow duplicate keys.
	 * Added entries are frozen to ensure immutability
	 * @returns path to the new (on = true) or conflicting (on = false) row. */
	async insert(entry: TEntry): Promise<Path<TKey, TEntry>> {
		return this.atomic(async () => {
			Object.freeze(entry);	// Ensure immutability
			const path = await this.internalInsert(entry);
			if (path.on) {
				path.version = ++this._version;
			}
			return path;
		});
	}

	/** Updates the entry at the given path to the given value.  Deletes and inserts if the key changes.
	 * @returns path to resulting entry and whether it was an update (as opposed to an insert).
	 * 	* on = true if update/insert succeeded.
	 * 		* wasUpdate = true if updated; false if inserted.
	 * 		* Returned path is on entry
	 * 	* on = false if update/insert failed.
	 * 		* wasUpdate = true, given path is not on an entry
	 * 		* else newEntry's new key already present; returned path is "near" existing entry */
	async updateAt(path: Path<TKey, TEntry>, newEntry: TEntry, parent?: AtomicScope): Promise<[path: Path<TKey, TEntry>, wasUpdate: boolean]> {
		return this.atomic(async () => {
			this.validatePath(path);
			if (path.on) {
				Object.freeze(newEntry);
			}
			const result = await this.internalUpdate(path, newEntry);
			if (result[0].on) {
				result[0].version = ++this._version;
			}
			return result;
		}, parent);
	}

	/** Inserts the entry if it doesn't exist, or updates it if it does.
	 * The entry is frozen to ensure immutability.
	 * @returns path to the new entry.  on = true if existing; on = false if new. */
	async upsert(entry: TEntry): Promise<Path<TKey, TEntry>> {
		return this.atomic(async () => {
			const path = await this.find(this.keyFromEntry(entry));
			Object.freeze(entry);
			if (path.on) {
				await this.updateEntry(path, entry);
			} else {
				await this.internalInsertAt(path, entry);
			}
			path.version = ++this._version;
			return path;
		});
	}

	/** Inserts or updates depending on the existence of the given key, using callbacks to generate the new value.
	 * @param newEntry the new entry to insert if the key doesn't exist.
	 * @param getUpdated a callback to generate an updated entry if the key does exist.  WARNING: mutation in this callback will cause merge to error.
	 * @returns path to new entry and whether an update or insert attempted.
	 * If getUpdated callback returns a row that is already present, the resulting path will not be on. */
	async merge(newEntry: TEntry, getUpdated: (existing: TEntry) => TEntry): Promise<[path: Path<TKey, TEntry>, wasUpdate: boolean]> {
		return this.atomic(async (scope) => {
			const newKey = this.keyFromEntry(newEntry);
			const path = await this.find(newKey);
			if (path.on) {
				// Thread this scope into updateAt so the nested call joins this atomic batch
				// (reuses the tracker) rather than opening/committing a second scope.
				const result = await this.updateAt(path, getUpdated(this.getEntry(path)), scope);	// Don't use internalUpdate - need to freeze and check for mutation
				// Note: updateAt already increments version, so don't double-increment here
				return result;
			} else {
				await this.internalInsertAt(path, Object.freeze(newEntry));
				path.on = true;
				path.version = ++this._version;
				return [path, false];
			}
		});
	}

	/** Deletes the entry at the given path.
	 * The on property of the path will be cleared.
	 * @returns true if the delete succeeded (the key was found); false otherwise.
	*/
	async deleteAt(path: Path<TKey, TEntry>): Promise<boolean> {
		return this.atomic(async () => {
			this.validatePath(path);
			const result = await this.internalDelete(path);
			if (result) {
				++this._version;
			}
			return result;
		});
	}

	async drop() {	// Node: only when a root treeBlock
		return this.atomic(async () => {
			const root = await this.trunk.get();
			for await (const id of this.nodeIds(root)) {
				this.store.delete(id);
			}
		});
	}

	/** Iterates forward starting from the path location (inclusive) to the end.
	 * WARNING: mutation during iteration will result in an exception.
	*/
	ascending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		this.validatePath(path);
		return this.internalAscending(path.clone());
	}

	/** Iterates backward starting from the path location (inclusive) to the end.
	 * WARNING: mutation during iteration will result in an exception
	*/
	descending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		this.validatePath(path);
		return this.internalDescending(path.clone());
	}

	/** Computed (not stored) count.  Computes the sum using leaf-node lengths.  O(n/af) where af is average fill.
	 * @param from if provided, the count will start from the given path (inclusive).  If ascending is false,
	 * 	the count will start from the end of the tree.  Ascending is true by default.
	 */
	async getCount(from?: { path: Path<TKey, TEntry>, ascending?: boolean }): Promise<number> {
		let result = 0;
		const path = from ? from.path.clone() : await this.first();
		if (from?.ascending ?? true) {
			while (path.on) {
				result += path.leafNode.entries.length - path.leafIndex;
				path.leafIndex = path.leafNode.entries.length - 1;
				await this.internalNext(path);
			}
		} else {
			while (path.on) {
				result += path.leafIndex + 1;
				path.leafIndex = 0;
				await this.internalPrior(path);
			}
		}
		return result;
	}

	/** @returns a path one step forward.  on will be true if the path hasn't hit the end. */
	async next(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
		const newPath = path.clone();
		await this.moveNext(newPath);
		return newPath;
	}

	/** Attempts to advance the given path one step forward. (mutates the path) */
	async moveNext(path: Path<TKey, TEntry>) {
		this.validatePath(path);
		await this.internalNext(path);
	}

	/** @returns a path one step backward.  on will be true if the path hasn't hit the end. */
	async prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
		const newPath = path.clone();
		await this.movePrior(newPath);
		return newPath;
	}

	/** Attempts to advance the given path one step backwards. (mutates the path) */
	async movePrior(path: Path<TKey, TEntry>) {
		this.validatePath(path);
		await this.internalPrior(path);
	}

	/** @remarks Assumes the path is "on" */
	protected keyFromPath(path: Path<TKey, TEntry>): TKey {
		return this.keyFromEntry(path.leafNode.entries[path.leafIndex]!);
	}

	private async *internalAscending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		this.validatePath(path);
		while (path.on) {
			yield path;
			await this.moveNext(path);	// Not internal - re-check after yield
		}
	}

	private async *internalDescending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>> {
		this.validatePath(path);
		while (path.on) {
			yield path;
			await this.movePrior(path);	// Not internal - re-check after yield
		}
	}

	private async findFirst(range: KeyRange<TKey>) {	// Assumes range.first is defined
		const startPath = await this.find(range.first!.key)
		if (!startPath.on || (range.first && !range.first.inclusive)) {
			if (range.isAscending) {
				await this.internalNext(startPath);
			} else {
				await this.internalPrior(startPath);
			}
		}
		return startPath;
	}

	private async findLast(range: KeyRange<TKey>) {	// Assumes range.last is defined
		const endPath = await this.find(range.last!.key)
		if (!endPath.on || (range.last && !range.last.inclusive)) {
			if (range.isAscending) {
				await this.internalPrior(endPath);
			} else {
				await this.internalNext(endPath);
			}
		}
		return endPath;
	}

	/** Descend from `node` toward `key`, building the path. When `navigate` is true this is a point
	 *  lookup (from {@link get}): each interior branch read below the root is captured as a droppable
	 *  `navigation` read, and the terminal leaf is upgraded back to a retained `value` read — the
	 *  result depends only on the leaf, and any concurrent restructuring that would change the result
	 *  also bumps the leaf's revision (Theorem 5), so the interior reads are redundant. When false
	 *  (find/range/scan/write descents) every read stays `value` (retained). */
	protected async getPath(node: ITreeNode, key: TKey, navigate = false): Promise<Path<TKey, TEntry>> {
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<TEntry>;
			if (navigate) {
				// The leaf ends a point-lookup descent: its content is the load-bearing VALUE read.
				// Its parent fetched it as `navigation` (a child's type is unknown before reading);
				// upgrade it (value-wins) so it is retained while the interior nodes above are dropped.
				this.markReadValue(leaf.header.id);
			}
			const [on, index] = this.indexOfEntry(leaf.entries, key);
			return new Path<TKey, TEntry>([], leaf, index, on, this._version);
		} else {
			const branch = node as BranchNode<TKey>;
			const index = this.indexOfKey(branch.partitions, key);
			const child = await get(this.store, branch.nodes[index]!, navigate ? 'navigation' : 'value');
			const path = await this.getPath(child, key, navigate);
			path.branches.unshift(new PathBranch(branch, index));
			return path;
		}
	}

	/** Upgrade a captured read of `id` to a retained `value` read via the store chain's read
	 *  collector (duck-typed — a no-op for stores without one, e.g. test doubles or log-walk
	 *  caches). Used by a point lookup to pin its terminal leaf. */
	private markReadValue(id: BlockId) {
		(this.store as { markReadValue?: (id: BlockId) => void }).markReadValue?.(id);
	}

	private indexOfEntry(entries: TEntry[], key: TKey): [on: boolean, index: number] {
		let lo = 0;
		let hi = entries.length - 1;
		let split = 0;
		let result = -1;

		while (lo <= hi) {
			split = (lo + hi) >>> 1;
			result = this.compare(key, this.keyFromEntry(entries[split]!));

			if (result === 0)
				return [true, split];
			else if (result < 0)
				hi = split - 1;
			else
				lo = split + 1;
		}

		return [false, lo];
	}

	protected indexOfKey(keys: TKey[], key: TKey): number {
		let lo = 0;
		let hi = keys.length - 1;
		let split = 0;
		let result = -1;

		while (lo <= hi) {
			split = (lo + hi) >>> 1;
			result = this.compare(key, keys[split]!);

			if (result === 0)
				return split + 1;	// +1 because taking right partition
			else if (result < 0)
				hi = split - 1;
			else
				lo = split + 1;
		}

		return lo;
	}

	private async internalNext(path: Path<TKey, TEntry>) {
		if (!path.on) {	// Attempt to move off of crack
			path.on = path.branches.every(branch => branch.index >= 0 && branch.index < branch.node.nodes.length)
				&& path.leafIndex >= 0 && path.leafIndex < path.leafNode.entries.length;
			if (path.on || path.leafIndex < path.leafNode.entries.length) {
				return;	// got on an entry, or an interior crack — nothing to advance into
			}
			// end-of-leaf crack (leafIndex === entries.length): fall through to branch-popping leaf-advance
		} else if (path.leafIndex < path.leafNode.entries.length - 1) {
			++path.leafIndex;
			path.on = true;
			return;
		}
		// on the last entry of the leaf, or off an end-of-leaf crack: advance into the next leaf
		let popCount = 0;
		let found = false;
		const last = path.branches.length - 1;
		while (popCount <= last && !found) {
			const branch = path.branches[last - popCount]!;
			if (branch.index === branch.node.partitions.length)	// last node in branch
				++popCount;
			else
				found = true;
		}

		if (!found) {
			path.leafIndex = path.leafNode.entries.length;	// after last row = end crack
			path.on = false;
		} else {
			path.branches.splice(-popCount, popCount);
			const branch = path.branches.at(-1)!;
			++branch.index;
			await this.moveToFirst(await get(this.store, branch.node.nodes[branch.index]!), path);
		}
	}

	private async internalPrior(path: Path<TKey, TEntry>) {
		this.validatePath(path);
		if (path.leafIndex <= 0) {
			let popCount = 0;
			let opening = false;
			const last = path.branches.length - 1;
			while (popCount <= last && !opening) {
				const branch = path.branches[last - popCount]!;
				if (branch.index === 0)	// first node in branch
					++popCount;
				else
					opening = true;
			}

			if (!opening) {
				path.leafIndex = 0;
				path.on = false;
			} else {
				path.branches.splice(-popCount, popCount);
				const branch = path.branches.at(-1)!;
				--branch.index;
				await this.moveToLast(await get(this.store, branch.node.nodes[branch.index]!), path);
			}
		}
		else {
			--path.leafIndex;
			path.on = true;
		}
	}

	private async internalUpdate(path: Path<TKey, TEntry>, newEntry: TEntry): Promise<[path: Path<TKey, TEntry>, wasUpdate: boolean]> {
		if (path.on) {
			const oldKey = this.keyFromPath(path);
			const newKey = this.keyFromEntry(newEntry);
			if (this.compare(oldKey, newKey) !== 0) {	// if key changed, delete and re-insert
				let newPath = await this.internalInsert(newEntry)
				if (newPath.on) {	// insert succeeded
					await this.internalDelete(await this.find(oldKey));	// Re-find - the prior insert invalidated the path
					newPath = await this.find(newKey);	// Re-find- delete invalidated path
				}
				return [newPath, false];
			} else {
				await this.updateEntry(path, newEntry);
			}
		}
		return [path, true];
	}

	protected async internalDelete(path: Path<TKey, TEntry>): Promise<boolean> {
		if (path.on) {
			apply(this.store, path.leafNode, [entries$, path.leafIndex, 1, []]);
			if (path.branches.length > 0) {   // Only worry about underflows, balancing, etc. if not root
				if (path.leafIndex === 0 && path.leafNode.entries.length > 0) { // If we deleted index 0 and leaf is not empty, update branches with new key
					const pathBranch = path.branches.at(-1)!;
					this.updatePartition(pathBranch.index, path, path.branches.length - 1,
						this.keyFromPath(path));
				}
				const newRoot = await this.rebalanceLeaf(path, path.branches.length);
				if (newRoot) {
					await this.trunk.set(newRoot);
				}
			}
			path.on = false;
			return true;
		} else {
			return false;
		}
	}

	private async internalInsert(entry: TEntry): Promise<Path<TKey, TEntry>> {
		const path = await this.find(this.keyFromEntry(entry));
		if (path.on) {
			path.on = false;
			return path;
		}
		await this.internalInsertAt(path, entry);
		path.on = true;
		return path;
	}

	private async internalInsertAt(path: Path<TKey, TEntry>, entry: TEntry) {
		await this.applyLeafEdit(path, { index: path.leafIndex, deleteCount: 0, entry });
	}

	/** Apply `edit` to the path's leaf and absorb whatever splits it causes up the path: each parent
	 *  that cannot take the new children splits in turn, and a split that reaches the root grows the
	 *  tree by a level. The path follows the edited entry throughout. */
	private async applyLeafEdit(path: Path<TKey, TEntry>, edit: LeafEdit<TEntry>) {
		let overflow = this.leafEdit(path, edit);
		for (let branchIndex = path.branches.length - 1; overflow && branchIndex >= 0; --branchIndex) {
			overflow = await this.branchInsert(path, branchIndex, overflow);
		}
		while (overflow) {
			overflow = await this.growRoot(path, overflow);
		}
	}

	/** Put a new root over the old one and the nodes `overflow` left to its right. Written whole when it
	 *  fits one node, as a root of two children always does. Otherwise — more new nodes than a branch
	 *  holds, or keys so large that two of them pass the byte target — the root starts as the old root
	 *  alone and absorbs the rest through {@link branchInsert}, which divides it and may hand back an
	 *  overflow for the caller to grow another level over. */
	private async growRoot(path: Path<TKey, TEntry>, overflow: Overflow<TKey>): Promise<Overflow<TKey> | undefined> {
		const oldRootId = await this.trunk.getId();
		const keys = overflow.rights.map(right => right.key);
		const ids = overflow.rights.map(right => right.node.header.id);
		const whole = newBranchNode(this.store, keys, [oldRootId, ...ids]);
		if (this.branchRuns(whole, whole.partitions, whole.nodes, overflow.pathRun) === undefined) {
			this.store.insert(whole);
			await this.trunk.set(whole);
			path.branches.unshift(new PathBranch(whole, overflow.pathRun));
			return undefined;
		}
		const root = newBranchNode<TKey>(this.store, [], [oldRootId]);
		this.store.insert(root);
		await this.trunk.set(root);
		path.branches.unshift(new PathBranch(root, 0));
		return await this.branchInsert(path, 0, overflow);
	}

	/** Starting from the given node, recursively working down to the leaf, build onto the path based on the beginning-most entry. */
	private async moveToFirst(node: ITreeNode, path: Path<TKey, TEntry>) {
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<TEntry>;
			path.leafNode = leaf;
			path.leafIndex = 0;
			path.on = leaf.entries.length > 0;
		} else {
			path.branches.push(new PathBranch(node as BranchNode<TKey>, 0));
			await this.moveToFirst(await get(this.store, (node as BranchNode<TKey>).nodes[0]!), path);
		}
	}

	/** Starting from the given node, recursively working down to the leaf, build onto the path based on the end-most entry. */
	private async moveToLast(node: ITreeNode, path: Path<TKey, TEntry>) {
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<TEntry>;
			const count = leaf.entries.length;
			path.leafNode = leaf;
			path.on = count > 0;
			path.leafIndex = count > 0 ? count - 1 : 0;
		} else {
			const branch = node as BranchNode<TKey>;
			const pathBranch = new PathBranch(branch, branch.partitions.length);
			path.branches.push(pathBranch);
			await this.moveToLast(await get(this.store, branch.nodes[pathBranch.index]!), path);
		}
	}

	/** Construct a path based on the first-most edge of the given. */
	private async getFirst(node: ITreeNode): Promise<Path<TKey, TEntry>> {
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<TEntry>;
			return new Path<TKey, TEntry>([], leaf, 0, leaf.entries.length > 0, this._version)
		} else {
			const branch = node as BranchNode<TKey>;
			const path = await this.getFirst(await get(this.store, branch.nodes[0]!));
			path.branches.unshift(new PathBranch(branch, 0));
			return path;
		}
	}

	/** Construct a path based on the last-most edge of the given node */
	private async getLast(node: ITreeNode): Promise<Path<TKey, TEntry>> {
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<TEntry>;
			const count = leaf.entries.length;
			return new Path<TKey, TEntry>([], leaf, count > 0 ? count - 1 : 0, count > 0, this._version);
		} else {
			const branch = node as BranchNode<TKey>;
			const index = branch.nodes.length - 1;
			const path = await this.getLast(await get(this.store, branch.nodes[index]!));
			path.branches.unshift(new PathBranch(branch, index));
			return path;
		}
	}

	/** Apply `edit` to the path's leaf, dividing the leaf when the result would not fit one node (see
	 *  {@link leafRuns}). The first run of entries stays in the leaf and each further run becomes a new
	 *  leaf to its right; the edit's entry is placed directly into whichever leaf it falls in rather
	 *  than logged as an operation on it, so a new leaf is one insert and the old leaf one or two small
	 *  operations. The path moves to the new leaf when its entry went there.
	 *  @returns the overflow for the parent to absorb, or `undefined` when the leaf took the edit whole. */
	private leafEdit(path: Path<TKey, TEntry>, edit: LeafEdit<TEntry>): Overflow<TKey> | undefined {
		const { leafNode: leaf } = path;
		const { index, deleteCount, entry } = edit;
		const op: BlockOperation = [entries$, index, deleteCount, [entry]];
		const entries = leaf.entries.slice();	// the leaf as it would stand with the edit applied
		entries.splice(index, deleteCount, entry);
		const runs = this.leafRuns(leaf, entries, index);
		if (runs === undefined) {
			apply(this.store, leaf, op);
			return undefined;
		}
		const rights = runs.slice(1, -1).map((from, i) => {
			const node = newLeafNode(this.store, entries.slice(from, runs[i + 2]!));
			this.store.insert(node);
			return { key: this.keyFromEntry(entries[from]!), node };
		});
		const end = runs[1]!;	// this leaf keeps the entries before it
		if (index < end) {	// the edit lands in this leaf: cut the tail off, then apply it
			const kept = end - 1 + deleteCount;	// entries of the leaf as it stands that stay, before the edit
			apply(this.store, leaf, [entries$, kept, leaf.entries.length - kept, []]);
			apply(this.store, leaf, op);
		} else {	// the edit landed in a new leaf, placed above
			apply(this.store, leaf, [entries$, end, leaf.entries.length - end, []]);
		}
		const pathRun = runOf(runs, index);
		if (pathRun > 0) {
			path.leafNode = rights[pathRun - 1]!.node as LeafNode<TEntry>;
			path.leafIndex = index - runs[pathRun]!;
		}
		return { rights, pathRun };
	}

	/** How `entries` — the path's leaf as it would stand after an edit at index `at` — divide into leaves,
	 *  or `undefined` when they fit one: at most `nodeCapacity` entries and, when the tree has a byte
	 *  target and the leaf would hold more than one entry, no more than the target's bytes. See
	 *  {@link divideItems} for the division, a pure function of the leaf's content and the edit, so a
	 *  replayed or retried action produces the same transforms. */
	private leafRuns(leaf: LeafNode<TEntry>, entries: readonly TEntry[], at: number): number[] | undefined {
		let bytes: ItemBytes | undefined;
		if (this.nodeTargetBytes !== undefined && entries.length > 1) {
			// NOTE: serializes every entry of the leaf once per insert or in-place update, the same order
			// of cost as the commit path's digest of each touched block. If bulk inserts ever show this in
			// a profile, keep a running byte count per leaf instead of re-measuring it.
			const before = prefixSums(itemBytes(entries));
			const base = emptyLeafBytes(leaf);
			bytes = {
				target: this.nodeTargetBytes,
				between: (from, to) => base + before[to]! - before[from]! + Math.max(0, to - from - 1),
			};
		}
		return divideItems(entries.length, this.nodeCapacity, at, 1, bytes);
	}

	/** Absorb a child's overflow into the branch at `branchIndex` of the path: the new children go after
	 *  the one that split, each under its key. When the branch cannot hold them all ({@link branchRuns})
	 *  it divides: the first run of children stays with the keys between them, each further run becomes
	 *  a new branch to the right, and the key before a run's first child is promoted as that branch's
	 *  key. As in {@link leafEdit}, a new child is placed directly into whichever branch it falls in.
	 *  @returns the overflow for the next branch up, or `undefined` when this one took the children whole. */
	private async branchInsert(path: Path<TKey, TEntry>, branchIndex: number, overflow: Overflow<TKey>): Promise<Overflow<TKey> | undefined> {
		const pathBranch = path.branches[branchIndex]!;
		const { index: childIndex, node } = pathBranch;
		pathBranch.index += overflow.pathRun;
		const keys = overflow.rights.map(right => right.key);
		const ids = overflow.rights.map(right => right.node.header.id);
		const partitions = node.partitions.slice();	// the branch as it would stand with the children absorbed
		partitions.splice(childIndex, 0, ...keys);
		const nodes = node.nodes.slice();
		nodes.splice(childIndex + 1, 0, ...ids);
		const runs = this.branchRuns(node, partitions, nodes, pathBranch.index);
		if (runs === undefined) {
			this.insertChildren(node, childIndex, keys, ids);
			return undefined;
		}
		const rights = runs.slice(1, -1).map((from, i) => {
			const to = runs[i + 2]!;
			const branch = newBranchNode(this.store, partitions.slice(from, to - 1), nodes.slice(from, to));
			this.store.insert(branch);
			return { key: partitions[from - 1]!, node: branch };
		});
		// This branch keeps the children before `end` and the keys between them. Of the new children,
		// those that fall before `end` land here: cut the tail off the branch as it stands, then insert them.
		const end = runs[1]!;
		const landed = Math.min(Math.max(end - (childIndex + 1), 0), ids.length);
		apply(this.store, node, [partitions$, end - 1 - landed, node.partitions.length - (end - 1 - landed), []]);
		apply(this.store, node, [nodes$, end - landed, node.nodes.length - (end - landed), []]);
		if (landed > 0) {
			this.insertChildren(node, childIndex, keys.slice(0, landed), ids.slice(0, landed));
		}
		const pathRun = runOf(runs, pathBranch.index);
		if (pathRun > 0) {
			pathBranch.node = rights[pathRun - 1]!.node as BranchNode<TKey>;
			pathBranch.index -= runs[pathRun]!;
		}
		return { rights, pathRun };
	}

	/** How a branch's children — `partitions` and `nodes` as the branch would stand with new children
	 *  absorbed, the path following child `at` — divide into branches, or `undefined` when they fit one;
	 *  the counterpart of {@link leafRuns}. A branch's bytes are its keys and child ids, so only large
	 *  keys ever make bytes the reason, and a branch of two children (one key) always counts as fitting:
	 *  nothing smaller routes. A run of children `[from, to)` carries the keys between them; the key
	 *  before `from` is promoted and counts on neither side. */
	private branchRuns(branch: BranchNode<TKey>, partitions: readonly TKey[], nodes: readonly BlockId[], at: number): number[] | undefined {
		let bytes: ItemBytes | undefined;
		if (this.nodeTargetBytes !== undefined && nodes.length > 2) {
			const ids = prefixSums(itemBytes(nodes));
			const keys = prefixSums(itemBytes(partitions));
			const base = emptyBranchBytes(branch);
			bytes = {
				target: this.nodeTargetBytes,
				between: (from, to) => base + ids[to]! - ids[from]! + keys[to - 1]! - keys[from]!
					+ Math.max(0, to - from - 1) + Math.max(0, to - from - 2),
			};
		}
		return divideItems(nodes.length, this.nodeCapacity, at, 2, bytes);
	}

	/** After a delete, fill the path's leaf back up when it is under-full ({@link leafUnderfull}):
	 *  borrow one entry from a sibling with more than half the count, else merge with a sibling. With
	 *  a byte target a borrow or merge that would take a leaf past it is refused, so a leaf of a few
	 *  large entries can stay under half the count for good; see "Node size" in `docs/btree.md`.
	 *
	 *  NOTE: a leaf that is under-full by both measures and whose siblings refuse it by bytes reads
	 *  both siblings on every delete from it and writes nothing — one delete of its last entry ends
	 *  that, since an empty leaf always merges. If such reads ever show up, remember the refusal on
	 *  the path for the rest of the action. */
	protected async rebalanceLeaf(path: Path<TKey, TEntry>, depth: number): Promise<ITreeNode | undefined> {
		if (depth === 0 || !this.leafUnderfull(path.leafNode)) {
			return undefined;
		}

		const leaf = path.leafNode;
		const parent = path.branches.at(depth - 1)!;
		const pIndex = parent.index;
		const pNode = parent.node;

		const rightSibId = pNode.nodes[pIndex + 1];
		const rightSib = rightSibId ? (await get(this.store, rightSibId)) as LeafNode<TEntry> : undefined;
		if (rightSib && rightSib.entries.length > (this.nodeCapacity >>> 1) && this.leafTakes(leaf, rightSib.entries[0]!)) {   // Attempt to borrow from right sibling
			const entry = rightSib.entries[0]!;
			apply(this.store, rightSib, [entries$, 0, 1, []]);
			apply(this.store, leaf, [entries$, leaf.entries.length, 0, [entry]]);
			this.updatePartition(pIndex + 1, path, depth - 1, this.keyFromEntry(rightSib.entries[0]!));
			return undefined;
		}

		const leftSibId = pNode.nodes[pIndex - 1];
		const leftSib = leftSibId ? (await get(this.store, leftSibId)) as LeafNode<TEntry> : undefined;
		if (leftSib && leftSib.entries.length > (this.nodeCapacity >>> 1) && this.leafTakes(leaf, leftSib.entries[leftSib.entries.length - 1]!)) {   // Attempt to borrow from left sibling
			const entry = leftSib.entries[leftSib.entries.length - 1]!;
			apply(this.store, leftSib, [entries$, leftSib.entries.length - 1, 1, []]);
			apply(this.store, leaf, [entries$, 0, 0, [entry]]);
			this.updatePartition(pIndex, path, depth - 1, this.keyFromEntry(entry));
			path.leafIndex += 1;
			return undefined;
		}

		if (rightSib && this.leavesMerge(leaf, rightSib)) {  // Attempt to merge right sibling into leaf (right sib deleted)
			apply(this.store, leaf, [entries$, leaf.entries.length, 0, rightSib.entries]);
			this.deletePartition(pNode, pIndex);
			if (pIndex === 0) { // 0th node of parent, update parent key
				this.updatePartition(pIndex, path, depth - 1, this.keyFromEntry(leaf.entries[0]!));
			}
			this.store.delete(rightSib.header.id);
			return await this.rebalanceBranch(path, depth - 1);
		}

		if (leftSib && this.leavesMerge(leftSib, leaf)) {  // Attempt to merge into left sibling (leaf deleted)
			// NOTE: this fixes leafIndex, but the parent-branch index up the path is left pointing at
			// the now-deleted leaf's old slot (same tolerated-staleness class as rebalanceBranch's
			// left-merge, part c). Harmless today because deleteAt version-bumps and abandons the
			// returned path. A future path-reuse consumer must audit BOTH left-merge sites, not just
			// rebalanceBranch.
			path.leafNode = leftSib;
			path.leafIndex += leftSib.entries.length;
			apply(this.store, leftSib, [entries$, leftSib.entries.length, 0, leaf.entries]);
			this.deletePartition(pNode, pIndex - 1);
			this.store.delete(leaf.header.id);
			return await this.rebalanceBranch(path, depth - 1);
		}
	}

	/** The branch counterpart of {@link rebalanceLeaf}, with the same rules: a branch under-full by
	 *  count and (with a byte target) by bytes borrows a child from a sibling with more than half the
	 *  count, else merges with a sibling, and neither may take a branch past the byte target. The key
	 *  that separates the two in the parent comes down with the borrowed child or the merge. */
	protected async rebalanceBranch(path: Path<TKey, TEntry>, depth: number): Promise<ITreeNode | undefined> {
		const pathBranch = path.branches[depth]!;
		const branch = pathBranch.node;
		if (depth === 0 && branch.partitions.length === 0) {  // last node... collapse child into root
			return path.branches[depth + 1]?.node ?? path.leafNode;
		}

		if (depth === 0 || !this.branchUnderfull(branch)) {
			return undefined;
		}

		const parent = path.branches.at(depth - 1)!;
		const pIndex = parent.index;
		const pNode = parent.node;

		const rightSibId = pNode.nodes[pIndex + 1];
		const rightSib = rightSibId ? (await get(this.store, rightSibId)) as BranchNode<TKey> : undefined;
		if (rightSib && rightSib.nodes.length > (this.nodeCapacity >>> 1) && this.branchTakes(branch, pNode.partitions[pIndex]!, rightSib.nodes[0]!)) {   // Attempt to borrow from right sibling
			const node = rightSib.nodes[0]!;
			const rightKey = rightSib.partitions[0]!;
			this.insertPartition(branch, branch.partitions.length, pNode.partitions[pIndex]!, node);
			this.deletePartition(rightSib, 0, 0);
			this.updatePartition(pIndex + 1, path, depth - 1, rightKey);
			return undefined;
		}

		const leftSibId = pNode.nodes[pIndex - 1];
		const leftSib = leftSibId ? (await get(this.store, leftSibId)) as BranchNode<TKey> : undefined;
		if (leftSib && leftSib.nodes.length > (this.nodeCapacity >>> 1) && this.branchTakes(branch, pNode.partitions[pIndex - 1]!, leftSib.nodes[leftSib.nodes.length - 1]!)) {   // Attempt to borrow from left sibling
			const node = leftSib.nodes[leftSib.nodes.length - 1]!;
			const pKey = leftSib.partitions[leftSib.partitions.length - 1]!;
			this.insertPartition(branch, 0, pNode.partitions[pIndex - 1]!, node, 0);
			this.deletePartition(leftSib, leftSib.partitions.length - 1);
			pathBranch.index += 1;
			this.updatePartition(pIndex, path, depth - 1, pKey);
			return undefined;
		}

		if (rightSib && this.branchesMerge(branch, rightSib, pNode.partitions[pIndex]!)) {   // Attempt to merge right sibling into self
			const pKey = pNode.partitions[pIndex]!;
			this.deletePartition(pNode, pIndex);
			apply(this.store, branch, [partitions$, branch.partitions.length, 0, [pKey]]);
			apply(this.store, branch, [partitions$, branch.partitions.length, 0, rightSib.partitions]);
			apply(this.store, branch, [nodes$, branch.nodes.length, 0, rightSib.nodes]);
			this.store.delete(rightSib.header.id);
			return this.rebalanceBranch(path, depth - 1);
		}

		if (leftSib && this.branchesMerge(leftSib, branch, pNode.partitions[pIndex - 1]!)) {   // Attempt to merge self into left sibling
			const leftLen = leftSib.nodes.length;	// capture BEFORE the appends below shift it (see leaf path at rebalanceLeaf)
			const pKey = pNode.partitions[pIndex - 1]!;
			this.deletePartition(pNode, pIndex - 1);
			apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, [pKey]]);
			apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, branch.partitions]);
			apply(this.store, leftSib, [nodes$, leftSib.nodes.length, 0, branch.nodes]);
			pathBranch.node = leftSib;
			pathBranch.index += leftLen;	// branch's children now sit after leftSib's original children
			this.store.delete(branch.header.id);
			return this.rebalanceBranch(path, depth - 1);
		}
	}

	protected updatePartition(nodeIndex: number, path: Path<TKey, TEntry>, depth: number, newKey: TKey) {
		const pathBranch = path.branches[depth]!;
		if (nodeIndex > 0) {  // Only affects this branch; just update the partition key
			apply(this.store, pathBranch.node, [partitions$, nodeIndex - 1, 1, [newKey]]);
		} else if (depth !== 0) {
			this.updatePartition(path.branches[depth - 1]!.index, path, depth - 1, newKey);
		}
	}

	protected insertPartition(branch: BranchNode<TKey>, index: number, key: TKey, node: BlockId, nodeOffset = 1) {
		apply(this.store, branch, [partitions$, index, 0, [key]]);
		apply(this.store, branch, [nodes$, index + nodeOffset, 0, [node]]);
	}

	/** Insert children after the child at `index`, each under its key: `keys` go in at `index` and
	 *  `nodes` at `index + 1`, one operation each. */
	private insertChildren(branch: BranchNode<TKey>, index: number, keys: readonly TKey[], nodes: readonly BlockId[]) {
		apply(this.store, branch, [partitions$, index, 0, keys.slice()]);
		apply(this.store, branch, [nodes$, index + 1, 0, nodes.slice()]);
	}

	protected deletePartition(branch: BranchNode<TKey>, index: number, nodeOffset = 1) {
		apply(this.store, branch, [partitions$, index, 1, []]);
		apply(this.store, branch, [nodes$, index + nodeOffset, 1, []]);
	}

	private validatePath(path: Path<TKey, TEntry>) {
		if (!this.isValid(path)) {
			throw new Error("Path is invalid due to mutation of the tree");
		}
	}

	/** Iterates every node ID below and including the given node. */
	private async *nodeIds(node: ITreeNode): AsyncIterableIterator<BlockId> {
		// TODO: This would be much more efficient if we avoided iterating into leaf nodes
		if (node.header.type === TreeBranchBlockType) {
			const subNodes = await Promise.all((node as BranchNode<TKey>).nodes.map(id => get(this.store, id)));
			for (let subNode of subNodes) {
				yield* this.nodeIds(subNode);
			}
		}
		yield node.header.id;
	}

	protected getEntry(path: Path<TKey, TEntry>): TEntry {
		return path.leafNode.entries[path.leafIndex]!;
	}

	/** Replace the entry at the path in place. A larger entry can take the leaf past the byte target
	 *  with no insert, so this goes through the same split an insert does ({@link leafEdit}); the path
	 *  follows the entry when it moves to a new leaf. */
	protected async updateEntry(path: Path<TKey, TEntry>, entry: TEntry) {
		await this.applyLeafEdit(path, { index: path.leafIndex, deleteCount: 1, entry });
	}

	// The fill rules a delete rebalances by. Each is one serialization of the nodes it weighs, and none
	// runs without a byte target.

	/** A leaf below half the count AND, with a byte target, below half the target — one that a borrow
	 *  or merge could usefully fill. A leaf of a few large entries is under half the count for good but
	 *  is a healthy block, so it is left alone and a delete from it reads no sibling. */
	private leafUnderfull(leaf: LeafNode<TEntry>): boolean {
		return leaf.entries.length < (this.nodeCapacity >>> 1)
			&& (this.nodeTargetBytes === undefined || jsonEncodedBytes(leaf) < this.nodeTargetBytes / 2);
	}

	/** Whether `leaf` may take one more `entry` from a sibling without passing the byte target. */
	private leafTakes(leaf: LeafNode<TEntry>, entry: TEntry): boolean {
		return this.nodeTargetBytes === undefined
			|| jsonEncodedBytes(leaf) + jsonEncodedBytes(entry) + (leaf.entries.length > 0 ? 1 : 0) <= this.nodeTargetBytes;
	}

	/** Whether two sibling leaves may become one: within the count, and within the byte target unless
	 *  one of them is empty — removing an empty leaf adds nothing to the other, so that is never refused
	 *  and no empty leaf outlives the delete that emptied it. */
	private leavesMerge(a: LeafNode<TEntry>, b: LeafNode<TEntry>): boolean {
		if (a.entries.length + b.entries.length > this.nodeCapacity) {
			return false;
		}
		if (this.nodeTargetBytes === undefined || a.entries.length === 0 || b.entries.length === 0) {
			return true;
		}
		return jsonEncodedBytes(a) + jsonEncodedBytes(b) - emptyLeafBytes(b) + 1 <= this.nodeTargetBytes;
	}

	/** {@link leafUnderfull} for a branch, by its children. */
	private branchUnderfull(branch: BranchNode<TKey>): boolean {
		return branch.nodes.length < (this.nodeCapacity >>> 1)
			&& (this.nodeTargetBytes === undefined || jsonEncodedBytes(branch) < this.nodeTargetBytes / 2);
	}

	/** Whether `branch` may take one more child, `node`, under `key` — the parent's key that comes down
	 *  with it — without passing the byte target. */
	private branchTakes(branch: BranchNode<TKey>, key: TKey, node: BlockId): boolean {
		return this.nodeTargetBytes === undefined
			|| jsonEncodedBytes(branch) + jsonEncodedBytes(key) + jsonEncodedBytes(node) + 2 <= this.nodeTargetBytes;
	}

	/** Whether two sibling branches may become one under `key`, the parent's key between them: within
	 *  the count and, with a byte target, within it. A branch is never empty, so there is no exemption. */
	private branchesMerge(a: BranchNode<TKey>, b: BranchNode<TKey>, key: TKey): boolean {
		if (a.nodes.length + b.nodes.length > this.nodeCapacity) {
			return false;
		}
		return this.nodeTargetBytes === undefined
			|| jsonEncodedBytes(a) + jsonEncodedBytes(b) - emptyBranchBytes(b) + jsonEncodedBytes(key) + 2 <= this.nodeTargetBytes;
	}
}

/** What a node that divided hands its parent: the nodes now to its right, each under the lowest key
 *  beneath it, and which of the resulting nodes the path's entry is in — 0 for the node that divided,
 *  1 for the first to its right, and so on. */
type Overflow<TKey> = { rights: { key: TKey; node: ITreeNode }[]; pathRun: number };

/** The byte rule a node's items are divided under: the target, and the bytes a node holding items
 *  `[from, to)` encodes to. */
type ItemBytes = { target: number; between(from: number, to: number): number };

function newLeafNode<TEntry>(store: BlockStore<ITreeNode>, entries: TEntry[]): LeafNode<TEntry> {
	const header = store.createBlockHeader(TreeLeafBlockType);
	return { header, entries };
}

function newBranchNode<TKey>(store: BlockStore<ITreeNode>, partitions: TKey[], nodes: BlockId[]): BranchNode<TKey> {
	const header = store.createBlockHeader(TreeBranchBlockType);
	return { header, partitions, nodes };
}

// The byte arithmetic behind a node's size limit. A node's JSON is its header and empty arrays (a
// fixed part per node) plus each item's JSON and the commas between them, so one serialization per
// item answers both whether a node fits and where to divide it.

/** The JSON size of each item, by the measure block limits are judged with. */
function itemBytes(items: readonly unknown[]): number[] {
	return items.map(item => jsonEncodedBytes(item));
}

/** Running totals: `sums[i]` is the bytes of the first `i` items, so any run of items is one subtraction. */
function prefixSums(sizes: readonly number[]): number[] {
	const sums = [0];
	for (const size of sizes) {
		sums.push(sums[sums.length - 1]! + size);
	}
	return sums;
}

/** What a leaf encodes to with no entries: the part of its size the entries do not account for. */
function emptyLeafBytes(leaf: LeafNode<unknown>): number {
	return jsonEncodedBytes({ header: leaf.header, entries: [] });
}

/** What a branch encodes to with no children: the part of its size the keys and ids do not account for. */
function emptyBranchBytes(branch: BranchNode<unknown>): number {
	return jsonEncodedBytes({ header: branch.header, partitions: [], nodes: [] });
}

/**
 * How `count` items of one node divide into nodes when they no longer fit one, as run boundaries —
 * run `i` is the items `[runs[i], runs[i + 1])`, the first boundary 0 and the last `count` — or
 * `undefined` when they fit. A run fits when it holds at most `capacity` items and either no more
 * than `always` items (one entry, or two children: the least a node of its kind holds, so a node over
 * the byte target holds no more than that) or, under the byte rule, no more than the target's bytes.
 *
 * - Over the count alone: two runs at the midpoint ({@link countSplit}), the division the tree has
 *   always made, kept as it was so a tree of small entries writes the transforms it always did.
 * - Over the bytes: the fewest fitting runs ({@link fewestRuns}), so an entry larger than the target
 *   is left alone in a node of its own and a node that outgrew the target before this rule existed is
 *   brought within it in one write; where two runs suffice, the two whose larger is smallest
 *   ({@link balancedSplit}).
 *
 * A pure function of its arguments, so a replayed or retried action divides identically.
 */
function divideItems(count: number, capacity: number, at: number, always: number, bytes?: ItemBytes): number[] | undefined {
	const fits = (from: number, to: number) => to - from <= capacity
		&& (bytes === undefined || to - from <= always || bytes.between(from, to) <= bytes.target);
	if (fits(0, count)) {
		return undefined;
	}
	if (bytes === undefined || count <= always || bytes.between(0, count) <= bytes.target) {
		return [0, countSplit(count, at), count];	// the count is the only reason
	}
	const runs = fewestRuns(count, always, fits);
	if (runs.length === 3) {
		runs[1] = balancedSplit(count, always, fits, bytes.between, runs[1]!);
	}
	return runs;
}

/** Where the count rule divides `count` items: at the midpoint, the odd item going to the half the
 *  edit at `at` lands in. */
function countSplit(count: number, at: number): number {
	const mid = count >>> 1;
	return mid + (at < mid ? 1 : 0);
}

/** The fewest runs that each fit, packing from the left: as many items into a run as fit, then the
 *  next run. A final run of a single item takes one more from the run before it when that run can
 *  spare one (it keeps more than `always`) and the pair fits — so a branch is not left routing to one
 *  child when its neighbour could have given it another. */
function fewestRuns(count: number, always: number, fits: (from: number, to: number) => boolean): number[] {
	const runs = [0];
	for (let from = 0; from < count;) {
		let to = from + 1;
		while (to < count && fits(from, to + 1)) {
			++to;
		}
		runs.push(to);
		from = to;
	}
	const last = runs.length - 1;
	if (last >= 2 && runs[last]! - runs[last - 1]! === 1 && runs[last - 1]! - runs[last - 2]! > always && fits(runs[last - 1]! - 1, count)) {
		runs[last - 1] = runs[last - 1]! - 1;
	}
	return runs;
}

/** Where to divide `count` items into two runs that both fit so that the larger run's bytes are as
 *  small as possible. Each run keeps at least `always` items when the count allows, so a branch is
 *  not divided down to one child for the sake of balance. `fallback` is a division already known to
 *  fit, returned when no candidate does. */
function balancedSplit(count: number, always: number, fits: (from: number, to: number) => boolean, between: (from: number, to: number) => number, fallback: number): number {
	const least = count >= 2 * always ? always : 1;
	let best = fallback;
	let bestLarger = Infinity;
	for (let m = least; m <= count - least; ++m) {
		if (!fits(0, m) || !fits(m, count)) {
			continue;
		}
		const larger = Math.max(between(0, m), between(m, count));
		if (larger < bestLarger) {
			bestLarger = larger;
			best = m;
		}
	}
	return best;
}

/** Which run of `runs` (see {@link divideItems}) item `index` falls in. */
function runOf(runs: readonly number[], index: number): number {
	let run = 0;
	while (index >= runs[run + 1]!) {
		++run;
	}
	return run;
}
