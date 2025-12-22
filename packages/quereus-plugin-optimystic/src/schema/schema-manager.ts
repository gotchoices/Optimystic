/**
 * SchemaManager - Manages table schemas in Optimystic trees
 *
 * Stores and retrieves table schema definitions from distributed Optimystic trees.
 * Schema is stored in a dedicated tree at `tree://schema/{tableName}`.
 */

import type { Tree } from '@optimystic/db-core';
import type { TableSchema, ColumnSchema } from '@quereus/quereus';
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
	autoIncrement?: boolean;
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
		const stored = this.tableSchemaToStored(schema);
		this.schemaCache.set(schema.name, stored);

		const tree = await this.getSchemaTree(transactor);
		await tree.replace([[schema.name, stored]]);
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

		// Load from tree
		const tree = await this.getSchemaTree(transactor);
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
	 * Convert TableSchema to storable format
	 */
	private tableSchemaToStored(schema: TableSchema): StoredTableSchema {
		return {
			name: schema.name,
			schemaName: schema.schemaName,
			columns: schema.columns.map(col => this.columnSchemaToStored(col)),
			primaryKeyDefinition: schema.primaryKeyDefinition.map(pk => ({
				index: pk.index,
				desc: pk.desc,
				autoIncrement: pk.autoIncrement,
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

