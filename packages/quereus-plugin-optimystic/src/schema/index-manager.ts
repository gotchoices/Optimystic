/**
 * IndexManager - Manages secondary indexes for Optimystic tables
 *
 * Creates and maintains secondary indexes stored in separate Optimystic trees.
 * Each index is stored as Tree<IndexKey, PrimaryKey> where IndexKey is a composite
 * of indexed column values.
 */

import type { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import type { ITransactor } from '@optimystic/db-core';
import type { Row, SqlValue } from '@quereus/quereus';
import type { StoredTableSchema, StoredIndexSchema } from './schema-manager.js';

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
	 * Create index key from row values
	 */
	createIndexKey(indexSchema: StoredIndexSchema, row: Row): IndexKey {
		const keyParts: string[] = [];

		for (const indexCol of indexSchema.columns) {
			const value = row[indexCol.index];
			const stringValue = this.serializeValue(value ?? null);
			keyParts.push(stringValue);
		}

		// Join with null separator (same as primary key encoding)
		return keyParts.join('\x00');
	}

	/**
	 * Insert index entries for a new row.
	 *
	 * Index tree keys are composites of indexKey + primaryKey to support
	 * non-unique indexes (multiple rows with the same indexed value).
	 * Format: indexKey\x00primaryKey -> primaryKey
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

			// Composite tree key: indexKey + primaryKey ensures uniqueness
			// Store as [treeKey, primaryKey] so the tree's keyExtractor (entry[0])
			// returns the treeKey for proper sorting and range scans
			const treeKey = `${indexKey}\x00${primaryKey}`;
			await tree.replace([[treeKey, [treeKey, primaryKey]]]);
		}
	}

	/**
	 * Delete index entries for a row
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
			const treeKey = `${indexKey}\x00${primaryKey}`;
			await tree.replace([[treeKey, undefined]]);
		}
	}

	/**
	 * Update index entries when a row changes
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

			const oldTreeKey = `${oldIndexKey}\x00${oldPrimaryKey}`;
			const newTreeKey = `${newIndexKey}\x00${newPrimaryKey}`;

			if (oldTreeKey !== newTreeKey) {
				// Index key or primary key changed - delete old, insert new
				await tree.replace([
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
	 * Since index tree keys are composites of indexKey\x00primaryKey,
	 * we do a range scan from indexKey\x00 (inclusive) to indexKey\x01 (exclusive)
	 * to find all entries matching the given index key.
	 */
	async* findByIndex(
		indexName: string,
		indexKey: IndexKey
	): AsyncIterable<PrimaryKey> {
		const tree = this.indexTrees.get(indexName);
		if (!tree) {
			throw new Error(`Index tree not found: ${indexName}`);
		}

		// Update tree to get latest data
		await tree.update();

		// Range scan for all entries with this index key prefix
		// Tree keys are formatted as: indexKey\x00primaryKey
		// Scan from indexKey\x00 (inclusive) to indexKey\x01 (exclusive)
		const startKey = `${indexKey}\x00`;
		const endKey = `${indexKey}\x01`; // \x01 > \x00, so this is the exclusive upper bound

		const range = new KeyRange<string>(
			{ key: startKey, inclusive: true },
			{ key: endKey, inclusive: false },
			true // ascending
		);

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
	 * Scan index range
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

		// Build range using the composite key format
		const rangeStart = startKey !== undefined
			? { key: `${startKey}\x00`, inclusive: true }
			: undefined;
		const rangeEnd = endKey !== undefined
			? { key: `${endKey}\x01`, inclusive: false }
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

	/**
	 * Serialize a value for use in index key
	 */
	private serializeValue(value: SqlValue): string {
		if (value === null || value === undefined) {
			return '\x01'; // Special marker for NULL
		}
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number') {
			// Pad numbers for lexicographic sorting
			// Use scientific notation with fixed precision
			return value.toExponential(15);
		}
		if (typeof value === 'bigint') {
			return value.toString();
		}
		if (value instanceof Uint8Array) {
			// Convert to base64 for string representation
			return btoa(String.fromCharCode(...value));
		}
		// Fallback
		return String(value);
	}
}

