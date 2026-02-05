import type { Database, SqlParameters } from '@quereus/quereus';
import type {
	ITransactionEngine,
	Transaction,
	ExecutionResult,
	CollectionActions,
	TransactionCoordinator
} from '@optimystic/db-core';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Engine ID for Quereus SQL transactions.
 * Format: "quereus@{version}" where version matches the quereus package version.
 * NOTE: Keep this in sync with @quereus/quereus package.json version.
 * TODO: Import version dynamically from @quereus/quereus when it exports its version.
 */
export const QUEREUS_ENGINE_ID = 'quereus@0.15.1';

/**
 * Statement format for Quereus transactions.
 * Each statement is a SQL string with optional parameters.
 */
export type QuereusStatement = {
	/** The SQL statement to execute */
	sql: string;
	/** Optional parameters for the statement */
	params?: SqlParameters;
};

/**
 * Quereus-specific transaction engine for SQL execution.
 *
 * This engine:
 * 1. Executes SQL statements through a Quereus database
 * 2. Collects resulting actions from the virtual table module
 * 3. Computes schema hash for validation
 *
 * Used for both initial execution (client creating transaction) and
 * re-execution (validators verifying transaction).
 */
export class QuereusEngine implements ITransactionEngine {
	private schemaHashCache: string | undefined;
	private schemaVersion: number = 0;

	constructor(
		private readonly db: Database,
		private readonly coordinator: TransactionCoordinator
	) {}

	/**
	 * Execute a transaction's statements and produce actions.
	 *
	 * For initial execution: Executes SQL through Quereus, which triggers
	 * the Optimystic virtual table module to apply actions.
	 *
	 * For validation: Re-executes the same SQL statements to verify
	 * they produce the same operations.
	 */
	async execute(transaction: Transaction): Promise<ExecutionResult> {
		try {
			const allActions: CollectionActions[] = [];

			for (const statementJson of transaction.statements) {
				const statement = JSON.parse(statementJson) as QuereusStatement;

				// Execute SQL through Quereus
				// The Optimystic virtual table module will:
				// 1. Translate SQL mutations to actions
				// 2. Call coordinator.applyActions() with the stampId
				await this.db.exec(statement.sql, statement.params);

				// Note: Actions are collected by the coordinator's trackers,
				// not returned directly from exec(). The coordinator tracks
				// all actions applied during this transaction.
			}

			return {
				success: true,
				actions: allActions
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to execute SQL transaction: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Get the schema hash for this engine.
	 *
	 * The schema hash is used for validation - all participants must have
	 * matching schema hashes for a transaction to be valid.
	 *
	 * Uses caching to avoid recomputing if schema hasn't changed.
	 */
	async getSchemaHash(): Promise<string> {
		// Check if we have a cached hash
		if (this.schemaHashCache !== undefined) {
			return this.schemaHashCache;
		}

		// Compute and cache the schema hash
		this.schemaHashCache = await this.computeSchemaHash();
		return this.schemaHashCache;
	}

	/**
	 * Invalidate the schema hash cache.
	 * Call this when the schema changes (e.g., after DDL statements).
	 */
	invalidateSchemaCache(): void {
		this.schemaHashCache = undefined;
		this.schemaVersion++;
	}

	/**
	 * Get the current schema version number.
	 * Increments each time the schema cache is invalidated.
	 */
	getSchemaVersion(): number {
		return this.schemaVersion;
	}

	/**
	 * Compute the schema hash from the database catalog.
	 *
	 * Uses the schema() table-valued function to get schema information,
	 * then hashes the canonical representation using SHA-256.
	 */
	private async computeSchemaHash(): Promise<string> {
		// Query schema information from Quereus
		const schemaInfo: Array<{ type: string; name: string; sql: string | null }> = [];

		for await (const row of this.db.eval("select type, name, sql from schema() order by type, name")) {
			schemaInfo.push({
				type: row.type as string,
				name: row.name as string,
				sql: row.sql as string | null
			});
		}

		// Serialize to canonical JSON
		const catalogJson = JSON.stringify(schemaInfo);

		// Compute SHA-256 hash using @noble/hashes
		const hashBytes = sha256(new TextEncoder().encode(catalogJson));
		// Use first 16 bytes encoded as base64url for compact representation
		const hashBase64 = bytesToBase64url(hashBytes.slice(0, 16));
		return `schema:${hashBase64}`;
	}
}

/**
 * Convert bytes to base64url encoding (URL-safe, no padding).
 */
function bytesToBase64url(bytes: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Helper to create Quereus statement JSON for a transaction.
 */
export function createQuereusStatement(sql: string, params?: SqlParameters): string {
	const statement: QuereusStatement = { sql, params };
	return JSON.stringify(statement);
}

/**
 * Helper to create an array of Quereus statements for a transaction.
 */
export function createQuereusStatements(statements: Array<{ sql: string; params?: SqlParameters }>): string[] {
	return statements.map(s => createQuereusStatement(s.sql, s.params));
}

