/**
 * index-walk — what an ordered walk of a secondary index's tree delivers, how the walk's rows are
 * put into the engine's order, and where a range predicate on a key column starts and ends it.
 *
 * An index tree's key is `frame(indexValues) ‖ frame(primaryKey)` (see index-manager.ts), compared
 * as raw UTF-16 code units (`compareTreeKeys` in optimystic-adapter/collection-factory.ts). A
 * walk of the tree, forwards or backwards, therefore delivers rows ordered by the index columns
 * and then the primary key — but only where the stored bytes order as the engine orders the
 * values. {@link walkDelivering} decides at plan time which required orderings that is, and
 * {@link inEngineOrder} repairs, at read time, the one place the two orders still differ. On
 * such a column the same bytes bracket a range predicate: {@link indexRangeScan} turns its bounds
 * into the tree keys the walk starts and ends at, and into a test on each row for a bound the
 * tree cannot apply.
 */

import { ANY_TYPE, BOOLEAN_TYPE, IndexConstraintOp, PhysicalType, compareSqlValues, equalitySeekKeyCount, hasSemanticOrdering, isMultiValueEquality, normalizeCollationName, nullSafeOrderingPrefixLength } from '@quereus/quereus';
import type { BestAccessPlanRequest, ColumnSchema, OrderingSpec, PredicateConstraint, Row, SqlValue, TableSchema, TableIndexSchema } from '@quereus/quereus';
import { KeyRange } from '@optimystic/db-core';
import { KEY_PREFIX_END, KEY_PRESENT_START } from './key-encoding.js';
import { indexKeyFromValues, type IndexKey } from './index-manager.js';

/** One key column of an index or primary key: its table column position and declared collation. */
export interface KeyColumn {
	readonly index: number;
	readonly collation?: string;
}

/** The ordered column positions an index or primary key names, in key order. */
type KeyColumnList = readonly KeyColumn[];

/**
 * Whether a seek on a key column finds every row a predicate on it would. The index and
 * primary-key trees compare raw bytes, so a seek finds only values whose stored bytes equal the
 * sought bytes, and a claimed filter is not re-checked by the engine. On a column where equal
 * values can have different bytes, a seek loses rows: a non-BINARY key collation, or a type that
 * compares by meaning (`hasSemanticOrdering`: `timespan`'s `'PT60M'` equals a stored `'PT1H'`).
 * Such a column stays a residual filter over a scan: slower, and correct.
 *
 * `keyCollation` is the same one `indexColumnCollationLookup` in
 * `@quereus/quereus/src/planner/rules/access/rule-select-access-path.ts` reads, so the module and
 * the engine judge one thing: the index column's for a secondary index, the table column's for the
 * primary key. The engine reads a `nocase` predicate over a `nocase` key as a full match, which is
 * a promise that the seek honours the collation; this module's cannot. The cost is that a
 * `collate binary` predicate over a `nocase` index, which a byte seek would answer correctly, scans.
 */
export function seekCanBeTrusted(column: ColumnSchema | undefined, keyCollation: string | undefined): boolean {
	return column !== undefined
		&& normalizeCollationName(keyCollation ?? 'BINARY') === 'BINARY'
		&& !hasSemanticOrdering(column.logicalType);
}

/**
 * Whether a seek of a secondary index's column finds every row a predicate on it would: everything
 * {@link seekCanBeTrusted} asks, and that the column cannot store a boolean. The engine compares
 * `true` equal to `1`, but an index frames them as different bytes (`serializeIndexValue`), so on a
 * `boolean` or `any` column one of the two is lost. A primary key frames both as `1`, so it needs
 * no such rule.
 */
export function indexSeekCanBeTrusted(column: ColumnSchema | undefined, keyCollation: string | undefined): boolean {
	return seekCanBeTrusted(column, keyCollation)
		&& column?.logicalType.name !== BOOLEAN_TYPE.name
		&& column?.logicalType.name !== ANY_TYPE.name;
}

/**
 * The key a walk of `index`'s tree orders rows by: the index's columns, then the primary key
 * columns not already among them. The tree key is `frame(indexValues) ‖ frame(primaryKey)`, so
 * rows with equal index values order by their primary key; a primary-key column repeated in the
 * index is already decided by its first position. An index column's own `desc` is ignored:
 * neither `IndexManager.createIndexKey` nor `RowCodec` reads it, so every tree is ascending in its
 * bytes. A primary-key column's collation is the table column's, which is the one the engine reads
 * for the primary key too (`indexColumnCollationLookup`, see {@link seekCanBeTrusted}).
 */
export function walkKeyColumns(
	indexColumns: KeyColumnList,
	primaryKeyColumns: readonly { readonly index: number }[],
	columns: readonly ColumnSchema[],
): KeyColumn[] {
	return walkKeyPositions(indexColumns, primaryKeyColumns).map(position => {
		const indexColumn = indexColumns.find(column => column.index === position);
		return { index: position, collation: indexColumn !== undefined ? indexColumn.collation : columns[position]?.collation };
	});
}

/**
 * The table-column positions of {@link walkKeyColumns}' key, in key order — what the read path
 * compares a walk's rows by ({@link inEngineOrder}), where no collation is needed.
 */
export function walkKeyPositions(
	indexColumns: readonly { readonly index: number }[],
	primaryKeyColumns: readonly { readonly index: number }[],
): number[] {
	const positions = indexColumns.map(column => column.index);
	for (const pk of primaryKeyColumns) {
		if (!positions.includes(pk.index)) positions.push(pk.index);
	}
	return positions;
}

/**
 * A column is pinned when a usable `=` or single-element `in` filter fixes its value, so it is
 * constant in the rows that survive and contributes no ordering. It counts here only when the
 * rows the filter keeps also have equal BYTES in that column ({@link indexSeekCanBeTrusted} under
 * the column's own collation, which is the one its predicates compare under): `where a = 'x'` on
 * a `nocase` column keeps `'X'` and `'x'`, which sit in separate groups of the tree, and the key
 * columns after `a` are ordered only within each group. The filter need not be one the plan
 * claims — an unclaimed one is enforced by the engine as a residual, which removes the other rows
 * just as well.
 * NOTE: a filter's comparison collation is not on `PredicateConstraint`, so `b = 'x' collate
 * nocase` on a BINARY column pins `b` here as a plain `=` would, and a walk ordered by the key
 * columns after it interleaves its 'X' and 'x' groups. The engine's own memory module pins the
 * same way, and the engine also keeps a plan's ordering claim after declining its seek for that
 * mismatch; both are the blocked ticket
 * `quereus-a-collate-nocase-equality-keeps-an-ordering-claim-the-plan-cannot-serve`. Once the
 * constraint carries its collation, pin only when it is at least as fine as BINARY.
 */
function pinnedColumns(filters: readonly PredicateConstraint[], tableInfo: TableSchema): Set<number> {
	const pinned = new Set<number>();
	for (const filter of filters) {
		if (!filter.usable || filter.runtimeSet || isMultiValueEquality(filter) || equalitySeekKeyCount(filter) !== 1) continue;
		const column = tableInfo.columns[filter.columnIndex];
		if (indexSeekCanBeTrusted(column, column?.collation)) pinned.add(filter.columnIndex);
	}
	return pinned;
}

/**
 * Whether the tree's byte order of `keyColumn` is the engine's order of the column's values: a
 * TEXT column stored raw (a number is framed as `toExponential`, a blob as base64, neither
 * order-preserving), compared by value rather than meaning (`timespan` is TEXT but compares by
 * elapsed time), under BINARY for both the table column and the key column (the tree compares code
 * units, which is BINARY up to the surrogate rule {@link inEngineOrder} repairs; any other collation
 * orders differently). The rule for a column a walk may order by, and for one a range predicate
 * may bracket ({@link indexRangeScan}).
 *
 * NOTE: this gates on the DECLARED physical type, while the stored payload is chosen by the runtime
 * JS value type (`serializeIndexValue`). They agree because Quereus coerces a TEXT column's values
 * to strings before they reach this module; if a number ever reached a TEXT column un-coerced, the
 * claim here would over-order.
 */
export function bytesOrderAsValues(keyColumn: KeyColumn, tableInfo: TableSchema): boolean {
	const column = tableInfo.columns[keyColumn.index];
	if (!column || column.logicalType.physicalType !== PhysicalType.TEXT) return false;
	if (hasSemanticOrdering(column.logicalType)) return false;
	return normalizeCollationName(column.collation || 'BINARY') === 'BINARY'
		&& normalizeCollationName(keyColumn.collation ?? 'BINARY') === 'BINARY';
}

/** How a walk delivers a required ordering; see {@link walkDelivering}. */
export interface WalkDelivery {
	/** Walk the tree backwards: the required columns are all descending. */
	readonly reverse: boolean;
	/**
	 * How many of the required columns the walk itself orders. The rest are pinned to one value
	 * by the query's filters, so any access path delivers them; a walk proposed for an ordering
	 * with none left to order would read the table through an index for nothing.
	 */
	readonly orders: number;
}

/**
 * How a walk of `index`'s tree delivers `required`, or `undefined` when it cannot.
 *
 * Pinned columns ({@link pinnedColumns}) are removed from the required list and skipped in the
 * key. The remaining required columns must then match the key's remaining columns positionally,
 * each must have bytes that order as its values do ({@link bytesOrderAsValues}), and all must share
 * one direction, which sets `reverse`; `order by a asc, b desc` is never delivered. With nothing
 * remaining the walk is forward.
 *
 * No NULL may reach a matched column, in either direction (`nullSafeOrderingPrefixLength`, asked
 * about every consumed key column as if it were descending): the engine loses an explicit `nulls
 * first` or `nulls last` before the request reaches a module, so a module cannot honour the
 * placement — see the blocked ticket
 * `quereus-explicit-nulls-placement-is-lost-when-an-index-serves-order-by`. A column is safe when
 * it is NOT NULL (the default in Quereus), pinned, or under a NULL-excluding filter such as
 * `is not null`, claimed or not.
 */
export function walkDelivering(
	required: readonly OrderingSpec[],
	index: Pick<TableIndexSchema, 'columns'>,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
): WalkDelivery | undefined {
	const key = walkKeyColumns(index.columns, tableInfo.primaryKeyDefinition, tableInfo.columns);
	const pinned = pinnedColumns(request.filters, tableInfo);
	const remaining = required.filter(spec => !pinned.has(spec.columnIndex));

	let consumed = 0;
	for (const spec of remaining) {
		while (consumed < key.length && pinned.has(key[consumed]!.index)) consumed++;
		const keyColumn = key[consumed];
		if (keyColumn === undefined || keyColumn.index !== spec.columnIndex) return undefined;
		if (!bytesOrderAsValues(keyColumn, tableInfo)) return undefined;
		if (spec.desc !== remaining[0]!.desc) return undefined;
		consumed++;
	}

	const asDescending = key.map(column => ({ index: column.index, desc: true, collation: column.collation }));
	if (nullSafeOrderingPrefixLength(tableInfo, request, asDescending, consumed, pinned) !== consumed) return undefined;

	return { reverse: remaining.length > 0 && remaining[0]!.desc, orders: remaining.length };
}

/**
 * The one way the tree's order and the engine's differ on text that passes
 * {@link bytesOrderAsValues}: the tree compares UTF-16 code units, the engine's BINARY collation
 * compares code points (`compareCodePoints` in `@quereus/quereus/src/util/comparison.ts`), and the
 * two disagree exactly when, at the first differing position, one string has a high surrogate and
 * the other a unit at or above U+E000 — an emoji against `～`. A row none of whose key columns
 * holds a unit in this range is a PIVOT: at its first differing unit against any other row, its own
 * unit is below U+D800, where the two orders agree, so the row compares the same way under both.
 */
const NOT_A_PIVOT = /[\uD800-\uFFFF]/;

/**
 * The rows of a walk in the engine's order.
 *
 * Everything the walk returned before a pivot (see {@link NOT_A_PIVOT}) stays on that side of it in
 * the engine's order, and everything after it stays after, so only the rows between two pivots can
 * be out of order among themselves. Those are held in a run and, at the next pivot or the end of
 * the walk, sorted stably by `keyColumns` with the engine's own comparison, negated when `reverse`,
 * then yielded ahead of the pivot. Text without such units is never buffered, so a `limit` stops
 * the walk at the rows it needs; BMP scripts, CJK and Hangul included, are all below U+D800.
 *
 * Comparing the whole key rather than the claimed columns needs no record of what was claimed:
 * rows that tie on the claimed columns may legitimately come out in either order, and the key's
 * trailing columns only ever decide such ties. A lone surrogate keeps its row out of the pivots, so
 * the order stays total and deterministic, matching the engine's.
 */
export async function* inEngineOrder(
	rows: AsyncIterable<Row>,
	keyColumns: readonly number[],
	reverse: boolean,
): AsyncIterable<Row> {
	const direction = reverse ? -1 : 1;
	const compareRows = (a: Row, b: Row): number => {
		for (const column of keyColumns) {
			const order = compareSqlValues(a[column] ?? null, b[column] ?? null);
			if (order !== 0) return order * direction;
		}
		return 0;
	};
	const isPivot = (row: Row): boolean =>
		!keyColumns.some(column => typeof row[column] === 'string' && NOT_A_PIVOT.test(row[column] as string));

	let run: Row[] = [];
	for await (const row of rows) {
		if (!isPivot(row)) {
			run.push(row);
			continue;
		}
		if (run.length > 0) {
			yield* run.sort(compareRows);
			run = [];
		}
		yield row;
	}
	yield* run.sort(compareRows);
}

/** The operators a range bound carries, as the engine's `FilterInfo.constraints` name them. */
export type RangeBoundOp = IndexConstraintOp.GT | IndexConstraintOp.GE | IndexConstraintOp.LT | IndexConstraintOp.LE;

/** One bound of a range predicate on an index column: its operator and the value bound at runtime. */
export interface RangeBound {
	readonly op: RangeBoundOp;
	readonly value: SqlValue | undefined;
}

/** What an index scan reads for a range predicate on one key column; see {@link indexRangeScan}. */
export interface IndexRangeScan {
	/** The tree-key range to walk, in walk order: `[low, high)` forwards, the same two keys swapped backwards. */
	readonly range: KeyRange<string>;
	/** The range's inclusive lower tree key, for the `index:seek` trace. */
	readonly low: string;
	/** The range's exclusive upper tree key, for the trace. */
	readonly high: string;
	/**
	 * The test every row the scan verifies must also pass, for a bound the tree could not apply
	 * ({@link boundInTree}); `undefined` when the tree applied both.
	 */
	readonly rowTest?: (row: Row) => boolean;
}

/**
 * The value of a bound the tree key can apply, or `undefined` for one it cannot.
 *
 * A bound reaches the rows in one of three ways. NULL — or undefined, a parameter bound to NULL —
 * makes the comparison UNKNOWN, so no row matches; {@link indexRangeScan} then builds no range, as
 * an equality seek with a NULL value seeks nothing. A string with no code unit at or above U+D800
 * is a PIVOT ({@link NOT_A_PIVOT}): every stored value compares the same way against it under the
 * tree's code-unit order and the engine's code-point order, so the tree's own bracketing of it
 * admits exactly the rows the predicate admits, and it goes in the tree key. Anything else — a
 * string holding such a unit, or a parameter bound to a value of another type, such as a number
 * against a text column — is left out of the tree key, which then brackets every present value on
 * that side, and is tested on each row instead ({@link boundTest}).
 */
function boundInTree(bound: RangeBound): string | undefined {
	return typeof bound.value === 'string' && !NOT_A_PIVOT.test(bound.value) ? bound.value : undefined;
}

/** Whether `bound` compares against NULL, which no row satisfies. */
const isNullBound = (bound: RangeBound | undefined): boolean =>
	bound !== undefined && (bound.value === null || bound.value === undefined);

/**
 * The per-row test of a bound the tree could not apply: the column's value against the bound's,
 * compared as the engine's own residual filter compares them for a BINARY, non-semantic column
 * (`compareSqlValuesFast` under BINARY in `@quereus/quereus/src/runtime/emit/binary.ts`), which
 * ranks a number below any text and compares two strings by code point. A NULL column value
 * fails: the comparison is UNKNOWN.
 */
function boundTest(column: number, bound: RangeBound): (row: Row) => boolean {
	const value = bound.value ?? null;
	const admits = (order: number): boolean => {
		switch (bound.op) {
			case IndexConstraintOp.GT: return order > 0;
			case IndexConstraintOp.GE: return order >= 0;
			case IndexConstraintOp.LT: return order < 0;
			case IndexConstraintOp.LE: return order <= 0;
		}
	};
	return row => {
		const stored = row[column];
		return stored !== null && stored !== undefined && admits(compareSqlValues(stored, value));
	};
}

/** `P ‖ frame(x)`: the tree key every entry of value `x` under the framed prefix `P` begins with. */
const framedUnder = (prefix: IndexKey, value: string): string => prefix + indexKeyFromValues([value]);

/** The inclusive lower tree key of {@link indexRangeScan}'s table. */
function lowKey(prefix: IndexKey, lower: RangeBound | undefined): string {
	const value = lower === undefined ? undefined : boundInTree(lower);
	if (lower === undefined || value === undefined) return prefix + KEY_PRESENT_START;
	return framedUnder(prefix, value) + (lower.op === IndexConstraintOp.GT ? KEY_PREFIX_END : '');
}

/** The exclusive upper tree key of {@link indexRangeScan}'s table. */
function highKey(prefix: IndexKey, upper: RangeBound | undefined): string {
	const value = upper === undefined ? undefined : boundInTree(upper);
	if (upper === undefined || value === undefined) return prefix + KEY_PREFIX_END;
	return framedUnder(prefix, value) + (upper.op === IndexConstraintOp.LE ? KEY_PREFIX_END : '');
}

/**
 * The tree-key range an index scan walks for a range predicate on the key column after the framed
 * prefix `prefix` (`P`, empty with no prefix), and the test on each row for whatever the tree
 * cannot apply. `undefined` when a bound is NULL: no row matches, so nothing is sought.
 *
 * With `f(x)` = `P ‖ frame(x)`, every lower key inclusive and every upper key exclusive:
 *
 * | bound    | tree key                      |
 * |----------|-------------------------------|
 * | `>= x`   | lower `f(x)`                  |
 * | `> x`    | lower `f(x) + KEY_PREFIX_END` |
 * | `< x`    | upper `f(x)`                  |
 * | `<= x`   | upper `f(x) + KEY_PREFIX_END` |
 * | no lower | lower `P + KEY_PRESENT_START` |
 * | no upper | upper `P + KEY_PREFIX_END`    |
 *
 * `f(x)` ends in the element terminator and every entry of value `x` continues it with the framed
 * primary key, whose first unit is a tag below `KEY_PREFIX_END`, so `f(x) + KEY_PREFIX_END` sits
 * above every entry of `x` and below every entry of a longer value — `x + '\x00'` included, whose
 * escape puts `\xff` there (the reasoning at `KEY_PREFIX_END` in key-encoding.ts). "No lower" is
 * not left open: NULL-keyed entries sort first, under the NULL tag, and `t < x` must not return
 * them. A bound the tree cannot apply ({@link boundInTree}) takes the open key on its side and is
 * tested on each row. `reverse` swaps the two ends, so the walk runs from the high key down.
 */
export function indexRangeScan(
	prefix: IndexKey,
	column: number,
	lower: RangeBound | undefined,
	upper: RangeBound | undefined,
	reverse: boolean,
): IndexRangeScan | undefined {
	if (isNullBound(lower) || isNullBound(upper)) return undefined;
	const low = lowKey(prefix, lower);
	const high = highKey(prefix, upper);
	const tests = [lower, upper]
		.filter((bound): bound is RangeBound => bound !== undefined && boundInTree(bound) === undefined)
		.map(bound => boundTest(column, bound));
	const first = { key: low, inclusive: true };
	const last = { key: high, inclusive: false };
	return {
		range: reverse ? new KeyRange<string>(last, first, false) : new KeyRange<string>(first, last, true),
		low,
		high,
		rowTest: tests.length === 0 ? undefined : row => tests.every(test => test(row)),
	};
}
