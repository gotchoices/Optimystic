/**
 * IndexManager - Manages secondary indexes for Optimystic tables
 *
 * Creates and maintains secondary indexes stored in separate Optimystic trees.
 * Each index is stored as Tree<IndexKey, PrimaryKey> where IndexKey is a composite
 * of indexed column values.
 */

import type { Tree, TreeReadView } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import type { ITransactor } from '@optimystic/db-core';
import type { Row, SqlValue } from '@quereus/quereus';
import type { StoredTableSchema, StoredIndexSchema } from './schema-manager.js';
import { encodeKeyTuple, KEY_PREFIX_END } from './key-encoding.js';

/**
 * Serialize a single value for use in a secondary-index key.
 *
 * MUST be type-insensitive for numeric equality: an INSERT keys off the raw Quereus
 * row while a later UPDATE/DELETE re-keys off the DECODED stored row, and those two
 * can disagree on JS type for the same logical integer. RowCodec normalizes a small
 * `bigint` to `Number` on encode and decodes it back as `number`, so a value staged
 * as `5n` reappears as `5`. Both branches therefore unify onto the SAME
 * `toExponential(15)` form so `5n` and `5` produce a byte-identical key — otherwise
 * the delete-of-old-key misses and a stale index entry orphans, and an index seek
 * whose argument arrives with the other type misses valid rows.
 *
 * (As of the pinned @quereus/quereus, integer literals reach this function as
 * `number` on every path, so the mismatch is latent rather than live — but any
 * `bigint` input, e.g. a bound BigInt parameter or a future Quereus that emits
 * integer literals as bigint, would trip it. The unify keeps it correct either way.)
 *
 * Do NOT canonicalize via RowCodec.normalizeValue first: it maps large bigints to a
 * tagged `{ $bigint }` object, which has no branch here and collapses to
 * `"[object Object]"` — merging every large integer into one key. And do NOT emit a
 * plain integer string: range bounds against REAL columns rely on the lexicographic
 * `toExponential` form (a plain "20" sorts wrong against a stored "2.999…e+1").
 *
 * NOTE: `Number(bigint).toExponential(15)` is lossy for integers beyond
 * Number.MAX_SAFE_INTEGER — the same precision ceiling REAL columns already have. It
 * stays self-consistent (insert and the decoded old row round-trip to the same lossy
 * string, so no orphan), but two distinct huge integers can collide into one key.
 *
 * Returns the per-value PAYLOAD for present values, or `null` for SQL NULL. NULL is no
 * longer an in-band sentinel string (which a real value could equal); the composition
 * layer (createIndexKey / the module's seek + unique-key builders) frames each payload
 * via {@link encodeKeyTuple}, which emits a distinct bare tag for NULL. Present-value
 * payload forms are unchanged so REAL range-bound ordering is preserved.
 */
export function serializeIndexValue(value: SqlValue): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'string') {
		return value;
	}
	// Unify bigint onto the number branch so 5n and 5 serialize identically.
	if (typeof value === 'bigint') {
		return Number(value).toExponential(15);
	}
	if (typeof value === 'number') {
		// Pad numbers for lexicographic sorting via fixed-precision scientific notation
		return value.toExponential(15);
	}
	if (value instanceof Uint8Array) {
		// Convert to base64 for string representation
		return btoa(String.fromCharCode(...value));
	}
	// Fallback
	return String(value);
}

/**
 * Index key format: composite of indexed column values joined with separator
 */
export type IndexKey = string;

/**
 * Primary key format: composite of primary key column values joined with separator
 */
export type PrimaryKey = string;

/**
 * Index entry: maps index key to primary key
 */
export type IndexEntry = [IndexKey, PrimaryKey];

/**
 * Factory function to create/get index trees
 */
export type IndexTreeFactory = (
	indexName: string,
	transactor?: ITransactor
) => Promise<Tree<IndexKey, IndexEntry>>;

/**
 * Manages secondary indexes for a table
 */
export class IndexManager {
	private indexTrees = new Map<string, Tree<IndexKey, IndexEntry>>();

	constructor(
		private schema: StoredTableSchema,
		private indexTreeFactory: IndexTreeFactory
	) {}

	/**
	 * Initialize all indexes for the table
	 */
	async initialize(transactor?: ITransactor): Promise<void> {
		for (const index of this.schema.indexes) {
			const tree = await this.indexTreeFactory(index.name, transactor);
			this.indexTrees.set(index.name, tree);
		}
	}

	/**
	 * Get an index tree by name
	 */
	getIndexTree(indexName: string): Tree<IndexKey, IndexEntry> | undefined {
		return this.indexTrees.get(indexName);
	}

	/**
	 * All index trees managed for this table. Used by the vtab to register every
	 * touched index tree as dirty (for commit-time flush / rollback-time discard)
	 * after staging, and by addIndex to flush a freshly populated index.
	 */
	getIndexTrees(): Tree<IndexKey, IndexEntry>[] {
		return [...this.indexTrees.values()];
	}

	/**
	 * Create index key from row values
	 */
	createIndexKey(indexSchema: StoredIndexSchema, row: Row): IndexKey {
		// Frame each column payload through the shared injective tuple encoding so an
		// indexed value containing the old raw `\x00` separator can neither shift
		// element boundaries nor break the prefix-range brackets below.
		return encodeKeyTuple(
			indexSchema.columns.map(indexCol => serializeIndexValue(row[indexCol.index] ?? null))
		);
	}

	/**
	 * Stage index entries for a new row.
	 *
	 * Index tree keys are composites of indexKey + primaryKey to support
	 * non-unique indexes (multiple rows with the same indexed value).
	 * Both are already framed tuples (self-delimiting), so the tree key is their plain
	 * concatenation: frame(indexCols) ‖ frame(pk) -> primaryKey. No separator is needed.
	 *
	 * Mutations are STAGED into each index tree's tracker (not flushed). The
	 * caller is responsible for flushing the touched trees at transaction commit
	 * (via TransactionBridge.markDirty) or discarding them on rollback, so a
	 * deferred-constraint rejection leaves no orphaned index entries.
	 */
	async insertIndexEntries(
		row: Row,
		primaryKey: PrimaryKey,
		_transactor?: ITransactor
	): Promise<void> {
		for (const index of this.schema.indexes) {
			const indexKey = this.createIndexKey(index, row);
			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			// Composite tree key: indexKey + primaryKey ensures uniqueness (both framed,
			// so plain concatenation is unambiguous). Store as [treeKey, primaryKey] so the
			// tree's keyExtractor (entry[0]) returns the treeKey for sorting and range scans.
			const treeKey = indexKey + primaryKey;
			await tree.stage([[treeKey, [treeKey, primaryKey]]]);
		}
	}

	/**
	 * Stage deletion of index entries for a row (staged, not flushed — see
	 * {@link insertIndexEntries} for the flush/discard contract).
	 */
	async deleteIndexEntries(
		row: Row,
		primaryKey: PrimaryKey,
		_transactor?: ITransactor
	): Promise<void> {
		for (const index of this.schema.indexes) {
			const indexKey = this.createIndexKey(index, row);
			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			// Composite tree key must match the format used in insertIndexEntries
			const treeKey = indexKey + primaryKey;
			await tree.stage([[treeKey, undefined]]);
		}
	}

	/**
	 * Stage index-entry updates when a row changes (staged, not flushed — see
	 * {@link insertIndexEntries} for the flush/discard contract).
	 */
	async updateIndexEntries(
		oldRow: Row,
		newRow: Row,
		oldPrimaryKey: PrimaryKey,
		newPrimaryKey: PrimaryKey,
		_transactor?: ITransactor
	): Promise<void> {
		// For each index, check if the indexed columns changed
		for (const index of this.schema.indexes) {
			const oldIndexKey = this.createIndexKey(index, oldRow);
			const newIndexKey = this.createIndexKey(index, newRow);

			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			const oldTreeKey = oldIndexKey + oldPrimaryKey;
			const newTreeKey = newIndexKey + newPrimaryKey;

			if (oldTreeKey !== newTreeKey) {
				// Index key or primary key changed - delete old, insert new
				await tree.stage([
					[oldTreeKey, undefined],
					[newTreeKey, [newTreeKey, newPrimaryKey]]
				]);
			}
			// If both keys are the same, no update needed
		}
	}

	/**
	 * Find rows using an index.
	 *
	 * Since index tree keys are framed composites of indexKey ‖ primaryKey, we do a
	 * range scan over the framed-prefix `indexKey`: from `indexKey` (inclusive) to
	 * `indexKey + KEY_PREFIX_END` (exclusive) to find all entries matching it.
	 */
	async* findByIndex(
		indexName: string,
		indexKey: IndexKey
	): AsyncIterable<PrimaryKey> {
		const tree = this.indexTrees.get(indexName);
		if (!tree) {
			throw new Error(`Index tree not found: ${indexName}`);
		}

		// Update tree to get latest data, then scan the live tree.
		await tree.update();
		yield* this.findByIndexIn(tree, indexKey);
	}

	/**
	 * Range-scan a supplied index read source for all primary keys whose entry matches
	 * `indexKey`. The caller chooses the source: {@link findByIndex} passes the live
	 * index tree (after refreshing it); a committed-read seek passes a pre-transaction
	 * view of the index tree so it excludes index entries staged by the in-flight
	 * transaction. Shared composite-key range logic for both paths — the read source
	 * is assumed already current (this method never refreshes it).
	 */
	async* findByIndexIn(
		read: TreeReadView<IndexKey, IndexEntry>,
		indexKey: IndexKey
	): AsyncIterable<PrimaryKey> {
		// Range scan for all entries whose framed index tuple equals `indexKey`.
		// Tree keys are `indexKey ‖ framedPrimaryKey`, so every match begins with the
		// complete framed prefix `indexKey`. Scan from `indexKey` (inclusive) to
		// `indexKey + KEY_PREFIX_END` (exclusive) — see KEY_PREFIX_END for why the
		// terminator-successor `\x01` would wrongly also match a longer value whose
		// escape happens to continue past the prefix.
		const startKey = indexKey;
		const endKey = indexKey + KEY_PREFIX_END;

		const range = new KeyRange<string>(
			{ key: startKey, inclusive: true },
			{ key: endKey, inclusive: false },
			true // ascending
		);

		for await (const path of read.range(range)) {
			if (!read.isValid(path)) {
				continue;
			}

			const entry = read.at(path);
			if (entry != null) {
				yield entry[1];
			}
		}
	}

	/**
	 * Scan index range.
	 *
	 * NOTE: no production caller today (only findByIndexIn is wired to query planning);
	 * its framed-prefix brackets are kept consistent with findByIndexIn but are not
	 * covered by a direct test. If this becomes live, add start/end range coverage.
	 */
	async* scanIndexRange(
		indexName: string,
		startKey?: IndexKey,
		endKey?: IndexKey,
		ascending = true
	): AsyncIterable<PrimaryKey> {
		const tree = this.indexTrees.get(indexName);
		if (!tree) {
			throw new Error(`Index tree not found: ${indexName}`);
		}

		await tree.update();

		// Build range over the framed composite keys. `startKey`/`endKey` are framed
		// index tuples; the lower bound is inclusive from the framed prefix, and the
		// upper bound uses the framed-prefix successor so entries whose tuple equals
		// `endKey` are included (see KEY_PREFIX_END).
		const rangeStart = startKey !== undefined
			? { key: startKey, inclusive: true }
			: undefined;
		const rangeEnd = endKey !== undefined
			? { key: endKey + KEY_PREFIX_END, inclusive: false }
			: undefined;

		const range = new KeyRange<string>(rangeStart, rangeEnd, ascending);

		for await (const path of tree.range(range)) {
			if (!tree.isValid(path)) {
				continue;
			}

			const entry = tree.at(path);
			if (entry != null) {
				yield entry[1];
			}
		}
	}

	/**
	 * Get index schema by name
	 */
	getIndexSchema(indexName: string): StoredIndexSchema | undefined {
		return this.schema.indexes.find(idx => idx.name === indexName);
	}
}

