import type { Libp2p } from '@libp2p/interface';
import type { ITransactor } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';

/**
 * Configuration for the optimystic virtual table
 */
export interface OptimysticOptions {
  /** URI for the collection (e.g., 'tree://mydb/users') */
  collectionUri: string;

  /** Transactor type - 'network', 'test', or custom class name */
  transactor?: 'network' | 'test' | 'mesh-test' | string;

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

  /**
   * Optional factory for the raw storage backing a `'local'` transactor.
   * Defaults to `MemoryRawStorage` when omitted. Has no effect for non-local
   * transactor types.
   */
  rawStorageFactory?: () => IRawStorage;
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
  transactor: 'network' | 'test' | 'mesh-test' | string;
  keyNetwork: 'libp2p' | 'test' | string;
  libp2p?: Libp2p;
  libp2pOptions: LibP2PNodeOptions;
  cache: boolean;
  encoding: 'json' | 'msgpack';
  rawStorageFactory?: () => IRawStorage;
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
 * Row data as stored in the tree
 * Format: [primaryKey, encodedRow]
 * - primaryKey: string representation of the primary key (composite keys are joined with \x00)
 * - encodedRow: JSON-encoded row data
 */
export type RowData = [string, string];

/**
 * Transaction state for managing Optimystic transactions
 */
export interface TransactionState {
  transactor: ITransactor;
  isActive: boolean;
  collections: Map<string, any>; // Tree collections used in this transaction
  stampId: string; // Unique identifier for this transaction (stable within transaction, cycles between)
}
