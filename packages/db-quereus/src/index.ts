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

import type { Path } from '@optimystic/db-core';
import { Tree } from '@optimystic/db-core/src/collections/tree/index.js';
import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import type { ParsedOptimysticOptions, RowData } from './types.js';

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
    vtables: ['optimystic']
  }
};

// Export utility functions for custom implementations
export { registerKeyNetwork, registerTransactor } from './optimystic-adapter/key-network.js';

// Export types for TypeScript users
export type {
  OptimysticOptions as OptimysticTreeOptions,
  ParsedOptimysticOptions as ParsedOptimysticTreeOptions,
  LibP2PNodeOptions,
  ColumnDefinition,
  RowData,
  TransactionState,
} from './types.js';

// Global factory instances
const collectionFactory = new CollectionFactory();
const txnBridge = new TransactionBridge(collectionFactory);

/**
 * Parse plugin arguments into configuration
 */
function parseArguments(args: string[], config: any): ParsedOptimysticOptions {
  if (args.length === 0) {
    throw new Error('Missing collection URI argument');
  }

  const options: ParsedOptimysticOptions = {
    collectionUri: args[0],
    transactor: config.default_transactor || 'network',
    keyNetwork: config.default_key_network || 'libp2p',
    libp2pOptions: {
      port: config.default_port || 0,
      networkName: config.default_network_name || 'optimystic',
      bootstrapNodes: [],
    },
    cache: config.enable_cache !== false,
    encoding: 'json',
  };

  // Parse remaining arguments as key=value pairs
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const [key, value] = arg.split('=');

    switch (key.toLowerCase()) {
      case 'transactor':
        options.transactor = value || options.transactor;
        break;
      case 'keynetwork':
      case 'key_network':
        options.keyNetwork = value || options.keyNetwork;
        break;
      case 'port':
        options.libp2pOptions.port = parseInt(value) || options.libp2pOptions.port;
        break;
      case 'networkname':
      case 'network_name':
        options.libp2pOptions.networkName = value || options.libp2pOptions.networkName;
        break;
      case 'cache':
        options.cache = value !== 'false';
        break;
      case 'encoding':
        options.encoding = (value === 'msgpack') ? 'msgpack' : 'json';
        break;
    }
  }

  return options;
}

/**
 * Virtual table implementation for Optimystic tree collections
 */
class OptimysticTable {
  private collection?: Tree<string, RowData>;
  private iterator?: AsyncIterableIterator<Path<string, RowData>>;
  private currentPath?: Path<string, RowData>;
  private isEof = true;

  constructor(
    private readonly options: ParsedOptimysticOptions
  ) {}

  async initialize() {
    // Initialize collection
    const txnState = txnBridge.getCurrentTransaction();
    this.collection = await collectionFactory.createOrGetCollection(this.options, txnState || undefined);
  }

  getSchema() {
    // Simple schema - in practice this could be more sophisticated
    return `CREATE TABLE optimystic_tree(
      id TEXT PRIMARY KEY,
      data TEXT
    ) WITHOUT ROWID`;
  }

  async * scan() {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    // Full table scan
    const iterator = this.collection.range({ isAscending: true });

    for await (const path of iterator) {
      if (this.collection.isValid(path)) {
        const entry = this.collection.at(path);
        if (entry && entry.length >= 2) {
          yield {
            id: entry[0],
            data: entry[1]
          };
        }
      }
    }
  }

  async filter(constraints: any[]) {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    // Handle point lookups and range scans
    for (const constraint of constraints) {
      if (constraint.column === 'id' && constraint.op === '=') {
        // Point lookup
        const key = String(constraint.value);
        const path = await this.collection.find(key);
        if (this.collection.isValid(path)) {
          const entry = this.collection.at(path);
          if (entry && entry.length >= 2) {
            return [{
              id: entry[0],
              data: entry[1]
            }];
          }
        }
        return [];
      }
    }

    // Fallback to full scan
    const results = [];
    for await (const row of this.scan()) {
      results.push(row);
    }
    return results;
  }

  async insert(row: any) {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    const key = String(row.id);
    const data = row.data;
    await this.collection.replace([[key, [key, data]]]);
  }

  async update(row: any, oldRow: any) {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    const oldKey = String(oldRow.id);
    const newKey = String(row.id);
    const data = row.data;

    if (oldKey !== newKey) {
      // Key changed - delete old, insert new
      await this.collection.replace([
        [oldKey, undefined],
        [newKey, [newKey, data]]
      ]);
    } else {
      // Simple update
      await this.collection.replace([[newKey, [newKey, data]]]);
    }
  }

  async delete(row: any) {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    const key = String(row.id);
    await this.collection.replace([[key, undefined]]);
  }

  async beginTransaction() {
    await txnBridge.beginTransaction(this.options);
  }

  async commitTransaction() {
    await txnBridge.commitTransaction();
  }

  async rollbackTransaction() {
    await txnBridge.rollbackTransaction();
  }

  getRowCount() {
    // This would require iterating through the entire collection
    // For now, return unknown
    return -1;
  }
}

/**
 * The optimystic virtual table module
 */
const optimysticModule = {
  create: async (tableName: string, args: string[], config: any) => {
    const options = parseArguments(args, config);
    const table = new OptimysticTable(options);
    await table.initialize();
    return {
      schema: table.getSchema(),
      vtable: table
    };
  },

  connect: async (tableName: string, args: string[], config: any) => {
    // Same as create for this implementation
    const options = parseArguments(args, config);
    const table = new OptimysticTable(options);
    await table.initialize();
    return {
      schema: table.getSchema(),
      vtable: table
    };
  }
};

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

  return {
    vtables: [
      {
        name: 'optimystic',
        module: optimysticModule,
        auxData: config
      }
    ]
  };
}
