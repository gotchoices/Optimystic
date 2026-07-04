/**
 * Optimystic Virtual Table Module for Quereus
 *
 * This module implements the VirtualTableModule interface to create
 * virtual tables backed by Optimystic distributed tree collections.
 */

import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OptimysticVirtualTableConnection } from './optimystic-adapter/vtab-connection.js';
import type { ParsedOptimysticOptions, RowData } from './types.js';
import type { IRawStorage } from '@optimystic/db-p2p';
import { VirtualTable } from '@quereus/quereus';
import { ConflictResolution, QuereusError, StatusCode } from '@quereus/quereus';
import type { VirtualTableModule, BaseModuleConfig, Database, DatabaseInternal, TableSchema, Row, FilterInfo, BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, VirtualTableConnection, TableIndexSchema as IndexSchema, UpdateArgs, UpdateResult, SqlValue } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import type { CollectionChangeEvent, TreeReadView } from '@optimystic/db-core';
import { SchemaManager } from './schema/schema-manager.js';
import type { StoredTableSchema } from './schema/schema-manager.js';
import { RowCodec, type EncodedRow } from './schema/row-codec.js';
import { SqlDataType, PhysicalType } from '@quereus/quereus';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, NUMERIC_TYPE, NULL_TYPE, BOOLEAN_TYPE, type LogicalType } from '@quereus/quereus';
import { IndexManager, serializeIndexValue, type IndexEntry } from './schema/index-manager.js';
import { encodeKeyTuple } from './schema/key-encoding.js';
import { StatisticsCollector } from './schema/statistics-collector.js';
import { createLogger } from './logger.js';

const log = createLogger('module');



/**
 * Configuration interface for Optimystic module
 */
export interface OptimysticModuleConfig extends BaseModuleConfig {
  collectionUri: string;
  transactor?: string;
  keyNetwork?: string;
  port?: number;
  networkName?: string;
  cache?: boolean;
  encoding?: 'json' | 'msgpack';
}

/**
 * Helper function to convert SqlDataType affinity to LogicalType
 */
function affinityToLogicalType(affinity: SqlDataType): LogicalType {
	switch (affinity) {
		case SqlDataType.NULL:
			return NULL_TYPE;
		case SqlDataType.INTEGER:
			return INTEGER_TYPE;
		case SqlDataType.REAL:
			return REAL_TYPE;
		case SqlDataType.TEXT:
			return TEXT_TYPE;
		case SqlDataType.BLOB:
			return BLOB_TYPE;
		case SqlDataType.NUMERIC:
			return NUMERIC_TYPE;
		case SqlDataType.BOOLEAN:
			return BOOLEAN_TYPE;
		default:
			return BLOB_TYPE; // Default fallback
	}
}

/**
 * Stable structural compare of two StoredTableSchema values. Both sides are
 * produced by SchemaManager.tableSchemaToStored (the persisted side via a
 * prior store + JSON round-trip), so JSON.stringify with deterministic key
 * order yields the same byte string when the schemas are equivalent.
 */
function schemasEqual(a: StoredTableSchema, b: StoredTableSchema): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Production-grade virtual table for Optimystic tree collections
 */
export class OptimysticVirtualTable extends VirtualTable {
  private collection?: Tree<string, any>;
  private isInitialized = false;
  private initializationPromise?: Promise<void>;
  private txnBridge: TransactionBridge;
  private collectionFactory: CollectionFactory;
  private options: ParsedOptimysticOptions;
  private schemaManager: SchemaManager;
  private rowCodec?: RowCodec;
  private indexManager?: IndexManager;
  private statisticsCollector?: StatisticsCollector;
  private connection?: OptimysticVirtualTableConnection;
  /** Unsubscribe handle for the collection-change → watch bridge (set once after init). */
  private changeUnsubscribe?: () => void;
  /** Subscribe-once guard for the collection-change bridge across repeated initialize()/connect(). */
  private changeSubscribed = false;
  public tableSchema: TableSchema; // Changed from private to public to match base class

  constructor(
    db: Database,
    module: VirtualTableModule<any, any>,
    schemaName: string,
    tableName: string,
    tableSchema: TableSchema,
    options: ParsedOptimysticOptions,
    collectionFactory: CollectionFactory,
    txnBridge: TransactionBridge,
    schemaManager: SchemaManager
  ) {
    super(db, module, schemaName, tableName);
    this.tableSchema = tableSchema;
    this.options = options;
    this.collectionFactory = collectionFactory;
    this.txnBridge = txnBridge;
    this.schemaManager = schemaManager;

    // Enable statement capture for replication/transaction logging
    this.wantStatements = true;
  }

  /**
   * Initialize the table and its collection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization
    this.initializationPromise = this.doInitialize();
    return this.initializationPromise;
  }

  /**
   * Internal initialization logic
   */
  private async doInitialize(): Promise<void> {
    try {
      const txnState = this.txnBridge.getCurrentTransaction();
      this.collection = await this.collectionFactory.createOrGetCollection(
        this.options,
        txnState || undefined
      );

      // Resolve which schema to honour as the table's effective shape:
      //   - xCreate (DDL provided columns): keep the local DDL schema and
      //     (re-)write it to storage so this node's view is what's persisted.
      //     Multi-node hosts that intentionally re-CREATE the same table with
      //     a different shape rely on the local DDL winning over what a peer
      //     last wrote.
      //   - xConnect / hydrated (no local columns): load the persisted schema
      //     and stamp it onto the placeholder tableSchema so query planning
      //     can see the real columns.
      const persistedSchema = await this.schemaManager.getSchema(this.tableName, txnState?.transactor);
      const hasLocalColumns = this.tableSchema.columns.length > 0;
      let storedSchema: StoredTableSchema;

      if (hasLocalColumns) {
        // Build the would-be-persisted form of the local DDL and short-circuit
        // when it matches what's already on disk. Without this, every cold-start
        // `connect()` after `hydrate()` re-writes a byte-identical schema and
        // re-reads it back — one transaction per table+index, which dominates
        // post-hydrate cold-start time (see tickets/fix/hydrated-vtab-...md).
        //
        // `CREATE TABLE` / `xConnect` arrives without its `CREATE INDEX`
        // siblings — those dispatch later as separate `addIndex()` calls. So
        // an empty `candidateStored.indexes` does NOT mean "the table has no
        // indexes"; it means "the indexes aren't in this DDL statement." The
        // persisted index list is authoritative whenever the local candidate
        // has none — otherwise the short-circuit miss below would write
        // `indexes: []`, clobbering the persisted indexes and forcing every
        // later `addIndex()` to fail its dedupe and rebuild from scratch.
        const candidateStored = this.schemaManager.tableSchemaToStored(this.tableSchema);
        const mergedCandidate: StoredTableSchema =
          candidateStored.indexes.length === 0 && persistedSchema
            ? { ...candidateStored, indexes: persistedSchema.indexes }
            : candidateStored;

        if (persistedSchema && schemasEqual(mergedCandidate, persistedSchema)) {
          storedSchema = persistedSchema;
        } else {
          // Structural mismatch (columns/PK/vtab args changed). Write the
          // merged candidate so a real DDL change still wins on columns
          // while persisted indexes survive — they're managed by addIndex().
          await this.schemaManager.storeStoredSchema(mergedCandidate, txnState?.transactor);
          const written = await this.schemaManager.getSchema(this.tableName, txnState?.transactor);
          if (!written) {
            throw new Error('Failed to store and retrieve schema');
          }
          storedSchema = written;
        }
      } else if (persistedSchema) {
        this.tableSchema.columns = persistedSchema.columns.map((col, index) => ({
          name: col.name,
          affinity: col.affinity as any,
          logicalType: affinityToLogicalType(col.affinity as any),
          notNull: col.notNull,
          primaryKey: col.primaryKey,
          pkOrder: col.pkOrder,
          defaultValue: col.defaultValue,
          collation: col.collation,
          generated: col.generated,
          pkDirection: col.pkDirection,
          index,
        }));
        this.tableSchema.columnIndexMap = new Map(
          persistedSchema.columns.map((col, index) => [col.name.toLowerCase(), index])
        );
        this.tableSchema.primaryKeyDefinition = persistedSchema.primaryKeyDefinition.map(pk => ({
          index: pk.index,
          desc: pk.desc,
          collation: pk.collation,
        }));
        storedSchema = persistedSchema;
      } else {
        throw new Error('Cannot create table without column definitions');
      }

      this.rowCodec = new RowCodec(storedSchema, this.options.encoding);

      // Create and initialize index manager
      this.indexManager = new IndexManager(storedSchema, async (indexName, transactor) => {
        const indexOptions: ParsedOptimysticOptions = {
          ...this.options,
          collectionUri: `${this.options.collectionUri}/index/${indexName}`,
        };
        const tree = await this.collectionFactory.createOrGetCollection(
          indexOptions,
          transactor ? { transactor, isActive: true, collections: new Map(), stampId: '' } : undefined
        );
        return tree as unknown as Tree<string, IndexEntry>;
      });

      await this.indexManager.initialize(txnState?.transactor);

      // Create statistics collector
      this.statisticsCollector = new StatisticsCollector(storedSchema);

      // Register the main + index collections with the bridge so a session-mode
      // coordinator shares the very trackers this vtab stages into (see
      // registerCollections). Must happen before any DML so the coordinator's
      // per-transaction snapshot includes them.
      this.registerCollections();

      this.isInitialized = true;

      // Bridge optimystic collection-change notifications to Quereus watch
      // invalidation so reactive consumers wake on commits without polling.
      // Self-isolating: a wiring failure here never blocks initialization.
      await this.ensureChangeSubscription();
    } catch (error) {
      const message = `Failed to initialize Optimystic table: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Subscribe (once) to optimystic collection-change notifications for this
   * table's collection and translate each into a coarse, whole-table Quereus
   * watch invalidation. Idempotent across repeated initialize()/connect();
   * failures are logged and swallowed so a missing/unsupported notifier never
   * blocks the table.
   *
   * Scope decisions:
   *   - Only the MAIN-table collection is watched. Index sub-collections
   *     (`<uri>/index/<name>`) mutate under the same actionId but carry their
   *     own collection id; whole-table invalidation re-queries them anyway.
   *   - The plugin-global schema tree (`tree://optimystic/schema`) is skipped —
   *     schema writes are not data-watch events.
   */
  private async ensureChangeSubscription(): Promise<void> {
    if (this.changeSubscribed) {
      return;
    }
    if (this.options.collectionUri === 'tree://optimystic/schema') {
      return;
    }
    // Set the guard before awaiting so a concurrent initialize() cannot
    // double-subscribe; reset it on failure to allow a later retry.
    this.changeSubscribed = true;
    try {
      const collectionId = this.collectionFactory.getCollectionId(this.options);
      this.changeUnsubscribe = await this.collectionFactory.subscribeToCollectionChanges(
        this.options,
        collectionId,
        (event) => this.handleCollectionChange(event)
      );
    } catch (error) {
      this.changeSubscribed = false;
      log(
        `WARN: failed to subscribe '${this.tableName}' to collection changes: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Translate a collection-change event into a coarse whole-table Quereus watch
   * invalidation. Errors are isolated and logged — a watch-dispatch failure must
   * not propagate into the synchronous storage commit callback that invoked this
   * listener (the StorageRepo already isolates throwing listeners; this is a
   * second line of defence and, critically, prevents an unhandled rejection from
   * the async notifyExternalChange).
   */
  private handleCollectionChange(_event: CollectionChangeEvent): void {
    try {
      const result = this.db.notifyExternalChange(this.tableName, this.schemaName);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          log(
            `WARN: notifyExternalChange failed for '${this.tableName}': ` +
            `${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
    } catch (error) {
      log(
        `WARN: notifyExternalChange threw for '${this.tableName}': ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tear down the collection-change subscription (idempotent). Called from
   * OptimysticModule.destroy (DROP TABLE / module teardown).
   *
   * Deliberately NOT called from disconnect(): in this vtab, disconnect() is a
   * per-statement no-op that intentionally keeps the table initialized across
   * statements (see disconnect()). Unsubscribing there would silently kill
   * reactivity after the first scan. The storage listener therefore lives for
   * the table's lifetime and is released on destroy.
   */
  teardownChangeSubscription(): void {
    if (this.changeUnsubscribe) {
      try {
        this.changeUnsubscribe();
      } catch (error) {
        log(
          `WARN: error tearing down change subscription for '${this.tableName}': ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.changeUnsubscribe = undefined;
    }
    this.changeSubscribed = false;
  }

  /**
   * Disconnects from this virtual table connection instance
   * Note: We don't reset isInitialized or collection here because the table
   * should remain initialized across multiple statements/connections. For the
   * same reason we do NOT release the collection-change subscription here — it
   * is owned for the table's lifetime and torn down in destroy() (see
   * teardownChangeSubscription).
   */
  async disconnect(): Promise<void> {
    // Don't reset state - the table should remain initialized
  }

  /**
   * Ensures a connection is established and registered with the database
   * This is called automatically on first table access, but can also be called
   * explicitly to register the connection early (e.g., for transaction support)
   */
  async ensureConnectionRegistered(): Promise<OptimysticVirtualTableConnection> {
    if (!this.connection) {
      // Check if there's already an active connection for this table in the database.
      // registerConnection / getConnectionsForTable are declared on Quereus's
      // DatabaseInternal interface (the documented extension-point for custom
      // vtabs with transaction support), not the public Database type — cast once.
      const db = this.db as DatabaseInternal;
      const existingConnections = db.getConnectionsForTable(this.tableName);
      if (existingConnections.length > 0 && existingConnections[0] instanceof OptimysticVirtualTableConnection) {
        this.connection = existingConnections[0] as OptimysticVirtualTableConnection;
      } else {
        // Create a new connection and register it with the database
        this.connection = new OptimysticVirtualTableConnection(this.tableName, this.txnBridge, this.options);
        await db.registerConnection(this.connection);
      }
    }
    return this.connection;
  }

  /**
   * Creates a new VirtualTableConnection for transaction support
   */
  createConnection(): VirtualTableConnection {
    return new OptimysticVirtualTableConnection(this.tableName, this.txnBridge, this.options);
  }

  /**
   * Gets the current connection if this table maintains one internally
   */
  getConnection(): VirtualTableConnection | undefined {
    return this.connection;
  }

  /**
   * Opens a direct data stream for this virtual table based on filter criteria.
   * Reads the LIVE collection — sees rows committed by prior transactions plus any
   * staged by THIS transaction (the tracker merges staged inserts over committed
   * data).
   */
  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    yield* this.runQuery(filterInfo, false);
  }

  /**
   * Opens a direct data stream that reads the COMMITTED (pre-transaction) snapshot,
   * excluding any rows the in-flight transaction has staged. This honours Quereus's
   * `_readCommitted` connect flag — the contract a `committed.<Table>` reference in a
   * deferred CHECK relies on (e.g. `FormationUsage.Monotonic`'s
   * `max(UseNumber) from committed.FormationUsage`, which must NOT count the row being
   * inserted). Mirrors the in-memory vtab's committed-snapshot connection.
   *
   * Invoked via the per-scan {@link OptimysticCommittedTable} wrapper returned from
   * {@link OptimysticModule.connect} so the committed view never mutates the shared,
   * cached table instance — a concurrent live scan of the same table during deferred
   * -constraint drain must keep seeing the live view.
   */
  async* queryCommitted(filterInfo: FilterInfo): AsyncIterable<Row> {
    yield* this.runQuery(filterInfo, true);
  }

  /**
   * Shared query dispatch for live and committed reads. The access-strategy parse is
   * identical for both; only the read SOURCE differs — `committed` routes each read
   * shape (full scan, point lookup, index seek) to a pre-transaction view of the
   * relevant tree (see {@link committedTreeView}).
   */
  private async* runQuery(filterInfo: FilterInfo, committed: boolean): AsyncIterable<Row> {
    // Ensure connection is registered
    await this.ensureConnectionRegistered();

    // Wait for initialization if needed
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    try {
      // Resolve the main-table read source once. Live reads refresh from the network
      // first; committed reads read the captured pre-transaction snapshot as-is (a
      // mid-constraint network pull would defeat the point of reading committed state).
      const mainRead = await this.resolveMainRead(committed);

      // Parse idxStr to determine access strategy
      // Quereus uses idxStr like 'idx=_primary_(0);plan=2' for equality seeks
      // or 'idx=idx_category(0);plan=2' for secondary index seeks
      const planType = this.parsePlanType(filterInfo.idxStr);
      const indexName = this.parseIndexName(filterInfo.idxStr);

      // Determine if this is a secondary index (not primary key)
      const isSecondaryIndex = indexName != null && indexName !== '_primary_';

      if (isSecondaryIndex && filterInfo.args.length > 0) {
        // Secondary index seek - route to index scan
        yield* this.executeIndexScan(mainRead, indexName, filterInfo.args, committed);
      } else if (planType === 2 && filterInfo.args.length > 0) {
        // Primary key equality seek (plan=2)
        yield* this.executePointLookup(mainRead, filterInfo.args);
      } else if (planType === 3) {
        // Range query on primary key (plan=3)
        yield* this.executeRangeQuery(mainRead, filterInfo);
      } else if (filterInfo.idxNum === 1) {
        // Legacy: Point lookup on primary key
        yield* this.executePointLookup(mainRead, filterInfo.args);
      } else if (filterInfo.idxNum === 2) {
        // Legacy: Range query on primary key
        yield* this.executeRangeQuery(mainRead, filterInfo);
      } else if (filterInfo.idxNum >= 10) {
        // Legacy: Index-based scan
        const idxName = filterInfo.idxStr;
        if (!idxName || typeof idxName !== 'string') {
          throw new Error('Index name not provided for index scan');
        }
        yield* this.executeIndexScan(mainRead, idxName, filterInfo.args, committed);
      } else {
        // Full table scan
        yield* this.executeTableScan(mainRead);
      }
    } catch (error) {
      const message = `Query failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Resolve the main-table read source for the current read mode. Live → the live
   * collection, refreshed from the network. Committed → the pre-transaction view of
   * the collection ({@link committedTreeView}).
   */
  private async resolveMainRead(committed: boolean): Promise<TreeReadView<string, RowData>> {
    const collection = this.collection as unknown as Tree<string, RowData>;
    if (committed) {
      return this.committedTreeView(collection);
    }
    await collection.update();
    return collection;
  }

  /**
   * The committed (pre-transaction) read view of `tree`: when the tree was staged
   * this transaction, a view built from the txn-bridge's captured snapshot (which
   * excludes the in-flight mutations); otherwise the live tree itself, since a tree
   * with nothing staged this transaction already reflects committed state. The view
   * is per-scan and never mutates the live tree, so concurrent live scans of the same
   * table are unaffected.
   */
  private committedTreeView<TKey, TEntry>(tree: Tree<TKey, TEntry>): TreeReadView<TKey, TEntry> {
    const snapshot = this.txnBridge.getDirtySnapshot(tree);
    return snapshot !== undefined
      ? tree.readView(snapshot as Parameters<Tree<TKey, TEntry>['readView']>[0])
      : tree;
  }

  /**
   * Parse the plan type from idxStr
   * Quereus uses format like 'idx=_primary_(0);plan=2'
   */
  private parsePlanType(idxStr: string | null): number | undefined {
    if (!idxStr) return undefined;
    const match = idxStr.match(/plan=(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : undefined;
  }

  /**
   * Parse the index name from idxStr
   * Quereus uses format like 'idx=idx_name(0);plan=2'
   */
  private parseIndexName(idxStr: string | null): string | undefined {
    if (!idxStr) return undefined;
    const match = idxStr.match(/idx=([^(;]+)/);
    return match?.[1] || undefined;
  }

  /**
   * Execute a point lookup query against the supplied read source (live collection
   * or a committed view). The read source is already network-refreshed (live) or a
   * static snapshot (committed); this method never refreshes it.
   */
  private async* executePointLookup(
    read: TreeReadView<string, RowData>,
    args: readonly unknown[],
  ): AsyncIterable<Row> {
    if (!this.rowCodec) return;

    // Assemble the full (possibly composite) primary key from ALL seek args using
    // the SAME encoding the row codec uses to store keys (extractPrimaryKey).
    // Using only args[0] silently drops every PK column past the first, so a
    // composite-PK point lookup builds a key that can never match a stored row.
    const key = this.rowCodec.createPrimaryKey(args as SqlValue[]);

    const path = await read.find(key);
    if (!read.isValid(path)) {
      return;
    }

    const entry = read.at(path) as [string, EncodedRow] | undefined;
    if (entry && entry.length >= 2) {
      const encodedRow = entry[1];
      const row = this.rowCodec.decodeRow(encodedRow);
      yield row;
    }
  }

  /**
   * Execute a range query
   */
  private async* executeRangeQuery(
    read: TreeReadView<string, RowData>,
    _filterInfo: FilterInfo,
  ): AsyncIterable<Row> {
    // For now, fall back to full scan
    // TODO: Implement proper range queries based on filter args
    yield* this.executeTableScan(read);
  }

  /**
   * Execute an index-based scan. The main-table rows are fetched through `mainRead`
   * (live or committed); the index tree is read through a matching source so a
   * committed seek excludes index entries staged by the in-flight transaction.
   */
  private async* executeIndexScan(
    mainRead: TreeReadView<string, RowData>,
    indexName: string,
    args: readonly unknown[],
    committed: boolean,
  ): AsyncIterable<Row> {
    if (!this.rowCodec || !this.indexManager) return;

    const indexSchema = this.indexManager.getIndexSchema(indexName);
    if (!indexSchema) {
      throw new Error(`Index not found: ${indexName}`);
    }

    const indexTree = this.indexManager.getIndexTree(indexName);
    if (!indexTree) {
      throw new Error(`Index tree not found: ${indexName}`);
    }

    // Resolve the index-tree read source to match the main read mode. Live → refresh
    // from the network; committed → the pre-transaction view of the index tree.
    let indexRead: TreeReadView<string, IndexEntry>;
    if (committed) {
      indexRead = this.committedTreeView(indexTree);
    } else {
      await indexTree.update();
      indexRead = indexTree;
    }

    // Build the (possibly partial) framed index key from constraint values. Must use
    // the SAME framing IndexManager.createIndexKey stores under, so the prefix range in
    // findByIndexIn brackets exactly this tuple. A partial key (fewer args than index
    // columns) frames only the provided leading columns and prefix-matches the rest.
    const indexKeyPayloads: Array<string | null> = [];
    for (let i = 0; i < args.length && i < indexSchema.columns.length; i++) {
      indexKeyPayloads.push(serializeIndexValue(args[i] as SqlValue));
    }

    const indexKey = encodeKeyTuple(indexKeyPayloads);

    // Look up primary keys using the index read source
    for await (const primaryKey of this.indexManager.findByIndexIn(indexRead, indexKey)) {
      // Fetch the row from the main table using the primary key
      const path = await mainRead.find(primaryKey);
      if (!mainRead.isValid(path)) {
        continue;
      }

      const entry = mainRead.at(path) as [string, any];
      if (entry && entry.length >= 2) {
        const encodedRow = entry[1];
        const row = this.rowCodec.decodeRow(encodedRow);
        yield row;
      }
    }
  }

  /**
   * Execute a full table scan against the supplied read source with retry on path
   * invalidation. In a distributed system, incoming replicated changes can mutate a
   * LIVE tree during iteration; this handles path invalidation by restarting from the
   * last known key. A committed read view is a static snapshot, so the retry path is
   * simply never exercised for it (harmless). The read source is already
   * network-refreshed (live) or a snapshot (committed); this method never refreshes it.
   */
  private async* executeTableScan(read: TreeReadView<string, RowData>): AsyncIterable<Row> {
    if (!this.rowCodec) return;

    const maxRetries = 5;
    let retryCount = 0;
    let lastKey: string | undefined;
    const yieldedKeys = new Set<string>();

    while (retryCount < maxRetries) {
      try {
        // Create range starting from lastKey (exclusive) if we're retrying
        const range = lastKey
          ? new KeyRange<string>({ key: lastKey, inclusive: false }, undefined, true)
          : new KeyRange<string>(undefined, undefined, true);

        const iterator = read.range(range);

        for await (const path of iterator) {
          if (!read.isValid(path)) {
            continue;
          }

          const entry = read.at(path);
          if (entry && Array.isArray(entry) && entry.length >= 2) {
            const key = entry[0] as string;
            // Skip if we've already yielded this key (shouldn't happen but safety check)
            if (yieldedKeys.has(key)) {
              lastKey = key;
              continue;
            }

            const encodedRow = entry[1];
            const row = this.rowCodec.decodeRow(encodedRow);
            yieldedKeys.add(key);
            lastKey = key;
            yield row;
          }
        }
        // Successfully completed iteration
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Path is invalid due to mutation')) {
          // Tree was mutated during iteration, retry from last known position
          retryCount++;
          if (retryCount >= maxRetries) {
            throw new Error(`Table scan failed after ${maxRetries} retries due to concurrent mutations`);
          }
          // Small delay before retry to let mutations settle
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        // Re-throw non-mutation errors
        throw error;
      }
    }
  }

  /**
   * Register the main collection plus every index tree as dirty on the
   * transaction bridge BEFORE a DML statement stages its mutations. The first
   * mark snapshots each tree's pre-stage state; the bridge flushes the trees at
   * commit (legacy mode) and restores those snapshots on rollback, which is what
   * makes a deferred-constraint rejection atomic. Marking must precede staging so
   * the snapshot captures the state to revert to. Index trees a given statement
   * doesn't touch are snapshotted too — harmless: their flush is a no-op and
   * their restore is to an identical state.
   */
  private markDirtyTrees(): void {
    if (this.collection) {
      this.txnBridge.markDirty(this.collection);
    }
    if (this.indexManager) {
      for (const tree of this.indexManager.getIndexTrees()) {
        this.txnBridge.markDirty(tree);
      }
    }
  }

  /**
   * Register this table's collections (main table + every index tree) with the
   * transaction bridge so a session-mode coordinator can read their staged
   * transforms at commit and revert them at rollback.
   *
   * Called as the table initializes — BEFORE any DML — so the collections are
   * present in the coordinator's (shared) map when it snapshots on the
   * transaction's first action. Distinct from {@link markDirtyTrees}, which runs
   * per-DML and is therefore too late to seed that snapshot. Idempotent and
   * mode-agnostic: the registry is a plain map the bridge maintains regardless of
   * whether session mode is ever wired up.
   */
  private registerCollections(): void {
    if (this.collection) {
      this.txnBridge.registerCollection(this.collection.getCollection());
    }
    if (this.indexManager) {
      for (const tree of this.indexManager.getIndexTrees()) {
        this.txnBridge.registerCollection(tree.getCollection());
      }
    }
  }

  /**
   * Render a SQLite-style UNIQUE-constraint message naming the offending columns:
   *   `UNIQUE constraint failed: <table>.<col>[, <table>.<col>…]`
   * This is the value clients see on a rejected duplicate, so it tracks SQLite's
   * wording for compatibility. With no argument it names the PRIMARY KEY columns (the
   * tree-key collision); pass the violated constraint's column indices for a secondary
   * UNIQUE violation.
   */
  private uniqueConstraintMessage(columnIndices?: readonly number[]): string {
    const indices = columnIndices
      ?? this.tableSchema.primaryKeyDefinition.map(pk => pk.index);
    const cols = indices
      .map(i => `${this.tableName}.${this.tableSchema.columns[i]?.name ?? `col${i}`}`)
      .join(', ');
    return `UNIQUE constraint failed: ${cols}`;
  }

  /** Serialized composite key for a set of column indices, using the SAME per-value
   *  encoding the secondary-index layer keys on (see {@link serializeIndexValue}),
   *  so a uniqueness comparison agrees byte-for-byte with how the index would key it. */
  private uniqueKeyFor(columns: readonly number[], row: Row): string {
    return encodeKeyTuple(columns.map(ci => serializeIndexValue(row[ci] ?? null)));
  }

  /**
   * Probe for an existing row that a secondary UNIQUE constraint would collide with if
   * `values` were written, returning the conflicting row plus the violated
   * constraint's columns, or null when there is no conflict.
   *
   * Optimystic enforces only the PRIMARY KEY structurally (it is the tree key); every
   * other declared UNIQUE constraint must be checked here, mirroring the in-memory
   * vtab. The control schema's single-use `StampId` (and nullable `MemberPrivateKey`)
   * anti-replay columns depend on this enforcement. The probe reads the LIVE collection
   * — committed rows plus rows staged earlier in THIS transaction — so two writes
   * sharing a unique value within one transaction collide exactly as a cross
   * -transaction duplicate does (the same immediate semantics PK uniqueness has, and
   * the reason it does NOT read the committed snapshot).
   *
   * SQL semantics honoured: a partial UNIQUE (carrying a `predicate`, synthesized from
   * `CREATE UNIQUE INDEX … WHERE …`) is skipped, and a row is exempt from a constraint
   * when ANY of that constraint's columns is NULL (multiple NULLs are allowed).
   * `excludeKey`, when given, is the primary key of the row being updated, so the row
   * does not conflict with itself.
   *
   * Cost: O(rows) per probe — no index backs the unique columns. Fine for the small
   * control tables this targets; large tables with secondary UNIQUE constraints want an
   * index-backed probe (tracked separately as a follow-up optimization).
   */
  private async checkUniqueConstraints(
    values: Row,
    excludeKey?: string,
  ): Promise<{ row: Row; columns: readonly number[] } | null> {
    const constraints = this.tableSchema.uniqueConstraints;
    if (!constraints || constraints.length === 0) return null;
    if (!this.collection || !this.rowCodec) return null;

    // Only the constraints that actually bind THIS row: non-partial, every column
    // present and non-null. Precompute each one's serialized key for the new row.
    const active = constraints
      .filter(uc => uc.predicate === undefined && uc.columns.length > 0
        && uc.columns.every(ci => values[ci] !== null && values[ci] !== undefined))
      .map(uc => ({ columns: uc.columns, key: this.uniqueKeyFor(uc.columns, values) }));
    if (active.length === 0) return null;

    // One live scan; compare every existing row against each active constraint.
    for await (const path of this.collection.range(new KeyRange<string>(undefined, undefined, true))) {
      if (!this.collection.isValid(path)) continue;
      const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
      if (!entry || entry.length < 2) continue;
      if (excludeKey !== undefined && entry[0] === excludeKey) continue;
      const existing = this.rowCodec.decodeRow(entry[1]);
      for (const a of active) {
        if (this.uniqueKeyFor(a.columns, existing) === a.key) {
          return { row: existing, columns: a.columns };
        }
      }
    }
    return null;
  }

  /**
   * Resolve a secondary-UNIQUE collision into an {@link UpdateResult}, mirroring the PK
   * conflict path: IGNORE swallows the write; every other mode returns a structured
   * constraint result (with `existingRow`) for the engine to map to ABORT/FAIL/ROLLBACK
   * or drive an ON CONFLICT resolution. Returns null when there is no collision.
   */
  private async resolveUniqueConflict(
    values: Row,
    onConflict: ConflictResolution,
    excludeKey?: string,
  ): Promise<UpdateResult | null> {
    const hit = await this.checkUniqueConstraints(values, excludeKey);
    if (!hit) return null;
    if (onConflict === ConflictResolution.IGNORE) {
      return { status: 'ok' };
    }
    return {
      status: 'constraint',
      constraint: 'unique',
      message: this.uniqueConstraintMessage(hit.columns),
      existingRow: hit.row,
    };
  }

  /**
   * Performs an INSERT, UPDATE, or DELETE operation
   */
  async update(args: UpdateArgs): Promise<UpdateResult> {
    const { operation, values, oldKeyValues, mutationStatement } = args;

    // Ensure connection is registered
    await this.ensureConnectionRegistered();

    // Wait for initialization if needed
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    // Capture the mutation statement if provided (for transaction replication).
    // Await so recording lands in the session's statement array BEFORE any
    // collection.stage below (deterministic snapshot timing) and so a recording
    // failure aborts this DML instead of committing a record missing a statement.
    // NOTE: this await must stay ABOVE every collection.stage in this method. The
    // first addStatement per transaction is what makes coordinator.applyActions
    // snapshot pre-stage tracker state for rollback; reordering a stage above it
    // reopens the non-deterministic-snapshot race and breaks session-mode rollback.
    if (mutationStatement) {
      await this.txnBridge.addStatement(mutationStatement);
    }

    const txnState = this.txnBridge.getCurrentTransaction();

    try {
      switch (operation) {
        case 'insert':
          if (!values) {
            throw new Error('INSERT requires values');
          }
          {
            const insertKey = this.rowCodec.extractPrimaryKey(values);

            // Staging is an upsert, so a pre-stage get() is the only thing that
            // notices a duplicate key before it would silently overwrite the
            // existing entry. The get sees rows staged earlier in this
            // transaction and rows committed by prior ones. On a hit we RETURN a
            // structured constraint/ok result (never throw) so the engine can
            // apply SQL conflict semantics — IGNORE, REPLACE, or ON CONFLICT
            // upsert — per the contract in dml-executor's processInsertRow.
            const existing = await this.collection.get(insertKey) as [string, EncodedRow] | undefined;
            if (existing !== undefined) {
              // Decode the displaced row once from the entry value [pk, encoded];
              // reuse the entry already fetched above — do not re-read.
              const existingRow = this.rowCodec.decodeRow(existing[1]);
              // No per-constraint default in optimystic, so the fallback for an
              // absent statement-level OR clause is plain ABORT.
              const onConflict = args.onConflict ?? ConflictResolution.ABORT;

              if (onConflict === ConflictResolution.IGNORE) {
                // INSERT OR IGNORE / ON CONFLICT DO NOTHING: preserve the
                // original row, stage nothing, leave the row count unchanged.
                return { status: 'ok' };
              }

              if (onConflict === ConflictResolution.REPLACE) {
                // INSERT OR REPLACE: overwrite the row in place. Same PK, so the
                // row count is unchanged (no statistics bump) and only changed
                // indexed columns restage via updateIndexEntries.
                const replacementEncoded = this.rowCodec.encodeRow(values);
                this.markDirtyTrees();
                await this.collection.stage([[insertKey, [insertKey, replacementEncoded]]]);
                await this.indexManager.updateIndexEntries(
                  existingRow,
                  values,
                  insertKey,
                  insertKey,
                  txnState?.transactor,
                );
                return { status: 'ok', row: values, replacedRow: existingRow };
              }

              // ABORT (default) / FAIL / ROLLBACK: report the violation
              // structurally. The engine's translateConflictError maps it to the
              // right subclass for FAIL/ROLLBACK, and when an ON CONFLICT (pk) DO
              // UPDATE/NOTHING clause is present it drives the upsert from
              // existingRow. The vtab no longer throws for these modes.
              return {
                status: 'constraint',
                constraint: 'unique',
                message: this.uniqueConstraintMessage(),
                existingRow,
              };
            }

            // PK is clear; now enforce any SECONDARY UNIQUE constraints (the tree only
            // guards the PK). A hit returns a structured constraint result the same way
            // the PK path does — e.g. the control schema's single-use StampId column.
            const uniqueConflict = await this.resolveUniqueConflict(
              values, args.onConflict ?? ConflictResolution.ABORT,
            );
            if (uniqueConflict) {
              return uniqueConflict;
            }

            const encodedRow = this.rowCodec.encodeRow(values);

            // Snapshot the trees before staging so a rollback can revert exactly
            // this mutation (flushed at commit / restored on rollback).
            this.markDirtyTrees();

            // Stage the row in the main table. Entry format: [primaryKey, encodedRow]
            await this.collection.stage([[insertKey, [insertKey, encodedRow]]]);

            // Stage into all indexes
            await this.indexManager.insertIndexEntries(values, insertKey, txnState?.transactor);

            // Update statistics
            this.statisticsCollector?.incrementRowCount();

            return { status: 'ok', row: values };
          }

        case 'update':
          if (!values) {
            throw new Error('UPDATE requires values');
          }
          if (!oldKeyValues) {
            throw new Error('UPDATE requires old key values');
          }
          {
            const oldKey = this.rowCodec.extractPrimaryKey(oldKeyValues);
            const newKey = this.rowCodec.extractPrimaryKey(values);
            const encodedRow = this.rowCodec.encodeRow(values);

            // Fetch the actual old row before any staging. collection.get() reads
            // staged-this-tx + committed state, giving the correct old image even
            // for chained updates within a single transaction. Must precede any
            // collection.stage() call, which would clear or overwrite the old slot.
            // Fallback to oldKeyValues (PK-only; index key may be wrong) if the
            // row is unexpectedly absent — should not happen in valid DML.
            const oldEntry = await this.collection.get(oldKey) as [string, EncodedRow] | undefined;
            const oldRow: Row = oldEntry ? this.rowCodec.decodeRow(oldEntry[1]) : (oldKeyValues as Row);

            // Enforce SECONDARY UNIQUE constraints against the post-update values,
            // excluding the row being updated (its own PK), before any staging. A
            // collision with a DIFFERENT row returns a structured constraint result,
            // mirroring the INSERT path. (PK collisions on a key change are handled
            // separately below.)
            const uniqueConflict = await this.resolveUniqueConflict(
              values, args.onConflict ?? ConflictResolution.ABORT, oldKey,
            );
            if (uniqueConflict) {
              return uniqueConflict;
            }

            // Stage the main-table change (flushed at commit / restored on
            // rollback). A PK change is staged as delete-old + insert-new so both
            // index halves revert together on rollback.
            if (oldKey !== newKey) {
              // Staging is an upsert, so a pre-stage get() is the only thing
              // that notices the moving row is about to land on a key a
              // *different* row already occupies (oldKey !== newKey guarantees
              // it is a different row). On a hit we RETURN a structured
              // constraint/ok result (never throw) so the engine can apply SQL
              // conflict semantics — IGNORE, REPLACE, or upsert — exactly as
              // the INSERT path does.
              const existing = await this.collection.get(newKey) as [string, EncodedRow] | undefined;
              if (existing !== undefined) {
                // Decode the displaced row once from the entry value [pk, encoded].
                const existingRow = this.rowCodec.decodeRow(existing[1]);
                // No per-constraint default in optimystic, so the fallback for
                // an absent statement-level OR clause is plain ABORT.
                const onConflict = args.onConflict ?? ConflictResolution.ABORT;

                if (onConflict === ConflictResolution.IGNORE) {
                  // UPDATE OR IGNORE: leave both rows put — the moving row stays
                  // at oldKey, the row at newKey is untouched. Stage nothing and
                  // skip markDirtyTrees so the ignored move costs nothing.
                  return { status: 'ok' };
                }

                if (onConflict === ConflictResolution.REPLACE) {
                  // UPDATE OR REPLACE: displace the row at newKey and move the
                  // moving row there. The main-table staging is identical to the
                  // non-collision move — staging undefined at oldKey clears the
                  // old slot and the upsert at newKey overwrites the displaced
                  // row in one shot, so no separate displaced-row delete is
                  // needed here.
                  this.markDirtyTrees();
                  await this.collection.stage([
                    [oldKey, undefined],
                    [newKey, [newKey, encodedRow]]
                  ]);

                  // Index maintenance needs both stagings, in this order: first
                  // remove the DISPLACED row's entries (treeKeys
                  // frame(displacedIdx)‖frame(newKey)), THEN transition the MOVING
                  // row's entries (frame(oldIdx)‖frame(oldKey) -> frame(newIdx)‖frame(newKey)).
                  // When both rows share an indexed value they touch the
                  // identical tree key frame(idx)‖frame(newKey); deleting first then
                  // re-inserting leaves the surviving (moving-row) entry in
                  // place. The reverse order would insert then delete, wrongly
                  // dropping the entry.
                  await this.indexManager.deleteIndexEntries(existingRow, newKey, txnState?.transactor);
                  await this.indexManager.updateIndexEntries(
                    oldRow,
                    values,
                    oldKey,
                    newKey,
                    txnState?.transactor
                  );

                  // The displaced row is gone, so the net row count drops by one
                  // — the one UPDATE that is not count-neutral, mirroring the
                  // delete path's decrementRowCount().
                  this.statisticsCollector?.decrementRowCount();

                  return { status: 'ok', row: values, replacedRow: existingRow };
                }

                // ABORT (default) / FAIL / ROLLBACK: reject the move
                // structurally. Stage nothing and touch no trees; the engine's
                // translateConflictError maps this to the right subclass for
                // FAIL/ROLLBACK. The vtab no longer throws for these modes.
                return {
                  status: 'constraint',
                  constraint: 'unique',
                  message: this.uniqueConstraintMessage(),
                  existingRow,
                };
              }

              // Snapshot before staging so a rollback reverts exactly this change.
              this.markDirtyTrees();

              // Key changed, no collision - delete old, insert new
              await this.collection.stage([
                [oldKey, undefined],
                [newKey, [newKey, encodedRow]]
              ]);
            } else {
              // Snapshot before staging so a rollback reverts exactly this change.
              this.markDirtyTrees();

              // Simple update
              await this.collection.stage([[newKey, [newKey, encodedRow]]]);
            }

            // Stage all index updates
            await this.indexManager.updateIndexEntries(
              oldRow,
              values,
              oldKey,
              newKey,
              txnState?.transactor
            );

            return { status: 'ok', row: values };
          }

        case 'delete':
          if (!oldKeyValues) {
            throw new Error('DELETE requires old key values');
          }
          {
            const deleteKey = this.rowCodec.extractPrimaryKey(oldKeyValues);

            // Fetch the actual old row before staging. Staging clears the slot,
            // so a fetch-after would return nothing. Fallback to oldKeyValues
            // (PK-only; index key may be wrong) if unexpectedly absent.
            const delEntry = await this.collection.get(deleteKey) as [string, EncodedRow] | undefined;
            const oldRow: Row = delEntry ? this.rowCodec.decodeRow(delEntry[1]) : (oldKeyValues as Row);

            // Snapshot before staging so a rollback reverts exactly this delete.
            this.markDirtyTrees();

            // Stage the main-table delete (flushed at commit / restored on rollback)
            await this.collection.stage([[deleteKey, undefined]]);

            // Stage deletes from all indexes
            await this.indexManager.deleteIndexEntries(oldRow, deleteKey, txnState?.transactor);

            // Update statistics
            this.statisticsCollector?.decrementRowCount();

            return { status: 'ok' };
          }

        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
    } catch (error) {
      // Rethrow QuereusErrors verbatim (e.g. a constraint violation surfaced by
      // an inner operation) so the engine keeps the error classification;
      // wrapping would mask it. Duplicate-key conflicts no longer reach here —
      // the INSERT and UPDATE paths return structured UpdateResults instead.
      if (error instanceof QuereusError) {
        throw error;
      }
      const message = `${operation} failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Add an index to the table schema
   */
  async addIndex(indexSchema: IndexSchema): Promise<void> {
    // Wait for initialization if needed
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.schemaManager || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    const storedSchema = await this.schemaManager.getSchema(this.tableName);
    if (!storedSchema) {
      throw new Error('Schema not found');
    }

    if (storedSchema.indexes.some(idx => idx.name === indexSchema.name)) {
      return;
    }

    // Add the index to the stored schema
    const updatedSchema = {
      ...storedSchema,
      indexes: [...storedSchema.indexes, {
        name: indexSchema.name,
        columns: indexSchema.columns.map((col: { index: number; desc?: boolean; collation?: string }) => ({
          index: col.index,
          desc: col.desc,
          collation: col.collation,
        })),
      }],
    };

    // Save the updated schema
    const txnState = this.txnBridge.getCurrentTransaction();
    await this.schemaManager.storeSchema({
      ...this.tableSchema,
      indexes: updatedSchema.indexes.map(idx => ({
        name: idx.name,
        columns: idx.columns,
      })),
    }, txnState?.transactor);

    // Initialize the new index tree
    const indexTreeFactory = async (indexName: string, transactor?: any) => {
      const indexOptions: ParsedOptimysticOptions = {
        ...this.options,
        collectionUri: `${this.options.collectionUri}/index/${indexName}`,
      };
      const tree = await this.collectionFactory.createOrGetCollection(
        indexOptions,
        transactor ? { transactor, isActive: true, collections: new Map(), stampId: '' } : undefined
      );
      return tree as unknown as Tree<string, IndexEntry>;
    };

    const indexTree = await indexTreeFactory(indexSchema.name, txnState?.transactor);

    // Add the index to the index manager
    if (this.indexManager) {
      this.indexManager.registerIndexTree(indexSchema.name, indexTree);
      this.indexManager.setSchema(updatedSchema);
    }

    // Register the new index collection so a session-mode coordinator sees it.
    // CREATE INDEX normally runs outside a DML transaction, so the coordinator
    // picks it up before the next transaction's snapshot. (An index created
    // mid-transaction would miss that transaction's already-taken snapshot — a
    // known, documented edge.)
    this.txnBridge.registerCollection(indexTree.getCollection());

    // Populate the index with existing data
    if (this.collection && this.rowCodec) {
      const firstPath = await this.collection.first();
      for await (const path of this.collection.ascending(firstPath)) {
        const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
        if (entry && entry.length >= 2) {
          const encodedRow = entry[1];
          const row = this.rowCodec.decodeRow(encodedRow);
          const primaryKey = this.rowCodec.extractPrimaryKey(row);
          await this.indexManager.insertIndexEntries(row, primaryKey, txnState?.transactor);
        }
      }

      // insertIndexEntries only STAGES now. addIndex runs outside the DML
      // transaction's commit (and Tree.replace() used to persist inline), so
      // flush the freshly populated index to storage here. Trees with nothing
      // staged sync as a no-op.
      for (const tree of this.indexManager.getIndexTrees()) {
        await tree.sync();
      }
    }
  }

  /**
   * Begin a transaction on this virtual table
   */
  async begin(): Promise<void> {
    try {
      await this.ensureConnectionRegistered();
      await this.txnBridge.beginTransaction(this.options);
    } catch (error) {
      const message = `Begin transaction failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Commit the virtual table transaction
   */
  async commit(): Promise<void> {
    try {
      await this.txnBridge.commitTransaction();
    } catch (error) {
      const message = `Commit transaction failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Rollback the virtual table transaction
   */
  async rollback(): Promise<void> {
    try {
      await this.txnBridge.rollbackTransaction();
    } catch (error) {
      const message = `Rollback transaction failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Delete this table's own persisted schema entry as part of teardown. Reads
   * its own transaction bridge for the active transactor and delegates to the
   * schema manager. Called from the module's destroy() on the resolved sibling
   * instance so the teardown path never reaches across this class's private
   * members. Best-effort by contract: the caller wraps this in a try/catch so a
   * schema-tree write failure can't stop teardown.
   */
  async deleteOwnSchema(tableName: string): Promise<void> {
    const txnState = this.txnBridge.getCurrentTransaction();
    await this.schemaManager.deleteSchema(tableName, txnState?.transactor);
  }
}

/**
 * Per-scan read-only wrapper exposing the COMMITTED (pre-transaction) view of an
 * already-initialized {@link OptimysticVirtualTable}.
 *
 * Returned by {@link OptimysticModule.connect} when Quereus passes
 * `_readCommitted: true` — the signal that this connection backs a `committed.<Table>`
 * reference inside a deferred CHECK (e.g. `FormationUsage.Monotonic`'s
 * `select max(UseNumber) from committed.FormationUsage`). Such a read MUST exclude the
 * rows the in-flight transaction has staged.
 *
 * Why a separate object rather than a flag on the shared table: `connect()` resolves to
 * a cached singleton per `schema.table`, and during deferred-constraint drain the engine
 * may scan the SAME table both live (e.g. `Strand.Authorized`'s `from FormationUsage`)
 * and committed. Storing committed-ness on the singleton would let one scan corrupt the
 * other's view. This wrapper is created per connect call and holds no mutable state — the
 * per-scan committed tracker is built and discarded inside the shared table's
 * {@link OptimysticVirtualTable.queryCommitted}. Mirrors the in-memory vtab's
 * unregistered committed-snapshot connection.
 */
class OptimysticCommittedTable extends VirtualTable {
  constructor(private readonly inner: OptimysticVirtualTable) {
    super(inner.db, inner.module, inner.schemaName, inner.tableName);
    this.tableSchema = inner.tableSchema;
  }

  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    yield* this.inner.queryCommitted(filterInfo);
  }

  async update(): Promise<UpdateResult> {
    throw new QuereusError('Cannot modify committed-state snapshot', StatusCode.ERROR);
  }

  async disconnect(): Promise<void> {
    // No-op: the committed view shares the inner table's lifetime and owns no
    // resources (its per-scan read tracker is created and dropped inside query()).
  }
}

/**
 * Optimystic Virtual Table Module
 */
export class OptimysticModule implements VirtualTableModule<VirtualTable, OptimysticModuleConfig> {
  private tables = new Map<string, OptimysticVirtualTable>();
  // The schema tree (`tree://optimystic/schema`) is plugin-global, so a single
  // SchemaManager per (transactor, key-network, network-name, raw-storage-
  // factory) tuple is enough. Sharing it means hydrateCatalog's `listTables`/
  // `getSchema` populate the same `schemaCache` that each table's
  // doInitialize will later consult, turning N per-table tree walks into N
  // cache hits.
  private schemaManagers = new Map<string, SchemaManager>();

  constructor(
    private collectionFactory: CollectionFactory,
    private txnBridge: TransactionBridge
  ) {}

  /**
   * Create a schema manager for a specific table's transactor configuration
   */
  private createSchemaManager(tableOptions: ParsedOptimysticOptions): SchemaManager {
    const fingerprint = [
      tableOptions.transactor ?? '',
      tableOptions.keyNetwork ?? '',
      tableOptions.libp2pOptions?.networkName ?? '',
      tableOptions.libp2pOptions?.port ?? 0,
      tableOptions.rawStorageFactory ? '1' : '0',
    ].join('|');
    const cached = this.schemaManagers.get(fingerprint);
    if (cached) return cached;

    const manager = new SchemaManager(async (transactor) => {
      const schemaOptions: ParsedOptimysticOptions = {
        collectionUri: 'tree://optimystic/schema',
        transactor: tableOptions.transactor,
        keyNetwork: tableOptions.keyNetwork,
        libp2p: tableOptions.libp2p,
        libp2pOptions: tableOptions.libp2pOptions,
        cache: true,
        encoding: 'json',
        rawStorageFactory: tableOptions.rawStorageFactory,
      };
      return await this.collectionFactory.createOrGetCollection(
        schemaOptions,
        transactor ? { transactor, isActive: true, collections: new Map(), stampId: '' } : undefined
      );
    });
    this.schemaManagers.set(fingerprint, manager);
    return manager;
  }

  /**
   * Parse table schema options into configuration
   */
  private parseTableSchema(tableSchema: TableSchema): ParsedOptimysticOptions {
    const args = tableSchema.vtabArgs || {};
    // Plugin-level defaults — configured via the `config` object passed to register()
    // and surfaced on the table schema as `vtabAuxData`. Per-table `USING optimystic(...)`
    // args override these; unset defaults fall back to production values.
    const aux = ((tableSchema as unknown as { vtabAuxData?: Record<string, unknown> }).vtabAuxData) ?? {};

    // Extract collection URI from first positional argument or use default
    const collectionUri = (args['0'] as string) || `tree://default/${tableSchema.name}`;

    // Extract named arguments
    const transactor = (args['transactor'] as string) || (aux['default_transactor'] as string) || 'network';
    const keyNetwork = (args['keyNetwork'] as string) || (aux['default_key_network'] as string) || 'libp2p';
    const port = typeof args['port'] === 'number' ? args['port'] : (typeof aux['default_port'] === 'number' ? aux['default_port'] as number : 0);
    const networkName = (args['networkName'] as string) || (aux['default_network_name'] as string) || 'optimystic';
    const cache = args['cache'] !== false;
    const encoding = (args['encoding'] as 'json' | 'msgpack') || 'json';
    // Plugin-level only (not exposed via per-table USING args because it's a function reference).
    const rawStorageFactory = typeof aux['rawStorageFactory'] === 'function'
      ? (aux['rawStorageFactory'] as () => IRawStorage)
      : undefined;

    const options: ParsedOptimysticOptions = {
      collectionUri,
      transactor,
      keyNetwork,
      libp2pOptions: {
        port,
        networkName,
        bootstrapNodes: [],
      },
      cache,
      encoding,
      rawStorageFactory,
    };

    return options;
  }

  /**
   * Build (and cache) an OptimysticVirtualTable for the given TableSchema.
   * Shared by create() (new storage), connect() (catalog-bound after import or
   * via runtime query), and hydrateCatalog() (catalog warm-up).
   */
  private async instantiateTable(
    db: Database,
    tableSchema: TableSchema,
    options?: ParsedOptimysticOptions
  ): Promise<OptimysticVirtualTable> {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
    const existing = this.tables.get(tableKey);
    if (existing) {
      await existing.initialize();
      return existing;
    }

    const tableOptions = options ?? this.parseTableSchema(tableSchema);
    const schemaManager = this.createSchemaManager(tableOptions);
    const table = new OptimysticVirtualTable(
      db,
      this,
      tableSchema.schemaName || 'main',
      tableSchema.name,
      tableSchema,
      tableOptions,
      this.collectionFactory,
      this.txnBridge,
      schemaManager
    );

    this.tables.set(tableKey, table);
    return table;
  }

  /**
   * Creates the persistent definition of a virtual table
   */
  async create(
    db: Database,
    tableSchema: TableSchema
  ): Promise<OptimysticVirtualTable> {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

    // Check if table already exists
    if (this.tables.has(tableKey)) {
      throw new Error(`Optimystic table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'.`);
    }

    const table = await this.instantiateTable(db, tableSchema);

    // Initialize table and register connection before returning
    // This ensures the table is fully ready for queries and transactions
    await table.initialize();
    await table.ensureConnectionRegistered();

    return table;
  }

  /**
   * Connects to an existing virtual table definition.
   * If the table isn't yet cached (e.g. after catalog hydration on a fresh
   * `Database`, or when called by Quereus's runtime against an imported
   * schema), instantiate it from the supplied tableSchema and let
   * initialize() bind it to the persisted storage.
   *
   * When Quereus passes `_readCommitted: true` (a `committed.<Table>` reference in a
   * deferred CHECK), wrap the resolved table in a per-scan {@link OptimysticCommittedTable}
   * that reads the pre-transaction snapshot — see that class for why the committed view is
   * a distinct object rather than a flag on the cached singleton.
   */
  async connect(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string,
    options: OptimysticModuleConfig,
    tableSchema?: TableSchema
  ): Promise<VirtualTable> {
    const baseTable = await this.resolveConnectedTable(db, schemaName, tableName, tableSchema);

    // Honour the committed-read flag with a per-scan read-only view; the shared table
    // is unchanged, so a concurrent live scan of it keeps its live view.
    if (options?._readCommitted) {
      return new OptimysticCommittedTable(baseTable);
    }
    return baseTable;
  }

  /**
   * Resolve (and initialize) the cached {@link OptimysticVirtualTable} for a
   * schema.table, instantiating it from the supplied/looked-up schema on first
   * connect. Shared by {@link connect} for both the live and committed-read paths.
   */
  private async resolveConnectedTable(
    db: Database,
    schemaName: string,
    tableName: string,
    tableSchema?: TableSchema
  ): Promise<OptimysticVirtualTable> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const existingTable = this.tables.get(tableKey);

    if (existingTable) {
      await existingTable.initialize();
      return existingTable;
    }

    const resolvedSchema = tableSchema ?? db.schemaManager.findTable(tableName, schemaName);
    if (!resolvedSchema) {
      throw new Error(`Optimystic table definition for '${tableName}' not found. Cannot connect.`);
    }

    const table = await this.instantiateTable(db, resolvedSchema);
    await table.initialize();
    await table.ensureConnectionRegistered();

    return table;
  }

  /**
   * Hydrate Quereus's in-memory catalog from persisted vtab schemas, so a
   * subsequent `apply schema` (or `CREATE TABLE IF NOT EXISTS`) sees existing
   * tables and avoids re-emitting per-table CREATE/CREATE INDEX statements
   * against storage on every cold start.
   *
   * Idempotent — tables already present in the catalog are skipped.
   * Returns the count of tables and indexes added to the catalog.
   */
  async hydrateCatalog(
    db: Database,
    config: Record<string, SqlValue> = {},
    auxData?: unknown
  ): Promise<{ tables: number; indexes: number }> {
    const options = this.deriveDefaultOptions(config);
    const schemaManager = this.createSchemaManager(options);

    let tableNames: string[];
    try {
      tableNames = await schemaManager.listTables();
    } catch (error) {
      // No persisted schema tree yet (cold start) — nothing to hydrate.
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|missing|empty/i.test(message)) {
        return { tables: 0, indexes: 0 };
      }
      throw error;
    }

    const targetSchemaName = db.schemaManager.getCurrentSchemaName();
    const targetSchema = db.schemaManager.getSchemaOrFail(targetSchemaName);

    let tables = 0;
    let indexes = 0;
    for (const tableName of tableNames) {
      if (targetSchema.getTable(tableName)) continue;

      const stored = await schemaManager.getSchema(tableName);
      if (!stored) continue;

      const tableSchema = schemaManager.storedToTableSchema(stored, this, auxData);
      // Re-stamp the schema name in case the host's current schema differs
      // from whatever was persisted.
      const hydratedSchema: TableSchema = {
        ...tableSchema,
        schemaName: targetSchemaName,
      };
      targetSchema.addTable(hydratedSchema);
      tables++;
      indexes += hydratedSchema.indexes?.length ?? 0;
    }

    return { tables, indexes };
  }

  /**
   * Mirror parseTableSchema's default-resolution against the plugin's
   * registration config so hydrateCatalog can open the schema tree using the
   * same transactor/network the tables themselves will use.
   */
  private deriveDefaultOptions(config: Record<string, SqlValue>): ParsedOptimysticOptions {
    const aux = config as Record<string, unknown>;
    const transactor = (aux['default_transactor'] as string) || 'network';
    const keyNetwork = (aux['default_key_network'] as string) || 'libp2p';
    const port = typeof aux['default_port'] === 'number' ? (aux['default_port'] as number) : 0;
    const networkName = (aux['default_network_name'] as string) || 'optimystic';
    const rawStorageFactory = typeof aux['rawStorageFactory'] === 'function'
      ? (aux['rawStorageFactory'] as () => IRawStorage)
      : undefined;

    return {
      collectionUri: 'tree://optimystic/schema',
      transactor,
      keyNetwork,
      libp2pOptions: {
        port,
        networkName,
        bootstrapNodes: [],
      },
      cache: true,
      encoding: 'json',
      rawStorageFactory,
    };
  }

  /**
   * Creates an index on an Optimystic virtual table
   */
  async createIndex(
    _db: Database,
    schemaName: string,
    tableName: string,
    indexSchema: IndexSchema
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const table = this.tables.get(tableKey);

    if (!table) {
      throw new Error(`Optimystic table '${tableName}' not found in schema '${schemaName}'. Cannot create index.`);
    }

    // Update the stored schema with the new index
    await table.addIndex(indexSchema);
  }

  /**
   * Modern access planning interface using BestAccessPlanRequest/Result
   */
  getBestAccessPlan(
    _db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult {
    // Get statistics for cost estimation - note: statisticsCollector is per-table, not per-module
    // For now, use default estimates
    const tableRowCount = tableInfo.estimatedRows || 1000000;
    const tableScanCost = Math.max(1000, tableRowCount);

    // Track best plan found
    let bestCost = tableScanCost;
    let bestRows = tableRowCount;
    let bestHandledFilters: boolean[] = request.filters.map(() => false);
    let bestOrdering: OrderingSpec[] | undefined = undefined;
    let bestIsSet = false;
    let bestExplains = `Full table scan (${tableRowCount} rows)`;
    let bestIndexName: string | undefined = undefined;
    let bestSeekColumnIndexes: number[] | undefined = undefined;

    // Check primary key constraints first
    const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);

    // Check if ALL primary key columns have equality constraints (required for point lookup)
    const fullPkEquality = pkColumns.length > 0 && pkColumns.every(pkCol =>
      request.filters.some(f => f && f.usable && f.op === '=' && f.columnIndex === pkCol)
    );

    for (let i = 0; i < request.filters.length; i++) {
      const filter = request.filters[i];
      if (!filter || !filter.usable) continue;

      // Check if this is a primary key column
      const isPkColumn = pkColumns.includes(filter.columnIndex);

      if (isPkColumn && filter.op === '=' && fullPkEquality) {
        // Full primary key equality - best case: O(log n)
        const pkCost = Math.log2(Math.max(2, tableRowCount)) * 2;
        bestCost = pkCost;
        bestRows = 1;
        // Mark ALL PK equality filters as handled
        bestHandledFilters = request.filters.map((f) =>
          f != null && f.usable && f.op === '=' && pkColumns.includes(f.columnIndex)
        );
        bestIsSet = true; // PK lookup guarantees unique row
        bestIndexName = '_primary_';
        bestSeekColumnIndexes = [...pkColumns];
        bestExplains = `Primary key equality seek (cost: ${pkCost.toFixed(2)})`;

        // Point lookup always satisfies any ORDER BY (single row)
        if (request.requiredOrdering && request.requiredOrdering.length > 0) {
          bestOrdering = [...request.requiredOrdering];
        }
        break; // Can't get better than this
      } else if (isPkColumn && filter.op === '=' && !fullPkEquality) {
        // Partial PK match - don't mark as handled, let Quereus apply the filter
        // but still estimate reduced selectivity for cost calculation
        const partialPkCost = tableRowCount * 0.3;
        if (partialPkCost < bestCost) {
          bestCost = partialPkCost;
          bestRows = Math.max(1, Math.floor(tableRowCount * 0.3));
          bestHandledFilters = request.filters.map(() => false); // NOT handled
          bestIsSet = false;
          bestExplains = `Partial primary key scan (cost: ${partialPkCost.toFixed(2)})`;
        }
      } else if (isPkColumn && ['>', '>=', '<', '<='].includes(filter.op)) {
        // NOTE: Range seek deliberately not pushed down. RowCodec encodes numbers as toString()
        // (not order-preserving) and the tree uses a raw lexicographic comparator, so a seek span
        // would return wrong results for numeric/DESC keys. Let Quereus apply the predicate over a
        // full scan instead. Revisit when debt-optimystic-pk-range-seek lands (prereq:
        // optimystic-tree-comparator-lexicographic-missort).
        const selectivity = 0.25;
        const rangeCost = Math.log2(Math.max(2, tableRowCount)) * 2 + tableRowCount * selectivity;
        const rangeRows = Math.floor(tableRowCount * selectivity);

        if (rangeCost < bestCost) {
          bestCost = rangeCost;
          bestRows = rangeRows;
          bestHandledFilters = request.filters.map(() => false); // NOT handled — engine applies predicate
          bestExplains = `Primary key range scan (selectivity: ${selectivity.toFixed(2)}, cost: ${rangeCost.toFixed(2)})`;
          // No bestIndexName / bestSeekColumnIndexes / bestOrdering — no seek until comparator is correct
        }
      }
    }

    // Check secondary indexes if we haven't found a PK equality match
    if (bestCost > 10 && tableInfo.indexes && tableInfo.indexes.length > 0) {
      for (const index of tableInfo.indexes) {
        // Try to match constraints to this index
        const indexColumns = index.columns.map(col => col.index);
        let selectivity = 1.0;
        let matchedFilterIndices: number[] = [];

        // Check if we have equality constraints on the index columns
        for (let colIdx = 0; colIdx < indexColumns.length; colIdx++) {
          const indexCol = indexColumns[colIdx];
          let foundEq = false;

          for (let i = 0; i < request.filters.length; i++) {
            const filter = request.filters[i];
            if (!filter || !filter.usable) continue;

            if (filter.columnIndex === indexCol && filter.op === '=') {
              matchedFilterIndices.push(i);
              foundEq = true;
              // Each equality constraint reduces selectivity
              const colSelectivity = 0.1; // Heuristic selectivity estimate
              selectivity *= colSelectivity;
              break;
            }
          }

          // If we didn't find an equality constraint for this column, stop matching
          if (!foundEq) {
            break;
          }
        }

        // Calculate cost and rows for this index
        if (matchedFilterIndices.length > 0) {
          const indexCost = Math.log2(Math.max(2, tableRowCount)) * 2 + tableRowCount * selectivity;
          const indexRows = Math.max(1, Math.floor(tableRowCount * selectivity));

          // If this index is better than what we have, use it
          if (indexCost < bestCost) {
            bestCost = indexCost;
            bestRows = indexRows;
            bestHandledFilters = request.filters.map((_, idx) => matchedFilterIndices.includes(idx));
            // Note: IndexSchema doesn't have unique property in quereus 0.4.8, so we can't determine uniqueness
            bestIsSet = false;
            bestIndexName = index.name;
            bestSeekColumnIndexes = matchedFilterIndices.map(fi => request.filters[fi]!.columnIndex);
            bestExplains = `Index seek on ${index.name} ` +
              `(selectivity: ${selectivity.toFixed(4)}, cost: ${indexCost.toFixed(2)})`;

            // Check if ORDER BY matches index order
            if (request.requiredOrdering && this.orderingMatchesIndex(request.requiredOrdering, index, tableInfo)) {
              bestOrdering = [...request.requiredOrdering];
            }
          }
        }
      }
    }

    // Return the best access plan found
    return {
      handledFilters: bestHandledFilters,
      cost: bestCost,
      rows: bestRows,
      providesOrdering: bestOrdering,
      indexName: bestIndexName,
      seekColumnIndexes: bestSeekColumnIndexes,
      isSet: bestIsSet,
      explains: bestExplains,
    };
  }

  /**
   * Helper: Check if required ordering matches index order AND the storage tree
   * can actually deliver it.
   *
   * The index tree is opened with a raw lexicographic string comparator
   * (collection-factory.ts) and is only ever iterated forward. It therefore only
   * *delivers* an ascending, BINARY-collated ordering over columns whose payload
   * is the raw stored string (TEXT). Numeric columns are keyed via a
   * non-order-preserving `toExponential(15)` payload, DESC needs reverse
   * iteration, and non-BINARY collations need a collation-aware compare — none of
   * which the tree provides. Promising `providesOrdering` for those cases makes
   * the engine skip its own sort and return genuinely mis-ordered rows.
   *
   * So: match positionally (column + prefix length) AND require every ordered
   * column to be ASC + BINARY + TEXT. Anything else → return false so the engine
   * sorts (correct, just not pushed down). True numeric/DESC/collated ordering is
   * gated work — see `debt-optimystic-true-key-ordering`.
   */
  private orderingMatchesIndex(
    requiredOrdering: readonly OrderingSpec[],
    index: { columns: readonly { index: number; desc?: boolean }[] },
    tableInfo: TableSchema
  ): boolean {
    if (requiredOrdering.length > index.columns.length) return false;

    for (let i = 0; i < requiredOrdering.length; i++) {
      const orderSpec = requiredOrdering[i];
      const indexCol = index.columns[i];

      if (!orderSpec || !indexCol) return false;
      if (orderSpec.columnIndex !== indexCol.index) return false;

      // Only promise the ordering the raw ascending lexicographic tree genuinely delivers.
      if (!this.treeDeliversOrdering(orderSpec, tableInfo)) return false;
    }

    return true;
  }

  /**
   * True only when a raw lexicographic, ascending, forward-iterated tree scan
   * coincides with the SQL order requested for this column: the request must be
   * ASC, the column BINARY-collated, and its physical storage a raw string
   * (TEXT). DESC, non-BINARY collations, and numeric/blob payloads are all
   * encoded/iterated in a way the tree cannot reproduce, so the engine must sort.
   */
  private treeDeliversOrdering(
    orderSpec: OrderingSpec,
    tableInfo: TableSchema
  ): boolean {
    // Reverse iteration is not available: a forward-only tree can never provide DESC.
    if (orderSpec.desc) return false;

    const col = tableInfo.columns[orderSpec.columnIndex];
    if (!col) return false;

    // TEXT is the only affinity stored as a raw, order-preserving string payload.
    // NOTE: this gates on the *declared* physicalType, but the stored index payload is
    // chosen by the runtime JS value type in serializeIndexValue() (string -> raw,
    // number -> non-order-preserving toExponential). They agree only because Quereus
    // coerces TEXT-affinity inserts to strings before they reach this vtab. If that
    // coercion contract ever changes (a numeric value reaching a TEXT column un-coerced),
    // the promise here would over-order — anchor the check to the persisted affinity then.
    if (col.logicalType?.physicalType !== PhysicalType.TEXT) return false;

    // The tree compares raw code units — that is BINARY. Any other declared
    // collation (NOCASE, RTRIM, custom) would order differently.
    const collation = (col.collation || 'BINARY').toUpperCase();
    if (collation !== 'BINARY') return false;

    return true;
  }

  /**
   * Destroys the underlying persistent representation of the virtual table.
   * Removes the table from the internal registry so the name can be re-used,
   * and deletes the persisted schema entry so a subsequent CREATE TABLE with
   * the same name picks up the new shape rather than the old one.
   */
  async destroy(
    _db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const table = this.tables.get(tableKey);
    if (table) {
      // Release the collection-change → watch bridge before forgetting the table
      // so the storage listener doesn't leak past the table's lifetime.
      table.teardownChangeSubscription();
      try {
        await table.deleteOwnSchema(tableName);
      } catch {
        // Best-effort: a schema-tree write failure shouldn't stop teardown.
      }
    }
    this.tables.delete(tableKey);
  }
}
