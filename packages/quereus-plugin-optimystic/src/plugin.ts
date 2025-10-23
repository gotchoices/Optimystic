/**
 * Quereus Plugin Entry Point for Optimystic
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OptimysticModule } from './optimystic-module.js';

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(db: Database, config: Record<string, SqlValue> = {}) {
	if (config.debug) {
		console.log('Optimystic plugin loading with config:', config);
	}

	// Global factory instances
	const collectionFactory = new CollectionFactory();
	const txnBridge = new TransactionBridge(collectionFactory);
	const optimysticModule = new OptimysticModule(collectionFactory, txnBridge);

	// Note: Transaction hooks are handled by the virtual table's xBegin, xCommit, xRollback methods

	return {
		vtables: [
			{
				name: 'optimystic',
				module: optimysticModule,
				auxData: config,
			},
		],
		functions: [],
		collations: [],
	};
}

