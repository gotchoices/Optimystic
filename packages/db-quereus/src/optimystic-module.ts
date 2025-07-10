/**
 * Optimystic Virtual Table Module for Quereus
 *
 * This module implements the VirtualTableModule interface to create
 * virtual tables backed by Optimystic distributed tree collections.
 */

import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import type { ParsedOptimysticOptions, RowData } from './types.js';
import { VirtualTable, StatusCode } from '@quereus/quereus';
import type { VirtualTableModule, BaseModuleConfig, Database, TableSchema, Row, FilterInfo, IndexInfo, RowOp } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';

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
  private collection?: Tree<string, RowData>;
  private isInitialized = false;
  private txnBridge: TransactionBridge;
  private collectionFactory: CollectionFactory;
  private options: ParsedOptimysticOptions;

  constructor(
    db: Database,
    module: VirtualTableModule<any, any>,
    schemaName: string,
    tableName: string,
    options: ParsedOptimysticOptions,
    collectionFactory: CollectionFactory,
    txnBridge: TransactionBridge
  ) {
    super(db, module, schemaName, tableName);
    this.options = options;
    this.collectionFactory = collectionFactory;
    this.txnBridge = txnBridge;
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
  async xDisconnect(): Promise<void> {
    this.collection = undefined;
    this.isInitialized = false;
  }

  /**
   * Opens a direct data stream for this virtual table based on filter criteria
   */
  async* xQuery(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    try {
      switch (filterInfo.idxNum) {
        case 1: // Point lookup
          yield* this.executePointLookup(filterInfo.args[0] ? String(filterInfo.args[0]) : '');
          break;
        case 2: // Range query
          yield* this.executeRangeQuery(filterInfo);
          break;
        case 3: // Full scan
        default:
          yield* this.executeTableScan();
          break;
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
    if (!this.collection) return;

    const path = await this.collection.find(key);
    if (!this.collection.isValid(path)) {
      return;
    }

    const entry = this.collection.at(path);
    if (entry && entry.length >= 2) {
      yield [entry[0], entry[1]]; // [id, data]
    }
  }

  /**
   * Execute a range query
   */
  private async* executeRangeQuery(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (!this.collection) return;

    // For now, fall back to full scan
    // TODO: Implement proper range queries based on filter args
    yield* this.executeTableScan();
  }

  /**
   * Execute a full table scan
   */
  private async* executeTableScan(): AsyncIterable<Row> {
    if (!this.collection) return;

    try {
      // Try to use proper KeyRange
      const { KeyRange } = await import('@optimystic/db-core/src/btree/index.js');
      const iterator = this.collection.range(new KeyRange(undefined, undefined, true));

      for await (const path of iterator) {
        if (!this.collection.isValid(path)) {
          continue;
        }

        const entry = this.collection.at(path);
        if (entry && entry.length >= 2) {
          yield [entry[0], entry[1]]; // [id, data]
        }
      }
    } catch (error) {
      // Fallback for import issues
      const iterator = this.collection.range({ isAscending: true });

      for await (const path of iterator) {
        if (!this.collection.isValid(path)) {
          continue;
        }

        const entry = this.collection.at(path);
        if (entry && entry.length >= 2) {
          yield [entry[0], entry[1]]; // [id, data]
        }
      }
    }
  }

  /**
   * Performs an INSERT, UPDATE, or DELETE operation
   */
  async xUpdate(
    operation: RowOp,
    values: Row | undefined,
    oldKeyValues?: Row
  ): Promise<Row | undefined> {
    if (!this.collection) {
      throw new Error('Table not initialized');
    }

    try {
      switch (operation) {
        case 'INSERT':
          if (!values || values.length < 2) {
            throw new Error('INSERT requires id and data values');
          }
          const insertKey = String(values[0]);
          const insertData = values[1];
          await this.collection.replace([[insertKey, [insertKey, insertData]]]);
          return values;

        case 'UPDATE':
          if (!values || values.length < 2) {
            throw new Error('UPDATE requires id and data values');
          }
          if (!oldKeyValues || oldKeyValues.length < 1) {
            throw new Error('UPDATE requires old key values');
          }
          const oldKey = String(oldKeyValues[0]);
          const newKey = String(values[0]);
          const updateData = values[1];

          if (oldKey !== newKey) {
            // Key changed - delete old, insert new
            await this.collection.replace([
              [oldKey, undefined],
              [newKey, [newKey, updateData]]
            ]);
          } else {
            // Simple update
            await this.collection.replace([[newKey, [newKey, updateData]]]);
          }
          return values;

        case 'DELETE':
          if (!oldKeyValues || oldKeyValues.length < 1) {
            throw new Error('DELETE requires old key values');
          }
          const deleteKey = String(oldKeyValues[0]);
          await this.collection.replace([[deleteKey, undefined]]);
          return undefined;

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
  async xBegin(): Promise<void> {
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
  async xCommit(): Promise<void> {
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
  async xRollback(): Promise<void> {
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
  constructor(
    private collectionFactory: CollectionFactory,
    private txnBridge: TransactionBridge
  ) {}

  /**
   * Parse table schema options into configuration
   */
  private parseTableSchema(tableSchema: TableSchema): ParsedOptimysticOptions {
    // Extract configuration from table schema or use defaults
    // This would need to be adapted based on how Quereus passes table creation options
    const options: ParsedOptimysticOptions = {
      collectionUri: `tree://default/${tableSchema.name}`, // Default URI
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

    // TODO: Extract actual configuration from tableSchema if available
    // This might be stored in tableSchema metadata or options

    return options;
  }

  /**
   * Creates the persistent definition of a virtual table
   */
  xCreate(
    db: Database,
    tableSchema: TableSchema
  ): OptimysticVirtualTable {
    const options = this.parseTableSchema(tableSchema);
    const table = new OptimysticVirtualTable(
      db,
      this,
      tableSchema.schemaName || 'main',
      tableSchema.name,
      options,
      this.collectionFactory,
      this.txnBridge
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
  xConnect(
    db: Database,
    pAux: unknown,
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

    const table = new OptimysticVirtualTable(
      db,
      this,
      schemaName,
      tableName,
      parsedOptions,
      this.collectionFactory,
      this.txnBridge
    );

    // Initialize asynchronously
    table.initialize().catch(error => {
      console.error('Failed to initialize Optimystic table:', error);
    });

    return table;
  }

  /**
   * Determines the best query plan for a given set of constraints and orderings
   */
  xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
    try {
      // Simple implementation - prefer equality constraints on column 0 (id)
      let bestCost = 1000000.0;
      let bestRows = 1000000;
      let indexNum = 3; // Default to full scan

      for (let i = 0; i < indexInfo.aConstraint.length; i++) {
        const constraint = indexInfo.aConstraint[i];
        if (constraint.iColumn === 0 && constraint.op === 'EQ' && constraint.usable) {
          // Primary key equality - best case
          bestCost = 1.0;
          bestRows = 1;
          indexNum = 1;
          indexInfo.aConstraintUsage[i] = {
            argvIndex: i + 1,
            omit: true
          };
          break;
        } else if (constraint.iColumn === 0 && ['GT', 'GE', 'LT', 'LE'].includes(constraint.op) && constraint.usable) {
          // Range scan
          bestCost = 100.0;
          bestRows = 100;
          indexNum = 2;
          indexInfo.aConstraintUsage[i] = {
            argvIndex: i + 1,
            omit: false
          };
        } else {
          // Don't use this constraint
          indexInfo.aConstraintUsage[i] = {
            argvIndex: 0,
            omit: false
          };
        }
      }

      indexInfo.estimatedCost = bestCost;
      indexInfo.estimatedRows = BigInt(bestRows);
      indexInfo.idxNum = indexNum;
      indexInfo.idxStr = indexNum === 1 ? 'point' : indexNum === 2 ? 'range' : 'scan';
      indexInfo.orderByConsumed = false;
      indexInfo.idxFlags = indexNum === 1 ? 0x0001 : 0; // UNIQUE flag for point lookups

      return StatusCode.OK;
    } catch (error) {
      console.error('xBestIndex error:', error);
      return StatusCode.ERROR;
    }
  }

  /**
   * Destroys the underlying persistent representation of the virtual table
   */
  async xDestroy(
    db: Database,
    pAux: unknown,
    moduleName: string,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    // For now, this is a no-op since we don't have persistent schema storage
    // In a full implementation, this would clean up any metadata or resources
    console.log(`Destroying virtual table ${schemaName}.${tableName}`);
  }
}
