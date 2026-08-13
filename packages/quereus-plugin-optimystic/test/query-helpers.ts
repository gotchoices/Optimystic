import { expect } from 'chai';
import type { Database, SqlValue } from '@quereus/quereus';
import { OptimysticVirtualTable } from '../dist/index.js';

/** Collect every row `sql` returns from a node's database, finalizing the statement. */
export async function queryAll(
	db: Database,
	sql: string,
	params?: SqlValue[],
): Promise<Record<string, any>[]> {
	const stmt = await db.prepare(sql);
	try {
		const rows: Record<string, any>[] = [];
		for await (const row of stmt.all(params)) rows.push(row);
		return rows;
	} finally {
		await stmt.finalize();
	}
}

/** Run `sql` and return its single row, or `undefined` when no row matches (not ready yet). */
export async function queryGet(db: Database, sql: string): Promise<Record<string, any> | undefined> {
	const stmt = await db.prepare(sql);
	try {
		return await stmt.get();
	} finally {
		await stmt.finalize();
	}
}

/**
 * Type-tagged, comparable rendering of one cell. `bigint` and `number` collapse onto the
 * same tag on purpose: the index key serializer unifies them too (see
 * serializeIndexValue), so `5n` and `5` are one logical index value and must group as one.
 */
function canonicalValue(value: SqlValue | undefined): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'bigint' || typeof value === 'number') return `n:${value}`;
	if (typeof value === 'string') return `s:${value}`;
	if (typeof value === 'boolean') return `b:${value}`;
	if (value instanceof Uint8Array) return `x:${Array.from(value).join(',')}`;
	return `?:${String(value)}`;
}

/**
 * Column-order-independent rendering of a whole row, so two row sets compare as
 * multisets. JSON-framed rather than concatenated so no two distinct rows can render
 * to the same string.
 */
function canonicalRow(row: Record<string, SqlValue>): string {
	return JSON.stringify(
		Object.keys(row).sort().map(name => [name, canonicalValue(row[name])]),
	);
}

interface IndexRoutingProbe {
	/** `executeIndexScan` invocations since the last reset — the secondary-index read path. */
	indexScans: number;
	/** Every plan Quereus handed the vtab since the last reset, for failure messages. */
	plans: string[];
	reset(): void;
	restore(): void;
}

/**
 * Count secondary-index reads on the shared vtab prototype, so a predicate query can be
 * shown to have gone THROUGH the index rather than being answered by a full-scan
 * fallback. Same mechanism as read-pull-mechanism.spec.ts — the dist bundle re-exports
 * the class from one shared chunk, so this is the prototype the registered plugin
 * instantiates.
 */
function installIndexRoutingProbe(): IndexRoutingProbe {
	const proto = OptimysticVirtualTable.prototype as any;
	const originalQuery = proto.query;
	const originalIndexScan = proto.executeIndexScan;

	const probe: IndexRoutingProbe = {
		indexScans: 0,
		plans: [],
		reset() {
			this.indexScans = 0;
			this.plans = [];
		},
		restore() {
			proto.query = originalQuery;
			proto.executeIndexScan = originalIndexScan;
		},
	};

	proto.query = async function* (this: any, filterInfo: any) {
		probe.plans.push(String(filterInfo?.idxStr ?? 'none'));
		yield* originalQuery.call(this, filterInfo);
	};
	proto.executeIndexScan = async function* (this: any, ...args: any[]) {
		probe.indexScans++;
		yield* originalIndexScan.apply(this, args);
	};

	return probe;
}

/**
 * Assert that an index-routed lookup on `column` returns exactly what a full scan
 * returns, for EVERY distinct value present in `table`.
 *
 * This is the generalized form of the class of defect "an index tree that does not
 * account for every committed row" (writes staged past a detached index, orphaned
 * entries left by an UPDATE, a re-attach that never backfilled): the row is committed
 * and a full scan sees it, while the seek the planner routes into the index silently
 * misses it. Any interleaving of table declaration, index declaration and writes must
 * leave the two agreeing.
 *
 * The values queried come from the SCAN, so this catches a stale/orphaned entry only
 * when its value is still present in some row (the entry then pulls an extra row into
 * that value's seek). An entry for a value no longer held by ANY row is never queried
 * and so never seen here — assert on the tree's keys directly for that.
 *
 * `column` must be covered by a DECLARED secondary index whose FIRST column it is —
 * that is what makes the equality form routable. Each value-form query is required to
 * have reached `executeIndexScan`, so a full-scan fallback fails the assertion instead
 * of passing it vacuously. (With a single equality filter, `getBestAccessPlan` can only
 * match an index led by `column`, so "some index scan ran" pins the right index.)
 *
 * The NULL group is compared through `where <column> is null` and is exempt from the
 * routing requirement: `is null` is not an equality filter, so it is never pushed down
 * into an index seek — only its row set is checked.
 */
export async function expectIndexAgreesWithScan(
	db: Database,
	table: string,
	column: string,
): Promise<void> {
	const scanned = await queryAll(db, `select * from ${table}`) as Record<string, SqlValue>[];
	if (scanned.length === 0) return;
	if (!(column in scanned[0]!)) {
		throw new Error(`expectIndexAgreesWithScan: table '${table}' has no column '${column}'`);
	}

	// Group the scan's rows by their value in `column`: each group is exactly the row set
	// a predicate on that value has to return.
	const groups = new Map<string, { value: SqlValue; rows: Record<string, SqlValue>[] }>();
	for (const row of scanned) {
		const value = row[column] ?? null;
		const key = canonicalValue(value);
		const group = groups.get(key) ?? { value, rows: [] };
		group.rows.push(row);
		groups.set(key, group);
	}

	const probe = installIndexRoutingProbe();
	try {
		for (const [key, group] of groups) {
			const isNull = group.value === null;
			const sql = isNull
				? `select * from ${table} where ${column} is null`
				: `select * from ${table} where ${column} = ?`;

			probe.reset();
			const viaPredicate = await queryAll(db, sql, isNull ? undefined : [group.value]) as Record<string, SqlValue>[];
			const where = `${table}.${column} ${isNull ? 'is null' : `= ${key}`}`;

			if (!isNull) {
				expect(
					probe.indexScans,
					`${where}: must be answered through a secondary index seek, not a full scan ` +
					`(plans seen: ${probe.plans.join(' | ')})`,
				).to.be.greaterThan(0);
			}

			expect(
				viaPredicate.map(canonicalRow).sort(),
				`${where}: the index-routed row set must equal the full scan's`,
			).to.deep.equal(group.rows.map(canonicalRow).sort());
		}
	} finally {
		probe.restore();
	}
}
