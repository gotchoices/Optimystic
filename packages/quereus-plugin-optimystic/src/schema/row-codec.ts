/**
 * RowCodec - Encodes and decodes rows with schema awareness
 *
 * Handles serialization/deserialization of multi-column rows to/from
 * the format stored in Optimystic trees.
 */

import type { Row, SqlValue } from '@quereus/quereus';
import { builtinCollationResolver, BINARY_COLLATION, compareSqlValues, type CollationFunction } from '@quereus/quereus';
import { toString as uint8ToString } from 'uint8arrays/to-string';
import { fromString as uint8FromString } from 'uint8arrays/from-string';
import type { StoredTableSchema, StoredColumnSchema } from './schema-manager.js';
import { encodeKeyTuple, splitKeyTuple, type DecodedKeyElement } from './key-encoding.js';

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
			row[i] = this.denormalizeValue(rowObj[col.name], col);
		}

		return row;
	}

	/**
	 * Extract primary key value from a row
	 */
	extractPrimaryKey(row: Row): PrimaryKeyValue {
		// Frame every part (including single-column keys) through the shared, injective
		// tuple encoding so a value containing the old raw `\x00` separator — or equal to
		// the old NULL sentinel — can never shift boundaries or collide. See key-encoding.
		const payloads = this.schema.primaryKeyDefinition.map(
			pkCol => this.serializeKeyPart(row[pkCol.index] ?? null)
		);
		return encodeKeyTuple(payloads);
	}

	/**
	 * Create a primary key from individual column values.
	 *
	 * Must produce byte-identical output to {@link extractPrimaryKey} for the same
	 * logical key: inserts key off the extracted row while point lookups key off these
	 * seek-arg values, and the two are compared by exact tree-key match.
	 */
	createPrimaryKey(values: SqlValue[]): PrimaryKeyValue {
		if (values.length !== this.schema.primaryKeyDefinition.length) {
			throw new Error(
				`Primary key requires ${this.schema.primaryKeyDefinition.length} values, got ${values.length}`
			);
		}

		return encodeKeyTuple(values.map(v => this.serializeKeyPart(v ?? null)));
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
	 * Serialize a single key part to its payload string, or `null` for SQL NULL.
	 *
	 * NULL is signalled by returning `null` (the framing layer emits a distinct bare
	 * tag for it) rather than an in-band sentinel string, so a real value can never be
	 * mistaken for NULL. Present-value payload forms are unchanged.
	 */
	private serializeKeyPart(value: SqlValue): string | null {
		if (value === null || value === undefined) {
			return null;
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
			return uint8ToString(value, 'base64');
		}

		// Fallback
		return String(value);
	}

	/**
	 * Normalize a value for storage
	 */
	private normalizeValue(value: SqlValue): SqlValue {
		if (typeof value === 'bigint') {
			// Small bigints safely convert to Number
			if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
				return Number(value);
			}
			// Large bigints use tagged encoding to preserve precision
			return { $bigint: value.toString() } as unknown as SqlValue;
		}

		if (value instanceof Uint8Array && this.encoding === 'json') {
			return uint8ToString(value, 'base64');
		}

		return value;
	}

	/**
	 * Restore a value from storage format using column schema
	 */
	private denormalizeValue(value: unknown, col: StoredColumnSchema): SqlValue {
		if (value === null || value === undefined) return null;

		// Restore tagged bigint
		if (typeof value === 'object' && value !== null && '$bigint' in value) {
			return BigInt((value as { $bigint: string }).$bigint);
		}

		// Restore Uint8Array from base64 for BLOB columns
		if (col.affinity === 'BLOB' && typeof value === 'string') {
			return uint8FromString(value, 'base64');
		}

		return value as SqlValue;
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

		const collationFuncs = pkDef.map(def => builtinCollationResolver(def.collation || 'BINARY') ?? BINARY_COLLATION);
		const descFlags = pkDef.map(def => def.desc || false);

		// NOTE: this comparator is currently dead code — the tree is opened with a raw
		// lexicographic string comparator (collection-factory.ts), which the injective
		// framing keeps correct on its own. debt-optimystic-true-key-ordering wires this
		// up (gated on the debt-optimystic-key-format-migration decision because it flips
		// stored order); the per-part decode below is already affinity-driven.
		const affinities = pkDef.map(def => this.schema.columns[def.index]?.affinity);

		return (a: string, b: string): -1 | 0 | 1 => {
			const partsA = this.decodeKeyForCompare(a);
			const partsB = this.decodeKeyForCompare(b);

			for (let i = 0; i < pkDef.length; i++) {
				const valueA = this.keyElementToValue(partsA[i], affinities[i]);
				const valueB = this.keyElementToValue(partsB[i], affinities[i]);

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
	 * Decode a tree key into its framed elements for comparison.
	 *
	 * A key produced by {@link encodeKeyTuple} begins with a structural tag; it is
	 * split element-by-element. A key that does not begin with a tag is a bare/legacy
	 * value (as fed by some low-level comparator unit tests) and is treated as one raw
	 * present element. debt-optimystic-true-key-ordering owns the eventual full decode
	 * and can drop this fallback.
	 */
	private decodeKeyForCompare(key: string): DecodedKeyElement[] {
		// NOTE: legacy/raw fallback for un-framed keys, live only via low-level comparator
		// unit tests while this comparator is dead code. debt-optimystic-true-key-ordering
		// (which wires the comparator into the tree) should update those tests to feed
		// framed keys and drop this branch.
		const lead = key[0];
		if (lead === '\x00' || lead === '\x02') {
			return splitKeyTuple(key);
		}
		return [{ isNull: false, payload: key }];
	}

	/** Map a decoded key element to its SQL value (missing element or NULL tag -> null). */
	private keyElementToValue(element: DecodedKeyElement | undefined, affinity?: string): SqlValue {
		if (!element || element.isNull) return null;
		return this.deserializeKeyPart(element.payload, affinity);
	}

	/**
	 * Deserialize a present key-part payload back to its original value, driven by the
	 * column's declared affinity rather than by sniffing the string with `Number()`.
	 *
	 * NULL is no longer represented in-band (the framing carries it), so there is no
	 * NULL sentinel here — this only ever sees present payloads. Affinity-driven decode
	 * keeps a TEXT `"123"`, `" "`, `"1e2"`, or `"0xff"` as its exact string (the old
	 * `Number()`-first sniff silently coerced all of those to numbers); only the numeric
	 * affinities parse back to a number.
	 */
	private deserializeKeyPart(serialized: string, affinity?: string): SqlValue {
		const aff = (affinity || '').toUpperCase();

		if (aff === 'INTEGER' || aff === 'REAL' || aff === 'NUMERIC') {
			// Numeric column: payload was `value.toString()` — parse it back.
			// NOTE: `serialized.trim() !== ''` guards `Number(' ') === 0`; blank payloads
			// never come from a numeric column today, so this only matters if/when this
			// (currently dead) comparator is wired up — see debt-optimystic-true-key-ordering.
			const num = Number(serialized);
			if (!isNaN(num) && serialized.trim() !== '') {
				return num;
			}
			return serialized;
		}

		// TEXT / BLOB / unknown affinity: keep the raw string payload verbatim.
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
		return compareSqlValues(a, b);
	}
}

