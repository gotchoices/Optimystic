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

