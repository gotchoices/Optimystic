/**
 * The tags an application puts on a table or a column to tell the plugin what its analyses cannot
 * see in the data (docs/offline-sync.md §Declared hints; README § Offline mode). Each is saved in the
 * catalog record like every tag (`SchemaManager.persistTags`), kept current on the vtab's own
 * `TableSchema` through `OptimysticVirtualTable.followSchemaTags`, and already part of the schema
 * hash: `QuereusEngine.computeSchemaHash` digests the `sql` column of Quereus's `schema()` function,
 * which `generateTableDDL` in `@quereus/quereus/src/schema/ddl-generator.ts` renders with every table
 * and column `with tags (…)` clause, so two machines whose declarations differ fail the validator's
 * schema check before any rule here is compared.
 *
 * One module for the five, rather than constants beside their first reader, because two readers
 * share them: the vtab (`optimystic-module.ts`) and the lane rule (`optimystic-adapter/lane.ts`),
 * which the vtab imports.
 */

import type { SqlValue } from '@quereus/quereus';

/** Anything Quereus hangs a `tags` record on: a table, a column, a constraint, an index. */
export interface Tagged {
	readonly tags?: Readonly<Record<string, SqlValue>>;
}

/** The column tag that declares the column's values generated unique per write by the application,
 * so an offline transaction's check on them cannot be refused by another writer, and an insert keyed
 * by them cannot collide with another machine's. */
export const FRESH_TAG = 'optimystic.fresh';

/** The table tag that declares only one machine writes the table's rows. */
export const SINGLE_WRITER_TAG = 'optimystic.single_writer';

/** The table tag that declares the table's primary key a deterministic function of the row's other
 * columns (a blob store keyed by content hash), so two machines inserting the same content insert the
 * same row and a plain `insert` of an equal row is the same write made twice. */
export const CONTENT_KEY_TAG = 'optimystic.content_key';

/** The table tag that declares the table's profile (`profileOf` in optimystic-adapter/lane.ts):
 * `'replay-permitted'`, whose writes may take the convergent lane when the statement allows it, or
 * `'strong'`, the default, where every write is serializable. */
export const PROFILE_TAG = 'optimystic.profile';

/** The column tag that declares how two machines' concurrent assignments of the column merge
 * (`mergeOf` in optimystic-adapter/lane.ts): `'last-writer-wins'`, the later HLC winning. */
export const MERGE_TAG = 'optimystic.merge';

/** Whether `column` is tagged fresh — read with `=== true`, the rule Quereus reads its own per-table
 * boolean opt-ins by (`quereus.sync.replicate`): any other value, a string `'true'` included, is off. */
export function freshTagged(column: Tagged | undefined): boolean {
	return column?.tags?.[FRESH_TAG] === true;
}

/** Whether `table` declares a single writer — read `=== true`, as {@link freshTagged} reads its tag. */
export function singleWriterTagged(table: Tagged): boolean {
	return table.tags?.[SINGLE_WRITER_TAG] === true;
}

/** Whether `table` declares its primary key a function of the row's content — read `=== true`, as
 * {@link freshTagged} reads its tag. */
export function contentKeyed(table: Tagged): boolean {
	return table.tags?.[CONTENT_KEY_TAG] === true;
}
