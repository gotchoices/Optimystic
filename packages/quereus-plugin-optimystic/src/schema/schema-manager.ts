/**
 * SchemaManager - Manages table schemas in Optimystic trees
 *
 * Stores and retrieves table schema definitions from distributed Optimystic trees. Every
 * table's record lives in one plugin-global catalog tree (`tree://optimystic/schema`), filed
 * under a key built from the table's engine schema AND its name ({@link catalogKey}), so
 * same-named tables in different schemas keep separate records.
 */

import type { Tree } from '@optimystic/db-core';
import type { TableSchema, ColumnSchema, VirtualTableModule, UniqueConstraintSchema, ConflictResolution, ForeignKeyConstraintSchema, SqlValue } from '@quereus/quereus';
import { buildColumnIndexMap, getTypeOrDefault, inferType } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { CatalogBatch, recordOfEntry, recordUriOf } from './catalog-batch.js';
import type { CatalogBatchCheckpoint, CatalogEntry } from './catalog-batch.js';
import { catalogKey, identityVtabArgs, namesOfCatalogKey, sessionBindingVtabArgs } from './table-identity.js';
import type { QualifiedTableName } from './table-identity.js';

// IndexSchema type from TableSchema.indexes
export type IndexSchema = NonNullable<TableSchema['indexes']>[number];
/** Quereus's CHECK / mutation-context / expression shapes, reached through `TableSchema` (not exported by name). */
type RowConstraintSchema = TableSchema['checkConstraints'][number];
type MutationContextDefinition = NonNullable<TableSchema['mutationContext']>[number];
type Expression = NonNullable<ColumnSchema['defaultValue']>;
type ForeignKeyAction = ForeignKeyConstraintSchema['onDelete'];

/**
 * Order-insensitive identity for a set of column POSITIONS — sorted and joined by `_`.
 * Uniqueness of `(a, b)` and `(b, a)` is the same rule, so constraint/index matching
 * compares sets. IN-MEMORY ONLY: every comparison is between two descriptors resolved
 * against the same {@link StoredTableSchema}, where positions mean one thing. It must
 * never name anything persistent — a position outlives nothing, but a tree URI or a
 * catalog record does, and a later `CREATE TABLE` can renumber the columns underneath
 * it. Persistent identity is by column NAME: {@link uniqueEnforcementTreeName} for the
 * synthesized enforcement trees, {@link PersistedIndexColumn} for the catalog.
 */
export function columnSetKey(columns: readonly number[]): string {
	return [...columns].sort((a, b) => a - b).join('_');
}

/**
 * Name of the vtab's synthesized UNIQUE-enforcement tree for a set of column NAMES —
 * the `<indexName>` in `<collectionUri>/index/<indexName>`, so it is persistent storage
 * identity and must stay stable across restarts AND across re-declares that reorder
 * the table's columns (which is why it is not built from positions).
 *
 * Names are lowercased and sorted so `(a, b)` and `(b, a)` name one tree, matching the
 * positional set semantics of {@link columnSetKey}. The join is length-prefixed
 * (`_uniq_3.bar_3.foo`) because SQL identifiers can contain `_`: a bare `_`-join would
 * make `(a_b, c)` and `(a, b_c)` collide on `_uniq_a_b_c`. Length prefixes keep it
 * injective while staying readable in a URI or a log line.
 *
 * Trees named by the retired positional scheme (`_uniq_1`, `_uniq_1_2`) are never read
 * again; they are left in storage as unreferenced collections, and the newly-named
 * tree is rebuilt from the table on first probe by the vtab's one-time backfill
 * (`ensureUniquePopulated`).
 */
export function uniqueEnforcementTreeName(columnNames: readonly string[]): string {
	const parts = columnNames.map(name => name.toLowerCase()).sort();
	return `_uniq_${parts.map(name => `${name.length}.${name}`).join('_')}`;
}

/** The subset of a UNIQUE constraint that {@link uniqueConstraintKey} identifies it by. */
interface ConstraintIdentity {
	columns: readonly number[];
	predicate?: unknown;
	derivedFromIndex?: string;
}

/**
 * Dedupe identity for a UNIQUE constraint.
 *
 * A FULL (non-partial) constraint is identified by its column set — two full
 * constraints over the same columns are the same rule and collapse to one. A
 * PARTIAL one binds only the rows its predicate admits, so it gets a separate
 * identity keyed on the index it came from: it must never stand in for a full
 * constraint over the same columns (that would silently drop enforcement), and
 * two partials over the same columns with different predicates are distinct.
 */
export function uniqueConstraintKey(uc: ConstraintIdentity): string {
	return uc.predicate === undefined
		? `cols:${columnSetKey(uc.columns)}`
		: `partial:${uc.derivedFromIndex ?? columnSetKey(uc.columns)}`;
}

/**
 * A table's schema as every consumer in this plugin sees it — the RESOLVED, in-memory
 * shape. Index columns are POSITIONS into `columns` (the row is a positional array and
 * every hot path indexes into it). Positions are valid only because this value is
 * produced by resolving a {@link PersistedTableSchema} against ITS OWN `columns` list
 * (or built straight from a Quereus `TableSchema`, whose columns and indexes come from
 * one declaration); it is never what gets written to the catalog — see
 * {@link PersistedTableSchema} for why.
 */
export interface StoredTableSchema {
	name: string;
	schemaName: string;
	columns: StoredColumnSchema[];
	primaryKeyDefinition: StoredPrimaryKeyColumn[];
	/**
	 * Declared action of a table-level `primary key (…) on conflict <action>`
	 * clause. OMITTED when the table declares none (never written as
	 * `undefined`/`null`), so a schema persisted before this field existed
	 * compares byte-equal against an action-free candidate and `schemasEqual`
	 * keeps its no-write short-circuit — same discipline as `uniqueConstraints`.
	 */
	primaryKeyDefaultConflict?: ConflictResolution;
	indexes: StoredIndexSchema[];
	vtabModuleName: string;
	/**
	 * The table's `using optimystic(…)` arguments MINUS the session-binding ones
	 * ({@link identityVtabArgs}): the collection URI (`'0'`) and anything else that
	 * describes the table rather than the process reaching it. OMITTED when nothing is
	 * left. Hydrate overlays the current session's binding on top of these.
	 */
	vtabArgs?: Record<string, SqlValue>;
	/**
	 * CHECK constraints as declared, named as Quereus minted them (`_check_<col>` for an
	 * unnamed column CHECK). Like every table-level field below: OMITTED when the table has
	 * none, so a table without the feature persists the same bytes as before the field
	 * existed; rewritten from the local declaration on every write, next to the column
	 * list it was computed against.
	 */
	checkConstraints?: StoredCheckConstraint[];
	/** FOREIGN KEY constraints as declared; `columns` are positions into `columns`. */
	foreignKeys?: StoredForeignKey[];
	/** `with context (…)` variables. */
	mutationContext?: StoredMutationContextVar[];
	/** Table-level `with tags (…)`. */
	tags?: Record<string, SqlValue>;
	/** `TableSchema.synthesizedPrimaryKey`: the key is the all-columns fallback, not a declared one. */
	synthesizedPrimaryKey?: boolean;
	/**
	 * `TableSchema.generatedColumnDependencies` as `[generated column, columns its
	 * expression reads]` entries in ascending column order, and
	 * `TableSchema.generatedColumnTopoOrder`, both exactly as Quereus computed them at
	 * CREATE time. Persisted rather than recomputed on hydrate: the INSERT / UPDATE
	 * planners iterate the topo order to compute generated columns AT ALL (a hydrated
	 * table without it stores nothing in a generated column), and Quereus does not
	 * export the dependency analysis. Positional, so {@link assertPositionsInRange}
	 * checks them on every read and write.
	 */
	generatedColumnDependencies?: [number, number[]][];
	generatedColumnTopoOrder?: number[];
	/**
	 * Catalog row count slot in our stored format. **Nothing populates it and nothing reads it
	 * back into a live schema** — it is retained only so a schema persisted by an older build
	 * still parses.
	 *
	 * It has always been inert in practice. Quereus never set `TableSchema.estimatedRows` for a
	 * plain virtual table (only its materialized-view helpers did), so the value this used to
	 * copy was `undefined` on every real table, and `undefined` keys vanish under JSON — no
	 * persisted optimystic schema carries one.
	 *
	 * NOTE: quereus 4.19 moved the in-memory row count onto `TableSchema.statistics`, which
	 * `ANALYZE` DOES populate — so mapping this field to and from `statistics` would, for the
	 * first time, make the slot live. That is deliberately NOT done here. It would silently
	 * deliver the first bullet of `tickets/backlog/feat-optimystic-persisted-planner-statistics`
	 * — a persisted row count surviving restart — while skipping the two questions that ticket
	 * defers the feature over: when statistics refresh, and what happens when several nodes
	 * compute and persist statistics for the same collection. It would also make `ANALYZE`
	 * dirty the stored schema, so the next table initialization takes the write branch in
	 * `OptimysticModule` (`schemasEqual` fails) and commits a schema rewrite — a write caused by
	 * what a user reasonably reads as a statistics-only command. Wire this up in that ticket,
	 * with those answers, not as a side effect of a type migration.
	 *
	 * In-session `ANALYZE` is unaffected either way: quereus keeps the statistics on its own
	 * catalog schema and hands the count to `getBestAccessPlan` through
	 * `BestAccessPlanRequest.estimatedRows`, which needs nothing from us.
	 */
	estimatedRows?: number;
	/**
	 * Non-derived UNIQUE constraints (column-level `unique` / table-level
	 * `unique (…)`). Constraints derived from a `CREATE UNIQUE INDEX`
	 * (`derivedFromIndex` set) are NOT stored here — they are reconstructed from
	 * the owning index's `unique` flag so the index stays the single source of
	 * truth. OMITTED (not `[]`) when the table has none, so a schema persisted
	 * before this field existed compares byte-equal against a constraint-free
	 * candidate and `schemasEqual` keeps its short-circuit without a rewrite.
	 */
	uniqueConstraints?: StoredUniqueConstraint[];
	/**
	 * Descriptions of index TREES that may still exist in storage at
	 * `<collectionUri>/index/<name>` but are NOT part of this table's schema — carried
	 * forward from the gravestone (or URI-sharing record) that described the storage
	 * this declaration adopted (see the guard in `doInitialize`). Read ONLY by the
	 * `addIndex` guard, which refuses to adopt a leftover tree under a contradicting
	 * column list; never merged into `indexes`, never maintained, never planned against.
	 *
	 * Stays NAME-keyed even in this resolved shape (unlike `indexes`): these
	 * descriptors reference the DROPPED table's column list, which may name columns
	 * absent from the live one, so resolving them to positions is exactly the drift
	 * this file's two-shape split exists to prevent. OMITTED when empty.
	 */
	orphanedIndexes?: PersistedIndexSchema[];
}

/**
 * NOTE: a deliberate subset of Quereus's `UniqueConstraintSchema` — the fields that
 * drive enforcement, plus the declared `tags`. `coveringStructureName` and
 * `exposedIndexTags` are NOT persisted; they describe covering materialized views and
 * exposed implicit indexes, which optimystic-backed tables do not use. If a covering
 * MV or an exposed implicit index is ever pointed at an optimystic table, they must
 * be persisted too — otherwise hydrate silently drops the link.
 */
export interface StoredUniqueConstraint {
	name?: string;
	/** Column indices in declared order (order matters for the synthesized tree's key). */
	columns: number[];
	defaultConflict?: ConflictResolution;
	/** Partial-constraint predicate AST ({@link persistExpression}; presence excludes it from point enforcement). */
	predicate?: unknown;
	/** Constraint `with tags (…)`; OMITTED when none. */
	tags?: Record<string, SqlValue>;
}

export interface StoredColumnSchema {
	name: string;
	/**
	 * The canonical logical type name (`INTEGER`, `TEXT`, …) the column's rows are stored
	 * under — `logicalType.name`. What the storage-adoption guard and the row codec key on.
	 */
	affinity: string;
	/**
	 * The type spelling the declaration used (`int`, `varchar(20)`, `timestamp`), verbatim
	 * — `ColumnSchema.declaredType`. Restored on hydrate so the rebuilt column carries
	 * what the DDL-created one carries (the logical type is re-inferred from it, exactly as
	 * CREATE TABLE does); `affinity` is what that inference flattens it to. OMITTED when the
	 * declaration named no type.
	 */
	declaredType?: string;
	notNull: boolean;
	primaryKey: boolean;
	pkOrder: number;
	/** DEFAULT expression AST ({@link persistExpression}). OMITTED when none. */
	defaultValue?: unknown;
	collation: string;
	/** Present (true) only for a user-written `COLLATE` clause — `ColumnSchema.collationExplicit`. */
	collationExplicit?: true;
	generated: boolean;
	/** `GENERATED ALWAYS AS` expression AST ({@link persistExpression}); OMITTED unless generated. */
	generatedExpr?: unknown;
	/** Whether the generated value is STORED rather than computed on read; OMITTED unless generated. */
	generatedStored?: boolean;
	pkDirection?: 'asc' | 'desc';
	/**
	 * Column-level `on conflict <action>` (from `… primary key on conflict X` /
	 * `… not null on conflict X`). The vtab reads it off PK columns to resolve a
	 * PK collision's default action. OMITTED when absent — see
	 * {@link StoredTableSchema.primaryKeyDefaultConflict} for the byte-equal
	 * discipline.
	 */
	defaultConflict?: ConflictResolution;
	/** Column `with tags (…)`; OMITTED when none. */
	tags?: Record<string, SqlValue>;
}

/**
 * A CHECK constraint as declared — Quereus's `RowConstraintSchema` minus the fields it
 * sets only on a write-plan-time constraint (`violationMessage`, `messageValued`, the
 * `referencedWriteRow*` lens bookkeeping), which never appear on a catalog table.
 */
export interface StoredCheckConstraint {
	name?: string;
	/** Constraint expression AST ({@link persistExpression}). */
	expr: unknown;
	/** `RowConstraintSchema.operations`: the insert / update / delete bitmask the CHECK applies to. */
	operations: number;
	deferrable?: boolean;
	initiallyDeferred?: boolean;
	defaultConflict?: ConflictResolution;
	tags?: Record<string, SqlValue>;
}

/**
 * A FOREIGN KEY as declared — Quereus's `ForeignKeyConstraintSchema`. `columns` are
 * POSITIONS into the record's own column list; the referenced side is by name, as
 * Quereus keeps it (the parent is resolved at enforcement time).
 */
export interface StoredForeignKey {
	name?: string;
	columns: number[];
	referencedTable: string;
	referencedSchema?: string;
	referencedColumnNames?: string[];
	onDelete: ForeignKeyAction;
	onUpdate: ForeignKeyAction;
	deferred: boolean;
	defaultConflict?: ConflictResolution;
	tags?: Record<string, SqlValue>;
}

/** One `with context (<name> <type> [null])` variable; `type` is the logical type name. */
export interface StoredMutationContextVar {
	name: string;
	type: string;
	notNull: boolean;
}

export interface StoredPrimaryKeyColumn {
	index: number;
	desc?: boolean;
	collation?: string;
}

/** Resolved (in-memory) index descriptor: columns addressed by POSITION. */
export interface StoredIndexSchema {
	name: string;
	columns: StoredIndexColumn[];
	/** Set (to true) only for a unique index; omitted otherwise so plain indexes
	 *  stay byte-identical with schemas persisted before this field was wired. */
	unique?: boolean;
	/** Partial-index predicate AST (`CREATE UNIQUE INDEX … WHERE …`; {@link persistExpression}), if any. */
	predicate?: unknown;
	/** Index `with tags (…)`; OMITTED when none. */
	tags?: Record<string, SqlValue>;
}

/** Resolved index column: `index` is a position into the owning schema's `columns`. */
export interface StoredIndexColumn {
	index: number;
	desc?: boolean;
	collation?: string;
}

/**
 * The catalog record as WRITTEN — identical to {@link StoredTableSchema} except that
 * index columns carry the column's NAME rather than its position.
 *
 * A position only means something relative to the column list it was computed
 * against, and the catalog does not preserve that list: a later `CREATE TABLE` on the
 * same name (no DROP) replaces `columns` with the new declaration while the persisted
 * `indexes` survive the write ({@link mergeIndexLists}). A positional index column
 * would then silently point at whichever column now sits in its old slot — rows
 * vanish from indexed seeks, and a uniqueness probe reads the wrong key space. A name
 * cannot drift; it either resolves against the current column list or it fails
 * loudly. {@link SchemaManager} owns the ONLY conversions between the two shapes:
 * {@link toStoredSchema} on every read, {@link toPersistedSchema} on every write.
 *
 * `primaryKeyDefinition`, `uniqueConstraints`, `foreignKeys` and the generated-column
 * fields stay positional: all are re-written from the local declaration on every write,
 * always alongside the column list from the same declaration, so they cannot drift — and
 * {@link assertPositionsInRange} checks that invariant at every write so the day one of
 * them is preserved across writes the way `indexes` is, the drift is caught instead of
 * persisted.
 *
 * The expression ASTs (partial-index / partial-constraint `predicate`, column
 * `defaultValue` and `generatedExpr`, CHECK `expr`) are persisted as Quereus parser
 * `Expression` trees ({@link persistExpression}) and need no positional conversion:
 * every column reference (`ColumnExpr`, `IdentifierExpr`) carries a column NAME — the
 * union has no positional column node at all — so an expression cannot outlive its
 * column list the way a positional index descriptor could. Audited against Quereus 4.17.
 */
export interface PersistedTableSchema extends Omit<StoredTableSchema, 'indexes'> {
	indexes: PersistedIndexSchema[];
	/**
	 * Present ⇔ this record is a GRAVESTONE, not a live schema: `DROP TABLE` replaces
	 * the live record with a copy carrying this timestamp ({@link SchemaManager.deleteSchema}),
	 * so what the leftover storage at the table's URI still holds stays written down.
	 * Storage must not outlive the catalog record that describes it — a later
	 * declaration over that storage is checked against the gravestone and refused when
	 * it contradicts it (the guards in `doInitialize` / `addIndex`), instead of
	 * silently adopting rows and index entries it cannot describe.
	 *
	 * A gravestone is invisible to every read/merge path ({@link SchemaManager.livePersistedEntry}
	 * returns undefined for it) and is read ONLY by the guards. Cross-version hazard,
	 * accepted for now (AGENTS.md: no backwards-compatibility promises yet): a build
	 * OLDER than this field reads a gravestone as a live record and resurrects the
	 * dropped table. If a persisted-format version stamp ever lands
	 * (tickets/backlog/debt-optimystic-key-format-migration.md), gate this there.
	 */
	droppedAt?: string;
}

/** Persisted index descriptor: columns addressed by NAME. */
export interface PersistedIndexSchema {
	name: string;
	columns: PersistedIndexColumn[];
	unique?: boolean;
	predicate?: unknown;
}

/** Persisted index column: `name` is the column's declared name, matched case-insensitively. */
export interface PersistedIndexColumn {
	name: string;
	desc?: boolean;
	collation?: string;
}

/**
 * Name-keyed union of two persisted index lists — the non-destructive merge every
 * schema write goes through (see {@link SchemaManager.storeStoredSchema}). Operates on
 * the PERSISTED (name-keyed) shape: unioning positional descriptors resolved against
 * two different column lists is exactly the drift this file's two-shape split exists
 * to prevent.
 *
 * Rules:
 * - An index present on either side survives. The result's ORDER means nothing:
 *   every written record is put in canonical order afterwards
 *   ({@link canonicalizeRecordOrder}), so this keeps `incoming`'s order and
 *   appends the indexes only `persisted` knows about. A removal never comes
 *   through here: `DROP TABLE` tombstones the whole entry
 *   ({@link SchemaManager.deleteSchema}), and `DROP INDEX` subtracts by name
 *   through {@link SchemaManager.removeIndex} — a record merely written without
 *   an index would be unioned straight back to what the catalog holds.
 * - Uniqueness never silently downgrades: when both sides carry the index and
 *   only `persisted` marks it unique, the merged entry keeps `unique` (and the
 *   predicate that scopes it) — mirroring addIndex's upgrade rule, which only
 *   ever adds the flag.
 */
export function mergeIndexLists(
	incoming: readonly PersistedIndexSchema[],
	persisted: readonly PersistedIndexSchema[]
): PersistedIndexSchema[] {
	const merged = [...incoming];
	const position = new Map(incoming.map((idx, i) => [idx.name, i]));
	for (const idx of persisted) {
		const at = position.get(idx.name);
		if (at === undefined) {
			merged.push(idx);
		} else if (idx.unique && !merged[at]!.unique) {
			merged[at] = { ...merged[at]!, unique: true, predicate: merged[at]!.predicate ?? idx.predicate };
		}
	}
	return merged;
}

/**
 * Ordinal (UTF-16 code unit) name order, never locale-aware, so every machine sorts alike.
 * An absent name sorts before every present one.
 */
function compareOptionalNames(a: string | undefined, b: string | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return -1;
	if (b === undefined) return 1;
	return a < b ? -1 : 1;
}

/** `items` by name; entries with equal (or no) names keep their existing relative order. */
function sortByName<T extends { name?: string }>(items: readonly T[]): T[] {
	return items
		.map((item, position) => ({ item, position }))
		.sort((a, b) => compareOptionalNames(a.item.name, b.item.name) || a.position - b.position)
		.map(({ item }) => item);
}

/**
 * `record` with the lists whose order carries no meaning — `indexes`, `orphanedIndexes`,
 * `checkConstraints` — in ONE canonical order: by name, unnamed CHECKs first in their
 * declared order. Without it the order is creation order, so a machine
 * that reached a declaration through earlier versions (a later version adding an index
 * declared before an existing one) would store different bytes from a machine that applied
 * it fresh — and a host writes the catalog on every machine before any peer contact, which
 * is fork-safe only while those bytes agree. Applied to every record a write produces
 * ({@link mergePersistedSchemas}) and to every candidate built from a live table
 * ({@link SchemaManager.tableSchemaToStored}), so a compare against a persisted record sees
 * the same order a write would land. A record persisted before this rule is rewritten in
 * canonical order on its next schema write; nothing migrates it sooner.
 *
 * Index names are unique within a table. Unnamed CHECKs only ever come from one declaration
 * (Quereus's schema differ never adds one to an existing table), so their relative order is
 * already the same everywhere.
 *
 * NOTE: accepted consequence — a hydrated table lists its indexes and CHECKs in this order
 * while a table declared in this session lists them as declared (Quereus's own catalog is
 * creation-ordered too). `getBestAccessPlan` keeps the FIRST of two equally-costed indexes,
 * so the two can pick different (equally good) indexes; and when several CHECKs fail on one
 * row, which one is reported can differ. Neither changes a result.
 */
function canonicalizeRecordOrder<T extends StoredTableSchema | PersistedTableSchema>(record: T): T {
	return {
		...record,
		indexes: sortByName<StoredIndexSchema | PersistedIndexSchema>(record.indexes),
		...(record.orphanedIndexes ? { orphanedIndexes: sortByName(record.orphanedIndexes) } : {}),
		...(record.checkConstraints ? { checkConstraints: sortByName(record.checkConstraints) } : {}),
	} as T;
}

/** Column-name → position map over a record's own column list (names compare case-insensitively). */
function columnPositions(columns: readonly StoredColumnSchema[]): Map<string, number> {
	return new Map(columns.map((col, index) => [col.name.toLowerCase(), index]));
}

/** Render a column list for an error message: `[id, a, b]`. */
function describeColumns(columns: readonly StoredColumnSchema[]): string {
	return `[${columns.map(col => col.name).join(', ')}]`;
}

/**
 * Every index column on `record` that does not resolve against the record's own column
 * list, as (index name, column name) pairs. Empty when the record is resolvable.
 */
function unresolvedIndexColumns(record: PersistedTableSchema): { index: string; column: string }[] {
	const positions = columnPositions(record.columns);
	const misses: { index: string; column: string }[] = [];
	for (const idx of record.indexes) {
		for (const col of idx.columns) {
			if (!positions.has(col.name.toLowerCase())) {
				misses.push({ index: idx.name, column: col.name });
			}
		}
	}
	return misses;
}

/**
 * The boundary check for the fields that stay POSITIONAL on disk: every primary-key
 * position and every UNIQUE-constraint position must be in range for the record's own
 * column list. Both are consistent by construction today (see
 * {@link PersistedTableSchema}); this is what turns that unstated invariant into a
 * loud failure the day a write preserves one of them across a re-declare. Runs on
 * both sides of the boundary — every write ({@link mergePersistedSchemas}) and every
 * read ({@link toStoredSchema}) — so a record corrupted by any route is caught before
 * a consumer indexes a row with it.
 */
function assertPositionsInRange(record: PersistedTableSchema): void {
	const width = record.columns.length;
	const check = (position: number, what: string) => {
		if (!Number.isInteger(position) || position < 0 || position >= width) {
			throw new Error(
				`Cannot persist table '${record.name}': ${what} position ${position} is out of range ` +
				`for its column list ${describeColumns(record.columns)}`
			);
		}
	};
	for (const pk of record.primaryKeyDefinition) check(pk.index, 'primary key');
	for (const uc of record.uniqueConstraints ?? []) {
		for (const position of uc.columns) check(position, `unique constraint ${uc.name ? `'${uc.name}' ` : ''}column`);
	}
	for (const fk of record.foreignKeys ?? []) {
		for (const position of fk.columns) check(position, `foreign key ${fk.name ? `'${fk.name}' ` : ''}column`);
	}
	for (const [generated, dependencies] of record.generatedColumnDependencies ?? []) {
		check(generated, 'generated column');
		for (const position of dependencies) check(position, `generated column ${generated} dependency`);
	}
	for (const position of record.generatedColumnTopoOrder ?? []) check(position, 'generated column order');
}

/**
 * An expression AST as the catalog stores it: the same nodes Quereus's parser produced,
 * with every `loc` (a parser position — whitespace, not meaning) removed and keys in
 * sorted order, so one declaration persists the same bytes on every machine that runs it
 * and a hydrated table's expressions compare equal to the declared ones. Nothing is
 * re-encoded: the result IS a valid `Expression`, and hydrate hands it back as is.
 * Applied to every expression the record carries — defaults, generated expressions,
 * CHECK bodies, partial predicates.
 *
 * NOTE: a blob literal's `Uint8Array` is passed through untouched, and the JSON catalog
 * encoding cannot represent it (nor a bigint literal). No declaration in use defaults to
 * or checks against a blob literal; if one ever does, encode literal values here explicitly.
 */
export function persistExpression(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(persistExpression);
	if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return node;
	const persisted: Record<string, unknown> = {};
	for (const key of Object.keys(node).sort()) {
		if (key === 'loc') continue;
		const value = (node as Record<string, unknown>)[key];
		if (value !== undefined) persisted[key] = persistExpression(value);
	}
	return persisted;
}

/** `items` when it has any, else undefined — so an empty list is OMITTED from the record. */
function nonEmpty<T>(items: readonly T[] | undefined): T[] | undefined {
	return items && items.length > 0 ? [...items] : undefined;
}

/** A copy of `tags` when it has any, else undefined — so tag-free objects carry no key. */
function copyTags(tags: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> | undefined {
	return tags && Object.keys(tags).length > 0 ? { ...tags } : undefined;
}

/**
 * De-resolve a runtime schema to its on-disk shape: index positions become the names
 * of the columns they address in `stored`'s OWN column list. A position outside that
 * list is a corrupt input (the resolved shape guarantees the two agree), so it throws
 * rather than persisting a dangling reference.
 */
export function toPersistedSchema(stored: StoredTableSchema): PersistedTableSchema {
	const indexes: PersistedIndexSchema[] = stored.indexes.map(idx => ({
		...idx,
		columns: idx.columns.map(col => {
			const column = stored.columns[col.index];
			if (column === undefined) {
				throw new Error(
					`Cannot persist table '${stored.name}': index '${idx.name}' addresses column position ` +
					`${col.index}, which is out of range for its column list ${describeColumns(stored.columns)}`
				);
			}
			const { index: _position, ...rest } = col;
			return { ...rest, name: column.name };
		}),
	}));
	return { ...stored, indexes };
}

/**
 * Resolve an on-disk record to the runtime shape: each index column name becomes its
 * position in the record's OWN column list. A name with no match is an unresolvable
 * record and throws, naming the table, the index and the column — the read-side half of
 * the guarantee that a resolved schema's positions always describe its own columns.
 *
 * NOTE: `hydrateCatalog` treats a listTables error matching /not found|missing|empty/
 * as "no catalog yet" and swallows it; this message deliberately uses none of those
 * words so an unresolvable record surfaces instead of reading as a cold start. That
 * only covers the message's FIXED words — the table, index and column names it
 * interpolates are user identifiers, so a corrupt record on a table with a column
 * literally named `missing` would still be swallowed as a cold start (hydrate reports
 * zero tables instead of failing). Conditional on an already-corrupt catalog, so left
 * as is; if it ever bites, give the cold-start case a typed signal from
 * `requireSchemaTree` and drop the regex rather than widening this wording.
 */
export function toStoredSchema(record: PersistedTableSchema): StoredTableSchema {
	const misses = unresolvedIndexColumns(record);
	if (misses.length > 0) {
		const [first] = misses;
		throw new Error(
			`Persisted catalog record for table '${record.name}' is unresolvable: index '${first!.index}' ` +
			`names column '${first!.column}', which is absent from its column list ${describeColumns(record.columns)}`
		);
	}
	assertPositionsInRange(record);
	const positions = columnPositions(record.columns);
	const indexes: StoredIndexSchema[] = record.indexes.map(idx => ({
		...idx,
		columns: idx.columns.map(col => {
			const { name, ...rest } = col;
			return { ...rest, index: positions.get(name.toLowerCase())! };
		}),
	}));
	return { ...record, indexes };
}

/**
 * The record a schema write produces: `incoming` (the caller's declaration, already in
 * persisted form) with its index list unioned against what the catalog holds
 * ({@link mergeIndexLists}), validated so that every surviving index column exists in
 * the MERGED record's column list — which is `incoming`'s.
 *
 * The one way that validation fails is a re-declare that drops a column a persisted
 * index still covers (the incoming indexes were de-resolved from the incoming columns,
 * so they always resolve). Before index columns were persisted by name, that write
 * went through silently and every later row was indexed under the NULL key; now it is
 * refused at the write with the way out spelled out. `DROP TABLE` tombstones the
 * entry ({@link SchemaManager.deleteSchema}), so drop-then-recreate is unaffected.
 */
/**
 * `record` with index `indexName` (matched case-insensitively) moved from `indexes` to
 * `orphanedIndexes` — the shape a `DROP INDEX` leaves. The description moves rather than
 * disappears: the drop leaves the index tree at `<uri>/index/<name>` in storage (nothing in this
 * plugin deletes a collection), and `orphanedIndexes` is the field that describes storage the
 * catalog no longer lists, read by the CREATE INDEX adoption guard. The dropped description goes
 * FIRST into the by-name merge, so it wins over an older description of the same name (a dropped
 * table's index stashed by the table-adoption guard): the tree's entries were last written under
 * the columns this index declared. Undefined when the record lists no such index.
 */
export function withoutIndex(record: PersistedTableSchema, indexName: string): PersistedTableSchema | undefined {
	const lower = indexName.toLowerCase();
	const removed = record.indexes.find(idx => idx.name.toLowerCase() === lower);
	if (!removed) {
		return undefined;
	}
	return canonicalizeRecordOrder({
		...record,
		indexes: record.indexes.filter(idx => idx !== removed),
		orphanedIndexes: mergeIndexLists([removed], record.orphanedIndexes ?? []),
	});
}

export function mergePersistedSchemas(
	incoming: PersistedTableSchema,
	persisted: PersistedTableSchema | undefined
): PersistedTableSchema {
	let merged: PersistedTableSchema = persisted
		? { ...incoming, indexes: mergeIndexLists(incoming.indexes, persisted.indexes) }
		: incoming;
	// `orphanedIndexes` describe leftover STORAGE, not schema: they are never unioned
	// into `indexes` (that would resurrect a dropped table's index list), but they must
	// survive every write — a re-declare candidate built from local DDL never carries
	// them, and losing them here would blind the addIndex guard after the first
	// post-adoption schema write. Union keyed by name, omitted when empty so records
	// without the field stay byte-identical.
	const orphaned = mergeIndexLists(incoming.orphanedIndexes ?? [], persisted?.orphanedIndexes ?? []);
	if (orphaned.length > 0) {
		merged = { ...merged, orphanedIndexes: orphaned };
	}
	merged = canonicalizeRecordOrder(merged);
	const [miss] = unresolvedIndexColumns(merged);
	if (miss) {
		throw new Error(
			`Cannot re-declare table '${merged.name}' without column '${miss.column}': persisted index ` +
			`'${miss.index}' covers it. Drop the index or the table first.`
		);
	}
	assertPositionsInRange(merged);
	return merged;
}

/**
 * Manages schema storage and retrieval in Optimystic trees
 */
export class SchemaManager {
	/** Resolved live schemas by catalog key ({@link catalogKey}). */
	private schemaCache = new Map<string, StoredTableSchema>();
	/**
	 * The open `APPLY SCHEMA` catalog batch, if any. While set, every catalog read and write
	 * below routes through it (see {@link beginBatch}); the unbatched paths are untouched.
	 */
	private batch?: CatalogBatch;

	/**
	 * @param getSchemaTree resolves the plugin-global schema catalog tree. `create` selects the
	 *   semantics: falsy opens an EXISTING catalog and resolves `undefined` when none has ever
	 *   been committed (read paths — so a catalog this node cannot see reads as absent, not as
	 *   "this database has no tables"); `true` brings the catalog into existence, which is what
	 *   the first `create table` on a fresh network legitimately needs.
	 */
	constructor(
		private readonly getSchemaTree: (transactor?: ITransactor, create?: boolean) => Promise<Tree<string, any> | undefined>
	) {}

	/**
	 * Open a catalog batch: from here until {@link commitBatch}, writes collect in memory and
	 * reads are served from that overlay plus one catalog tree opened once (see
	 * {@link CatalogBatch}). Called by `OptimysticModule.beginSchemaBatch` for every manager
	 * that exists, and by its `createSchemaManager` for one created while a batch is open.
	 * No I/O. Throws if a batch is already open — batches never nest.
	 */
	beginBatch(): void {
		if (this.batch) {
			throw new Error('A catalog batch is already open on this SchemaManager');
		}
		this.batch = new CatalogBatch(this.getSchemaTree, mergePersistedSchemas);
	}

	/**
	 * Close the open batch and flush it in ONE catalog commit — zero I/O when nothing was
	 * written. The batch is closed whether or not the commit lands (the next apply must be
	 * able to open a fresh one); the error propagates to the module, which re-initializes the
	 * tables it left unpersisted. Only after the sync succeeds is the per-instance cache
	 * seeded with the resolved live records that were actually written, and cleared for
	 * every dropped table — the same discipline as the unbatched write path.
	 */
	async commitBatch(): Promise<void> {
		const batch = this.batch;
		if (!batch) {
			throw new Error('No catalog batch is open on this SchemaManager');
		}
		this.batch = undefined;
		const written = await batch.commit();
		for (const [key, entry] of written) {
			// resolveAndCache filters gravestones and tombstones exactly as every read does.
			if (this.resolveAndCache(entry) === undefined) {
				this.schemaCache.delete(key);
			}
		}
	}

	/**
	 * Close the open batch WITHOUT committing it: every pending write is dropped and the cache
	 * is left untouched (a batch never seeds it before its commit lands). Called by the module
	 * when an index tree that the batch's records list failed to land, so the catalog commit
	 * must not happen (see `OptimysticModule.endSchemaBatch`). A no-op when no batch is open —
	 * {@link commitBatch} closes the batch before its own commit, so discarding after a failed
	 * commit is safe.
	 */
	discardBatch(): void {
		this.batch = undefined;
	}

	/**
	 * Snapshot the open batch's pending writes before one DDL statement's catalog work, so a
	 * throw can withdraw exactly that statement's changes with {@link restoreBatch}. Undefined
	 * when no batch is open (direct DDL outside `apply schema`).
	 */
	checkpointBatch(): CatalogBatchCheckpoint | undefined {
		return this.batch?.checkpoint();
	}

	/** Drop every batched write staged since `checkpoint` was taken. */
	restoreBatch(checkpoint: CatalogBatchCheckpoint): void {
		if (!this.batch) {
			throw new Error('No catalog batch is open on this SchemaManager');
		}
		this.batch.restore(checkpoint);
	}

	/**
	 * The schema catalog tree, brought into existence when absent. Only for write paths —
	 * see the `create` parameter on {@link getSchemaTree}.
	 */
	private async requireSchemaTree(transactor?: ITransactor): Promise<Tree<string, any>> {
		const tree = await this.getSchemaTree(transactor, true);
		if (!tree) {
			throw new Error('Schema catalog tree unavailable: create-on-missing resolved to nothing');
		}
		return tree;
	}

	/**
	 * Store a table schema
	 */
	async storeSchema(schema: TableSchema, transactor?: ITransactor): Promise<void> {
		await this.storeStoredSchema(this.tableSchemaToStored(schema), transactor);
	}

	/**
	 * Store an already-converted StoredTableSchema directly. Exposed so callers
	 * that need precise control over the persisted shape (e.g. merging
	 * persisted indexes into a local-DDL candidate to avoid clobbering them)
	 * can hand us the exact bytes to write — with ONE exception, below.
	 *
	 * NON-DESTRUCTIVE for `indexes`: before writing, the current catalog entry is
	 * re-read through the write tree and the incoming index list is unioned with it
	 * ({@link mergeIndexLists}). This is the last-moment guard against two silent
	 * loss modes that a caller's earlier read cannot rule out:
	 * - the caller's read collapsed "catalog unreadable" into "absent" (a provably
	 *   indeterminate read throws, but a silently-empty cohort answer still reads
	 *   as absent — see {@link getSchema}) and its candidate would overwrite a
	 *   real index list with `[]`;
	 * - the caller read through this instance's cache (or its own earlier snapshot)
	 *   and a sibling added an index in between — a whole-record write-back would
	 *   drop it.
	 * Residual hole: if the WRITE path's read is served that same silent "absent"
	 * for a catalog that really exists, the union has nothing to merge and the
	 * write can still clobber — closing that needs the cluster-consult contract to
	 * count responders (see the coordinator-repo tripwire recorded in
	 * tickets/complete/4.5-repo-reports-unavailable-vs-absent.md).
	 *
	 * Returns the schema actually written (input + any unioned-in indexes, resolved
	 * against the input's column list); callers that keep using the schema after the
	 * write must use the returned value, not their input.
	 *
	 * This is the WRITE half of the catalog's shape boundary: the positional input is
	 * de-resolved to the name-keyed {@link PersistedTableSchema} against its own
	 * columns, unioned, validated and written ({@link mergePersistedSchemas}) — so a
	 * re-declare that reorders columns re-points every persisted index at the column
	 * it was declared on, and one that drops an indexed column is refused here.
	 */
	async storeStoredSchema(stored: StoredTableSchema, transactor?: ITransactor): Promise<StoredTableSchema> {
		if (this.batch) {
			return this.storeInBatch(this.batch, stored, transactor);
		}
		const tree = await this.requireSchemaTree(transactor);
		const key = catalogKey(stored.schemaName, stored.name);

		// Same read sequence as the read path: pull latest committed state, then
		// look up this table's entry. Skip tombstones (entry[1] === undefined).
		await tree.update();
		const path = await tree.find(key);
		const persisted = tree.isValid(path) ? this.livePersistedEntry(tree.at(path)) : undefined;
		const merged = mergePersistedSchemas(toPersistedSchema(stored), persisted);
		const resolved = toStoredSchema(merged);

		// The schema tree's keyExtractor (in collection-factory) treats entries
		// as `[key, PersistedTableSchema]` tuples — keying on `entry[0]`. The
		// per-table cache and read paths (getSchema, listTables) also expect
		// the tuple shape. Storing the bare `stored` object made `entry[0]`
		// undefined inside the btree, so cross-instance reads (and listTables)
		// couldn't see the entries even after a clean sync.
		await tree.replace([[key, [key, merged]]]);

		// Cache what was ACTUALLY written, and only after the write succeeded — a
		// failed replace must not leave the cache claiming the new value landed.
		this.schemaCache.set(key, resolved);
		return resolved;
	}

	/**
	 * The batched half of {@link storeStoredSchema}: the same de-resolve → union → validate →
	 * resolve sequence against the entry as the BATCH sees it (pending first, then the
	 * committed catalog), staged into the overlay instead of written. The cache is NOT
	 * touched here: in-batch reads are answered by the overlay, and the cache is seeded from
	 * what the end-of-batch commit actually lands ({@link commitBatch}) — a failed end commit
	 * must not leave it claiming a value that never reached storage.
	 */
	private async storeInBatch(
		batch: CatalogBatch,
		stored: StoredTableSchema,
		transactor?: ITransactor
	): Promise<StoredTableSchema> {
		const key = catalogKey(stored.schemaName, stored.name);
		const current = this.livePersistedEntry(await batch.readEntry(key, transactor));
		const merged = mergePersistedSchemas(toPersistedSchema(stored), current);
		batch.write(key, [key, merged]);
		return toStoredSchema(merged);
	}

	/**
	 * The batched read behind {@link getSchema}, {@link getSchemaFresh} and
	 * {@link readSchemaFromCatalog}: the live record as the batch sees it, resolved. Does
	 * not populate the cache (see {@link storeInBatch} for why).
	 */
	private async readLiveInBatch(
		batch: CatalogBatch,
		key: string,
		transactor?: ITransactor
	): Promise<StoredTableSchema | undefined> {
		const record = this.livePersistedEntry(await batch.readEntry(key, transactor));
		return record ? toStoredSchema(record) : undefined;
	}

	/**
	 * What a schema write to the catalog WOULD produce for `candidate` given the
	 * `persisted` schema this instance has read, without writing: the same
	 * de-resolve → union → validate → resolve sequence as {@link storeStoredSchema},
	 * so a caller comparing the two to skip a byte-identical write compares against
	 * exactly what a write would land. Throws what the write would throw (a
	 * re-declare that drops an indexed column).
	 */
	mergeWithPersisted(candidate: StoredTableSchema, persisted: StoredTableSchema): StoredTableSchema {
		return toStoredSchema(mergePersistedSchemas(toPersistedSchema(candidate), toPersistedSchema(persisted)));
	}

	/**
	 * The record inside a catalog entry whether live OR gravestone, or undefined for a
	 * bare tombstone (`entry[1] === undefined`, written by builds before gravestones
	 * or as {@link deleteSchema}'s degraded fallback). Internal building block for the
	 * two public-facing filters below — callers pick a side; nothing merges, caches,
	 * or plans against this unfiltered value directly.
	 */
	private anyPersistedEntry(entry: unknown): PersistedTableSchema | undefined {
		return recordOfEntry(entry);
	}

	/**
	 * The LIVE persisted record inside a catalog entry — undefined for a bare tombstone
	 * AND for a gravestone (`droppedAt` set). Every read/merge/hydrate path routes
	 * through this, so a dropped table stays invisible to the planner exactly as a
	 * bare tombstone always did; only the storage-adoption guards read gravestones,
	 * via {@link droppedPersistedEntry} / {@link findRecordForUri}.
	 */
	private livePersistedEntry(entry: unknown): PersistedTableSchema | undefined {
		const record = this.anyPersistedEntry(entry);
		return record && !record.droppedAt ? record : undefined;
	}

	/**
	 * The GRAVESTONE record inside a catalog entry — the record only when `droppedAt`
	 * is present. Read by the storage-adoption guards and by nothing else.
	 */
	private droppedPersistedEntry(entry: unknown): PersistedTableSchema | undefined {
		const record = this.anyPersistedEntry(entry);
		return record && record.droppedAt ? record : undefined;
	}

	/**
	 * The READ half of the catalog's shape boundary: resolve a live entry's record to
	 * the positional {@link StoredTableSchema} every consumer expects, against the
	 * record's own column list, and cache it under the catalog key it is filed under
	 * (`entry[0]`). Undefined for a tombstone. The one place a persisted record becomes
	 * a runtime schema.
	 *
	 * NOTE: {@link toStoredSchema} throws on an unresolvable record, and
	 * {@link listTables} calls this once per catalog entry — so ONE corrupt record
	 * makes the whole catalog unlistable and hydrate finds no tables at all, rather
	 * than the other tables hydrating and the bad one failing when it is opened.
	 * Deliberate while the only producer of such a record is a build older than the
	 * name-keyed format (see tickets/backlog/debt-optimystic-key-format-migration.md),
	 * where a partial hydrate would be the more confusing answer. If the catalog ever
	 * gains records this build legitimately cannot resolve, make the listTables walk
	 * collect per-table failures instead of propagating the first.
	 */
	private resolveAndCache(entry: unknown): StoredTableSchema | undefined {
		const record = this.livePersistedEntry(entry);
		if (!record) {
			return undefined;
		}
		const resolved = toStoredSchema(record);
		this.schemaCache.set((entry as CatalogEntry)[0], resolved);
		return resolved;
	}

	/**
	 * Retrieve a table schema — CACHED read.
	 *
	 * The first answer this instance produced for a table is served from memory on
	 * every later call; nothing invalidates it, so a schema another node (or another
	 * SchemaManager over the same storage) changed since is NOT seen here. That is
	 * fine for read paths (hydrate, planner, doInitialize's short-circuit compare)
	 * where the write-time union in {@link storeStoredSchema} bounds the damage of
	 * acting on a stale copy. A MUTATING path — anything that will write the schema
	 * back or change enforcement based on the answer — must use
	 * {@link getSchemaFresh} instead.
	 *
	 * `undefined` means "no schema visible". The block layer throws
	 * `BlockUnavailableError` when it can PROVE a read is indeterminate
	 * (repo-reports-unavailable-vs-absent, landed), and that throw propagates out
	 * of this method — so a provably-unreachable catalog fails loudly here. But a
	 * cohort that silently answers "nothing" (a per-peer timeout is
	 * indistinguishable from a peer that holds nothing) still reads as
	 * authoritatively absent, so `undefined` is not proof the catalog holds
	 * nothing. Callers must never treat it as a licence to overwrite what might
	 * really be persisted; the write-time index union is the standing guard.
	 */
	async getSchema(schemaName: string, tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const key = catalogKey(schemaName, tableName);
		if (this.batch) {
			// While an APPLY SCHEMA batch is open the overlay IS the catalog: a table created a
			// statement earlier is pending, not committed, and the cache is deliberately not
			// consulted or filled until the batch commits (see storeInBatch).
			// NOTE: a committed read running outside the engine's lock (`readCommittedSnapshot`)
			// can reach this on a batched manager and see a pending, not-yet-committed record.
			// Accepted: the engine's in-memory catalog already exposes those tables to the same
			// readers, so the plugin answering consistently with it is the coherent choice.
			return this.readLiveInBatch(this.batch, key, transactor);
		}
		const cached = this.schemaCache.get(key);
		if (cached) {
			return cached;
		}
		return await this.readSchemaFromCatalog(key, transactor);
	}

	/**
	 * Retrieve a table schema for a MUTATING path: the catalog is consulted first,
	 * bypassing the per-instance cache, so a change a sibling instance persisted
	 * since this instance's first read is seen before anything is written back.
	 * The blunt rule (every read that precedes a write goes to the catalog) is
	 * deliberate — schema mutations are rare, and a subtler invalidation scheme is
	 * exactly the kind of thing that rots.
	 *
	 * Falls back to the cached copy when the catalog read yields nothing: a cached
	 * entry proves a schema existed, and "nothing" can still mean an undetectably
	 * unreadable catalog (see {@link getSchema} for the residual ambiguity) —
	 * reporting the table gone would be inventing certainty. The write-time union
	 * in {@link storeStoredSchema} still guards whatever is written after such a
	 * fallback.
	 */
	async getSchemaFresh(schemaName: string, tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const key = catalogKey(schemaName, tableName);
		const fresh = this.batch
			? await this.readLiveInBatch(this.batch, key, transactor)
			: await this.readSchemaFromCatalog(key, transactor);
		if (fresh) {
			return fresh;
		}
		return this.schemaCache.get(key);
	}

	/**
	 * The tree-read half of {@link getSchema}: load the entry from the catalog and
	 * refresh the cache on a hit. Open-only: a catalog that has never been committed
	 * means this database has no persisted schemas — never invent one just to read it.
	 * A PROVABLY unretrievable catalog block throws `BlockUnavailableError` out of
	 * `Tree.open`/`update` (repo-reports-unavailable-vs-absent) rather than reading
	 * as absent; only a silently-empty cohort answer still collapses to absent —
	 * see {@link getSchema}.
	 * The btree's local state is built lazily, so a fresh SchemaManager (e.g. after
	 * process restart) sees an empty tree until we sync against storage — without
	 * this, cold-start reads silently return undefined and callers re-persist a
	 * schema that already exists.
	 */
	private async readSchemaFromCatalog(key: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return undefined;
		}
		await tree.update();
		const path = await tree.find(key);
		if (!tree.isValid(path)) {
			return undefined;
		}

		return this.resolveAndCache(tree.at(path));
	}

	/**
	 * Delete a table schema — a tombstone write, but OPEN-ONLY on the catalog.
	 *
	 * An absent catalog is a no-op, not a reason to invent one. There is nothing to
	 * tombstone in a catalog that has never been committed, and the alternative
	 * (create-on-missing) commits a locally-invented EMPTY catalog — which, on a node
	 * whose read of a real remote catalog came back empty, erases every other table's
	 * entry. That trade only ever favoured create-on-missing while "absent" reliably
	 * meant "fresh database"; it does not (see {@link getSchema} — a provably
	 * unreachable catalog throws, but a silently-empty cohort answer still reads as
	 * absent). Losing one drop's tombstone is recoverable; losing the catalog is not.
	 */
	async deleteSchema(schemaName: string, tableName: string, transactor?: ITransactor): Promise<void> {
		const key = catalogKey(schemaName, tableName);
		this.schemaCache.delete(key);

		if (this.batch) {
			return this.deleteInBatch(this.batch, key, transactor);
		}
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return;
		}
		// Write a GRAVESTONE, not a bare tombstone: the record being deleted, stamped
		// `droppedAt`, so the storage the drop leaves behind (rows at the table's URI,
		// index trees at `<uri>/index/<name>`) stays described and a later declaration
		// over it can be checked instead of silently adopting it. When the current
		// record cannot be read here, degrade to the bare `undefined` tombstone exactly
		// as before gravestones existed — a missing gravestone only means the guards
		// find nothing and let the declaration through, which is the old behaviour and
		// the right failure direction (never let a failed read block the drop).
		// An entry already carrying `droppedAt` keeps its original timestamp.
		let gravestone: PersistedTableSchema | undefined;
		try {
			await tree.update();
			const path = await tree.find(key);
			const record = tree.isValid(path) ? this.anyPersistedEntry(tree.at(path)) : undefined;
			if (record) {
				gravestone = { ...record, droppedAt: record.droppedAt ?? new Date().toISOString() };
			}
		} catch {
			gravestone = undefined;
		}
		// NOTE: on the catch path the `tree.update()` above did NOT land, so this stages its
		// tombstone against a possibly-stale view — blind in exactly the sense
		// `IndexManager.deleteIndexEntries` documents, and correct for the same reason: db-core's
		// `updateInternal` replays pending actions against the revision it adopts, so a delete that
		// wrote no block at staging is re-applied before the commit. Untested — reaching a failed
		// read here deliberately is awkward — so it rests on that rule, not on coverage here.
		await tree.replace([[key, gravestone ? [key, gravestone] : undefined]]);
	}

	/**
	 * The batched half of {@link deleteSchema}: the same gravestone rules (including the
	 * bare-tombstone fallback when the current record cannot be read), staged into the
	 * overlay. Stays OPEN-ONLY on the catalog: with no committed catalog and no pending
	 * entry under this key there is nothing to tombstone, and staging one would make the
	 * end-of-batch commit invent a catalog just to hold it. A table created and dropped
	 * within one apply on a cold database DOES stage its gravestone — the create is pending,
	 * so the commit creates the catalog for that record exactly as two direct statements
	 * would have.
	 */
	private async deleteInBatch(batch: CatalogBatch, key: string, transactor?: ITransactor): Promise<void> {
		if (!batch.hasPending(key) && !(await batch.catalogExists(transactor))) {
			return;
		}
		let gravestone: PersistedTableSchema | undefined;
		try {
			const record = this.anyPersistedEntry(await batch.readEntry(key, transactor));
			if (record) {
				gravestone = { ...record, droppedAt: record.droppedAt ?? new Date().toISOString() };
			}
		} catch {
			gravestone = undefined;
		}
		batch.write(key, gravestone ? [key, gravestone] : undefined);
	}

	/**
	 * The `DROP INDEX` write: take `indexName` off the table's live record, keeping its description
	 * as leftover storage ({@link withoutIndex}). The one catalog write that SHRINKS an index list,
	 * which is why it cannot go through {@link storeStoredSchema}: that path unions the incoming list
	 * with the persisted one at write time — deliberately, so an index a sibling added since the
	 * caller's read survives — and would union a removal straight back in. Here the latest record is
	 * read and written back subtracted in one step (the same read-to-write window
	 * {@link storeStoredSchema} has); inside an `APPLY SCHEMA` batch the subtracted record is staged
	 * into the overlay AND the name is handed to the batch, so the commit-time re-merge leaves it out
	 * of the committed side ({@link CatalogBatch.excludeIndexAtCommit}).
	 *
	 * Open-only on the catalog, and a no-op on a record that lists no such index: a table whose record
	 * never landed (`OptimysticVirtualTable.markSchemaUnpersisted`) has nothing to subtract from, and
	 * the live instance still has to stop maintaining the index — that half is the caller's. Returns
	 * the record as it now stands, resolved, or undefined when the catalog holds none.
	 */
	async removeIndex(
		schemaName: string,
		tableName: string,
		indexName: string,
		transactor?: ITransactor
	): Promise<StoredTableSchema | undefined> {
		const key = catalogKey(schemaName, tableName);
		if (this.batch) {
			return this.removeIndexInBatch(this.batch, key, indexName, transactor);
		}
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return undefined;
		}
		await tree.update();
		const path = await tree.find(key);
		const record = tree.isValid(path) ? this.livePersistedEntry(tree.at(path)) : undefined;
		if (!record) {
			return undefined;
		}
		const subtracted = withoutIndex(record, indexName);
		if (!subtracted) {
			return toStoredSchema(record);
		}
		await tree.replace([[key, [key, subtracted]]]);
		// Cached only once the write landed, as storeStoredSchema does.
		const resolved = toStoredSchema(subtracted);
		this.schemaCache.set(key, resolved);
		return resolved;
	}

	/** The batched half of {@link removeIndex}: staged into the overlay, and named to the batch's commit. */
	private async removeIndexInBatch(
		batch: CatalogBatch,
		key: string,
		indexName: string,
		transactor?: ITransactor
	): Promise<StoredTableSchema | undefined> {
		const record = this.livePersistedEntry(await batch.readEntry(key, transactor));
		if (!record) {
			return undefined;
		}
		const subtracted = withoutIndex(record, indexName);
		if (!subtracted) {
			return toStoredSchema(record);
		}
		batch.write(key, [key, subtracted]);
		batch.excludeIndexAtCommit(key, indexName);
		return toStoredSchema(subtracted);
	}

	/**
	 * ONE pass over every catalog entry, in key order — the shared walk behind
	 * {@link listTables} and {@link findRecordForUri}, so the two cannot drift.
	 * Open-only: a fresh install has no catalog at all and yields nothing rather
	 * than inventing an empty catalog to iterate. Pulls the latest tree state
	 * first; a fresh SchemaManager otherwise iterates an empty in-memory btree
	 * even when storage already holds the persisted schemas.
	 *
	 * NOTE: deliberately NOT routed through an open catalog batch. Its only callers are
	 * {@link listTables} (hydrate, which never runs inside an `apply schema`) and the
	 * unbatched arm of {@link findRecordForUri}; the batched arm has its own one-walk overlay
	 * (`CatalogBatch.recordForUri`). If hydrate ever runs mid-apply, route this through the
	 * batch too rather than letting it open a second catalog tree.
	 */
	private async *catalogEntries(
		transactor?: ITransactor
	): AsyncGenerator<CatalogEntry> {
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return;
		}
		await tree.update();
		for await (const path of tree.range({ isAscending: true } as any)) {
			if (!tree.isValid(path)) {
				continue;
			}
			const entry = tree.at(path) as CatalogEntry | undefined;
			if (entry && entry.length >= 1) {
				yield entry;
			}
		}
	}

	/**
	 * List every (schema, table) the catalog holds an entry for — INCLUDING dropped ones. A
	 * gravestone is a real entry under the table's key, so a dropped table's name still
	 * comes back here; the record behind it does not, and callers that want live tables
	 * filter on the follow-up `getSchema`, which returns undefined for a gravestone
	 * (`hydrateCatalog` does exactly that and skips them).
	 *
	 * The names are decoded from each entry's catalog key ({@link namesOfCatalogKey}), so a
	 * bare tombstone lists too. An entry whose key is not a (schema, table) key — a record
	 * filed by a build that keyed the catalog by bare table name — is skipped: no
	 * `getSchema(schema, table)` can reach it, so listing it would only hand hydrate a name
	 * it cannot read (no backwards compatibility is owed yet — AGENTS.md).
	 *
	 * NOTE: gravestones are immortal by design — they are what keeps the leftover
	 * storage described — so this walk, and the one `getSchema` per name that
	 * `hydrateCatalog` runs after it, grow with a catalog's whole DROP history rather
	 * than with its live table count. Immaterial at the handful of drops a schema sees
	 * today; if a workload ever creates and drops tables at the same URI in a loop,
	 * hydrate is where it will show up first, and the fix is a live-only variant of this
	 * walk (the filter already exists — {@link livePersistedEntry}) rather than pruning
	 * gravestones, which would re-open the hole they close.
	 */
	async listTables(transactor?: ITransactor): Promise<QualifiedTableName[]> {
		const tables: QualifiedTableName[] = [];
		for await (const entry of this.catalogEntries(transactor)) {
			const names = namesOfCatalogKey(entry[0]);
			if (!names) {
				continue;
			}
			// Seed the per-instance cache from this single traversal so the
			// follow-up `getSchema(name)` calls (hydrateCatalog walks one
			// listTables + one getSchema per table) hit memory instead of
			// re-walking the schema btree from the root. The seeded value is
			// the same resolved shape getSchema itself caches and returns.
			// Skip tombstones and gravestones — a dropped entry must not
			// register as a cache hit (resolveAndCache filters both).
			this.resolveAndCache(entry);
			tables.push(names);
		}
		return tables;
	}

	/**
	 * The record — live OR gravestone — describing the storage at `collectionUri`,
	 * or undefined when no catalog entry claims that URI. One pass over the catalog
	 * ({@link catalogEntries} — the same walk listTables runs, one entry per table),
	 * so callers on hot paths must not call this per-open; the doInitialize guard
	 * runs it only on the genuinely-new-table arm.
	 *
	 * A record's URI is its first `USING optimystic(...)` argument, defaulted the
	 * way parseTableSchema defaults it (`tree://default/<schema>/<table>` — see
	 * {@link recordUriOf}) so tables declared without an explicit URI still match.
	 * Live records win over gravestones when
	 * both claim the URI — a live table's description of shared storage is the
	 * current one, not a dropped predecessor's.
	 *
	 * NOTE: the URI match is a raw string compare, but the collection factory strips a
	 * leading `tree://` before using the URI as the collection id, so `tree://db/t` and
	 * `db/t` name the SAME storage and are not matched here — a table declared under one
	 * spelling is not checked against a record written under the other, and the
	 * declaration falls back to the pre-guard silent adoption. Nobody spells one URI two
	 * ways today, and the same unnormalized string is already the identity used for the
	 * factory's per-transaction collection cache key, so normalizing only here would be
	 * half a fix; if the two spellings ever show up in one database, normalize the URI
	 * once at parse time and let both sites read the normalized form.
	 */
	async findRecordForUri(
		collectionUri: string,
		transactor?: ITransactor
	): Promise<PersistedTableSchema | undefined> {
		if (this.batch) {
			// Pending entries override committed ones by name, so a table dropped earlier in the
			// same apply is seen as its gravestone here — the guard still refuses a contradicting
			// re-declare over rows that still exist.
			return this.batch.recordForUri(collectionUri, transactor);
		}
		let dropped: PersistedTableSchema | undefined;
		for await (const entry of this.catalogEntries(transactor)) {
			const record = this.anyPersistedEntry(entry);
			if (!record) {
				continue;
			}
			if (recordUriOf(record) !== collectionUri) {
				continue;
			}
			if (!record.droppedAt) {
				return record;
			}
			dropped = dropped ?? record;
		}
		return dropped;
	}

	/**
	 * The gravestone under `schemaName`.`tableName`, or undefined when the entry is absent,
	 * live, or a bare (pre-gravestone) tombstone. Read by the storage-adoption guards only.
	 */
	async getDroppedSchemaRecord(
		schemaName: string,
		tableName: string,
		transactor?: ITransactor
	): Promise<PersistedTableSchema | undefined> {
		const key = catalogKey(schemaName, tableName);
		if (this.batch) {
			return this.droppedPersistedEntry(await this.batch.readEntry(key, transactor));
		}
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return undefined;
		}
		await tree.update();
		const path = await tree.find(key);
		return tree.isValid(path) ? this.droppedPersistedEntry(tree.at(path)) : undefined;
	}

	/**
	 * Clear the schema cache
	 */
	clearCache(): void {
		this.schemaCache.clear();
	}

	/**
	 * Build a Quereus TableSchema from a persisted StoredTableSchema — the table the
	 * declaration would create in THIS session, field for field. Used during catalog
	 * hydration so Quereus's in-memory catalog can short-circuit `apply schema` diffs
	 * against tables already present in storage; what hydrate leaves out of the rebuilt
	 * table is not diffed back in (mutation contexts are never compared) or surfaces as a
	 * spurious ALTER (a type spelling), so the record carries everything and this restores
	 * everything. `hydrate-restores-declared-table.spec.ts` compares the result against a
	 * DDL-created table key by key.
	 *
	 * `sessionVtabArgs` is the CURRENT session's `default_vtab_args` when this module is its
	 * default module. Only their binding entries ({@link sessionBindingVtabArgs}) are overlaid
	 * under the record's identity args ({@link identityVtabArgs}): the record never carries a
	 * binding, and the session never decides a hydrated table's identity (its `encoding`).
	 *
	 * NOTE: this and the other record ↔ `TableSchema` conversions below (~300 lines) use no
	 * manager state; this file is 1532 lines. If it grows again, move them to their own module.
	 */
	storedToTableSchema(
		stored: StoredTableSchema,
		vtabModule: VirtualTableModule<any, any>,
		vtabAuxData?: unknown,
		sessionVtabArgs: Readonly<Record<string, SqlValue>> = {}
	): TableSchema {
		const columns = stored.columns.map(col => this.storedToColumnSchema(col));
		const primaryKeyDefinition = stored.primaryKeyDefinition.map(pk => ({
			index: pk.index,
			desc: pk.desc,
			collation: pk.collation,
		}));
		return {
			name: stored.name,
			schemaName: stored.schemaName,
			columns,
			columnIndexMap: buildColumnIndexMap(columns),
			primaryKeyDefinition,
			primaryKeyDefaultConflict: stored.primaryKeyDefaultConflict,
			synthesizedPrimaryKey: stored.synthesizedPrimaryKey,
			checkConstraints: (stored.checkConstraints ?? []).map(check => this.storedToCheckConstraint(check)),
			foreignKeys: stored.foreignKeys?.map(fk => this.storedToForeignKey(fk)),
			vtabModule,
			vtabAuxData,
			vtabArgs: { ...sessionBindingVtabArgs(sessionVtabArgs), ...stored.vtabArgs },
			vtabModuleName: stored.vtabModuleName,
			isView: false,
			// Absent, not `[]`, for a table with no index: CREATE TABLE sets no `indexes` and
			// the first CREATE INDEX starts the list, so that is the shape a declared table has.
			indexes: stored.indexes.length > 0 ? this.storedIndexesToIndexSchemas(stored.indexes) : undefined,
			// No `statistics`: see StoredTableSchema.estimatedRows. Absent is the honest answer —
			// quereus reads absent as "nobody has measured this table" and applies its own
			// fallback, whereas any value we synthesized here would claim an ANALYZE that never
			// ran and, with no column statistics behind it, would claim it badly.
			uniqueConstraints: this.storedToUniqueConstraints(stored),
			mutationContext: stored.mutationContext?.map(variable => this.storedToMutationContextVar(variable)),
			generatedColumnDependencies: stored.generatedColumnDependencies
				? new Map(stored.generatedColumnDependencies.map(([generated, dependencies]) => [generated, [...dependencies]]))
				: undefined,
			generatedColumnTopoOrder: stored.generatedColumnTopoOrder ? [...stored.generatedColumnTopoOrder] : undefined,
			tags: copyTags(stored.tags),
		};
	}

	/**
	 * One column of a hydrated table — the inverse of {@link columnSchemaToStored}. The
	 * logical type is re-inferred from the declared spelling by the same rule CREATE TABLE
	 * uses (`inferType`), falling back to the stored canonical name for a column declared
	 * without a type. Also used by the vtab's own load arm (a `connect` whose caller
	 * supplied no columns), so the two never rebuild a column differently.
	 */
	storedToColumnSchema(col: StoredColumnSchema): ColumnSchema {
		return {
			name: col.name,
			logicalType: col.declaredType !== undefined ? inferType(col.declaredType) : getTypeOrDefault(col.affinity),
			declaredType: col.declaredType,
			notNull: col.notNull,
			primaryKey: col.primaryKey,
			pkOrder: col.pkOrder,
			defaultValue: (col.defaultValue as Expression | undefined) ?? null,
			collation: col.collation,
			collationExplicit: col.collationExplicit,
			generated: col.generated,
			generatedExpr: col.generatedExpr as Expression | undefined,
			generatedStored: col.generatedStored,
			pkDirection: col.pkDirection,
			defaultConflict: col.defaultConflict,
			tags: copyTags(col.tags),
		};
	}

	private storedToCheckConstraint(check: StoredCheckConstraint): RowConstraintSchema {
		return {
			name: check.name,
			expr: check.expr as Expression,
			operations: check.operations as RowConstraintSchema['operations'],
			deferrable: check.deferrable,
			initiallyDeferred: check.initiallyDeferred,
			defaultConflict: check.defaultConflict,
			tags: copyTags(check.tags),
		};
	}

	private storedToForeignKey(fk: StoredForeignKey): ForeignKeyConstraintSchema {
		return {
			name: fk.name,
			columns: [...fk.columns],
			referencedTable: fk.referencedTable,
			referencedSchema: fk.referencedSchema,
			referencedColumnNames: fk.referencedColumnNames ? [...fk.referencedColumnNames] : undefined,
			onDelete: fk.onDelete,
			onUpdate: fk.onUpdate,
			deferred: fk.deferred,
			defaultConflict: fk.defaultConflict,
			tags: copyTags(fk.tags),
		};
	}

	private storedToMutationContextVar(variable: StoredMutationContextVar): MutationContextDefinition {
		return {
			name: variable.name,
			logicalType: getTypeOrDefault(variable.type),
			notNull: variable.notNull,
		};
	}

	/**
	 * Resolved index descriptors in Quereus's `TableSchema.indexes` shape — the inverse of
	 * {@link indexSchemaToStored}. Used by {@link storedToTableSchema} for hydrate, and by
	 * the vtab to refresh its own `tableSchema.indexes` from what its IndexManager maintains
	 * before a forced re-persist (`OptimysticVirtualTable.markSchemaUnpersisted`).
	 */
	storedIndexesToIndexSchemas(indexes: readonly StoredIndexSchema[]): IndexSchema[] {
		return indexes.map(idx => ({
			name: idx.name,
			columns: idx.columns.map(col => ({
				index: col.index,
				desc: col.desc,
				collation: col.collation,
			})),
			unique: idx.unique ? true : undefined,
			predicate: idx.predicate as IndexSchema['predicate'],
			tags: copyTags(idx.tags),
		}));
	}

	/**
	 * Reconstruct the full UNIQUE-constraint list a hydrated table must enforce:
	 * the persisted non-derived constraints, plus one derived constraint per
	 * persisted `unique` index (mirroring what Quereus's
	 * `appendIndexToTableSchema` synthesizes when the `CREATE UNIQUE INDEX` DDL
	 * actually runs — which it does not on the hydrate path — down to the
	 * constraint being named after its index). Deduped by
	 * {@link uniqueConstraintKey}, so a unique index over columns already carrying
	 * a table-level UNIQUE contributes no second constraint, while a partial index
	 * never dedupes away the full constraint it shares columns with. Returns
	 * undefined when there are none.
	 */
	storedToUniqueConstraints(stored: StoredTableSchema): UniqueConstraintSchema[] | undefined {
		const constraints: UniqueConstraintSchema[] = (stored.uniqueConstraints ?? []).map(uc => ({
			name: uc.name,
			columns: [...uc.columns],
			defaultConflict: uc.defaultConflict,
			predicate: uc.predicate as UniqueConstraintSchema['predicate'],
			tags: copyTags(uc.tags),
		}));
		const seen = new Set(constraints.map(uniqueConstraintKey));
		for (const idx of stored.indexes) {
			if (!idx.unique) continue;
			const derived: UniqueConstraintSchema = {
				name: idx.name,
				columns: idx.columns.map(col => col.index),
				predicate: idx.predicate as UniqueConstraintSchema['predicate'],
				derivedFromIndex: idx.name,
			};
			const key = uniqueConstraintKey(derived);
			if (seen.has(key)) continue;
			seen.add(key);
			constraints.push(derived);
		}
		return constraints.length > 0 ? constraints : undefined;
	}

	/**
	 * Convert TableSchema to storable format. Exposed so callers can build a
	 * candidate StoredTableSchema (e.g. to compare against the persisted one
	 * and skip a redundant write when the in-memory shape matches what's
	 * already on disk).
	 */
	tableSchemaToStored(schema: TableSchema): StoredTableSchema {
		// Persist only NON-derived constraints: a `derivedFromIndex` constraint is
		// re-synthesized from its index's `unique` flag on read (see
		// storedToUniqueConstraints), so persisting it too would double it up.
		// Omit the key entirely when empty — see StoredTableSchema.uniqueConstraints.
		const uniqueConstraints: StoredUniqueConstraint[] = (schema.uniqueConstraints ?? [])
			.filter(uc => uc.derivedFromIndex === undefined)
			.map(uc => ({
				name: uc.name,
				columns: [...uc.columns],
				defaultConflict: uc.defaultConflict,
				predicate: uc.predicate ? persistExpression(uc.predicate) : undefined,
				tags: copyTags(uc.tags),
			}));
		const generatedColumnDependencies = schema.generatedColumnDependencies
			? [...schema.generatedColumnDependencies.entries()]
				.sort(([a], [b]) => a - b)
				.map(([generated, dependencies]): [number, number[]] => [generated, [...dependencies]])
			: undefined;
		return canonicalizeRecordOrder({
			name: schema.name,
			schemaName: schema.schemaName,
			columns: schema.columns.map(col => this.columnSchemaToStored(col)),
			primaryKeyDefinition: schema.primaryKeyDefinition.map(pk => ({
				index: pk.index,
				desc: pk.desc,
				collation: pk.collation,
			})),
			// undefined-valued keys vanish under JSON serialization, so an absent
			// action stays byte-identical with pre-upgrade schemas (see the field docs).
			primaryKeyDefaultConflict: schema.primaryKeyDefaultConflict,
			indexes: (schema.indexes || []).map(idx => this.indexSchemaToStored(idx)),
			vtabModuleName: schema.vtabModuleName,
			vtabArgs: identityVtabArgs(schema.vtabArgs),
			// `estimatedRows` is deliberately not emitted: see StoredTableSchema.estimatedRows.
			// Omitting it keeps this byte-identical with every schema persisted before quereus
			// 4.19 moved the row count onto `statistics`, so the migration costs no rewrites.
			uniqueConstraints: nonEmpty(uniqueConstraints),
			checkConstraints: nonEmpty(schema.checkConstraints.map(check => this.checkConstraintToStored(check))),
			foreignKeys: nonEmpty(schema.foreignKeys?.map(fk => this.foreignKeyToStored(fk))),
			mutationContext: nonEmpty(schema.mutationContext?.map(variable => ({
				name: variable.name,
				type: variable.logicalType.name,
				notNull: variable.notNull,
			}))),
			tags: copyTags(schema.tags),
			synthesizedPrimaryKey: schema.synthesizedPrimaryKey,
			generatedColumnDependencies: nonEmpty(generatedColumnDependencies),
			generatedColumnTopoOrder: nonEmpty(schema.generatedColumnTopoOrder),
		});
	}

	/**
	 * Convert ColumnSchema to storable format — the inverse of {@link storedToColumnSchema}.
	 */
	private columnSchemaToStored(col: ColumnSchema): StoredColumnSchema {
		return {
			name: col.name,
			affinity: col.logicalType.name,
			declaredType: col.declaredType,
			notNull: col.notNull,
			primaryKey: col.primaryKey,
			pkOrder: col.pkOrder,
			defaultValue: col.defaultValue ? persistExpression(col.defaultValue) : undefined,
			collation: col.collation,
			collationExplicit: col.collationExplicit ? true : undefined,
			generated: col.generated,
			generatedExpr: col.generatedExpr ? persistExpression(col.generatedExpr) : undefined,
			generatedStored: col.generatedStored,
			pkDirection: col.pkDirection,
			defaultConflict: col.defaultConflict,
			tags: copyTags(col.tags),
		};
	}

	/**
	 * `stored` with `check` added: the persisted half of `ALTER TABLE … ADD CONSTRAINT … CHECK`
	 * (see `OptimysticVirtualTable.addCheckConstraint`). A CHECK already carrying that name,
	 * compared case-insensitively as Quereus compares constraint names, is replaced rather than
	 * doubled — the engine refuses a name its own catalog holds, so such a CHECK came from a
	 * writer this session's declaration never saw, and local DDL wins here as it does on every
	 * other schema write. List order is left to the write ({@link canonicalizeRecordOrder}).
	 */
	withCheckConstraint(stored: StoredTableSchema, check: RowConstraintSchema): StoredTableSchema {
		const name = check.name?.toLowerCase();
		const kept = (stored.checkConstraints ?? []).filter(existing => name === undefined || existing.name?.toLowerCase() !== name);
		return { ...stored, checkConstraints: [...kept, this.checkConstraintToStored(check)] };
	}

	private checkConstraintToStored(check: RowConstraintSchema): StoredCheckConstraint {
		return {
			name: check.name,
			expr: persistExpression(check.expr),
			operations: check.operations,
			deferrable: check.deferrable,
			initiallyDeferred: check.initiallyDeferred,
			defaultConflict: check.defaultConflict,
			tags: copyTags(check.tags),
		};
	}

	private foreignKeyToStored(fk: ForeignKeyConstraintSchema): StoredForeignKey {
		return {
			name: fk.name,
			columns: [...fk.columns],
			referencedTable: fk.referencedTable,
			referencedSchema: fk.referencedSchema,
			referencedColumnNames: fk.referencedColumnNames ? [...fk.referencedColumnNames] : undefined,
			onDelete: fk.onDelete,
			onUpdate: fk.onUpdate,
			deferred: fk.deferred,
			defaultConflict: fk.defaultConflict,
			tags: copyTags(fk.tags),
		};
	}

	/**
	 * Convert IndexSchema to storable format — the ONE place an index descriptor takes its
	 * persisted shape, used by {@link tableSchemaToStored} and by the vtab's `addIndex`
	 * when it appends or upgrades a persisted index, so the two cannot drift.
	 */
	indexSchemaToStored(idx: IndexSchema): StoredIndexSchema {
		return {
			name: idx.name,
			columns: idx.columns.map((col: { index: number; desc?: boolean; collation?: string }) => ({
				index: col.index,
				desc: col.desc,
				collation: col.collation,
			})),
			// Normalize false → omitted so a plain index round-trips byte-identical
			// with schemas persisted before uniqueness metadata was wired through.
			unique: idx.unique ? true : undefined,
			predicate: idx.predicate ? persistExpression(idx.predicate) : undefined,
			tags: copyTags(idx.tags),
		};
	}
}

