/**
 * IndexManager - Manages secondary indexes for Optimystic tables
 *
 * Creates and maintains secondary indexes stored in separate Optimystic trees.
 * Each index is stored as Tree<IndexKey, PrimaryKey> where IndexKey is a composite
 * of indexed column values.
 */

import type { Tree } from '@optimystic/db-core';
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
) => Promise<Tree<IndexKey, PrimaryKey>>;

/**
 * Manages secondary indexes for a table
 */
export class IndexManager {
	private indexTrees = new Map<string, Tree<IndexKey, PrimaryKey>>();

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
	getIndexTree(indexName: string): Tree<IndexKey, PrimaryKey> | undefined {
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
	 * Insert index entries for a new row
	 */
	async insertIndexEntries(
		row: Row,
		primaryKey: PrimaryKey,
		transactor?: ITransactor
	): Promise<void> {
		const updates: Array<[string, IndexEntry[]]> = [];

		for (const index of this.schema.indexes) {
			const indexKey = this.createIndexKey(index, row);
			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			updates.push([index.name, [[indexKey, primaryKey]]]);
		}

		// Apply all index updates
		for (const [indexName, entries] of updates) {
			const tree = this.indexTrees.get(indexName);
			if (tree) {
				await tree.replace(entries);
			}
		}
	}

	/**
	 * Delete index entries for a row
	 */
	async deleteIndexEntries(
		row: Row,
		primaryKey: PrimaryKey,
		transactor?: ITransactor
	): Promise<void> {
		const updates: Array<[string, Array<[IndexKey, undefined]>]> = [];

		for (const index of this.schema.indexes) {
			const indexKey = this.createIndexKey(index, row);
			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			updates.push([index.name, [[indexKey, undefined]]]);
		}

		// Apply all index deletions
		for (const [indexName, entries] of updates) {
			const tree = this.indexTrees.get(indexName);
			if (tree) {
				await tree.replace(entries);
			}
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
		transactor?: ITransactor
	): Promise<void> {
		// For each index, check if the indexed columns changed
		for (const index of this.schema.indexes) {
			const oldIndexKey = this.createIndexKey(index, oldRow);
			const newIndexKey = this.createIndexKey(index, newRow);

			const tree = this.indexTrees.get(index.name);
			if (!tree) {
				throw new Error(`Index tree not found: ${index.name}`);
			}

			if (oldIndexKey !== newIndexKey || oldPrimaryKey !== newPrimaryKey) {
				// Index key or primary key changed - delete old, insert new
				await tree.replace([
					[oldIndexKey, undefined],
					[newIndexKey, newPrimaryKey]
				]);
			}
			// If both keys are the same, no update needed
		}
	}

	/**
	 * Find rows using an index
	 */
	async* findByIndex(
		indexName: string,
		indexKey: IndexKey
	): AsyncIterable<PrimaryKey> {
		const tree = this.indexTrees.get(indexName);
		if (!tree) {
			throw new Error(`Index tree not found: ${indexName}`);
		}

		const path = await tree.find(indexKey);
		if (!tree.isValid(path)) {
			return;
		}

		const entry = tree.at(path) as unknown as [IndexKey, PrimaryKey];
		if (entry && entry.length >= 2) {
			yield entry[1];
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

		// TODO: Implement proper range scanning with KeyRange
		// For now, do a full scan and filter
		const iterator = tree.range({ isAscending: ascending } as any);

		for await (const path of iterator) {
			if (!tree.isValid(path)) {
				continue;
			}

			const entry = tree.at(path) as unknown as [IndexKey, PrimaryKey];
			if (entry && entry.length >= 2) {
				const [key, primaryKey] = entry;

				// Apply range filters
				if (startKey !== undefined && key < startKey) {
					continue;
				}
				if (endKey !== undefined && key > endKey) {
					break;
				}

				yield primaryKey;
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

