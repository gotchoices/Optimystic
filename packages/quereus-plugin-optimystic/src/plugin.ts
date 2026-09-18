/**
 * Quereus Plugin Entry Point for Optimystic
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, SqlValue, FunctionFlags } from '@quereus/quereus';
import { TEXT_TYPE } from '@quereus/quereus';
import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OptimysticModule } from './optimystic-module.js';
import { createStampIdFunction } from './functions/transaction-id.js';
import { createLogger } from './logger.js';

const log = createLogger('plugin');

// Error classes callers are told to classify commit failures against (see docs/transactions.md,
// "Legacy (single-node) commit" and its coordinator counterpart), re-exported here so a host that
// loads the plugin through THIS entry can import them from where it loads, with no assumption that
// the root entry (`./index.js`) shares a build chunk with this one — see the `splitting` comment in
// tsup.config.ts and the identity check in test/browser-bundle.spec.ts.
//
// `PartialCommitError` is the plugin's own class, defined in this package, so re-exporting it here
// is exactly the same object `TransactionBridge` throws — no copy is possible.
//
// The db-core classes are safe to re-export too, unlike a class this package itself defines: db-core
// is `external` in tsup.config.ts, so neither entry bundles it — both just `import` the package, and
// Node's module resolution hands out the one instance already loaded for the process (the classic
// "dual package hazard" would still apply if two different copies of `@optimystic/db-core` end up
// installed, but that is a generic node_modules concern, not something this package's own build can
// cause).
export { PartialCommitError } from './optimystic-adapter/txn-bridge.js';
export { CoordinatorPartialCommitError } from '@optimystic/db-core';
export { SyncRetryExhaustedError, TornActionError } from '@optimystic/db-core';

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(_db: Database, config: Record<string, SqlValue> = {}) {
	if (config.debug) {
		log('Optimystic plugin loading with config: %o', config);
	}

	// Global factory instances
	const collectionFactory = new CollectionFactory();
	const txnBridge = new TransactionBridge(collectionFactory);
	const optimysticModule = new OptimysticModule(collectionFactory, txnBridge);

	// Create the StampId function
	const stampIdFunc = createStampIdFunction(txnBridge);

	// Note: Transaction hooks are handled by the virtual table's begin, commit, rollback methods

	return {
		vtables: [
			{
				name: 'optimystic',
				module: optimysticModule,
				auxData: config,
			},
		],
		functions: [
			{
				schema: {
					name: 'StampId',
					numArgs: 0,
					flags: 1 as FunctionFlags, // UTF8
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: TEXT_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: stampIdFunc,
				},
			},
		],
		collations: [],
		// Expose internal components for testing and advanced usage
		collectionFactory,
		txnBridge,
		/**
		 * Hydrate Quereus's in-memory catalog from persisted Optimystic vtab
		 * schemas. Hosts that re-open a `Database` against existing storage
		 * should call this once after registering the plugin (and before
		 * running `apply schema` / DDL) so Quereus sees the existing tables in
		 * its catalog and skips re-emitting CREATE TABLE / CREATE INDEX for
		 * each one. Idempotent.
		 */
		hydrate: (db: Database) => optimysticModule.hydrateCatalog(db, config, config),
		/**
		 * Compare every secondary index of one table against the table's rows, in both
		 * directions, and report each disagreement: a row the index holds no entry for
		 * (`missing`), or an entry pointing at a row that is gone or no longer holds the indexed
		 * value (`orphaned`). One report per index the table maintains, including the internal
		 * tree that enforces a `unique` column with no declared index. Queries cannot show an
		 * orphaned entry — an index lookup checks every entry against the row it resolves to and
		 * skips the ones that row does not imply, so a leftover entry and no entry look the same
		 * from a query — which is why this exists.
		 *
		 * Reads this node's live trees, including an open transaction's uncommitted writes, and
		 * repairs nothing. `schema` defaults to `main`. Throws for a table that is not a known
		 * Optimystic table. How to read a report: docs/debugging.md, "Does an index agree with
		 * its table?".
		 */
		verifyIndexes: (db: Database, table: string, schema?: string) =>
			optimysticModule.verifyIndexes(db, table, schema),
		/**
		 * Release what the plugin holds outside the `Database` — today its LEASES on the
		 * raw-storage read caches behind `local` transactors over host-supplied storage (see
		 * `CollectionFactory.dispose`). Call after `db.close()`. Quereus has no close hook
		 * that reaches the plugin, so this is explicit.
		 *
		 * A cache is shared by every consumer of one backing store and is cleared only when the
		 * LAST lease on it releases, so skipping this is not a correctness problem — but it keeps
		 * that store's cache warm for the process, and a later `Database` over the same store then
		 * reads it instead of the backend. Anything that mutates the store behind Optimystic's
		 * back between two `Database`s must dispose in between. See `withReadCache` in
		 * `@optimystic/db-p2p`.
		 */
		dispose: () => collectionFactory.dispose(),
	};
}

