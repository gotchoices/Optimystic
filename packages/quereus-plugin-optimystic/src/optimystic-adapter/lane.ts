import type { SqlValue, TableSchema, TableWrite } from '@quereus/quereus';
import { stricterLane } from '@optimystic/db-core';
import type { Lane } from '@optimystic/db-core';
import { contentKeyed, freshTagged, MERGE_TAG, PROFILE_TAG, type Tagged } from '../schema/declared-tags.js';
import { anyFresh, freshColumnsOf, type WriteFact } from './write-description.js';

/**
 * Which lane a SQL statement's write takes (`Lane` in `packages/db-core/src/lane/lane.ts`;
 * docs/transactions.md §Which lane a transaction takes): `serializable`, the cohort must agree
 * before the write commits and the revision order decides every conflict, or `convergent`, one
 * machine may commit it alone and merge it into other machines' concurrent writes later. Pure over
 * Quereus's write description (`TableWrite`, the object `UpdateArgs.writeScope` carries; the
 * contract is `@quereus/quereus/src/planner/analysis/write-scope.ts`) and the table's `TableSchema`,
 * reusing write-description.ts's reading of the description rather than making a second one, so the
 * rule is unit-tested over prepared statements alone (test/lane.spec.ts).
 *
 * The rule has TWO layers, because the two parties that compute it see different inputs. A member
 * re-executes statements rebuilt from evaluated row values (`TransactionBridge.addStatement`'s
 * `NOTE:`), so a key the writer computed with `StampId()` reaches it as a literal and `set n = n + 1`
 * as `set n = <value>`: provenance and read-dependence are the writer's alone. What every machine
 * with the same schema hash computes identically is the CEILING ({@link laneCeilingOf}) — the
 * table's profile, the constraints the write is subject to, the merge tags of the assigned columns,
 * the operation and the selection's shape — and the writer's lane ({@link laneOf}) is the ceiling
 * narrowed by what only it can see. A member checks a `convergent` claim against the ceiling and
 * never reclassifies (the next ticket); it cannot catch a writer that lies about freshness or a
 * read, which is the replay stage's guards' business at merge time.
 *
 * The declarations are two tags, read from the vtab's `tableSchema` as `optimystic.content_key` and
 * `optimystic.fresh` are read ({@link profileOf}, {@link mergeOf}), and already part of the schema
 * hash — see `declared-tags.ts` — so two machines whose declarations differ fail the validator's
 * schema check before any lane is compared.
 *
 * On idempotence, the mistake a reader makes first (the plan's note): SETTING a column to a value is
 * idempotent and still needs the tie-break the merge tag declares, since two machines setting it to
 * different values must agree on one; an INCREMENT is not idempotent and would merge fine, and is
 * `serializable` here only because clause (b) of {@link laneOf} cannot see that the read `n + 1`
 * depends on is one a counter merge absorbs. NOTE: a `'counter'` merge kind, under which an
 * assignment of the form `n = n + <literal>` would classify convergent, is the natural second arm of
 * {@link mergeOf}; add it when a replay-mode application needs counters to merge.
 */

/** What a table declares about its writes (`optimystic.profile`): `strong`, the default, every write
 * serializable whatever the statement looks like — the application's ceiling — or `replay-permitted`,
 * a write may be convergent when the statement allows it. */
export type TableProfile = 'strong' | 'replay-permitted';

/** How two machines' concurrent assignments of a column merge (`optimystic.merge`): by the later HLC
 * winning. The only kind this pass defines; the merge itself is evaluated by the replay stage, here it
 * only decides the lane. */
export type ColumnMerge = 'last-writer-wins';

type Tags = Readonly<Record<string, SqlValue>>;

/**
 * The profile `tags` declare, and whether the tag's value named one. An absent tag is `strong`, so
 * every table that declares nothing behaves exactly as before the tag existed; so is any value other
 * than `'strong'` and `'replay-permitted'`, which cannot be refused because Quereus applies a tag to
 * its own catalog before the module hears of it, and which the vtab logs once per table instead
 * (`optimystic:profile-tag-ignored`), fail safe.
 */
export function profileTag(tags: Tags | undefined): { profile: TableProfile; recognised: boolean } {
	const value = tags?.[PROFILE_TAG];
	if (value === 'replay-permitted') return { profile: 'replay-permitted', recognised: true };
	return { profile: 'strong', recognised: value === undefined || value === 'strong' };
}

/** The profile `table` declares ({@link profileTag}). */
export function profileOf(table: Tagged): TableProfile {
	return profileTag(table.tags).profile;
}

/**
 * The merge `tags` declare for a column, and whether the tag's value named one. An absent tag is no
 * merge: two machines' concurrent assignments of the column are the quorum's to order. So is any
 * value other than `'last-writer-wins'`, logged once per column by the vtab
 * (`optimystic:merge-tag-ignored`), fail safe.
 */
export function mergeTag(tags: Tags | undefined): { merge: ColumnMerge | undefined; recognised: boolean } {
	const value = tags?.[MERGE_TAG];
	if (value === 'last-writer-wins') return { merge: 'last-writer-wins', recognised: true };
	return { merge: undefined, recognised: value === undefined };
}

/** The merge `column` declares ({@link mergeTag}), or `undefined` for none. */
export function mergeOf(column: Tagged): ColumnMerge | undefined {
	return mergeTag(column.tags).merge;
}

/**
 * The lane the catalog and the statement's shape alone allow — the same on every machine with the
 * same schema hash, so a member can compute it from a rebuilt statement and its own catalog. It is
 * `serializable` when any of these holds, else `convergent`:
 *
 * - the table's profile is not `replay-permitted`: the profile is the application's ceiling;
 * - the write is subject to a constraint other rows can make pass or fail ({@link decidedAgainstOtherRows}):
 *   a `unique`, `foreign-key-child`, `foreign-key-parent` or `assertion` constraint, a `check` whose
 *   locality is `cross-row`, or `primary-key` on anything but an INSERT — an UPDATE that assigns a
 *   key column moves the row, and two machines moving rows onto one key must be ordered. An INSERT's
 *   key is judged by the writer-only clause of {@link laneOf}, since a fresh key cannot collide and
 *   a content key merges as the same write made twice. A `foreign-key-parent` entry is also how a
 *   cascade reaches the rule: the cascade's child writes carry no description of their own (an
 *   `undescribed` fact, serializable by itself), but the parent statement lists the constraint;
 * - the operation is an UPDATE whose rows were chosen by anything but a key equality
 *   (`selection.kind === 'global'`): which rows the statement touches is itself a read of other
 *   writers' state;
 * - the operation is a DELETE. NOTE: no tombstone merge is declared in this pass, so a delete of a
 *   row another machine concurrently updated is the quorum's to order; a `'tombstone'` arm of
 *   {@link mergeOf} is the first to add once a replay-mode application needs deletes to merge;
 * - the operation is an UPDATE and an assigned column is not tagged `optimystic.merge`
 *   (clause (c) of the plan: the collection defines a merge for the touched fields);
 * - the disposition is an upsert with a `do update` clause: the arm's assignments are a second write
 *   the rule would have to judge, and the arm receives the INSERT's description (write-description.ts),
 *   so the whole statement is judged conservative.
 *
 * NOTE: a transaction's lane is stamped on the main tree's entry and on each index tree's entry alike
 * (one `WriteContext` per transaction). A non-unique index entry is keyed `indexValue ‖ pk`, so a
 * fresh-keyed insert's index entry is new too; how an index tree's entries merge under
 * last-writer-wins is the replay stage's question, not this rule's.
 */
export function laneCeilingOf(write: TableWrite, table: TableSchema): Lane {
	if (profileOf(table) !== 'replay-permitted') return 'serializable';
	if (write.constraints.some(constraint => decidedAgainstOtherRows(constraint, write.operation))) return 'serializable';
	switch (write.operation) {
		case 'delete':
			return 'serializable';
		case 'update':
			if (write.selection.kind === 'global') return 'serializable';
			if (!write.columns.every(column => mergeOf(columnNamed(table, column.column) ?? {}) !== undefined)) return 'serializable';
			return 'convergent';
		case 'insert':
			return hasDoUpdateClause(write.disposition) ? 'serializable' : 'convergent';
	}
}

/**
 * The lane the writer takes: the ceiling ({@link laneCeilingOf}) narrowed by what only the writer
 * sees — clause (b) of the plan, the write must not depend on a read:
 *
 * - the description lists a read (`reads`), or the write is not self-independent (`set n = n + 1`
 *   reads `n`; a volatile `now()` is fine, it is a last-writer-wins value like any other);
 * - an INSERT's primary key may collide with another machine's unless the table is content-keyed
 *   (the same row from the same content, accepted under `absentOrEqual` as the same write made
 *   twice) or a key column is fresh — labelled `fresh` by the description, or tagged
 *   `optimystic.fresh`, the declared hint the outlook honours (docs/offline-sync.md §Declared
 *   hints). Any ONE fresh column makes the whole key unique, the composite rule `freshElementsOf`
 *   applies; an `input` or `literal` key is `serializable`. A false tag produces a convergent lane
 *   for a write that can collide, which the replay stage resolves by its guards: as the README says
 *   of the tag, it changes the prediction, every guard is still enforced.
 *
 * A write with no description (the vtab's `update()` called with no `writeScope`: a cascade child
 * write) is `serializable`, fail safe.
 */
export function laneOf(write: TableWrite | undefined, table: TableSchema): Lane {
	if (write === undefined) return 'serializable';
	if (laneCeilingOf(write, table) === 'serializable') return 'serializable';
	if (write.reads.length > 0 || !write.selfIndependent) return 'serializable';
	if (write.operation === 'insert' && !contentKeyed(table) && !insertKeyIsFresh(write, table)) return 'serializable';
	return 'convergent';
}

/**
 * The lane of a transaction from the facts its statements recorded (`WriteFact`): the stricter over
 * each described statement's `lane` record, and `serializable` outright when a write of the
 * transaction went undescribed (a cascade child write) or when no write was described, since a
 * write of no classified parts claims nothing. So a transaction spanning a `strong` table and a
 * `replay-permitted` one is `serializable`.
 */
export function transactionLaneOf(records: readonly WriteFact[]): Lane {
	const lanes: Lane[] = [];
	for (const record of records) {
		if (record.kind === 'undescribed') return 'serializable';
		if (record.kind === 'lane') lanes.push(record.lane);
	}
	return stricterLane(lanes);
}

/**
 * Whether a tag change moved anything the rule reads: the table's profile, or the merge of a column
 * (matched by name, as Quereus names columns). What the vtab asks on `table_modified`, to say when
 * entries queued for the table were classified under declarations the table no longer carries.
 */
export function laneDeclarationChanged(before: TableSchema, after: TableSchema): boolean {
	if (profileOf(before) !== profileOf(after)) return true;
	const merges = new Map(before.columns.map(column => [column.name.toLowerCase(), mergeOf(column)]));
	return after.columns.some(column => merges.get(column.name.toLowerCase()) !== mergeOf(column));
}

/** Whether `constraint` is one other rows can make pass or fail, for `operation` (see {@link laneCeilingOf}). */
function decidedAgainstOtherRows(constraint: TableWrite['constraints'][number], operation: TableWrite['operation']): boolean {
	switch (constraint.kind) {
		case 'unique':
		case 'foreign-key-child':
		case 'foreign-key-parent':
		case 'assertion':
			return true;
		case 'check':
			return constraint.locality === 'cross-row';
		case 'primary-key':
			return operation !== 'insert';
		case 'not-null':
			return false;
	}
}

function hasDoUpdateClause(disposition: TableWrite['disposition']): boolean {
	return disposition.kind === 'upsert' && disposition.clauses.some(clause => clause.action === 'update');
}

/** Whether any primary-key column of an INSERT carries a value no other machine can produce: labelled
 * `fresh` by the description, or tagged `optimystic.fresh`. The composite rule, as `freshElementsOf`
 * judges the main-tree element: one fresh column makes the whole key unique. */
function insertKeyIsFresh(write: TableWrite, table: TableSchema): boolean {
	const fresh = freshColumnsOf(write);
	const keyColumns = table.primaryKeyDefinition.map(pk => table.columns[pk.index]).filter(column => column !== undefined);
	for (const column of keyColumns) {
		if (freshTagged(column)) fresh.add(column.name.toLowerCase());
	}
	return anyFresh(fresh, keyColumns.map(column => column.name));
}

/** The table's column named `name`, compared lowercased: Quereus lowercases `WrittenColumn.column`,
 * the schema keeps the declared spelling. */
function columnNamed(table: TableSchema, name: string): TableSchema['columns'][number] | undefined {
	return table.columns.find(column => column.name.toLowerCase() === name);
}
