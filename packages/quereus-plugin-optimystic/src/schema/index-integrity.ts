/**
 * index-integrity — does a secondary index agree with its table, in both directions?
 *
 * An index tree entry is `[indexEntryKey(indexKey, primaryKey), primaryKey]`. Every row
 * implies exactly one such entry per index, and every entry should be implied by exactly
 * one row. Two kinds of disagreement follow:
 *
 *   - a MISSING entry: a row whose implied tree key the tree does not hold, so an
 *     index-routed lookup for the row's value silently skips the row;
 *   - an ORPHANED entry: one no row implies. Queries cannot see these. `executeIndexScan`
 *     fetches each entry's row by primary key and skips an entry whose row is gone, and
 *     Quereus re-applies the predicate to a row whose value moved, so a lookup's row set
 *     still matches a full scan; and a lookup for a value no row holds is never issued by
 *     an oracle that takes its values from a scan. They still occupy the tree — in a
 *     unique-enforcement tree, a value the probe then treats as taken.
 *
 * The comparison is a set difference over tree keys, so it sees both kinds whichever values
 * rows currently hold. It is pure (no I/O): it takes the rows and entries the caller already
 * read, and `OptimysticVirtualTable.verifyIndexes` does the reading and chooses the view.
 */

import type { Row } from '@quereus/quereus';
import type { StoredIndexSchema } from './schema-manager.js';
import { hasNullIndexValue, indexEntryKey, type IndexEntry, type IndexKey, type PrimaryKey } from './index-manager.js';
import { encodeKeyTuple, splitKeyTuple } from './key-encoding.js';

/**
 * `declared` — an index the table declares (`CREATE INDEX`), offered to the planner.
 * `unique-enforcement` — a tree the table synthesizes to enforce a UNIQUE constraint that has
 * no declared backing index, named by `uniqueEnforcementTreeName`.
 */
export type IndexKind = 'declared' | 'unique-enforcement';

/**
 * An index tree key decoded back into its element payloads, split where the index columns
 * end. Each payload is `null` for SQL NULL, else the serialized value: `serializeIndexValue`'s
 * form in the index half (the number 5 reads `5.000000000000000e+0`), `RowCodec`'s in the
 * primary-key half (the number 5 reads `5`). Enough for a message or a test to name an entry by
 * value and id without re-implementing the key encoding.
 */
export interface DecodedIndexTreeKey {
	indexPayloads: (string | null)[];
	primaryKeyPayloads: (string | null)[];
}

/** A row the index holds no entry for. Its payloads decode `expectedTreeKey`. */
export interface MissingIndexEntry extends DecodedIndexTreeKey {
	/** The tree key the row's values imply, absent from the tree. */
	expectedTreeKey: string;
	primaryKey: PrimaryKey;
	row: Row;
}

/**
 * Why an entry no row implies is in the tree:
 *   - `no-row` — its primary key resolves to no row (the row was deleted or moved to another
 *     primary key, or never landed);
 *   - `stale-value` — it resolves to a row whose current values imply a DIFFERENT tree key
 *     (the row's indexed value changed without the entry following);
 *   - `malformed` — its stored primary key is not the primary-key half of its own tree key, so
 *     where the entry sits and the row a seek resolves it to disagree.
 */
export type OrphanReason = 'no-row' | 'stale-value' | 'malformed';

/** An index entry no row implies. Its payloads decode `treeKey`, i.e. where the entry sits. */
export interface OrphanedIndexEntry extends DecodedIndexTreeKey {
	treeKey: string;
	/** The entry's stored value, `entry[1]`: the row a seek resolves it to. */
	primaryKey: PrimaryKey;
	reason: OrphanReason;
	/** The row `primaryKey` resolves to, for `stale-value`. */
	currentRow?: Row;
}

/** One index's agreement with its table. Clean when `missing` and `orphaned` are both empty. */
export interface IndexIntegrityReport {
	table: string;
	/** The index name; for `unique-enforcement`, the synthesized tree name. */
	index: string;
	kind: IndexKind;
	rowCount: number;
	entryCount: number;
	missing: MissingIndexEntry[];
	orphaned: OrphanedIndexEntry[];
}

/** What {@link compareIndexToRows} compares: one index's entries against every row. */
export interface IndexIntegrityInput {
	table: string;
	index: StoredIndexSchema;
	kind: IndexKind;
	/** Every row of the table, keyed by its framed primary key (`RowCodec.extractPrimaryKey`). */
	rows: ReadonlyMap<PrimaryKey, Row>;
	/** Every entry the index tree holds. */
	entries: readonly IndexEntry[];
	/**
	 * The row's framed index key for `index`. Pass `IndexManager.createIndexKey`, so expected
	 * keys come from the same definition maintenance stages with rather than a copy of it.
	 */
	indexKeyOf: (row: Row) => IndexKey;
}

type ExpectedEntries = ReadonlyMap<string, { primaryKey: PrimaryKey; row: Row }>;

/** Diff the tree keys `input.rows` imply against the tree keys `input.entries` hold. */
export function compareIndexToRows(input: IndexIntegrityInput): IndexIntegrityReport {
	const { index, kind, rows } = input;
	const width = index.columns.length;

	// NOTE: `index.predicate` (a partial index) is ignored, because maintenance ignores it too:
	// insertIndexEntries and backfillIndexTrees index every row (see the NOTE on
	// backfillIndexTrees). Honouring it here alone would report every row the predicate
	// excludes as missing. The check and maintenance must change together.
	//
	// NOTE: holds every row's expected key in memory, next to the rows and entries the caller
	// already materialized. Fine for a diagnostic over modest tables; if this is ever run on
	// large ones, stream it per index instead: sort the expected keys and merge them against
	// the tree's ascending scan.
	const expected = new Map<string, { primaryKey: PrimaryKey; row: Row }>();
	const optional = new Set<string>();
	for (const [primaryKey, row] of rows) {
		const treeKey = indexEntryKey(input.indexKeyOf(row), primaryKey);
		expected.set(treeKey, { primaryKey, row });
		if (isEntryOptional(index, kind, row)) optional.add(treeKey);
	}

	const present = new Set<string>();
	const orphaned: OrphanedIndexEntry[] = [];
	for (const [treeKey, primaryKey] of input.entries) {
		present.add(treeKey);
		const orphan = classifyEntry(treeKey, primaryKey, width, expected, rows);
		if (orphan) orphaned.push(orphan);
	}

	const missing: MissingIndexEntry[] = [];
	for (const [treeKey, { primaryKey, row }] of expected) {
		if (present.has(treeKey) || optional.has(treeKey)) continue;
		missing.push({ expectedTreeKey: treeKey, primaryKey, row, ...decodeTreeKey(treeKey, width) });
	}

	return {
		table: input.table,
		index: index.name,
		kind,
		rowCount: rows.size,
		entryCount: input.entries.length,
		missing,
		orphaned,
	};
}

/**
 * Whether a row's entry may be absent without that being a discrepancy. True only for a
 * NULL-bearing row in a unique-enforcement tree: the constraint exempts the row, so the tree's
 * one-time populate for rows an older build wrote (`ensureUniquePopulated`) stages nothing for
 * it, while live DML stages an entry. Both states are correct, so an absent entry is not
 * reported; a present one is still checked like any other.
 */
function isEntryOptional(index: StoredIndexSchema, kind: IndexKind, row: Row): boolean {
	return kind === 'unique-enforcement' && hasNullIndexValue(index, row);
}

/** The orphan report for one stored entry, or `undefined` when some row implies it exactly. */
function classifyEntry(
	treeKey: string,
	primaryKey: PrimaryKey,
	width: number,
	expected: ExpectedEntries,
	rows: ReadonlyMap<PrimaryKey, Row>,
): OrphanedIndexEntry | undefined {
	// The common case, answered without decoding: exactly the entry one row implies.
	if (expected.get(treeKey)?.primaryKey === primaryKey) return undefined;

	const decoded = decodeTreeKey(treeKey, width);
	const base = { treeKey, primaryKey, ...decoded };
	// Well formed means the stored primary key is exactly the tree key's primary-key half. A
	// well-formed key some row implies has passed the check above, so past this point a
	// well-formed entry is implied by no row at all.
	if (treeKey !== indexEntryKey(encodeKeyTuple(decoded.indexPayloads), primaryKey)) {
		return { ...base, reason: 'malformed' };
	}
	const currentRow = rows.get(primaryKey);
	return currentRow === undefined
		? { ...base, reason: 'no-row' }
		: { ...base, reason: 'stale-value', currentRow };
}

function decodeTreeKey(treeKey: string, width: number): DecodedIndexTreeKey {
	const payloads = splitKeyTuple(treeKey).map(element => (element.isNull ? null : element.payload));
	return { indexPayloads: payloads.slice(0, width), primaryKeyPayloads: payloads.slice(width) };
}
