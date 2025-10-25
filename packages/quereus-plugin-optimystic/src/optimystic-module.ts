/**
 * Optimystic Virtual Table Module for Quereus
 *
 * This module implements the VirtualTableModule interface to create
 * virtual tables backed by Optimystic distributed tree collections.
 */

import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import type { ParsedOptimysticOptions } from './types.js';
import { VirtualTable } from '@quereus/quereus';
import type { VirtualTableModule, BaseModuleConfig, Database, TableSchema, Row, FilterInfo, RowOp, BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import { SchemaManager } from './schema/schema-manager.js';
import { RowCodec } from './schema/row-codec.js';
import { IndexManager } from './schema/index-manager.js';
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
 * Production-grade virtual table for Optimystic tree collections
 */
export class OptimysticVirtualTable extends VirtualTable {
  private collection?: Tree<string, any>;
  private isInitialized = false;
  private txnBridge: TransactionBridge;
  private collectionFactory: CollectionFactory;
  private options: ParsedOptimysticOptions;
  private schemaManager: SchemaManager;
  private rowCodec?: RowCodec;
  private indexManager?: IndexManager;
  private statisticsCollector?: StatisticsCollector;
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
  }

  /**
   * Initialize the table and its collection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      const txnState = this.txnBridge.getCurrentTransaction();
      this.collection = await this.collectionFactory.createOrGetCollection(
        this.options,
        txnState || undefined
      );

      // If this is a new table (xCreate), store the schema
      // If connecting to existing table (xConnect), load the schema
      let storedSchema = await this.schemaManager.getSchema(this.tableName, txnState?.transactor);

      if (!storedSchema) {
        // New table - store the schema
        if (this.tableSchema.columns.length === 0) {
          throw new Error('Cannot create table without column definitions');
        }
        await this.schemaManager.storeSchema(this.tableSchema, txnState?.transactor);
        storedSchema = await this.schemaManager.getSchema(this.tableName, txnState?.transactor);
        if (!storedSchema) {
          throw new Error('Failed to store and retrieve schema');
        }
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
          transactor ? { transactor, isActive: true, collections: new Map() } : undefined
        );
        // Index trees store string->string mappings (IndexKey->PrimaryKey)
        return tree as unknown as Tree<string, string>;
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
   */
  async disconnect(): Promise<void> {
    this.collection = undefined;
    this.isInitialized = false;
  }

  /**
   * Opens a direct data stream for this virtual table based on filter criteria
   */
  async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    try {
      if (filterInfo.idxNum === 1) {
        // Point lookup on primary key
        yield* this.executePointLookup(filterInfo.args[0] ? String(filterInfo.args[0]) : '');
      } else if (filterInfo.idxNum === 2) {
        // Range query on primary key
        yield* this.executeRangeQuery(filterInfo);
      } else if (filterInfo.idxNum >= 10) {
        // Index-based scan
        const indexName = filterInfo.idxStr;
        if (!indexName || typeof indexName !== 'string') {
          throw new Error('Index name not provided for index scan');
        }
        yield* this.executeIndexScan(indexName, filterInfo.args);
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
   * Execute a point lookup query
   */
  private async* executePointLookup(key: string): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec) return;

    const path = await this.collection.find(key);
    if (!this.collection.isValid(path)) {
      return;
    }

    const entry = this.collection.at(path) as [string, any];
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
   * Execute a full table scan
   */
  private async* executeTableScan(): AsyncIterable<Row> {
    if (!this.collection || !this.rowCodec) return;

    try {
      const iterator = this.collection.range(new KeyRange<string>(undefined, undefined, true));

      for await (const path of iterator) {
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
    } catch (error) {
      // Fallback plain ascending iteration if needed
      const iterator = this.collection.range({ isAscending: true } as any);

      for await (const path of iterator) {
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
  }

  /**
   * Performs an INSERT, UPDATE, or DELETE operation
   */
  async update(
    operation: RowOp,
    values: Row | undefined,
    oldKeyValues?: Row
  ): Promise<Row | undefined> {
    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
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
            await this.collection.replace([[insertKey, encodedRow]]);

            // Insert into all indexes
            await this.indexManager.insertIndexEntries(values, insertKey, txnState?.transactor);

            // Update statistics
            this.statisticsCollector?.incrementRowCount();

            return values;
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
                [newKey, encodedRow]
              ]);
            } else {
              // Simple update
              await this.collection.replace([[newKey, encodedRow]]);
            }

            // Update all indexes
            await this.indexManager.updateIndexEntries(
              oldKeyValues,
              values,
              oldKey,
              newKey,
              txnState?.transactor
            );

            return values;
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

            return undefined;
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
   * Begin a transaction on this virtual table
   */
  async begin(): Promise<void> {
    try {
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
  private schemaManager: SchemaManager;

  constructor(
    private collectionFactory: CollectionFactory,
    private txnBridge: TransactionBridge
  ) {
    // Create schema manager with a factory function for the schema tree
    this.schemaManager = new SchemaManager(async (transactor) => {
      const schemaOptions: ParsedOptimysticOptions = {
        collectionUri: 'tree://optimystic/schema',
        transactor: 'network',
        keyNetwork: 'libp2p',
        libp2pOptions: {
          port: 0,
          networkName: 'optimystic',
          bootstrapNodes: [],
        },
        cache: true,
        encoding: 'json',
      };
      return await this.collectionFactory.createOrGetCollection(
        schemaOptions,
        transactor ? { transactor, isActive: true, collections: new Map() } : undefined
      );
    });
  }

  /**
   * Parse table schema options into configuration
   */
  private parseTableSchema(tableSchema: TableSchema): ParsedOptimysticOptions {
    const args = tableSchema.vtabArgs || {};

    // Extract collection URI from first positional argument or use default
    const collectionUri = (args['0'] as string) || `tree://default/${tableSchema.name}`;

    // Extract named arguments
    const transactor = (args['transactor'] as string) || 'network';
    const keyNetwork = (args['keyNetwork'] as string) || 'libp2p';
    const port = typeof args['port'] === 'number' ? args['port'] : 0;
    const networkName = (args['networkName'] as string) || 'optimystic';
    const cache = args['cache'] !== false;
    const encoding = (args['encoding'] as 'json' | 'msgpack') || 'json';

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
    };

    return options;
  }

  /**
   * Creates the persistent definition of a virtual table
   */
  create(
    db: Database,
    tableSchema: TableSchema
  ): OptimysticVirtualTable {
    const options = this.parseTableSchema(tableSchema);
    const table = new OptimysticVirtualTable(
      db,
      this,
      tableSchema.schemaName || 'main',
      tableSchema.name,
      tableSchema,
      options,
      this.collectionFactory,
      this.txnBridge,
      this.schemaManager
    );

    // Initialize asynchronously - this might need to be handled differently
    table.initialize().catch(error => {
      console.error('Failed to initialize Optimystic table:', error);
    });

    return table;
  }

  /**
   * Connects to an existing virtual table definition
   */
  connect(
    db: Database,
    _pAux: unknown,
    moduleName: string,
    schemaName: string,
    tableName: string,
    options: OptimysticModuleConfig
  ): OptimysticVirtualTable {
    const parsedOptions: ParsedOptimysticOptions = {
      collectionUri: options.collectionUri,
      transactor: options.transactor || 'network',
      keyNetwork: options.keyNetwork || 'libp2p',
      libp2pOptions: {
        port: options.port || 0,
        networkName: options.networkName || 'optimystic',
        bootstrapNodes: [],
      },
      cache: options.cache !== false,
      encoding: options.encoding || 'json',
    };

    // For connect, we need to retrieve the schema from storage
    // For now, create a minimal schema - this will be loaded during initialize
    const tableSchema: TableSchema = {
      name: tableName,
      schemaName,
      columns: [],
      columnIndexMap: new Map(),
      primaryKeyDefinition: [],
      checkConstraints: [],
      vtabModule: this,
      vtabModuleName: moduleName,
      vtabArgs: options as any,
      isView: false,
    };

    const table = new OptimysticVirtualTable(
      db,
      this,
      schemaName,
      tableName,
      tableSchema,
      parsedOptions,
      this.collectionFactory,
      this.txnBridge,
      this.schemaManager
    );

    // Initialize asynchronously - will load schema from storage
    table.initialize().catch(error => {
      console.error('Failed to initialize Optimystic table:', error);
    });

    return table;
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

    // Check primary key constraints first
    const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);
    for (let i = 0; i < request.filters.length; i++) {
      const filter = request.filters[i];
      if (!filter || !filter.usable) continue;

      // Check if this is a primary key column
      const isPkColumn = pkColumns.includes(filter.columnIndex);

      if (isPkColumn && filter.op === '=') {
        // Primary key equality - best case: O(log n)
        const pkCost = Math.log2(Math.max(2, tableRowCount)) * 2;
        bestCost = pkCost;
        bestRows = 1;
        bestHandledFilters = request.filters.map((_, idx) => idx === i);
        bestIsSet = true; // PK lookup guarantees unique row
        bestExplains = `Primary key equality seek (cost: ${pkCost.toFixed(2)})`;

        // Point lookup always satisfies any ORDER BY (single row)
        if (request.requiredOrdering && request.requiredOrdering.length > 0) {
          bestOrdering = [...request.requiredOrdering];
        }
        break; // Can't get better than this
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
   * Destroys the underlying persistent representation of the virtual table
   */
  async destroy(
    _db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    // For now, this is a no-op since we don't have persistent schema storage
    // In a full implementation, this would clean up any metadata or resources
    console.log(`Destroying virtual table ${schemaName}.${tableName}`);
  }
}
