/**
 * RowCodec - Encodes and decodes rows with schema awareness
 *
 * Handles serialization/deserialization of multi-column rows to/from
 * the format stored in Optimystic trees.
 */

import type { Row, SqlValue } from '@quereus/quereus';
import { resolveCollation, compareSqlValues, type CollationFunction } from '@quereus/quereus';
import type { StoredTableSchema } from './schema-manager.js';

/**
 * Encoding format for row data
 */
export type EncodingFormat = 'json' | 'msgpack';

/**
 * Encoded row data stored in the tree
 */
export type EncodedRow = Uint8Array | string;

/**
 * Primary key value (can be composite)
 */
export type PrimaryKeyValue = string;

/**
 * Handles encoding/decoding of rows based on table schema
 */
export class RowCodec {
	constructor(
		private readonly schema: StoredTableSchema,
		private readonly encoding: EncodingFormat = 'json'
	) {}

	/**
	 * Encode a row for storage in the tree
	 */
	encodeRow(row: Row): EncodedRow {
		// Convert Row (array) to object format for storage
		const rowObj: Record<string, SqlValue> = {};

		for (let i = 0; i < this.schema.columns.length; i++) {
			const col = this.schema.columns[i];
			if (!col) continue;
			const value = row[i];
			rowObj[col.name] = this.normalizeValue(value ?? null);
		}

		if (this.encoding === 'msgpack') {
			// TODO: Add msgpack support when dependency is added
			throw new Error('msgpack encoding not yet implemented');
		}

		return JSON.stringify(rowObj);
	}

	/**
	 * Decode a row from storage format
	 */
	decodeRow(encoded: EncodedRow): Row {
		let rowObj: Record<string, SqlValue>;

		if (this.encoding === 'msgpack') {
			// TODO: Add msgpack support when dependency is added
			throw new Error('msgpack decoding not yet implemented');
		} else {
			rowObj = JSON.parse(encoded as string);
		}

		// Convert object back to Row (array) format
		const row: Row = [];
		for (let i = 0; i < this.schema.columns.length; i++) {
			const col = this.schema.columns[i];
			if (!col) continue;
			row[i] = rowObj[col.name] ?? null;
		}

		return row;
	}

	/**
	 * Extract primary key value from a row
	 */
	extractPrimaryKey(row: Row): PrimaryKeyValue {
		const pkParts: string[] = [];

		for (const pkCol of this.schema.primaryKeyDefinition) {
			const value = row[pkCol.index];
			pkParts.push(this.serializeKeyPart(value ?? null));
		}

		// For single-column keys, return the value directly
		if (pkParts.length === 1 && pkParts[0]) {
			return pkParts[0];
		}

		// For composite keys, join with a separator
		// Use a separator that's unlikely to appear in data
		return pkParts.join('\x00');
	}

	/**
	 * Create a primary key from individual column values
	 */
	createPrimaryKey(values: SqlValue[]): PrimaryKeyValue {
		if (values.length !== this.schema.primaryKeyDefinition.length) {
			throw new Error(
				`Primary key requires ${this.schema.primaryKeyDefinition.length} values, got ${values.length}`
			);
		}

		const pkParts = values.map(v => this.serializeKeyPart(v ?? null));

		if (pkParts.length === 1 && pkParts[0]) {
			return pkParts[0];
		}

		return pkParts.join('\x00');
	}

	/**
	 * Get the indices of primary key columns
	 */
	getPrimaryKeyIndices(): number[] {
		return this.schema.primaryKeyDefinition.map(pk => pk.index);
	}

	/**
	 * Get the number of columns in the schema
	 */
	getColumnCount(): number {
		return this.schema.columns.length;
	}

	/**
	 * Get column name by index
	 */
	getColumnName(index: number): string {
		return this.schema.columns[index]?.name || '';
	}

	/**
	 * Get column index by name
	 */
	getColumnIndex(name: string): number {
		return this.schema.columns.findIndex(col => col.name.toLowerCase() === name.toLowerCase());
	}

	/**
	 * Serialize a single key part to string
	 */
	private serializeKeyPart(value: SqlValue): string {
		if (value === null || value === undefined) {
			return '\x01NULL\x01';
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number') {
			// Pad numbers for lexicographic sorting
			// This is a simplified approach; a production system would need more sophisticated encoding
			return value.toString();
		}

		if (typeof value === 'bigint') {
			return value.toString();
		}

		if (typeof value === 'boolean') {
			return value ? '1' : '0';
		}

		if (value instanceof Uint8Array) {
			// Convert to base64 for string representation
			return Buffer.from(value).toString('base64');
		}

		// Fallback
		return String(value);
	}

	/**
	 * Normalize a value for storage
	 */
	private normalizeValue(value: SqlValue): SqlValue {
		// Convert bigint to number for JSON compatibility
		if (typeof value === 'bigint') {
			return Number(value);
		}

		// Uint8Array needs special handling for JSON
		if (value instanceof Uint8Array && this.encoding === 'json') {
			return Buffer.from(value).toString('base64');
		}

		return value;
	}

	/**
	 * Check if a column is part of the primary key
	 */
	isColumnInPrimaryKey(columnIndex: number): boolean {
		return this.schema.primaryKeyDefinition.some(pk => pk.index === columnIndex);
	}

	/**
	 * Get the schema
	 */
	getSchema(): StoredTableSchema {
		return this.schema;
	}

	/**
	 * Create a comparison function for primary keys that respects collations
	 * This is used by the Tree to maintain proper sort order
	 */
	createPrimaryKeyComparator(): (a: string, b: string) => -1 | 0 | 1 {
		const pkDef = this.schema.primaryKeyDefinition;

		// For empty primary key (singleton table), all keys are equal
		if (pkDef.length === 0) {
			return () => 0;
		}

		// For single-column primary key
		if (pkDef.length === 1) {
			const collationName = pkDef[0]?.collation || 'BINARY';
			const collationFunc = resolveCollation(collationName);
			const desc = pkDef[0]?.desc || false;
			const multiplier = desc ? -1 : 1;

			return (a: string, b: string): -1 | 0 | 1 => {
				// Deserialize the key parts
				const valueA = this.deserializeKeyPart(a);
				const valueB = this.deserializeKeyPart(b);

				// Compare using the appropriate collation
				const result = this.compareValues(valueA, valueB, collationFunc);
				return (result * multiplier) as -1 | 0 | 1;
			};
		}

		// For composite primary key
		const collationFuncs = pkDef.map(def => resolveCollation(def.collation || 'BINARY'));
		const descFlags = pkDef.map(def => def.desc || false);

		return (a: string, b: string): -1 | 0 | 1 => {
			// Split composite keys
			const partsA = a.split('\x00');
			const partsB = b.split('\x00');

			// Compare each part in order
			for (let i = 0; i < pkDef.length; i++) {
				const valueA = this.deserializeKeyPart(partsA[i] || '');
				const valueB = this.deserializeKeyPart(partsB[i] || '');

				const result = this.compareValues(valueA, valueB, collationFuncs[i]!);
				if (result !== 0) {
					const multiplier = descFlags[i] ? -1 : 1;
					return (result * multiplier) as -1 | 0 | 1;
				}
			}

			return 0;
		};
	}

	/**
	 * Deserialize a key part back to its original value
	 */
	private deserializeKeyPart(serialized: string): SqlValue {
		if (serialized === '\x01NULL\x01') {
			return null;
		}

		// Try to parse as number
		const num = Number(serialized);
		if (!isNaN(num) && serialized !== '') {
			return num;
		}

		// Otherwise treat as string
		return serialized;
	}

	/**
	 * Compare two values using the specified collation
	 */
	private compareValues(a: SqlValue, b: SqlValue, collationFunc: CollationFunction): number {
		// Handle nulls first
		if (a === null && b === null) return 0;
		if (a === null) return -1;
		if (b === null) return 1;

		// For strings, use the collation function
		if (typeof a === 'string' && typeof b === 'string') {
			return collationFunc(a, b);
		}

		// For numbers, use numeric comparison
		if (typeof a === 'number' && typeof b === 'number') {
			return a < b ? -1 : a > b ? 1 : 0;
		}

		// For mixed types, use SQL comparison rules
		return compareSqlValues(a, b, 'BINARY');
	}
}

