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
 * Order-insensitive identity for a set of column indices — sorted and joined by `_`.
 * Uniqueness of `(a, b)` and `(b, a)` is the same rule, so constraint/index matching
 * compares sets. Also names the vtab's synthesized enforcement trees (`_uniq_<key>`),
 * which must stay stable across restarts so the same tree URI resolves.
 */
export function columnSetKey(columns: readonly number[]): string {
	return [...columns].sort((a, b) => a - b).join('_');
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
 * Serializable schema storage format
 */
export interface StoredTableSchema {
	name: string;
	schemaName: string;
	columns: StoredColumnSchema[];
	primaryKeyDefinition: StoredPrimaryKeyColumn[];
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
}

export interface StoredPrimaryKeyColumn {
	index: number;
	desc?: boolean;
	collation?: string;
}

export interface StoredIndexSchema {
	name: string;
	columns: StoredIndexColumn[];
	/** Set (to true) only for a unique index; omitted otherwise so plain indexes
	 *  stay byte-identical with schemas persisted before this field was wired. */
	unique?: boolean;
	/** Partial-index predicate AST (`CREATE UNIQUE INDEX … WHERE …`), if any. */
	predicate?: unknown;
}

export interface StoredIndexColumn {
	index: number;
	desc?: boolean;
	collation?: string;
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
	 * can hand us the exact bytes to write.
	 */
	async storeStoredSchema(stored: StoredTableSchema, transactor?: ITransactor): Promise<void> {
		this.schemaCache.set(stored.name, stored);

		const tree = await this.requireSchemaTree(transactor);
		// The schema tree's keyExtractor (in collection-factory) treats entries
		// as `[name, StoredTableSchema]` tuples — keying on `entry[0]`. The
		// per-table cache and read paths (getSchema, listTables) also expect
		// the tuple shape. Storing the bare `stored` object made `entry[0]`
		// undefined inside the btree, so cross-instance reads (and listTables)
		// couldn't see the entries even after a clean sync.
		await tree.replace([[stored.name, [stored.name, stored]]]);
	}

	/**
	 * Retrieve a table schema
	 */
	async getSchema(tableName: string, transactor?: ITransactor): Promise<StoredTableSchema | undefined> {
		// Check cache first
		const cached = this.schemaCache.get(tableName);
		if (cached) {
			return cached;
		}

		// Load from tree. Open-only: a catalog that has never been committed means this
		// database has no persisted schemas — never invent one just to read it.
		// NOTE: this only fully separates "no schemas" from "could not reach the catalog"
		// once the storage layer throws on an unretrievable block instead of reporting it
		// missing (ticket repo-reports-unavailable-vs-absent).
		// The btree's local state is built lazily, so a fresh SchemaManager (e.g. after
		// process restart) sees an empty tree until we sync against storage — without
		// this, cold-start reads silently return undefined and callers re-persist a
		// schema that already exists.
		const tree = await this.getSchemaTree(transactor);
		if (!tree) {
			return undefined;
		}
		await tree.update();
		const path = await tree.find(tableName);
		if (!tree.isValid(path)) {
			return undefined;
		}

		const entry = tree.at(path) as [string, StoredTableSchema];
		if (entry && entry.length >= 2) {
			const stored = entry[1];
			this.schemaCache.set(tableName, stored);
			return stored;
		}

		return undefined;
	}

	/**
	 * Delete a table schema
	 */
	async deleteSchema(tableName: string, transactor?: ITransactor): Promise<void> {
		this.schemaCache.delete(tableName);

		// Create-on-missing: writing a tombstone is a write, and the catalog it belongs in
		// may not exist yet on this node (nothing is written to storage until the tree syncs).
		// NOTE: a consequence is that dropping a table on a node that has never seen the
		// catalog brings an (empty) catalog into existence. Harmless while a missing catalog
		// really means "fresh database" — the drop then targets nothing and commits an empty
		// catalog. It stops being harmless if a missing catalog can also mean "unreachable":
		// the drop would then commit a locally-invented catalog over a real remote one. If
		// repo-reports-unavailable-vs-absent lands and this is still create-on-missing, make
		// the delete a no-op on an absent catalog instead.
		const tree = await this.requireSchemaTree(transactor);
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

			const entry = tree.at(path) as [string, StoredTableSchema];
			// Seed the per-instance cache from this single traversal so the
			// follow-up `getSchema(name)` calls (hydrateCatalog walks one
			// listTables + one getSchema per table) hit memory instead of
			// re-walking the schema btree from the root. The seeded value is
			// the same `entry[1]` shape getSchema itself caches and returns
			// (`[name, StoredTableSchema]`). Skip tombstones — a deleted entry
			// can surface as `entry[1] === undefined` and must not register as
			// a cache hit.
			if (entry && entry.length >= 2 && entry[1]) {
				this.schemaCache.set(entry[0], entry[1]);
			}
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

