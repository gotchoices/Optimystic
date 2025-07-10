/**
 * Optimystic Plugin for Quereus
 *
 * This plugin provides a virtual table module for Quereus that allows
 * querying Optimystic distributed tree collections using SQL.
 *
 * Usage:
 *   CREATE TABLE users USING optimystic(
 *     'tree://myapp/users',
 *     transactor='network',
 *     keyNetwork='libp2p'
 *   );
 */

import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OptimysticModule } from './optimystic-module.js';
import type { ParsedOptimysticOptions, RowData } from './types.js';
import { cryptoFunctions, functionRegistrations } from './crypto-functions/index.js';

export const manifest = {
  name: 'Optimystic',
  version: '0.1.0',
  author: 'Optimystic Team',
  description: 'Virtual table module for Optimystic distributed collections',
  pragmaPrefix: 'optimystic',
  settings: [
    {
      key: 'default_transactor',
      label: 'Default Transactor',
      type: 'string',
      default: 'network',
      help: 'Default transactor type (network, test, or custom)'
    },
    {
      key: 'default_key_network',
      label: 'Default Key Network',
      type: 'string',
      default: 'libp2p',
      help: 'Default key network type (libp2p, test, or custom)'
    },
    {
      key: 'default_port',
      label: 'Default Port',
      type: 'number',
      default: 0,
      help: 'Default port for libp2p nodes (0 = random)'
    },
    {
      key: 'default_network_name',
      label: 'Default Network Name',
      type: 'string',
      default: 'optimystic',
      help: 'Default network identifier'
    },
    {
      key: 'enable_cache',
      label: 'Enable Caching',
      type: 'boolean',
      default: true,
      help: 'Whether to cache collections between queries'
    }
  ],
  provides: {
    vtables: ['optimystic'],
    functions: functionRegistrations.map(reg => ({
      name: reg.name,
      description: reg.description,
      examples: reg.examples
    }))
  }
};

// Export utility functions for custom implementations
export { registerKeyNetwork, registerTransactor } from './optimystic-adapter/key-network.js';

// Export virtual table classes
export { OptimysticModule, OptimysticVirtualTable } from './optimystic-module.js';

// Export crypto functions
export { Digest, Sign, SignatureValid } from './crypto-functions/index.js';

// Export types for TypeScript users
export type {
  OptimysticOptions as OptimysticTreeOptions,
  ParsedOptimysticOptions as ParsedOptimysticTreeOptions,
  LibP2PNodeOptions,
  ColumnDefinition,
  RowData,
  TransactionState,
} from './types.js';

// Export crypto function types
export type {
  DigestInput,
  DigestOptions,
  HashAlgorithm,
  CurveType,
  PrivateKeyInput,
  SignOptions,
  BytesInput,
  VerifyOptions,
  CryptoInput,
} from './crypto-functions/index.js';

// Global factory instances
const collectionFactory = new CollectionFactory();
const txnBridge = new TransactionBridge(collectionFactory);
const optimysticModule = new OptimysticModule(collectionFactory, txnBridge);

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(db: any, config: any = {}) {
  if (config.debug) {
    console.log('Optimystic plugin loading with config:', config);
  }

  // Register transaction hooks
  if (db.onBeginTransaction) {
    db.onBeginTransaction(async () => {
      // Transaction begin is handled per-table
    });
  }

  if (db.onCommitTransaction) {
    db.onCommitTransaction(async () => {
      await txnBridge.commitTransaction();
    });
  }

  if (db.onRollbackTransaction) {
    db.onRollbackTransaction(async () => {
      await txnBridge.rollbackTransaction();
    });
  }

  // Register crypto functions with Quereus
  const functions: any = {};
  for (const reg of functionRegistrations) {
    functions[reg.name] = reg.func;
  }

  return {
    vtables: [
      {
        name: 'optimystic',
        module: optimysticModule,
        auxData: config
      }
    ],
    functions
  };
}
