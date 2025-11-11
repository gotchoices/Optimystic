import type { Libp2p } from '@libp2p/interface';
import type { IKeyNetwork, ITransactor } from '@optimystic/db-core';

/**
 * Configuration for the optimystic virtual table
 */
export interface OptimysticOptions {
  /** URI for the collection (e.g., 'tree://mydb/users') */
  collectionUri: string;

  /** Transactor type - 'network', 'test', or custom class name */
  transactor?: 'network' | 'test' | string;

  /** Key network type - 'libp2p', 'test', or custom class name */
  keyNetwork?: 'libp2p' | 'test' | string;

  /** Existing libp2p instance to use (optional) */
  libp2p?: Libp2p;

  /** Options for creating a new libp2p node */
  libp2pOptions?: LibP2PNodeOptions;

  /** Enable local snapshot cache */
  cache?: boolean;

  /** Row encoding format */
  encoding?: 'json' | 'msgpack';
}

/**
 * Options for creating a libp2p node
 */
export interface LibP2PNodeOptions {
  /** Network port to listen on */
  port?: number;

  /** Network name for protocol prefixes */
  networkName?: string;

  /** Bootstrap nodes for peer discovery */
  bootstrapNodes?: string[];
}

/**
 * Internal configuration after parsing and validation
 */
export interface ParsedOptimysticOptions {
  collectionUri: string;
  transactor: 'network' | 'test' | string;
  keyNetwork: 'libp2p' | 'test' | string;
  libp2p?: Libp2p;
  libp2pOptions: LibP2PNodeOptions;
  cache: boolean;
  encoding: 'json' | 'msgpack';
}

/**
 * Registry for custom transactor and key network implementations
 */
export interface CustomImplementationRegistry {
  transactors: Map<string, new (...args: any[]) => ITransactor>;
  keyNetworks: Map<string, new (...args: any[]) => IKeyNetwork>;
}

/**
 * Column definition for the virtual table
 */
export interface ColumnDefinition {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'NULL';
  isPrimaryKey: boolean;
  isNotNull: boolean;
}

/**
 * Row data as stored in the tree (array format)
 */
export type RowData = (string | number | boolean | null | Uint8Array)[];

/**
 * Transaction state for managing Optimystic transactions
 */
export interface TransactionState {
  transactor: ITransactor;
  isActive: boolean;
  collections: Map<string, any>; // Tree collections used in this transaction
  transactionId: string; // Unique identifier for this transaction (stable within transaction, cycles between)
}
