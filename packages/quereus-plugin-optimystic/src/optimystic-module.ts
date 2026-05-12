/**
 * Optimystic Virtual Table Module for Quereus
 *
 * This module implements the VirtualTableModule interface to create
 * virtual tables backed by Optimystic distributed tree collections.
 */

import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OptimysticVirtualTableConnection } from './optimystic-adapter/vtab-connection.js';
import type { ParsedOptimysticOptions } from './types.js';
import type { IRawStorage } from '@optimystic/db-p2p';
import { VirtualTable } from '@quereus/quereus';
import type { VirtualTableModule, BaseModuleConfig, Database, TableSchema, Row, FilterInfo, BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, VirtualTableConnection, TableIndexSchema as IndexSchema, UpdateArgs, UpdateResult, SqlValue } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import { SchemaManager } from './schema/schema-manager.js';
import type { StoredTableSchema } from './schema/schema-manager.js';
import { RowCodec, type EncodedRow } from './schema/row-codec.js';
import { SqlDataType } from '@quereus/quereus';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, NUMERIC_TYPE, NULL_TYPE, BOOLEAN_TYPE, type LogicalType } from '@quereus/quereus';
import { IndexManager, type IndexEntry } from './schema/index-manager.js';
import { StatisticsCollector } from './schema/statistics-collector.js';



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
        await this.schemaManager.storeSchema(this.tableSchema, txnState?.transactor);
        const written = await this.schemaManager.getSchema(this.tableName, txnState?.transactor);
        if (!written) {
          throw new Error('Failed to store and retrieve schema');
        }
        storedSchema = written;
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

      this.isInitialized = true;
    } catch (error) {
      const message = `Failed to initialize Optimystic table: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
  }

  /**
   * Disconnects from this virtual table connection instance
   * Note: We don't reset isInitialized or collection here because the table
   * should remain initialized across multiple statements/connections
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
      // Check if there's already an active connection for this table in the database
      // Using type assertion to access internal methods
      const db = this.db as any;
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
   * Opens a direct data stream for this virtual table based on filter criteria
   */
  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
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
      // Parse idxStr to determine access strategy
      // Quereus uses idxStr like 'idx=_primary_(0);plan=2' for equality seeks
      // or 'idx=idx_category(0);plan=2' for secondary index seeks
      const planType = this.parsePlanType(filterInfo.idxStr);
      const indexName = this.parseIndexName(filterInfo.idxStr);

      // Determine if this is a secondary index (not primary key)
      const isSecondaryIndex = indexName != null && indexName !== '_primary_';

      if (isSecondaryIndex && filterInfo.args.length > 0) {
        // Secondary index seek - route to index scan
        yield* this.executeIndexScan(indexName, filterInfo.args);
      } else if (planType === 2 && filterInfo.args.length > 0) {
        // Primary key equality seek (plan=2)
        yield* this.executePointLookup(String(filterInfo.args[0]));
      } else if (planType === 3) {
        // Range query on primary key (plan=3)
        yield* this.executeRangeQuery(filterInfo);
      } else if (filterInfo.idxNum === 1) {
        // Legacy: Point lookup on primary key
        yield* this.executePointLookup(filterInfo.args[0] ? String(filterInfo.args[0]) : '');
      } else if (filterInfo.idxNum === 2) {
        // Legacy: Range query on primary key
        yield* this.executeRangeQuery(filterInfo);
      } else if (filterInfo.idxNum >= 10) {
        // Legacy: Index-based scan
        const idxName = filterInfo.idxStr;
        if (!idxName || typeof idxName !== 'string') {
          throw new Error('Index name not provided for index scan');
        }
        yield* this.executeIndexScan(idxName, filterInfo.args);
      } else {
        // Full table scan
        yield* this.executeTableScan();
      }
    } catch (error) {
      const message = `Query failed: ${error instanceof Error ? error.message : String(error)}`;
      this.setErrorMessage(message);
      throw new Error(message);
    }
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
   * Execute a point lookup query
   */
  private async* executePointLookup(key: string): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec) return;

    // Update from network to get latest data
    await this.collection.update();

    const path = await this.collection.find(key);
    if (!this.collection.isValid(path)) {
      return;
    }

    const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
    if (entry && entry.length >= 2) {
      const encodedRow = entry[1];
      const row = this.rowCodec.decodeRow(encodedRow);
      yield row;
    }
  }

  /**
   * Execute a range query
   */
  private async* executeRangeQuery(_filterInfo: FilterInfo): AsyncIterable<Row> {
    if (!this.collection) return;

    // For now, fall back to full scan
    // TODO: Implement proper range queries based on filter args
    yield* this.executeTableScan();
  }

  /**
   * Execute an index-based scan
   */
  private async* executeIndexScan(indexName: string, args: readonly unknown[]): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec || !this.indexManager) return;

    const indexSchema = this.indexManager.getIndexSchema(indexName);
    if (!indexSchema) {
      throw new Error(`Index not found: ${indexName}`);
    }

    // Update collection to get latest data
    await this.collection.update();

    // Build index key from constraint values
    // args contains the values for the matched constraints in order
    const indexKeyParts: string[] = [];
    for (let i = 0; i < args.length && i < indexSchema.columns.length; i++) {
      const value = args[i];
      indexKeyParts.push(this.serializeValueForIndex(value));
    }

    const indexKey = indexKeyParts.join('\x00');

    // Look up primary keys using the index
    for await (const primaryKey of this.indexManager.findByIndex(indexName, indexKey)) {
      // Fetch the row from the main table using the primary key
      const path = await this.collection.find(primaryKey);
      if (!this.collection.isValid(path)) {
        continue;
      }

      const entry = this.collection.at(path) as [string, any];
      if (entry && entry.length >= 2) {
        const encodedRow = entry[1];
        const row = this.rowCodec.decodeRow(encodedRow);
        yield row;
      }
    }
  }

  /**
   * Serialize a value for use in index key (helper for executeIndexScan)
   */
  private serializeValueForIndex(value: unknown): string {
    if (value === null || value === undefined) {
      return '\x01'; // Special marker for NULL
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return value.toExponential(15);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Uint8Array) {
      return btoa(String.fromCharCode(...value));
    }
    return String(value);
  }

  /**
   * Execute a full table scan with retry on path invalidation
   * In a distributed system, incoming replicated changes can mutate the tree during iteration.
   * This method handles path invalidation by restarting from the last known key.
   */
  private async* executeTableScan(): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec) return;

    // Update from network to get latest data
    await this.collection.update();

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

        const iterator = this.collection.range(range);

        for await (const path of iterator) {
          if (!this.collection.isValid(path)) {
            continue;
          }

          const entry = this.collection.at(path);
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

    // Capture the mutation statement if provided (for transaction replication)
    if (mutationStatement) {
      this.txnBridge.addStatement(mutationStatement);
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
            const encodedRow = this.rowCodec.encodeRow(values);

            // Insert into main table
            // Entry format: [primaryKey, encodedRow]
            await this.collection.replace([[insertKey, [insertKey, encodedRow]]]);

            // Insert into all indexes
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

            // Update main table
            if (oldKey !== newKey) {
              // Key changed - delete old, insert new
              await this.collection.replace([
                [oldKey, undefined],
                [newKey, [newKey, encodedRow]]
              ]);
            } else {
              // Simple update
              await this.collection.replace([[newKey, [newKey, encodedRow]]]);
            }

            // Update all indexes
            await this.indexManager.updateIndexEntries(
              oldKeyValues,
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

            // Delete from main table
            await this.collection.replace([[deleteKey, undefined]]);

            // Delete from all indexes
            await this.indexManager.deleteIndexEntries(oldKeyValues, deleteKey, txnState?.transactor);

            // Update statistics
            this.statisticsCollector?.decrementRowCount();

            return { status: 'ok' };
          }

        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
    } catch (error) {
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
      (this.indexManager as any).indexTrees.set(indexSchema.name, indexTree);
      (this.indexManager as any).schema = updatedSchema;
    }

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
}

/**
 * Optimystic Virtual Table Module
 */
export class OptimysticModule implements VirtualTableModule<OptimysticVirtualTable, OptimysticModuleConfig> {
  private tables = new Map<string, OptimysticVirtualTable>();

  constructor(
    private collectionFactory: CollectionFactory,
    private txnBridge: TransactionBridge
  ) {}

  /**
   * Create a schema manager for a specific table's transactor configuration
   */
  private createSchemaManager(tableOptions: ParsedOptimysticOptions): SchemaManager {
    return new SchemaManager(async (transactor) => {
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
   */
  async connect(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string,
    _options: OptimysticModuleConfig,
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
        // Primary key range scan: O(log n + k)
        const selectivity = 0.25; // Heuristic for range queries
        const rangeCost = Math.log2(Math.max(2, tableRowCount)) * 2 + tableRowCount * selectivity;
        const rangeRows = Math.floor(tableRowCount * selectivity);

        if (rangeCost < bestCost) {
          bestCost = rangeCost;
          bestRows = rangeRows;
          bestHandledFilters = request.filters.map((_, idx) => idx === i);
          bestIsSet = false;
          bestIndexName = '_primary_';
          bestSeekColumnIndexes = [...pkColumns];
          bestExplains = `Primary key range scan (selectivity: ${selectivity.toFixed(2)}, cost: ${rangeCost.toFixed(2)})`;

          // Check if ORDER BY matches primary key order
          if (request.requiredOrdering && this.orderingMatchesPrimaryKey(request.requiredOrdering, tableInfo)) {
            bestOrdering = [...request.requiredOrdering];
          }
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
            if (request.requiredOrdering && this.orderingMatchesIndex(request.requiredOrdering, index)) {
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
   * Helper: Check if required ordering matches primary key order
   */
  private orderingMatchesPrimaryKey(
    requiredOrdering: readonly OrderingSpec[],
    tableInfo: TableSchema
  ): boolean {
    const pkColumns = tableInfo.primaryKeyDefinition;
    if (requiredOrdering.length > pkColumns.length) return false;

    for (let i = 0; i < requiredOrdering.length; i++) {
      const orderSpec = requiredOrdering[i];
      const pkCol = pkColumns[i];

      if (!orderSpec || !pkCol) return false;
      if (orderSpec.columnIndex !== pkCol.index) return false;

      // Check if sort direction matches
      const pkDesc = pkCol.desc || false;
      if (orderSpec.desc !== pkDesc) return false;
    }

    return true;
  }

  /**
   * Helper: Check if required ordering matches index order
   */
  private orderingMatchesIndex(
    requiredOrdering: readonly OrderingSpec[],
    index: { columns: readonly { index: number; desc?: boolean }[] }
  ): boolean {
    if (requiredOrdering.length > index.columns.length) return false;

    for (let i = 0; i < requiredOrdering.length; i++) {
      const orderSpec = requiredOrdering[i];
      const indexCol = index.columns[i];

      if (!orderSpec || !indexCol) return false;
      if (orderSpec.columnIndex !== indexCol.index) return false;

      // Check if sort direction matches
      const indexDesc = indexCol.desc || false;
      if (orderSpec.desc !== indexDesc) return false;
    }

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
      try {
        const txnState = (table as any).txnBridge?.getCurrentTransaction?.();
        await (table as any).schemaManager.deleteSchema(tableName, txnState?.transactor);
      } catch {
        // Best-effort: a schema-tree write failure shouldn't stop teardown.
      }
    }
    this.tables.delete(tableKey);
  }
}
