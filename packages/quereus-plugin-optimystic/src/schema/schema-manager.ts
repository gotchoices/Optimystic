/**
 * SchemaManager - Manages table schemas in Optimystic trees
 *
 * Stores and retrieves table schema definitions from distributed Optimystic trees.
 * Schema is stored in a dedicated tree at `tree://schema/{tableName}`.
 */

import type { Tree } from '@optimystic/db-core';
import type { TableSchema, ColumnSchema, VirtualTableModule, UniqueConstraintSchema, ConflictResolution } from '@quereus/quereus';
import { getTypeOrDefault } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';

// IndexSchema type from TableSchema.indexes
type IndexSchema = NonNullable<TableSchema['indexes']>[number];

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
 * (`_uniq_3.foo_3.bar`) because SQL identifiers can contain `_`: a bare `_`-join would
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
	vtabArgs?: Record<string, any>;
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
}

/**
 * NOTE: a deliberate subset of Quereus's `UniqueConstraintSchema` — the fields that
 * drive enforcement. `coveringStructureName`, `tags` and `exposedIndexTags` are NOT
 * persisted (nor is `IndexSchema.tags`); they are informational or describe covering
 * materialized views, which optimystic-backed tables do not use. If a covering MV or
 * an exposed implicit index is ever pointed at an optimystic table, they must be
 * persisted too — otherwise hydrate silently drops the link.
 */
export interface StoredUniqueConstraint {
	name?: string;
	/** Column indices in declared order (order matters for the synthesized tree's key). */
	columns: number[];
	defaultConflict?: ConflictResolution;
	/** Partial-constraint predicate AST (presence excludes it from point enforcement). */
	predicate?: unknown;
}

export interface StoredColumnSchema {
	name: string;
	affinity: string;
	notNull: boolean;
	primaryKey: boolean;
	pkOrder: number;
	defaultValue?: any;
	collation: string;
	generated: boolean;
	pkDirection?: 'asc' | 'desc';
	/**
	 * Column-level `on conflict <action>` (from `… primary key on conflict X` /
	 * `… not null on conflict X`). The vtab reads it off PK columns to resolve a
	 * PK collision's default action. OMITTED when absent — see
	 * {@link StoredTableSchema.primaryKeyDefaultConflict} for the byte-equal
	 * discipline.
	 */
	defaultConflict?: ConflictResolution;
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
	/** Partial-index predicate AST (`CREATE UNIQUE INDEX … WHERE …`), if any. */
	predicate?: unknown;
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
 * `primaryKeyDefinition` and `uniqueConstraints` stay positional: both are re-written
 * from the local declaration on every write, always alongside the column list from
 * the same declaration, so they cannot drift — and {@link assertPositionsInRange}
 * checks that invariant at every write so the day one of them is preserved across
 * writes the way `indexes` is, the drift is caught instead of persisted.
 */
export interface PersistedTableSchema extends Omit<StoredTableSchema, 'indexes'> {
	indexes: PersistedIndexSchema[];
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
 * - An index present on either side survives. `incoming` keeps its order;
 *   indexes only `persisted` knows about are appended after it. There is no
 *   index-removal path in this plugin today (DROP TABLE tombstones the whole
 *   entry via deleteSchema), so "union" and "correct" coincide; if a DROP INDEX
 *   ever lands it needs a dedicated removal API, not a shrunken write here.
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
 * The write-time boundary check for the fields that stay POSITIONAL on disk: every
 * primary-key position and every UNIQUE-constraint position must be in range for the
 * record's own column list. Both are consistent by construction today (see
 * {@link PersistedTableSchema}); this is what turns that unstated invariant into a
 * loud failure the day a write preserves one of them across a re-declare.
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
 * words so an unresolvable record surfaces instead of reading as a cold start.
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
export function mergePersistedSchemas(
	incoming: PersistedTableSchema,
	persisted: PersistedTableSchema | undefined
): PersistedTableSchema {
	const merged: PersistedTableSchema = persisted
		? { ...incoming, indexes: mergeIndexLists(incoming.indexes, persisted.indexes) }
		: incoming;
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
	private schemaCache = new Map<string, StoredTableSchema>();

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
		const tree = await this.requireSchemaTree(transactor);

		// Same read sequence as the read path: pull latest committed state, then
		// look up this table's entry. Skip tombstones (entry[1] === undefined).
		await tree.update();
		const path = await tree.find(stored.name);
		const persisted = tree.isValid(path) ? this.livePersistedEntry(tree.at(path)) : undefined;
		const merged = mergePersistedSchemas(toPersistedSchema(stored), persisted);
		const resolved = toStoredSchema(merged);

		// The schema tree's keyExtractor (in collection-factory) treats entries
		// as `[name, PersistedTableSchema]` tuples — keying on `entry[0]`. The
		// per-table cache and read paths (getSchema, listTables) also expect
		// the tuple shape. Storing the bare `stored` object made `entry[0]`
		// undefined inside the btree, so cross-instance reads (and listTables)
		// couldn't see the entries even after a clean sync.
		await tree.replace([[merged.name, [merged.name, merged]]]);

		// Cache what was ACTUALLY written, and only after the write succeeded — a
		// failed replace must not leave the cache claiming the new value landed.
		this.schemaCache.set(merged.name, resolved);
		return resolved;
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
	 * The persisted record inside a catalog entry, or undefined for a tombstone — a
	 * deleted entry surfaces as `entry[1] === undefined` and must never be merged
	 * with, cached, or returned as a live schema.
	 */
	private livePersistedEntry(entry: unknown): PersistedTableSchema | undefined {
		const tuple = entry as [string, PersistedTableSchema | undefined] | undefined;
		return tuple && tuple.length >= 2 && tuple[1] ? tuple[1] : undefined;
	}

	/**
	 * The READ half of the catalog's shape boundary: resolve a live entry's record to
	 * the positional {@link StoredTableSchema} every consumer expects, against the
	 * record's own column list, and cache it under its table name. Undefined for a
	 * tombstone. The one place a persisted record becomes a runtime schema.
	 */
	private resolveAndCache(entry: unknown): StoredTableSchema | undefined {
		const record = this.livePersistedEntry(entry);
		if (!record) {
			return undefined;
		}
		const resolved = toStoredSchema(record);
		this.schemaCache.set(resolved.name, resolved);
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
	async getSchema(tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const cached = this.schemaCache.get(tableName);
		if (cached) {
			return cached;
		}
		return await this.readSchemaFromCatalog(tableName, transactor);
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
	async getSchemaFresh(tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const fresh = await this.readSchemaFromCatalog(tableName, transactor);
		if (fresh) {
			return fresh;
		}
		return this.schemaCache.get(tableName);
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
	private async readSchemaFromCatalog(tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return undefined;
		}
		await tree.update();
		const path = await tree.find(tableName);
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
	async deleteSchema(tableName: string, transactor?: ITransactor): Promise<void> {
		this.schemaCache.delete(tableName);

		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return;
		}
		await tree.replace([[tableName, undefined]]);
	}

	/**
	 * List all table names
	 */
	async listTables(transactor?: ITransactor): Promise<string[]> {
		// Open-only: a fresh install has no catalog at all, and must list zero tables
		// rather than invent an empty catalog to iterate.
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return [];
		}
		// Pull the latest tree state from storage; a fresh SchemaManager
		// otherwise iterates an empty in-memory btree even when the underlying
		// storage already contains the persisted schemas.
		await tree.update();
		const tables: string[] = [];

		for await (const path of tree.range({ isAscending: true } as any)) {
			if (!tree.isValid(path)) {
				continue;
			}

			const entry = tree.at(path) as [string, PersistedTableSchema | undefined] | undefined;
			// Seed the per-instance cache from this single traversal so the
			// follow-up `getSchema(name)` calls (hydrateCatalog walks one
			// listTables + one getSchema per table) hit memory instead of
			// re-walking the schema btree from the root. The seeded value is
			// the same resolved shape getSchema itself caches and returns.
			// Skip tombstones — a deleted entry can surface as
			// `entry[1] === undefined` and must not register as a cache hit.
			this.resolveAndCache(entry);
			if (entry && entry.length >= 1) {
				tables.push(entry[0]);
			}
		}

		return tables;
	}

	/**
	 * Clear the schema cache
	 */
	clearCache(): void {
		this.schemaCache.clear();
	}

	/**
	 * Build a Quereus TableSchema from a persisted StoredTableSchema. Used
	 * during catalog hydration so Quereus's in-memory catalog can short-circuit
	 * `apply schema` diffs against tables already present in storage.
	 */
	storedToTableSchema(
		stored: StoredTableSchema,
		vtabModule: VirtualTableModule<any, any>,
		vtabAuxData?: unknown
	): TableSchema {
		const columns: ColumnSchema[] = stored.columns.map(col => ({
			name: col.name,
			logicalType: getTypeOrDefault(col.affinity),
			notNull: col.notNull,
			primaryKey: col.primaryKey,
			pkOrder: col.pkOrder,
			defaultValue: col.defaultValue ?? null,
			collation: col.collation,
			generated: col.generated,
			pkDirection: col.pkDirection,
			defaultConflict: col.defaultConflict,
		}));
		const columnIndexMap = new Map<string, number>(
			columns.map((col, index) => [col.name.toLowerCase(), index])
		);
		const primaryKeyDefinition = stored.primaryKeyDefinition.map(pk => ({
			index: pk.index,
			desc: pk.desc,
			collation: pk.collation,
		}));
		const indexes: IndexSchema[] = stored.indexes.map(idx => ({
			name: idx.name,
			columns: idx.columns.map(col => ({
				index: col.index,
				desc: col.desc,
				collation: col.collation,
			})),
			unique: idx.unique ? true : undefined,
			predicate: idx.predicate as IndexSchema['predicate'],
		}));
		return {
			name: stored.name,
			schemaName: stored.schemaName,
			columns,
			columnIndexMap,
			primaryKeyDefinition,
			primaryKeyDefaultConflict: stored.primaryKeyDefaultConflict,
			checkConstraints: [],
			vtabModule,
			vtabAuxData,
			vtabArgs: stored.vtabArgs,
			vtabModuleName: stored.vtabModuleName,
			isView: false,
			indexes,
			estimatedRows: stored.estimatedRows,
			uniqueConstraints: this.storedToUniqueConstraints(stored),
		};
	}

	/**
	 * Reconstruct the full UNIQUE-constraint list a hydrated table must enforce:
	 * the persisted non-derived constraints, plus one derived constraint per
	 * persisted `unique` index (mirroring what Quereus's
	 * `appendIndexToTableSchema` synthesizes when the `CREATE UNIQUE INDEX` DDL
	 * actually runs — which it does not on the hydrate path). Deduped by
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
		}));
		const seen = new Set(constraints.map(uniqueConstraintKey));
		for (const idx of stored.indexes) {
			if (!idx.unique) continue;
			const derived: UniqueConstraintSchema = {
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
				predicate: uc.predicate,
			}));
		return {
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
			vtabArgs: schema.vtabArgs as Record<string, any>,
			estimatedRows: schema.estimatedRows,
			uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
		};
	}

	/**
	 * Convert ColumnSchema to storable format
	 */
	private columnSchemaToStored(col: ColumnSchema): StoredColumnSchema {
		return {
			name: col.name,
			affinity: col.logicalType.name, // Use logicalType.name for storage
			notNull: col.notNull,
			primaryKey: col.primaryKey,
			pkOrder: col.pkOrder,
			defaultValue: col.defaultValue ? this.serializeExpression(col.defaultValue) : undefined,
			collation: col.collation,
			generated: col.generated,
			pkDirection: col.pkDirection,
			defaultConflict: col.defaultConflict,
		};
	}

	/**
	 * Convert IndexSchema to storable format
	 */
	private indexSchemaToStored(idx: IndexSchema): StoredIndexSchema {
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
			predicate: idx.predicate,
		};
	}

	/**
	 * Serialize an expression for storage
	 * For now, we'll store a simplified representation
	 */
	private serializeExpression(expr: any): any {
		// TODO: Implement proper expression serialization
		// For now, just store the expression as-is if it's a simple value
		if (typeof expr === 'object' && expr !== null) {
			if ('type' in expr && expr.type === 'literal') {
				return { type: 'literal', value: expr.value };
			}
			// For complex expressions, we'll need to implement full serialization
			return { type: 'complex', raw: JSON.stringify(expr) };
		}
		return expr;
	}
}

