import type { Libp2p } from '@libp2p/interface';
import type { ITransactor } from '@optimystic/db-core';
import type { NodeOptions, NodeStorage } from '@optimystic/db-p2p';
import type { BlobReferenceLedger } from './optimystic-adapter/blob-reference-ledger.js';
import type { TransactionWriteFacts } from './optimystic-adapter/write-description.js';

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
   * Every store the network a table binds to persists to on THIS machine, as one value
   * (`NodeStorage` in `@optimystic/db-p2p`): the blocks behind a `'local'` transactor, the blob
   * pieces and blob records behind the blob service of a transactor with no libp2p node
   * (docs/blobs.md §SQL), and the whole value as `NodeOptions.storage` for the node a `'network'`
   * transactor builds — so the plugin's own node keeps its blobs, and the pins on them, where this
   * says, and building a node by hand is no longer the only way to keep them across a restart.
   *
   * Called ONCE per network — per transactor key, `<transactor>:<keyNetwork>` — however many tables
   * and blob services resolve on it, and the result is kept for the life of the plugin. So a factory
   * may construct rather than return a value it holds, and the plugin cannot be the reason two sets
   * of stores open over one location (`fileNodeStorage` in `@optimystic/db-p2p-storage-fs` is one
   * set per directory; two would double-count the pieces and break the piece store).
   *
   * Omitted, everything is in memory and nothing survives a restart; for a `'network'` transactor
   * the node then logs one `node-wiring` `WARN:` line naming what it is keeping in memory and what
   * is lost with each.
   *
   * The plugin closes NOTHING: it owns no store it was handed, and `plugin.dispose()` releases only
   * its lease on the read cache in front of `blocks`. A host that must close its stores opens them
   * outside `register()` and returns them from here.
   */
  storageFactory?: () => NodeStorage;
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

  /**
   * The slowest round trip (ms) between any two nodes that will talk to each other; the node derives
   * every network deadline from it (`NodeOptions.linkRoundTripMs` in `@optimystic/db-p2p`). Set
   * through the plugin-level `link_round_trip_ms` only: it configures the node, which every table on
   * one network and port shares.
   */
  linkRoundTripMs?: number;

  /**
   * The node's cohort-topic substrate (`NodeOptions.cohortTopic` in `@optimystic/db-p2p`). Enabling it
   * gives the node the watch service a table tagged `"optimystic.network_watch" = true` subscribes
   * through. Set through the plugin-level `cohort_topic` only, for the same reason as
   * {@link linkRoundTripMs}.
   */
  cohortTopic?: NodeOptions['cohortTopic'];
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
  storageFactory?: () => NodeStorage;
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
 * - primaryKey: string representation of the primary key (composite keys are framed via
 *   key-encoding's injective tuple encoding, not a raw \x00 join)
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
  /**
   * Who acknowledges this transaction's commit, fixed when it began (`TransactionBridge.beginTransaction`):
   * `'network'`, the commit resolves once storage holds it; `'local'`, offline mode was entered when
   * the transaction began, and the commit resolves once the transaction is queued on this machine
   * (docs/offline-sync.md §Entering and leaving the mode). A mode change while the transaction is
   * open changes nothing about it.
   */
  acknowledgement: 'local' | 'network';
  /**
   * What the statements' write descriptions said about the elements this transaction staged
   * (`WriteFact`, recorded by the vtab through `TransactionBridge.noteWriteFacts`), with the marks
   * its savepoints left; `emptyWriteFacts()` to begin with. Folded into the queue entry's facts at
   * commit and read live by `CommitOutlook()`.
   */
  writeFacts: TransactionWriteFacts;
  /**
   * What this transaction's statements staged into their tables' reference trees, and what it put
   * through `plugin.blobs` while open (`BlobReferenceLedger`, recorded by the vtab through
   * `TransactionBridge.noteBlobReferences` and by `SqlBlobService.put`);
   * `emptyBlobReferenceLedger()` to begin with. Folded at commit into the pins the transaction's
   * references are held under (`SqlBlobPins` in `./optimystic-adapter/blob-pins.ts`).
   */
  blobReferences: BlobReferenceLedger;
}
