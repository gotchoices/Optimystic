import type { QualifiedName, ScopeValue, SqlValue, TableWatch, TableWrite, UpsertClause, WatchScope } from '@quereus/quereus';
import type { CollectionId } from '@optimystic/db-core';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { EntryFacts, UncheckedDecision } from './commit-outlook.js';

/**
 * Everything that reads a Quereus write description (`TableWrite`, the object `UpdateArgs.writeScope`
 * carries once a table sets `wantWriteScope`; the contract is
 * `@quereus/quereus/src/planner/analysis/write-scope.ts`, documented in the sibling checkout's
 * docs/write-scope.md) on the vtab's behalf: the facts it turns the description into, and which guard
 * variant a statement admits ({@link insertAcceptsEqualRow}, {@link rewriteAcceptsEqualRow}). Pure: no
 * table, bridge or queue state, so the rules are unit-tested over prepared statements alone
 * (test/write-description.spec.ts). The plugin trusts the description's labels and does no provenance
 * reasoning of its own: a `fresh` column is fresh, anything else is not; a read is what the description
 * lists, with the scope it gives it; a statement is self-independent when it says so.
 */

/** One row a `rows`-scoped read pinned: the unique key it was pinned by, lowercased as Quereus names
 *  columns, and the bound values in `key` order. */
export type PinnedRow = { readonly key: readonly string[]; readonly values: readonly SqlValue[] };

/**
 * One decision a described statement made against rows other than the target row its guard protects
 * (docs/offline-sync.md §Unchecked decisions): the three fields of `UncheckedDecision`, with the table
 * as Quereus names it (lowercased `schema.table`) and, for a `row`-scoped read, the rows it pinned —
 * what the dependency rule matches against earlier entries' writes (`outlookFrom` in commit-outlook.ts).
 */
export type UncheckedRead = {
	readonly table: QualifiedName;
	readonly kind: UncheckedDecision['kind'];
	readonly scope: UncheckedDecision['scope'];
	/** For scope `'row'`, the rows the read pinned — none for a read restored from the journal
	 * ({@link encodeFacts}), which the judgement then matches by its table; empty for the other scopes. */
	readonly rows: readonly PinnedRow[];
};

/**
 * What the vtab records about a transaction as it stages, from the write descriptions of its
 * statements:
 *
 * - `fresh`: a staged element whose value came from a fresh source — the primary key of a main-tree
 *   entry, the unique value of a unique-index entry (docs/offline-sync.md §Judging each guard);
 * - `statement`: one described statement's decisions against other rows ({@link uncheckedOf}),
 *   recorded once per statement;
 * - `undescribed`: a write the engine handed no description for (an FK cascade child write), after
 *   which the transaction's decisions cannot be listed in full.
 */
export type WriteFact =
	| { readonly kind: 'fresh'; readonly collectionId: CollectionId; readonly key: string }
	| { readonly kind: 'statement'; readonly unchecked: readonly UncheckedRead[] }
	| { readonly kind: 'undescribed' };

/**
 * The facts a transaction has recorded so far, as `TransactionState.writeFacts` keeps them: the records
 * in staging order, at each open savepoint's creation the record count (`marks`, keyed by the depth
 * Quereus broadcasts) so a rollback to it discards the records of the statements it discards, and the
 * descriptions whose statement record is already taken (`described`): the engine hands one `TableWrite`
 * object per execution, shared by every row's `update()`, so the object is what identifies the statement.
 */
export type TransactionWriteFacts = { records: WriteFact[]; marks: Map<number, number>; described: WeakSet<TableWrite> };

/** The facts of a transaction that has recorded none: what every transaction state starts with. */
export function emptyWriteFacts(): TransactionWriteFacts {
	return { records: [], marks: new Map(), described: new WeakSet() };
}

/** One entry a row's write stages in a UNIQUE-enforcing index tree, as {@link freshElementsOf} needs it. */
export type UniqueEntryOf = {
	readonly collectionId: CollectionId;
	/** The tree key the entry is staged under (`indexEntryKey` in schema/index-manager.ts). */
	readonly key: string;
	/** The constraint's column names. */
	readonly columns: readonly string[];
};

/** The elements one `update()` arm stages for a row, as {@link freshElementsOf} needs them. */
export type StagedRowOf = {
	readonly mainCollectionId: CollectionId;
	/** The framed primary key the row is staged under. */
	readonly key: string;
	/** The primary-key column names, in any order. */
	readonly keyColumns: readonly string[];
	readonly uniqueEntries: readonly UniqueEntryOf[];
};

/**
 * The fresh elements one row's write stages, from the provenance of the columns the statement wrote
 * (docs/offline-sync.md §Judging each guard):
 *
 * - no description (a cascade child write), or a description of another operation than the arm
 *   staging the row — the upsert `DO UPDATE` arm receives the INSERT's — describes none of the row's
 *   values: nothing is fresh;
 * - a column is fresh when the description labels it `fresh`; a column the statement did not write
 *   (an UPDATE's unassigned columns) is not;
 * - the main-tree element is fresh when ANY primary-key column is fresh, the composite rule;
 * - a unique entry is fresh when any of its constraint's columns is.
 *
 * Column names are compared lowercased: Quereus lowercases `WrittenColumn.column`, the schema keeps
 * the declared spelling.
 */
export function freshElementsOf(write: TableWrite | undefined, arm: 'insert' | 'update', row: StagedRowOf): WriteFact[] {
	if (write === undefined || write.operation !== arm) return [];
	const fresh = freshColumnsOf(write);
	if (fresh.size === 0) return [];
	const facts: WriteFact[] = [];
	if (anyFresh(fresh, row.keyColumns)) facts.push({ kind: 'fresh', collectionId: row.mainCollectionId, key: row.key });
	for (const entry of row.uniqueEntries) {
		if (anyFresh(fresh, entry.columns)) facts.push({ kind: 'fresh', collectionId: entry.collectionId, key: entry.key });
	}
	return facts;
}

/** The lowercased names of the columns `write` labels `fresh`. */
function freshColumnsOf(write: TableWrite): Set<string> {
	const fresh = new Set<string>();
	for (const column of write.columns) {
		if (column.provenance.kind === 'fresh') fresh.add(column.column.toLowerCase());
	}
	return fresh;
}

function anyFresh(fresh: ReadonlySet<string>, columns: readonly string[]): boolean {
	return columns.some(column => fresh.has(column.toLowerCase()));
}

// ── the guard variant a described statement admits ───────────────────────────────────────────

/**
 * Whether an INSERT whose probe found the key clear may carry `absentOrEqual` in place of `absent`
 * (docs/offline-sync.md §Guards that make idempotent writes assured): a rival's equal row at the key is
 * then accepted as this write already made, where `absent` refuses it. True exactly when the statement
 * said a present row is not an error — its disposition is `ignore` (`insert or ignore`), `replace`
 * (`insert or replace`), or an upsert with a `do nothing` clause on the primary key: `on conflict do
 * nothing`, which Quereus describes with the target `'primary-key'`, or `on conflict (<the key columns>)
 * do nothing`, the columns compared lowercased as a set. A plain `insert` keeps `absent`: SQL says a
 * duplicate is an error, and an application may rely on that to learn that someone else got there
 * first. A clause on another unique column does not excuse a present row at the primary key, and a `do
 * update` clause is not a `do nothing`. As for {@link freshElementsOf}, no description (a cascade child
 * write) or one of another operation says nothing about the row.
 */
export function insertAcceptsEqualRow(write: TableWrite | undefined, keyColumns: readonly string[]): boolean {
	if (write === undefined || write.operation !== 'insert') return false;
	const disposition = write.disposition;
	switch (disposition.kind) {
		case 'ignore':
		case 'replace':
			return true;
		case 'upsert':
			return disposition.clauses.some(clause => clause.action === 'nothing' && targetsPrimaryKey(clause.target, keyColumns));
		default:
			return false;
	}
}

/** Whether an upsert clause's conflict target is the primary key: named as such, or exactly its columns. */
function targetsPrimaryKey(target: UpsertClause['target'], keyColumns: readonly string[]): boolean {
	if (target === 'primary-key') return true;
	const key = new Set(keyColumns.map(column => column.toLowerCase()));
	const named = new Set(target.map(column => column.toLowerCase()));
	return named.size === key.size && [...named].every(column => key.has(column));
}

/**
 * Whether a rewrite of an existing row — a same-key UPDATE (`arm` `'update'`), or an INSERT OR REPLACE
 * over an occupied key (`arm` `'insert'`) — may carry `unchangedOrEqual` in place of `unchanged`
 * (docs/offline-sync.md §Guards that make idempotent writes assured): a rival that already wrote
 * exactly this row is then accepted as this write already made, where `unchanged` refuses every
 * change. Sound only for a self-independent statement (`TableWrite.selfIndependent`: no written value
 * depends on the row's previous values or on other rows), since then applying the statement to its own
 * result changes nothing and "rival, then us" is the row we hold; `set n = n + 1` keeps `unchanged`,
 * because a rival's identical increment followed by ours would not. As for {@link freshElementsOf}, no
 * description, or one of another operation than the arm (the upsert `DO UPDATE` arm receives the
 * INSERT's), describes nothing about the row and keeps `unchanged`.
 */
export function rewriteAcceptsEqualRow(write: TableWrite | undefined, arm: 'insert' | 'update'): boolean {
	return write !== undefined && write.operation === arm && write.selfIndependent;
}

// ── the decisions a statement made against other rows ────────────────────────────────────────

/**
 * The decisions one described statement made against rows other than the target row its guard
 * protects (docs/offline-sync.md §Unchecked decisions), from the description's selection, constraints
 * and reads — nothing re-checks them when the entry is submitted, so an earlier entry's failure or a
 * rival's write can leave the decision resting on rows that are gone:
 *
 * - an UPDATE or DELETE whose rows were chosen by anything but a key equality (`selection.kind ===
 *   'global'`) is a `row-selection` on the target, `global`: a rival's new matching row is not touched;
 * - each `foreign-key-child` constraint is a `foreign-key` on the parent it references, with the scope
 *   of the read watch on that table when one is listed (Quereus lists the parent probe as a whole-table
 *   watch today) and `global` otherwise; that watch is consumed, since the description does not label a
 *   read by what it served;
 * - each `foreign-key-parent` constraint (a DELETE, or an UPDATE of a referenced column) is a
 *   `foreign-key` on the child it references, `global`;
 * - each `assertion` constraint is an `assertion` on the table it references (the target when it names
 *   none), `global`;
 * - each cross-row `check` constraint is a `check` on the WRITTEN table, `global` — the description does
 *   not say which read is the CHECK's, so its subquery's watch stays listed as a `read` beside it: one
 *   decision too many rather than one too few;
 * - every other read watch is a `read` on the watch's table with its binding mode mapped to the three
 *   scopes (`full` → `global`; `rows` → `row`, with the pinned rows; `groups` and `rowsByGroup` →
 *   `group`) — except a watch on the target table no wider than the selection, which is the target row
 *   itself: a `rows` watch pinned to the selection's rows under a `rows` selection (the guard covers
 *   the row), and any watch under a `global` selection (the `row-selection` decision covers it). A
 *   target watch wider than a `rows` selection (`set x = (select max(x) from t) where id = ?`), and
 *   every target watch under an INSERT's `none` selection, is a `read`;
 * - `primary-key`, `unique`, `not-null` and a row-local `check` add nothing: the first two are guards,
 *   the rest are decided from the row alone.
 *
 * A pinned row still holding a parameter placeholder (an unbound description, which the hook never
 * hands the vtab) widens its read to `global`, as does a `rows` watch with no tuples. Deduped by
 * (table, kind, scope), merging the pinned rows.
 */
export function uncheckedOf(write: TableWrite): UncheckedRead[] {
	const target = write.table;
	const decisions: UncheckedRead[] = [];
	const consumed = new Set<TableWatch>();
	if (write.operation !== 'insert' && write.selection.kind === 'global') {
		decisions.push(decisionOn(target, 'row-selection', 'global'));
	}
	for (const constraint of write.constraints) {
		switch (constraint.kind) {
			case 'foreign-key-child': {
				const parent = constraint.references ?? target;
				const watch = parentWatch(write.reads, consumed, parent);
				if (watch !== undefined) consumed.add(watch);
				decisions.push(watch === undefined ? decisionOn(parent, 'foreign-key', 'global') : readDecision(watch, 'foreign-key'));
				break;
			}
			case 'foreign-key-parent':
				decisions.push(decisionOn(constraint.references ?? target, 'foreign-key', 'global'));
				break;
			case 'assertion':
				decisions.push(decisionOn(constraint.references ?? target, 'assertion', 'global'));
				break;
			case 'check':
				if (constraint.locality === 'cross-row') decisions.push(decisionOn(target, 'check', 'global'));
				break;
			default:
				break;
		}
	}
	for (const watch of write.reads) {
		if (consumed.has(watch) || coveredByTarget(watch, write)) continue;
		decisions.push(readDecision(watch, 'read'));
	}
	return dedupeReads(decisions);
}

function decisionOn(table: QualifiedName, kind: UncheckedRead['kind'], scope: 'group' | 'global'): UncheckedRead {
	return { table, kind, scope, rows: [] };
}

/** The watch a foreign key's parent probe left on `parent`, not yet taken by another constraint: the
 *  whole-table one when there is one, since that is how Quereus lists the probe today, so a subquery
 *  of the statement pinned to a parent row keeps its own `read`; else any watch on the table. */
function parentWatch(reads: ReadonlyArray<TableWatch>, consumed: ReadonlySet<TableWatch>, parent: QualifiedName): TableWatch | undefined {
	const candidates = reads.filter(read => !consumed.has(read) && sameTable(read.table, parent));
	return candidates.find(read => read.scope.kind === 'full') ?? candidates[0];
}

/** A watch as a decision of `kind` on its table, scoped by its binding mode. */
function readDecision(watch: TableWatch, kind: UncheckedRead['kind']): UncheckedRead {
	const scope = watch.scope;
	switch (scope.kind) {
		case 'full':
			return decisionOn(watch.table, kind, 'global');
		case 'groups':
		case 'rowsByGroup':
			return decisionOn(watch.table, kind, 'group');
		case 'rows': {
			const rows = pinnedRows(scope);
			return rows === undefined ? decisionOn(watch.table, kind, 'global') : { table: watch.table, kind, scope: 'row', rows };
		}
	}
}

/** The rows a `rows` scope pins, or `undefined` when it pins none, or one through an unbound parameter. */
function pinnedRows(scope: Extract<WatchScope, { kind: 'rows' }>): PinnedRow[] | undefined {
	if (scope.values.length === 0) return undefined;
	const rows: PinnedRow[] = [];
	for (const tuple of scope.values) {
		if (tuple.some(isParamPlaceholder)) return undefined;
		rows.push({ key: scope.key, values: tuple as readonly SqlValue[] });
	}
	return rows;
}

/** Whether `watch`, on the written table, is the target row the statement's own guard protects. */
function coveredByTarget(watch: TableWatch, write: TableWrite): boolean {
	if (!sameTable(watch.table, write.table)) return false;
	const selection = write.selection;
	switch (selection.kind) {
		case 'none':
			return false;
		case 'global':
			return true;
		case 'rows':
			return watch.scope.kind === 'rows' && withinSelection(watch.scope, selection);
	}
}

/** Whether a `rows` watch pins no row the `rows` selection does not: the same key, every tuple among the selection's. */
function withinSelection(scope: Extract<WatchScope, { kind: 'rows' }>, selection: { readonly key: readonly string[]; readonly values: ReadonlyArray<ReadonlyArray<ScopeValue>> }): boolean {
	if (scope.key.length !== selection.key.length || !scope.key.every((column, i) => column === selection.key[i])) return false;
	const selected = new Set(selection.values.map(renderTuple));
	return scope.values.every(tuple => selected.has(renderTuple(tuple)));
}

function sameTable(a: QualifiedName, b: QualifiedName): boolean {
	return a.schema === b.schema && a.table === b.table;
}

function isParamPlaceholder(value: ScopeValue): boolean {
	return value !== null && typeof value === 'object' && !(value instanceof Uint8Array) && (value as { kind?: unknown }).kind === 'param';
}

/** `reads` with one decision per (table, kind, scope), in order of first appearance, the pinned rows merged. */
function dedupeReads(reads: readonly UncheckedRead[]): UncheckedRead[] {
	const merged = new Map<string, { readonly read: UncheckedRead; readonly rows: PinnedRow[]; readonly seen: Set<string> }>();
	for (const read of reads) {
		const key = `${read.table.schema}.${read.table.table}\0${read.kind}\0${read.scope}`;
		let entry = merged.get(key);
		if (entry === undefined) {
			entry = { read, rows: [], seen: new Set() };
			merged.set(key, entry);
		}
		for (const row of read.rows) {
			const rendered = `${row.key.join(',')}\0${renderTuple(row.values)}`;
			if (entry.seen.has(rendered)) continue;
			entry.seen.add(rendered);
			entry.rows.push(row);
		}
	}
	return [...merged.values()].map(({ read, rows }) => ({ table: read.table, kind: read.kind, scope: read.scope, rows }));
}

/** A tuple as one string, for equality: a bigint by its digits, bytes by hex, a placeholder by its index. */
function renderTuple(values: ReadonlyArray<ScopeValue>): string {
	return JSON.stringify(values, (_field, value: unknown) => {
		if (typeof value === 'bigint') return `${value}n`;
		if (value instanceof Uint8Array) return `0x${uint8ArrayToString(value, 'base16')}`;
		return value;
	});
}

// ── folding a transaction's records ──────────────────────────────────────────────────────────

/**
 * The facts a transaction's records amount to. The fresh elements are merged by `(collectionId, key)`:
 * a key written twice in one transaction is fresh if either write produced it fresh, since freshness is
 * a property of where the value came from, and a value minted fresh inside this uncommitted transaction
 * cannot be known to another machine however later statements refer to it. The decisions are the
 * statements' lists concatenated in statement order and deduped as one statement's are. The facts are
 * `complete` unless a write went undescribed. A rolled-back statement's records are gone before this
 * runs (`TransactionBridge.rollbackToSavepoint`), so this never credits a key a surviving statement
 * supplied from a parameter, nor lists a decision a surviving statement did not make.
 */
export function foldWriteFacts(records: readonly WriteFact[]): EntryFacts {
	const fresh = new Map<CollectionId, Set<string>>();
	const unchecked: UncheckedRead[] = [];
	let complete = true;
	for (const record of records) {
		switch (record.kind) {
			case 'fresh': {
				let keys = fresh.get(record.collectionId);
				if (keys === undefined) {
					keys = new Set();
					fresh.set(record.collectionId, keys);
				}
				keys.add(record.key);
				break;
			}
			case 'statement':
				unchecked.push(...record.unchecked);
				break;
			case 'undescribed':
				complete = false;
				break;
		}
	}
	return { fresh, unchecked: dedupeReads(unchecked), complete };
}

// ── the facts across a restart ───────────────────────────────────────────────────────────────

/**
 * An entry's facts as its journal entry record carries them (`EntryRecordV1.outlook` in
 * offline-journal.ts; docs/offline-sync.md §What is journaled): JSON-safe, so the restore after a
 * restart hands the controller what the statements' write descriptions said, and the restored
 * transaction is judged as it was before.
 */
export type JournaledFacts = {
	/** `EntryFacts.fresh` as pairs: each collection with the keys of its fresh elements. */
	readonly fresh: readonly (readonly [CollectionId, readonly string[]])[];
	/** `EntryFacts.unchecked`, each read without its pinned rows ({@link encodeFacts}). */
	readonly unchecked: readonly Omit<UncheckedRead, 'rows'>[];
	readonly complete: boolean;
};

/**
 * `facts` as the entry record journals them ({@link JournaledFacts}).
 *
 * NOTE: a `row` read's pinned rows are not journaled — a bound value can be a bigint or bytes, which
 * the journal's `JSON.stringify` cannot carry — so a restored read is matched by its table, as a
 * `group` read is, and keeps its reported scope: a restored outlook can list a dependency the original
 * did not, never miss one, and only until that earlier entry settles. If restored outlooks ever list
 * dependencies an application cannot act on, journal the encoded main-tree keys instead (the controller
 * can encode them at enqueue, since every published table hands it its key codec).
 */
export function encodeFacts(facts: EntryFacts): JournaledFacts {
	return {
		fresh: [...facts.fresh].map(([collectionId, keys]) => [collectionId, [...keys]]),
		unchecked: facts.unchecked.map(({ table, kind, scope }) => ({ table: { schema: table.schema, table: table.table }, kind, scope })),
		complete: facts.complete,
	};
}

/** The facts an entry record's `outlook` carries, each read with no pinned rows ({@link encodeFacts}). */
export function decodeFacts(journaled: JournaledFacts): EntryFacts {
	return {
		fresh: new Map(journaled.fresh.map(([collectionId, keys]) => [collectionId, new Set(keys)])),
		unchecked: journaled.unchecked.map(read => ({ ...read, rows: [] })),
		complete: journaled.complete,
	};
}
