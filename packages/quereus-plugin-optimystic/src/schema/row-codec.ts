/**
 * RowCodec - Encodes and decodes rows with schema awareness
 *
 * Handles serialization/deserialization of multi-column rows to/from
 * the format stored in Optimystic trees.
 */

import type { Row, SqlValue } from '@quereus/quereus';
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
}

