import { expect } from 'chai';
import type { Database, Row, SqlValue } from '@quereus/quereus';
import { OptimysticModule, OptimysticVirtualTable } from '../dist/index.js';
import type { IndexIntegrityReport, MissingIndexEntry, OrphanedIndexEntry } from '../dist/index.js';

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

/** Assert that `fn` rejects and return the thrown error's message. */
export async function captureThrowMessage(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected operation to throw, but it resolved');
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
 * Run `body` and return how many secondary-index reads (`executeIndexScan` invocations) it made,
 * across every Database sharing the vtab prototype — for a spec that must show a statement's row
 * source went THROUGH an index, or did not, rather than trusting the planner's choice.
 */
export async function countIndexScans(body: () => Promise<unknown>): Promise<number> {
	const probe = installIndexRoutingProbe();
	try {
		await body();
		return probe.indexScans;
	} finally {
		probe.restore();
	}
}

/**
 * The agreement report for every secondary index `table` maintains, WITHOUT asserting — for a
 * test that pins an exact discrepancy rather than requiring none. Goes through the registered
 * module's `verifyIndexes`, so the tree-key format stays owned by the plugin, and a table
 * hydrated but not yet touched by any statement is initialized the way a statement would.
 */
export async function readIndexIntegrity(db: Database, table: string): Promise<IndexIntegrityReport[]> {
	const module = db.schemaManager.getModule('optimystic')?.module;
	if (!(module instanceof OptimysticModule)) {
		throw new Error(
			`readIndexIntegrity: ${module === undefined ? 'no module' : 'a module other than OptimysticModule'} ` +
			`is registered as 'optimystic' on this database`,
		);
	}
	return await module.verifyIndexes(db, table);
}

/** Decoded key payloads, e.g. `["tok-a"]`, or `[null,"5.000000000000000e+0"]` for NULL and 5. */
function renderPayloads(payloads: readonly (string | null)[]): string {
	return JSON.stringify(payloads);
}

function renderRow(row: Row): string {
	return `[${row.map(value => canonicalValue(value)).join(', ')}]`;
}

function describeOrphan(orphan: OrphanedIndexEntry): string {
	const detail = orphan.reason === 'stale-value' && orphan.currentRow !== undefined
		? `, row now ${renderRow(orphan.currentRow)}`
		: orphan.reason === 'malformed'
			? `, but stores primary key ${JSON.stringify(orphan.primaryKey)}`
			: '';
	return `    orphaned (${orphan.reason}): value ${renderPayloads(orphan.indexPayloads)} ` +
		`pk ${renderPayloads(orphan.primaryKeyPayloads)}${detail}`;
}

function describeMissing(entry: MissingIndexEntry): string {
	return `    missing: value ${renderPayloads(entry.indexPayloads)} pk ${renderPayloads(entry.primaryKeyPayloads)}, ` +
		`row ${renderRow(entry.row)}`;
}

function describeReport(report: IndexIntegrityReport): string {
	return [
		`  ${report.index} (${report.kind}): ${report.rowCount} rows, ${report.entryCount} entries`,
		...report.orphaned.map(describeOrphan),
		...report.missing.map(describeMissing),
	].join('\n');
}

/**
 * Assert that every secondary index `table` maintains (declared indexes, and the internal
 * trees enforcing a `unique` column with no declared index) corresponds one-to-one with the
 * table's rows: no row lacks its entry, and no entry is left pointing at a row that is gone or
 * at a value its row no longer holds. The failure names each discrepancy by index, kind,
 * reason, decoded value and primary key — plus the row's current values for a `stale-value`
 * orphan — and gives each index's row and entry counts.
 *
 * This is the half of index agreement no lookup of the table's own values can check: a lookup
 * skips an entry whose row is gone, and an entry left under a value its row no longer holds is
 * reached only by seeking that old value, which no row holds. (Seeking it does return the moved
 * row today: see the NOTE in `OptimysticVirtualTable.executeIndexScan`.)
 */
export async function expectIndexesIntact(db: Database, table: string): Promise<void> {
	const broken = (await readIndexIntegrity(db, table))
		.filter(report => report.missing.length > 0 || report.orphaned.length > 0);
	if (broken.length === 0) return;
	expect.fail(
		`${table}: index entries must correspond one-to-one with rows\n${broken.map(describeReport).join('\n')}`,
	);
}

/**
 * Assert that `table`'s secondary indexes agree with the table in both directions, and that
 * an index-routed lookup on `column` returns exactly what a full scan returns, for EVERY
 * distinct value present in `column`.
 *
 * Two arms, the structural one first:
 *
 *  - Structure ({@link expectIndexesIntact}), over EVERY index the table maintains, not only
 *    `column`'s: each row has exactly its entry, and each entry belongs to exactly one row.
 *    This is the only arm that sees an orphaned entry, such as one left by an UPDATE or DELETE
 *    whose index maintenance was lost, or by a concurrent write whose index change replayed
 *    without its row change. No lookup below can: `executeIndexScan` skips an entry whose row
 *    is gone, and the value a moved row left behind is one no row holds, so it is never
 *    looked up. It runs before the scan's early return, because a table emptied by DELETEs is
 *    exactly where an entry with no row lives.
 *  - Lookups ({@link expectLookupsAgreeWithScan}): the read path's view of "an index tree that
 *    does not account for every committed row" (writes staged past a detached index, a
 *    re-attach that never backfilled). The row is
 *    committed and a full scan sees it, while the seek the planner routes into the index
 *    silently misses it. Any interleaving of table declaration, index declaration and writes
 *    must leave the two agreeing.
 *
 * All three checks (structure, routing, and the row-set comparison) are pinned against a
 * deliberately broken index in `query-helpers.spec.ts`, so a refactor here cannot quietly turn
 * every caller into a no-op. `index-integrity-check.spec.ts` pins the structural check's
 * report itself.
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
	await expectIndexesIntact(db, table);
	await expectLookupsAgreeWithScan(db, table, column);
}

/**
 * The lookup arm of {@link expectIndexAgreesWithScan} alone: an index-routed lookup on `column`
 * returns exactly the full scan's rows for every distinct value the table holds. For a test that
 * pins a known orphan with `readIndexIntegrity`, and so cannot pass the structural arm.
 */
export async function expectLookupsAgreeWithScan(db: Database, table: string, column: string): Promise<void> {
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
