/**
 * IndexPredicate — which rows a partial index (`create index … where …`) holds.
 *
 * The one home of the rule "what a partial index admits": the index manager's staging paths, the
 * vtab's backfill and the integrity check all ask it, so maintenance and the check cannot disagree
 * about which rows an index should hold.
 *
 * The evaluator is Quereus's own (`compilePredicate`, the one its memory and store modules use for
 * partial indexes), so a predicate means here exactly what it means to the engine. Only SQL TRUE
 * admits a row; FALSE and NULL both exclude it — SQLite partial-index semantics, and what Quereus's
 * memory module does.
 */

import { compilePredicate } from '@quereus/quereus';
import type { CompiledPredicate, Row, SqlValue } from '@quereus/quereus';
import { storedToColumnSchema, type StoredColumnSchema } from './schema-manager.js';

/** The parser `Expression` `compilePredicate` takes; a persisted predicate is one (`persistExpression` in schema-manager.ts). */
type PredicateExpression = Parameters<typeof compilePredicate>[0];

export class IndexPredicate {
	private constructor(
		private readonly compiled: CompiledPredicate,
		/**
		 * For each column the predicate reads: its position in the column list the predicate was
		 * compiled against → its position in the rows {@link admits} is handed now. Undefined while
		 * the two layouts agree, which is every predicate until a catalog-only DROP COLUMN
		 * ({@link repositioned}) moves a column it reads.
		 */
		private readonly positions: ReadonlyMap<number, number> | undefined,
	) {}

	/**
	 * Compile a persisted predicate AST against the columns of the schema it came from. Throws
	 * `compilePredicate`'s `QuereusError` for an expression form it does not support (a function
	 * call, a subquery) or a column it cannot resolve.
	 */
	static compile(predicate: unknown, columns: readonly StoredColumnSchema[], tableName: string): IndexPredicate {
		const compiled = compilePredicate(predicate as PredicateExpression, columns.map(storedToColumnSchema), tableName);
		return new IndexPredicate(compiled, undefined);
	}

	/** True only when the predicate evaluates to SQL TRUE for `row`, a full row in the current layout. */
	admits(row: Row): boolean {
		return this.compiled.evaluate(this.positions === undefined ? row : compiledLayout(row, this.positions)) === true;
	}

	/**
	 * The same predicate over rows renumbered by `reposition` — the column-position map of a
	 * catalog-only DROP COLUMN. Remapped rather than recompiled: the manager's column list is not
	 * renumbered with the indexes, so a recompile would bind the predicate's names to the old
	 * positions. Quereus refuses to drop a column a partial index's predicate names, so `reposition`
	 * never meets a removed position here.
	 */
	repositioned(reposition: (position: number) => number): IndexPredicate {
		const positions = new Map<number, number>();
		for (const compiledAt of this.compiled.referencedColumns) {
			positions.set(compiledAt, reposition(this.positions?.get(compiledAt) ?? compiledAt));
		}
		const identity = [...positions].every(([compiledAt, currentAt]) => compiledAt === currentAt);
		return new IndexPredicate(this.compiled, identity ? undefined : positions);
	}
}

/** `row` laid out as the predicate was compiled, holding only the columns `positions` maps. */
function compiledLayout(row: Row, positions: ReadonlyMap<number, number>): Row {
	const layout: SqlValue[] = [];
	for (const [compiledAt, currentAt] of positions) {
		layout[compiledAt] = row[currentAt] ?? null;
	}
	return layout;
}
