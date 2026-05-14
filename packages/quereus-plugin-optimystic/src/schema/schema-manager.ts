/**
 * SchemaManager - Manages table schemas in Optimystic trees
 *
 * Stores and retrieves table schema definitions from distributed Optimystic trees.
 * Schema is stored in a dedicated tree at `tree://schema/{tableName}`.
 */

import type { Tree } from '@optimystic/db-core';
import type { TableSchema, ColumnSchema, VirtualTableModule } from '@quereus/quereus';
import { getTypeOrDefault } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';

// IndexSchema type from TableSchema.indexes
type IndexSchema = NonNullable<TableSchema['indexes']>[number];

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
	isTemporary?: boolean;
	estimatedRows?: number;
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
	unique?: boolean;
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

	constructor(
		private readonly getSchemaTree: (transactor?: ITransactor) => Promise<Tree<string, any>>
	) {}

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

		const tree = await this.getSchemaTree(transactor);
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

		// Load from tree. The btree's local state is built lazily, so a fresh
		// SchemaManager (e.g. after process restart) sees an empty tree until
		// we sync against storage — without this, cold-start reads silently
		// return undefined and callers re-persist a schema that already exists.
		const tree = await this.getSchemaTree(transactor);
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

		const tree = await this.getSchemaTree(transactor);
		await tree.replace([[tableName, undefined]]);
	}

	/**
	 * List all table names
	 */
	async listTables(transactor?: ITransactor): Promise<string[]> {
		const tree = await this.getSchemaTree(transactor);
		// Pull the latest tree state from storage; a fresh SchemaManager
		// otherwise iterates an empty in-memory btree even when the underlying
		// storage already contains the persisted schemas.
		await tree.update();
		const tables: string[] = [];

		for await (const path of tree.range({ isAscending: true } as any)) {
			if (!tree.isValid(path)) {
				continue;
			}

			const entry = tree.at(path) as [string, any];
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
			isTemporary: stored.isTemporary,
			isView: false,
			indexes,
			estimatedRows: stored.estimatedRows,
		};
	}

	/**
	 * Convert TableSchema to storable format. Exposed so callers can build a
	 * candidate StoredTableSchema (e.g. to compare against the persisted one
	 * and skip a redundant write when the in-memory shape matches what's
	 * already on disk).
	 */
	tableSchemaToStored(schema: TableSchema): StoredTableSchema {
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
			isTemporary: schema.isTemporary,
			estimatedRows: schema.estimatedRows,
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

