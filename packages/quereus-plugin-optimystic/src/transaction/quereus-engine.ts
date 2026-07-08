import type { Database, SqlParameters } from '@quereus/quereus';
import type {
	ITransactionEngine,
	Transaction,
	ExecutionResult,
	CollectionActions,
	TransactionCoordinator
} from '@optimystic/db-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { version: _quereusVersion } = _require('@quereus/quereus/package.json') as { version: string };
// Engine ID derived from the installed @quereus/quereus version at runtime.
export const QUEREUS_ENGINE_ID = `quereus@${_quereusVersion}`;

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
	readonly id = QUEREUS_ENGINE_ID;

	/**
	 * Cached schema hash. Set on a successful idle compute; cleared by
	 * {@link invalidateSchemaCache} whenever the schema changes. While warm, it is
	 * what the session-mode provider returns at `begin` WITHOUT re-entering the db —
	 * which is the whole point: keeping this warm out of band is how a host avoids
	 * the in-`begin` re-entrant query that would deadlock (see {@link getSchemaHash}).
	 */
	private schemaHashCache: string | undefined;
	private schemaVersion: number = 0;
	private unsubscribeSchema: (() => void) | undefined;

	constructor(
		private readonly db: Database,
		_coordinator: TransactionCoordinator
	) {
		// Invalidate the cached hash on every schema change. We deliberately do NOT
		// eagerly recompute here: recomputing issues `db.eval`, which acquires the
		// exec mutex and so flips `db._isExecuting()` true for the duration — and a
		// background recompute racing a host statement (or the validator, or a direct
		// getSchemaHash) makes those callers observe "executing" at surprising times
		// and mis-route. Recompute happens lazily on the next IDLE getSchemaHash; the
		// host keeps the hash warm out of band (see configureTransactionMode).
		this.unsubscribeSchema = this.db.onSchemaChange(() => this.invalidateSchemaCache());
	}

	/**
	 * Dispose of this engine, unsubscribing from schema change events.
	 */
	dispose(): void {
		if (this.unsubscribeSchema) {
			this.unsubscribeSchema();
			this.unsubscribeSchema = undefined;
		}
	}

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
	 * ## Non-re-entrancy contract (read before wiring session mode)
	 *
	 * Session mode wires this method as the `schemaHashProvider` that
	 * {@link TransactionBridge.beginTransaction} awaits — and `begin` runs INSIDE a
	 * statement's exec (the host's `db.exec('insert …')`, `db.exec('begin')`, even a
	 * `create table`/`create index` all hold Quereus's exec mutex when the vtab's
	 * transaction opens). Computing a COLD hash here issues
	 * `db.eval('select … from schema()')`, which tries to re-acquire that SAME mutex
	 * → circular wait → permanent hang. So this method NEVER runs a re-entrant query:
	 *
	 *   1. Warm cache → return it (the common path: no db access, no re-entrancy).
	 *   2. Cold cache while a statement is in flight (`db._isExecuting()` — Quereus's
	 *      sanctioned re-entrancy signal, `execMutexDepth > 0`) → THROW an actionable
	 *      error. A loud, immediate throw is strictly better than the silent deadlock
	 *      this replaces: it names the fix (warm the hash out of band) instead of
	 *      hanging the process.
	 *   3. Cold cache while idle → safe to compute, cache, and return.
	 *
	 * The cache is invalidated on every schema change (see the constructor), so after
	 * any DDL the next IDLE call recomputes. A host running session mode must keep the
	 * hash warm OUT OF BAND — call `getSchemaHash()` once, outside any statement, after
	 * its DDL and before the first transaction (and again after any later schema change
	 * it makes while session mode is live). That single idle call populates the cache,
	 * so every subsequent in-`begin` call takes path 1. If a host skips that and a
	 * transaction's `begin` hits a cold cache, it gets the path-2 throw — a clear
	 * signal to add the warm-up — rather than a hung node.
	 *
	 * NOTE: we deliberately do NOT auto-recompute in the background on schema change,
	 * and do NOT serve a stale "last known" hash as an in-`begin` fallback. Both were
	 * considered (see ticket `optimystic-session-schemahash-reentrancy`) and rejected:
	 * a background `db.eval` flips `db._isExecuting()` true at unpredictable times and
	 * derails OTHER callers (the re-validation path, direct hash reads), and a stale
	 * fallback silently signs a transaction with the wrong schema hash. Fail-fast +
	 * out-of-band warm keeps the re-entrancy signal honest and the hash correct.
	 */
	async getSchemaHash(): Promise<string> {
		// 1. Warm cache hit — the common path; no db access, so no re-entrancy.
		if (this.schemaHashCache !== undefined) {
			return this.schemaHashCache;
		}

		// 2. Cold cache while a statement is in flight: computing would issue a
		//    nested db.eval that re-acquires the exec mutex this call is transitively
		//    holding → deadlock. Fail fast with an actionable error instead of hanging.
		if (this.db._isExecuting()) {
			throw new Error(
				'QuereusEngine.getSchemaHash: schema hash is cold and cannot be computed '
				+ 'while a statement is in flight — a re-entrant schema() query would '
				+ 'deadlock on Quereus\'s exec mutex. Warm the hash out of band: call '
				+ 'getSchemaHash() once OUTSIDE any statement (after your DDL and before '
				+ 'the first transaction, and again after any later schema change made '
				+ 'while session mode is live). See QuereusEngine.getSchemaHash docs.'
			);
		}

		// 3. Cold cache and idle: safe to compute. Guard the cache write with the
		//    schema version so a concurrent invalidation (a later schema change)
		//    wins rather than being clobbered by this now-stale result.
		const version = this.schemaVersion;
		const hash = await this.computeSchemaHash();
		if (version === this.schemaVersion) {
			this.schemaHashCache = hash;
		}
		return hash;
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

