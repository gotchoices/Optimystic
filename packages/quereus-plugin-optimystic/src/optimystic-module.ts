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
import type { VirtualTableModule, BaseModuleConfig, Database, DatabaseInternal, TableSchema, Row, FilterInfo, BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, VirtualTableConnection, TableIndexSchema as IndexSchema, UniqueConstraintSchema, UpdateArgs, UpdateResult, SqlValue } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import type { CollectionChangeEvent, ITransactor, TreeReadView } from '@optimystic/db-core';
import { SchemaManager, columnSetKey, mergeIndexLists, uniqueConstraintKey } from './schema/schema-manager.js';
import type { StoredTableSchema, StoredIndexSchema } from './schema/schema-manager.js';
import { RowCodec, type EncodedRow } from './schema/row-codec.js';
import { SqlDataType, PhysicalType } from '@quereus/quereus';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, NUMERIC_TYPE, NULL_TYPE, BOOLEAN_TYPE, type LogicalType } from '@quereus/quereus';
import { IndexManager, indexKeyFromValues, type IndexEntry } from './schema/index-manager.js';
import type { PrimaryKeyTuple } from './schema/key-tuples.js';
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
 * The named secondary index a scan reads through, resolved (schema + tree) BEFORE any
 * read view is built, so the committed arm of {@link OptimysticVirtualTable.runQuery}
 * can pin the index view in the same synchronous block as the main-table view.
 */
interface IndexScanTarget {
  schema: StoredIndexSchema;
  tree: Tree<string, IndexEntry>;
}

/** An {@link IndexScanTarget} plus the read view the scan actually walks. */
interface IndexScanSource extends IndexScanTarget {
  read: TreeReadView<string, IndexEntry>;
}

/** One existing row a secondary UNIQUE constraint collides with, keyed by its
 *  primary key so a REPLACE resolution can evict it. */
interface UniqueCollision {
  pk: string;
  row: Row;
}

/**
 * Outcome of resolving a DML row against the table's secondary UNIQUE
 * constraints (see {@link OptimysticVirtualTable.resolveSecondaryUniqueDecision}):
 * no collision (`clear`), swallow the write (a constraint resolved IGNORE),
 * reject it (`blocked`, carrying the structured constraint result), or evict the
 * colliding rows and proceed with the write (every hit resolved REPLACE).
 */
type SecondaryUniqueDecision =
  | { kind: 'clear' }
  | { kind: 'swallow' }
  | { kind: 'blocked'; result: UpdateResult }
  | { kind: 'evict'; collisions: UniqueCollision[] };

/**
 * Outcome of an UPDATE's PRIMARY KEY move onto `newKey` (see
 * {@link OptimysticVirtualTable.resolvePkMoveDecision}): the target slot is free
 * (`clear`), the move is swallowed (`swallow`, IGNORE), rejected (`blocked`), or
 * the row occupying the slot is displaced by it (`displace`, REPLACE).
 */
type PkMoveDecision =
  | { kind: 'clear' }
  | { kind: 'swallow' }
  | { kind: 'blocked'; result: UpdateResult }
  | { kind: 'displace'; row: Row };

/**
 * THE message for a violation of the maintained-index invariant — a table asked to
 * read through a secondary index its own writes do not keep up to date.
 *
 * One builder for every site that can detect it (plan selection in
 * {@link OptimysticModule.getBestAccessPlan}, scan resolution in
 * {@link OptimysticVirtualTable.resolveIndexTarget}), so the recognizable phrase
 * `does not maintain index '<name>'` and the remediation stay identical no matter
 * which site fires. `detail` says which half of the maintained set is missing.
 */
function unmaintainedIndexMessage(tableName: string, indexName: string, detail: string): string {
  return (
    `Table '${tableName}' does not maintain index '${indexName}': ${detail}, so reading through ` +
    `it would silently return incomplete results. Re-declare the index on this connection ` +
    `(CREATE INDEX) to re-attach it.`
  );
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
 * Render primary-key values for a human-readable error message.
 *
 * Never report the ENCODED tree key here: encodeKeyTuple frames every element with
 * `\x00`/`\x02`/`\xff` control units, so an encoded key pasted into an error string
 * is unreadable and unsearchable in a log. The caller's logical values are what a
 * human can match back to their SQL. Must not throw — JSON.stringify rejects bigint,
 * and a formatter that dies turns a diagnostic into a second, worse failure.
 */
function formatKeyValues(values: readonly SqlValue[]): string {
  const parts = values.map(v => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
    return String(v);
  });
  return `(${parts.join(', ')})`;
}

/**
 * Production-grade virtual table for Optimystic tree collections
 */
export class OptimysticVirtualTable extends VirtualTable {
  private collection?: Tree<string, any>;
  private isInitialized = false;
  private initializationPromise?: Promise<void>;
  /**
   * True after a PROVISIONAL (read-only) initialization completed — see
   * {@link initializeForCommittedRead}. The table can serve committed reads but has
   * not persisted schema, registered its collections with the bridge, or subscribed
   * to change notifications; the next {@link initialize} upgrades it fully.
   */
  private isProvisionallyInitialized = false;
  /** In-flight provisional initialization, shared by concurrent committed reads. */
  private provisionalInitPromise?: Promise<void>;
  private txnBridge: TransactionBridge;
  private collectionFactory: CollectionFactory;
  private options: ParsedOptimysticOptions;
  private schemaManager: SchemaManager;
  private rowCodec?: RowCodec;
  private indexManager?: IndexManager;
  /**
   * Synthesized index descriptors that back a secondary UNIQUE constraint lacking a
   * declared index (see {@link buildUniqueEnforcementIndexes}). Computed once in
   * doInitialize and handed to the IndexManager; kept here too so the probe can tell a
   * synthesized (needs one-time backfill) tree from a reused declared one.
   */
  private uniqueEnforcementIndexes: StoredIndexSchema[] = [];
  /**
   * Names of synthesized unique trees whose one-time population (for rows written by
   * an older build that never maintained the tree) has already run this process. Guards
   * {@link ensureUniquePopulated} so the backfill scan happens at most once per tree.
   */
  private populatedUniqueTrees = new Set<string>();
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
    this.initializationPromise = (async () => {
      // An in-flight PROVISIONAL (read-only) initialization shares this table's
      // instance fields; let it settle before rebuilding fully so the two cannot
      // interleave half-assigned state. Its failure is irrelevant here — the full
      // pass redoes all of its work.
      if (this.provisionalInitPromise) {
        try {
          await this.provisionalInitPromise;
        } catch {
          // Full initialization below redoes the provisional pass's work.
        }
      }
      await this.doInitialize(false);
    })();
    return this.initializationPromise;
  }

  /**
   * Initialization entry point for the COMMITTED (`_readCommitted`) connect path.
   *
   * A committed read must never join the writer's in-flight transaction — but plain
   * {@link initialize} does exactly that on a cold table: it opens collections under
   * the writer's transaction state, persists the schema when the local shape
   * disagrees with storage, registers collections into the live registry a
   * session-mode coordinator commits from, and subscribes to change notifications.
   * Serialized reads made that unobservable; with `readCommittedSnapshot` declared,
   * committed reads run OUTSIDE the execution mutex and a first touch can interleave
   * with an in-flight commit.
   *
   * So: when the bridge is quiescent (no active transaction — the overwhelmingly
   * common first touch), run the ordinary full initialization; there is nothing to
   * interleave with. When a writer transaction IS active, run a PROVISIONAL
   * read-only initialization instead: open collections with NO transaction state,
   * resolve the schema without writing it, and skip collection registration and
   * change subscription. The table stays un-memoized as initialized, so the next
   * touch on a quiescent bridge (or the next live touch) upgrades it fully.
   *
   * An initialization already in flight wins over both branches — a full one because
   * its caller owns the decision to join, a provisional one because awaiting it would
   * make the quiescence check below stale (see the comments at those checks).
   */
  async initializeForCommittedRead(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    // A FULL initialization is already in flight (the writer's own create/connect
    // path — it owns the decision to join its transaction). Await it.
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    // A PROVISIONAL pass is already in flight: join it, whatever the bridge reads as
    // right now. Deferring to initialize() here instead would await this pass and only
    // THEN sample the transaction — a stale check, since a writer may have begun in the
    // meantime, which is exactly the transaction-joining first touch this method exists
    // to prevent. A read-only init is always a correct answer for a committed read; the
    // upgrade happens on the next touch.
    if (this.provisionalInitPromise) {
      return this.provisionalInitPromise;
    }
    if (!this.txnBridge.isTransactionActive()) {
      // Safe without a re-check: initialize() reaches doInitialize's
      // getCurrentTransaction() in this same microtask (no provisional pass to await),
      // so the transaction state it joins is the one just sampled.
      return this.initialize();
    }
    if (this.isProvisionallyInitialized) {
      return;
    }
    const pass = this.doInitialize(true).finally(() => {
      // Cleared on completion either way: on success isProvisionallyInitialized
      // gates re-entry; on failure the next committed read retries.
      this.provisionalInitPromise = undefined;
    });
    this.provisionalInitPromise = pass;
    return pass;
  }

  /**
   * Internal initialization logic.
   *
   * @param readOnly PROVISIONAL mode for a committed read arriving while a writer
   * transaction is in flight (see {@link initializeForCommittedRead}): never joins
   * the writer's transaction state, never writes the schema tree (a mismatched
   * local shape is honoured in memory and persisted by the later full pass), and
   * skips collection registration and change subscription.
   */
  private async doInitialize(readOnly: boolean): Promise<void> {
    try {
      const txnState = readOnly ? null : this.txnBridge.getCurrentTransaction();
      // NOTE: create-on-missing is intentional here, and stays. A table registered in the
      // schema catalog but never written to has NO committed header block — the header is
      // only committed on the first write — so "absent header" and "empty table" are
      // genuinely indistinguishable at the block layer on this path. Inventing the tree in
      // the local tracker is the correct representation of an empty table; switching this to
      // `getCollection` would make `select` from a created-but-never-written table fail.
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
        // `candidateStored.indexes` is never authoritative about which indexes
        // the table HAS; it only says which ones this DDL statement mentioned.
        // The candidate therefore unions its index list with the persisted one
        // — the SAME rule storeStoredSchema applies at write time
        // (mergeIndexLists), so what we compare against is what a write would
        // actually produce. Two things fall out: an index-free re-declare can
        // never write `indexes: []` over a real list (which would force every
        // later `addIndex()` to fail its dedupe and rebuild from scratch), and
        // a candidate that carries SOME indexes while the catalog carries more
        // still short-circuits once, instead of missing the compare and
        // re-writing a byte-identical record on every single open.
        //
        // A schema persisted before uniqueness metadata was wired through misses
        // this short-circuit exactly once for a table that HAS unique
        // constraints (the candidate now carries `uniqueConstraints`; the
        // persisted side lacks the key). That single re-write persists them and
        // the second open short-circuits again. Constraint-free tables OMIT the
        // key on both sides (see tableSchemaToStored) and never miss.
        const candidateStored = this.schemaManager.tableSchemaToStored(this.tableSchema);
        const mergedCandidate: StoredTableSchema = persistedSchema
          ? { ...candidateStored, indexes: mergeIndexLists(candidateStored.indexes, persistedSchema.indexes) }
          : candidateStored;

        if (persistedSchema && schemasEqual(mergedCandidate, persistedSchema)) {
          storedSchema = persistedSchema;
        } else if (readOnly) {
          // Provisional (committed-read) pass: honour the merged candidate in
          // memory but write NOTHING — a read must not persist schema, and the
          // schema tree's flush would race the in-flight commit this mode exists
          // to avoid. The later full initialization persists it.
          storedSchema = mergedCandidate;
        } else {
          // Structural mismatch (columns/PK/vtab args changed). Write the
          // merged candidate so a real DDL change still wins on columns
          // while persisted indexes survive — they're managed by addIndex().
          //
          // CONTRACT: `persistedSchema === undefined` does NOT prove the catalog
          // holds nothing for this table. A PROVABLY unreachable catalog throws
          // out of getSchema (BlockUnavailableError) and this initialization
          // fails loudly — but a silently-empty cohort answer still reads as
          // absent (see SchemaManager.getSchema). This write is safe against
          // that residual ambiguity only because storeStoredSchema re-reads the
          // entry at write time and unions `indexes`, so a persisted index list
          // this node's read could not see is never overwritten with the
          // candidate's empty one. The returned value is the schema actually
          // written (including any unioned-in indexes) and MUST be what this
          // table honours from here on.
          if (!persistedSchema && candidateStored.indexes.length === 0) {
            log(
              'doInitialize(%s): persisting local DDL schema with no persisted catalog entry visible; ' +
              'if an entry exists but was unreadable, the write-time index union preserves its indexes',
              this.tableName
            );
          }
          storedSchema = await this.schemaManager.storeStoredSchema(mergedCandidate, txnState?.transactor);
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
          defaultConflict: col.defaultConflict,
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
        // The PK's declared conflict action must survive a hydrate-only open —
        // pkDeclaredConflict reads it from this rebuilt schema.
        this.tableSchema.primaryKeyDefaultConflict = persistedSchema.primaryKeyDefaultConflict;
        storedSchema = persistedSchema;
      } else {
        throw new Error('Cannot create table without column definitions');
      }

      // Fold persisted uniqueness metadata into this.tableSchema BEFORE the
      // enforcement indexes are synthesized below, so enforcement never depends
      // on which DDL (if any) replayed this open — a hydrate-only open replays
      // none, and a re-declared CREATE TABLE arrives without the constraints
      // its CREATE UNIQUE INDEX siblings once derived.
      this.attachPersistedUniqueConstraints(storedSchema);

      this.rowCodec = new RowCodec(storedSchema, this.options.encoding);

      // Create and initialize index manager
      this.indexManager = new IndexManager(
        storedSchema,
        (indexName, transactor) => this.openIndexTree(indexName, transactor)
      );

      await this.indexManager.initialize(txnState?.transactor);

      // Give every point-enforceable secondary UNIQUE constraint a backing index tree
      // so probeUniqueConstraint can probe it instead of full-scanning the table per
      // DML row (an O(N) scan per row -> O(log n) point probe). Must run BEFORE
      // registerCollections so the synthesized trees are present in getIndexTrees()
      // when the bridge snapshots this table's collections.
      this.uniqueEnforcementIndexes = this.buildUniqueEnforcementIndexes(storedSchema);
      await this.indexManager.setUniqueEnforcementIndexes(
        this.uniqueEnforcementIndexes,
        txnState?.transactor,
      );

      if (readOnly) {
        // Provisional pass: leave the bridge's collection registry untouched (a
        // live session-mode coordinator commits from that map) and defer the
        // change subscription. The next full initialization completes both.
        this.isProvisionallyInitialized = true;
        return;
      }

      // Register the main + index collections with the bridge so a session-mode
      // coordinator shares the very trackers this vtab stages into (see
      // registerCollections). Must happen before any DML so the coordinator's
      // per-transaction snapshot includes them.
      this.registerCollections();

      // NOTE: this is the one path on which doInitialize runs TWICE for a table — the
      // upgrade after a provisional pass — so it is the only one that replaces
      // `rowCodec`/`indexManager` while a committed scan started off the provisional
      // state may still be iterating (scans re-read both fields per row). Harmless
      // while both passes resolve the same schema, which they do unless DDL changed the
      // table in between; if concurrent DDL ever becomes real here, a scan must capture
      // its codec and index manager as locals alongside its pinned views.
      this.isProvisionallyInitialized = false;
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
   * -constraint drain must keep seeing the live view. The committed path never
   * registers a connection (see {@link runQuery}): a `_readCommitted` read must not
   * mutate the engine's connection registry or join the writer's transaction.
   */
  async* queryCommitted(filterInfo: FilterInfo): AsyncIterable<Row> {
    yield* this.runQuery(filterInfo, true);
  }

  /**
   * Shared query dispatch for live and committed reads. The access-strategy parse is
   * identical for both; only the read SOURCE differs — `committed` routes each read
   * shape (full scan, point lookup, index seek) to a pre-transaction view of the
   * relevant tree (see {@link committedTreeView}).
   *
   * The committed arm builds EVERY view the scan will use — the main tree plus the
   * index tree, when the parsed plan drives one — in ONE synchronous block, so both
   * pin the same committed moment. Building them across an await boundary let a
   * commit land in between: the main view pinned one revision and the index view
   * another, so an index-driven plan and a full scan of the same nominal snapshot
   * could disagree — which the committed-snapshot contract forbids (see upstream
   * module-authoring.md § Committed-Snapshot Reads).
   */
  private async* runQuery(filterInfo: FilterInfo, committed: boolean): AsyncIterable<Row> {
    if (committed) {
      // Refuse to answer from a known-degraded state: after a partial commit some
      // trees are durably committed and others are not, so NO single tree set is a
      // coherent commit boundary. Upstream requires throwing from the first pull
      // rather than answering. Live reads are unaffected — they honestly mirror
      // whatever the trees hold.
      const degradedReason = this.txnBridge.getDegradedReason();
      if (degradedReason !== undefined) {
        throw new QuereusError(
          `Committed read refused: storage is in a partially-committed state and no ` +
          `coherent committed snapshot exists until the next successful commit or ` +
          `rollback. ${degradedReason}`,
          StatusCode.ERROR,
        );
      }
      // Deliberately NO ensureConnectionRegistered() here: a `_readCommitted` read
      // must not mutate the engine's connection registry — a first-touch committed
      // read running outside the exec mutex would otherwise register the writer's
      // connection mid-transaction. Initialization goes through the committed-read
      // entry point for the same reason (no joining the writer's transaction).
      await this.initializeForCommittedRead();
    } else {
      // Live reads join the writer's transaction; make sure the connection exists.
      await this.ensureConnectionRegistered();
      if (!this.isInitialized) {
        await this.initialize();
      }
    }

    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    try {
      // Parse the access strategy FIRST (all synchronous), so the committed arm
      // below can resolve every tree this scan reads before building any view.
      // Quereus uses idxStr like 'idx=_primary_(0);plan=2' for equality seeks
      // or 'idx=idx_category(0);plan=2' for secondary index seeks.
      const planType = this.parsePlanType(filterInfo.idxStr);
      const indexName = this.parseIndexName(filterInfo.idxStr);

      // Determine if this is a secondary index (not primary key)
      const isSecondaryIndex = indexName != null && indexName !== '_primary_';

      // The secondary index this scan reads through, if any: a modern index seek
      // (idx=<name> with args) or a legacy index scan (idxNum >= 10, idxStr is the
      // bare index name). Mirrors the dispatch order below — the legacy arm applies
      // only when no modern plan matched first.
      let scanIndexName: string | undefined;
      if (isSecondaryIndex && filterInfo.args.length > 0) {
        scanIndexName = indexName;
      } else if (
        filterInfo.idxNum >= 10
        && !(planType === 2 && filterInfo.args.length > 0)
        && planType !== 3
      ) {
        if (!filterInfo.idxStr || typeof filterInfo.idxStr !== 'string') {
          throw new Error('Index name not provided for index scan');
        }
        scanIndexName = filterInfo.idxStr;
      }

      const mainTree = this.collection as unknown as Tree<string, RowData>;
      const indexTarget = scanIndexName !== undefined
        ? this.resolveIndexTarget(scanIndexName)
        : undefined;

      let mainRead: TreeReadView<string, RowData>;
      let indexScan: IndexScanSource | undefined;
      if (committed) {
        // ONE synchronous block — no await between the two views — so both pin the
        // SAME committed moment (committedTreeView is synchronous). A committed read
        // never refreshes from the network: a mid-constraint pull would defeat the
        // point of reading committed state.
        mainRead = this.committedTreeView(mainTree);
        indexScan = indexTarget !== undefined
          ? { ...indexTarget, read: this.committedTreeView(indexTarget.tree) }
          : undefined;
      } else {
        // Live reads refresh each tree from the network first.
        await mainTree.update();
        mainRead = mainTree;
        if (indexTarget !== undefined) {
          await indexTarget.tree.update();
          indexScan = { ...indexTarget, read: indexTarget.tree };
        }
      }

      // Carrying the index schema, tree, and read view as ONE value keeps the
      // "index-driven plan" decision single-valued — there is no shape where the plan
      // says index-scan but a source is missing and the scan silently falls through to
      // a different access path.
      if (indexScan !== undefined) {
        yield* this.executeIndexScan(mainRead, indexScan, filterInfo.args);
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
   * Resolve the schema and tree behind a named secondary index, throwing when either
   * is unknown. Synchronous, so {@link runQuery}'s committed arm can resolve it inside
   * the single view-building block.
   */
  private resolveIndexTarget(indexName: string): IndexScanTarget {
    if (!this.indexManager) {
      throw new Error('Table not initialized');
    }
    // Scan-time backstop of the maintained-index invariant (the plan-time guard is
    // OptimysticModule.assertIndexMaintained): a scan routed through an index this
    // table does not maintain must fail loudly, naming table and index, instead of
    // descending a stale tree and honestly returning too few rows.
    const schema = this.indexManager.getIndexSchema(indexName);
    if (!schema) {
      throw new QuereusError(
        unmaintainedIndexMessage(
          this.tableName,
          indexName,
          'it has no descriptor in this table instance\'s maintained index set, so writes skip it',
        ),
        StatusCode.ERROR,
      );
    }
    const tree = this.indexManager.getIndexTree(indexName);
    if (!tree) {
      throw new QuereusError(
        unmaintainedIndexMessage(
          this.tableName,
          indexName,
          'its tree is not open on this table instance, so writes have nowhere to stage into',
        ),
        StatusCode.ERROR,
      );
    }
    return { schema, tree };
  }

  /**
   * The committed (pre-transaction) read view of `tree`, ALWAYS built through
   * `readView` — which pins the view to the boundary the SNAPSHOT was captured on
   * (`CollectionSnapshot.context`), falling back to the collection's current boundary
   * only for a snapshot that records none (see `Collection.createReadTracker`). For a
   * dirty tree that boundary is the transaction's first touch, so the view stays
   * coherent even mid-commit-sweep; for a clean tree the snapshot is taken here, so
   * the two are the same moment.
   *
   * When the tree was staged this transaction, the source is the txn-bridge's captured
   * pre-stage snapshot (it excludes the in-flight mutations). When it was not, the
   * tree's current staged state already IS the committed state, so `tree.snapshot()`
   * supplies the same transforms the live tree would read. Returning the live tree
   * itself in that case is NOT equivalent: the live tree reads through the shared
   * cache and live action context, so an interleaved live read of the same table
   * (which runs `collection.update()`, clearing cached blocks when another writer has
   * committed) makes the committed walk finish against post-commit blocks — observed
   * as a mid-scan `Missing block` failure, not merely a torn row set.
   *
   * The view is per-scan and never mutates the live tree, so concurrent live scans of
   * the same table are unaffected.
   *
   * NOTE: pinning a clean tree costs a transforms copy plus a clone of the cached
   * blocks (LRU budget, currently 128) per committed scan, where returning the live
   * tree was free. Fine for per-statement committed reads; if a workload ever opens
   * committed scans per row over a large hot cache, cache the view per statement.
   *
   * NOTE: an index CREATED inside the in-flight transaction has no committed entries
   * at the pre-transaction boundary this view pins to, so a committed scan the
   * planner routes through that brand-new index returns nothing while a full scan
   * returns the pre-transaction rows — a disagreement, but only for DDL+DML in one
   * transaction with a committed read racing its own publish window. If that shape
   * ever becomes real, committed reads should refuse indexes younger than their
   * pinned boundary and fall back to a full scan.
   */
  private committedTreeView<TKey, TEntry>(tree: Tree<TKey, TEntry>): TreeReadView<TKey, TEntry> {
    const staged = this.txnBridge.getDirtySnapshot(tree);
    const snapshot = (staged ?? tree.snapshot()) as Parameters<Tree<TKey, TEntry>['readView']>[0];
    return tree.readView(snapshot);
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
    // Seek args are the key-ordered tuple shape, not a row — see schema/key-tuples.ts.
    const key = this.rowCodec.createPrimaryKey(
      this.rowCodec.asPrimaryKeyTuple(args as readonly SqlValue[]),
    );

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
   * Execute an index-based scan. Both read sources are resolved by {@link runQuery}
   * BEFORE this is called — for a committed read, in the same synchronous block as
   * the main view, so the index entries and the rows they resolve to come from one
   * committed moment. This method never builds or refreshes a view itself.
   */
  private async* executeIndexScan(
    mainRead: TreeReadView<string, RowData>,
    index: IndexScanSource,
    args: readonly unknown[],
  ): AsyncIterable<Row> {
    if (!this.rowCodec || !this.indexManager) return;

    // Build the (possibly partial) framed index key from constraint values. Both this
    // and IndexManager.createIndexKey route through indexKeyFromValues, so the prefix
    // range in findByIndexIn brackets exactly the tuple an insert stored. A partial key
    // (fewer args than index columns) frames only the provided leading columns and
    // prefix-matches the rest; the planner may also hand over MORE constraint values
    // than the index covers, so the excess is truncated rather than rejected.
    const width = Math.min(args.length, index.schema.columns.length);
    // Zero constraint values means the plan wants the whole index (e.g. an index-served
    // ORDER BY): frame the empty prefix directly. asIndexColumnTuple deliberately
    // rejects an empty tuple, so this case bypasses it rather than weakening that guard.
    const indexKey = width === 0
      ? indexKeyFromValues([])
      : this.indexManager.createIndexKeyFromTuple(
          this.indexManager.asIndexColumnTuple(
            index.schema,
            args.slice(0, width) as readonly SqlValue[],
          ),
        );

    // NOTE: an entry whose row has since moved off the indexed value (a writer that was
    // not maintaining this index UPDATEd the row; backfillIndexTrees adds the new entry on
    // re-attach but never purges the old one) still resolves to a LIVE row, and this loop
    // yields it although it does not match the seek key. Benign only because Quereus
    // re-applies the predicate: over such a tree, `where token = 'tok-a'` was observed
    // yielding row `[1, 'tok-z']` here while the statement still returned no rows.
    // getBestAccessPlan reports those filters as handledFilters=true, so the day the engine
    // trusts that promise — or a covering-index read lands that never fetches the row — a
    // stale entry becomes a wrong row. Close it then by re-deriving
    // IndexManager.createIndexKey from the fetched row and skipping entries whose key does
    // not prefix-match `indexKey`.
    for await (const primaryKey of this.indexManager.findByIndexIn(index.read, indexKey)) {
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

  /** Serialized composite key for a set of column indices of a FULL ROW, built by the
   *  same shared core the secondary-index layer keys on ({@link indexKeyFromValues}),
   *  so a uniqueness comparison agrees byte-for-byte with how the index would key it. */
  private uniqueKeyFor(columns: readonly number[], row: Row): string {
    return indexKeyFromValues(columns.map(ci => row[ci] ?? null));
  }

  /**
   * Merge the UNIQUE constraints reconstructable from the persisted schema
   * (explicit `uniqueConstraints` plus one derived per `unique` index — see
   * {@link SchemaManager.storedToUniqueConstraints}) into
   * `this.tableSchema.uniqueConstraints`, deduped against whatever the local DDL
   * already carries by {@link uniqueConstraintKey}. Idempotent. This is what keeps
   * {@link resolveSecondaryUniqueDecision} armed on opens where no `CREATE TABLE` /
   * `CREATE UNIQUE INDEX` DDL re-runs (the documented hydrate warm-restart flow),
   * and on re-declares that replay only the CREATE TABLE half.
   */
  private attachPersistedUniqueConstraints(storedSchema: StoredTableSchema): void {
    const persisted = this.schemaManager.storedToUniqueConstraints(storedSchema);
    if (!persisted) return;
    const existing = this.tableSchema.uniqueConstraints ?? [];
    const seen = new Set(existing.map(uniqueConstraintKey));
    const additions = persisted.filter(uc => !seen.has(uniqueConstraintKey(uc)));
    if (additions.length === 0) return;
    // Same copy-on-write pattern as the addIndex mirror: this vtab's enforcement
    // reads its OWN tableSchema reference, so replacing it never mutates the
    // schema object Quereus holds in its catalog.
    this.tableSchema = {
      ...this.tableSchema,
      uniqueConstraints: [...existing, ...additions],
    };
  }

  /**
   * Decide which secondary UNIQUE constraints need a synthesized backing index tree, and
   * return one descriptor per such constraint. A constraint is EXCLUDED when:
   *   - it is partial (`predicate !== undefined`, from `CREATE UNIQUE INDEX … WHERE …`) —
   *     never point-enforced here, matching the probe's own filter;
   *   - its columns match the PRIMARY KEY as a set — already structural (the tree key);
   *   - its columns match a declared index as a set — reuse that tree (covers a
   *     `derivedFromIndex` UNIQUE index and any plain index over the same columns), so we
   *     never build a second tree for the same key.
   * Everything else gets a descriptor with a reserved `_uniq_`-prefixed name (the prefix
   * is reserved for enforcement trees and must not collide with a user index) and the
   * constraint's columns in declared order. Two constraints over the same column set
   * collapse to one descriptor.
   */
  private buildUniqueEnforcementIndexes(storedSchema: StoredTableSchema): StoredIndexSchema[] {
    const constraints = this.tableSchema.uniqueConstraints;
    if (!constraints || constraints.length === 0) return [];

    const pkKey = columnSetKey(storedSchema.primaryKeyDefinition.map(pk => pk.index));
    const declaredKeys = new Set(
      storedSchema.indexes.map(idx => columnSetKey(idx.columns.map(c => c.index))),
    );

    const synthesized: StoredIndexSchema[] = [];
    const seen = new Set<string>();
    for (const uc of constraints) {
      if (uc.predicate !== undefined || uc.columns.length === 0) continue;
      const setKey = columnSetKey(uc.columns);
      if (setKey === pkKey) continue;
      if (declaredKeys.has(setKey)) continue;
      if (seen.has(setKey)) continue;
      seen.add(setKey);
      synthesized.push({
        name: `_uniq_${setKey}`,
        columns: uc.columns.map(index => ({ index })),
      });
    }
    return synthesized;
  }

  /**
   * Resolve the index tree that enforces `uc`, or undefined if none can be resolved. A
   * DECLARED index (in `schema.indexes`) is preferred over a synthesized `_uniq_` tree
   * covering the same columns, so a real `CREATE UNIQUE INDEX` wins if one lands on the
   * same column set as an already-synthesized plain UNIQUE. `synthesized` flags whether
   * the resolved tree may need one-time backfill (see {@link ensureUniquePopulated}).
   *
   * NOTE: when both a declared index and a synthesized tree cover the same columns, both
   * are still maintained on every DML (double writes to redundant trees). This can only
   * arise from `CREATE UNIQUE INDEX` over columns already carrying a plain UNIQUE — a
   * degenerate, rare DDL shape. If it ever shows up as a cost, drop the synthesized
   * descriptor from the maintained set when a declared index subsumes it.
   */
  private resolveEnforcingIndex(
    uc: { columns: readonly number[] },
  ): { descriptor: StoredIndexSchema; tree: Tree<string, IndexEntry>; synthesized: boolean } | undefined {
    if (!this.indexManager) return undefined;
    const setKey = columnSetKey(uc.columns);

    for (const idx of this.indexManager.getDeclaredIndexes()) {
      if (columnSetKey(idx.columns.map(c => c.index)) === setKey) {
        const tree = this.indexManager.getIndexTree(idx.name);
        if (tree) return { descriptor: idx, tree, synthesized: false };
      }
    }
    for (const idx of this.uniqueEnforcementIndexes) {
      if (columnSetKey(idx.columns.map(c => c.index)) === setKey) {
        const tree = this.indexManager.getIndexTree(idx.name);
        if (tree) return { descriptor: idx, tree, synthesized: true };
      }
    }
    return undefined;
  }

  /**
   * One-time backfill of a synthesized unique tree from the existing main-table rows.
   *
   * A table CREATED under this build maintains its unique tree from the first insert, so
   * the tree is always in sync and this is a fast no-op (guarded by the empty check). The
   * case that needs backfill is a table whose rows were written by an OLDER build that
   * never maintained such a tree: the tree is empty while the main table is populated, so
   * a probe would find no collision and silently admit a duplicate. Scan the main table
   * once and stage each non-exempt row's entry into the unique tree IN ISOLATION (stage +
   * sync only, never touching the caller's staged main-table mutations), mirroring
   * addIndex's populate loop. O(rows) once per tree per process lifetime.
   *
   * NOTE: a table whose unique columns are NULL in every row leaves the tree
   * legitimately empty (NULL rows are constraint-exempt and stage no entry), so this
   * cheap no-op-staging scan re-runs on every cold start until a non-null row exists. If
   * that ever matters, persist a "built" marker and check it here instead of emptiness.
   */
  private async ensureUniquePopulated(
    descriptor: StoredIndexSchema,
    tree: Tree<string, IndexEntry>,
  ): Promise<void> {
    if (this.populatedUniqueTrees.has(descriptor.name)) return;
    if (!this.collection || !this.rowCodec || !this.indexManager) return;

    await tree.update();
    // Emptiness is "the first path is not ON an entry" — isValid() only reports whether
    // a path survived a concurrent mutation (its version), NOT whether it points at a
    // row, so at()===undefined is the on-entry signal (an empty tree's first() is
    // version-valid but sits on no entry).
    const treeEmpty = tree.at(await tree.first()) === undefined;
    if (treeEmpty) {
      await this.collection.update();
      for await (const path of this.collection.ascending(await this.collection.first())) {
        if (!this.collection.isValid(path)) continue;
        const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
        if (!entry || entry.length < 2) continue;
        const row = this.rowCodec.decodeRow(entry[1]);
        // NULL-bearing rows are exempt from the constraint — stage no entry, matching the
        // probe's null-exemption and keeping the all-null tree legitimately empty.
        if (descriptor.columns.some(c => row[c.index] === null || row[c.index] === undefined)) {
          continue;
        }
        const pk = this.rowCodec.extractPrimaryKey(row);
        const treeKey = this.indexManager.createIndexKey(descriptor, row) + pk;
        await tree.stage([[treeKey, [treeKey, pk]]]);
      }
      await tree.sync();
    }
    this.populatedUniqueTrees.add(descriptor.name);
  }

  /**
   * Defensive full-scan fallback for a single UNIQUE constraint whose enforcing tree
   * could not be resolved (should not happen — logged by the caller). Retains the
   * pre-index behaviour: compare every existing row's serialized unique key against the
   * new row's, honouring `excludeKeys`. Collects every colliding row (not just the
   * first) so a REPLACE resolution can evict them all.
   */
  private async scanUniqueConstraint(
    uc: { columns: readonly number[] },
    values: Row,
    excludeKeys?: ReadonlySet<string>,
  ): Promise<UniqueCollision[]> {
    if (!this.collection || !this.rowCodec) return [];
    const key = this.uniqueKeyFor(uc.columns, values);
    const collisions: UniqueCollision[] = [];
    for await (const path of this.collection.range(new KeyRange<string>(undefined, undefined, true))) {
      if (!this.collection.isValid(path)) continue;
      const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
      if (!entry || entry.length < 2) continue;
      if (excludeKeys?.has(entry[0]!)) continue;
      const existing = this.rowCodec.decodeRow(entry[1]);
      if (this.uniqueKeyFor(uc.columns, existing) === key) {
        collisions.push({ pk: entry[0], row: existing });
      }
    }
    return collisions;
  }

  /**
   * All existing rows a single secondary UNIQUE constraint would collide with if
   * `values` were written — each with its primary key, so a REPLACE resolution can
   * evict it. More than one collision is possible when the tree admitted duplicates
   * before the constraint was enforced (CREATE UNIQUE INDEX over duplicate data, or
   * rows written by a build that predates the constraint).
   *
   * The probe is a POINT PROBE of the constraint's backing index tree (the reused
   * declared index, or a synthesized `_uniq_` tree) rather than a full table scan —
   * ~O(log n) per constraint per row instead of O(rows). The tree is refreshed
   * (`update()`) for a LIVE read so the probe sees rows staged earlier in THIS
   * transaction plus committed rows; that is what makes two writes sharing a unique
   * value within one transaction collide exactly as a cross-transaction duplicate does
   * (the same immediate semantics PK uniqueness has, and the reason it does NOT read the
   * committed snapshot). `excludeKeys` holds the primary keys that must not count as
   * live collisions — see {@link resolveSecondaryUniqueDecision}.
   */
  private async probeUniqueConstraint(
    uc: UniqueConstraintSchema,
    values: Row,
    excludeKeys?: ReadonlySet<string>,
  ): Promise<UniqueCollision[]> {
    if (!this.collection || !this.rowCodec || !this.indexManager) return [];
    const enforcing = this.resolveEnforcingIndex(uc);
    if (!enforcing) {
      // Should not happen: buildUniqueEnforcementIndexes synthesizes a tree for every
      // point-enforceable constraint. Fall back to a full scan for this constraint
      // rather than silently skip enforcement.
      log(
        `WARN: no enforcing index for UNIQUE(${uc.columns.join(',')}) on ` +
        `'${this.tableName}'; falling back to full scan`,
      );
      return this.scanUniqueConstraint(uc, values, excludeKeys);
    }

    const { descriptor, tree, synthesized } = enforcing;
    if (synthesized) {
      await this.ensureUniquePopulated(descriptor, tree);
    }
    await tree.update();
    const probeKey = this.indexManager.createIndexKey(descriptor, values);
    const collisions: UniqueCollision[] = [];
    for await (const pk of this.indexManager.findByIndexIn(tree, probeKey)) {
      if (excludeKeys?.has(pk)) continue;
      const entry = await this.collection.get(pk) as [string, EncodedRow] | undefined;
      if (!entry || entry.length < 2) continue;
      collisions.push({ pk, row: this.rowCodec.decodeRow(entry[1]) });
    }
    return collisions;
  }

  /**
   * Effective conflict action for a uniqueness collision: the statement-level
   * `OR <action>` clause first, else the action declared on the violated rule itself
   * (`… on conflict <action>`), else ABORT. The engine passes `undefined` when the
   * statement carries no OR clause precisely so the vtab can fall back to the
   * schema-declared action (see processInsertRow in quereus's dml-executor); the
   * memory module resolves the same `onConflict ?? declared ?? ABORT` chain.
   *
   * NOTE: FAIL and ROLLBACK resolve here but are honoured only as ABORT. The engine
   * picks the FAIL/ROLLBACK unwind branch from the error SUBCLASS
   * (`FailConflictError` / `RollbackConflictError`), which its
   * `translateConflictError` synthesizes only from the STATEMENT-level clause — a
   * vtab returning `{status: 'constraint'}` always lands on plain ABORT, and neither
   * subclass is exported for the vtab to throw. The engine's own memory module has
   * exactly the same limitation, so parity with it is the bar taken here.
   */
  private resolveConflictAction(
    stmt: ConflictResolution | undefined,
    declared: ConflictResolution | undefined,
  ): ConflictResolution {
    return stmt ?? declared ?? ConflictResolution.ABORT;
  }

  /**
   * The PRIMARY KEY's declared conflict action: a table-level
   * `primary key (…) on conflict <action>` first, else the column-level action on
   * ANY PK column (`Id integer primary key on conflict <action>`), else undefined.
   *
   * NOTE: mirrors quereus's `resolvePkDefaultConflict` (src/schema/table.ts), which
   * is not exported from the package entry point — the same few-line duplication its
   * own doc comment notes for the quereus-store and quereus-isolation packages. Keep
   * in sync with that upstream rule.
   */
  private pkDeclaredConflict(): ConflictResolution | undefined {
    if (this.tableSchema.primaryKeyDefaultConflict !== undefined) {
      return this.tableSchema.primaryKeyDefaultConflict;
    }
    for (const def of this.tableSchema.primaryKeyDefinition) {
      const col = this.tableSchema.columns[def.index];
      if (col?.defaultConflict !== undefined) return col.defaultConflict;
    }
    return undefined;
  }

  /**
   * Decide an UPDATE's PRIMARY KEY move onto `newKey` under the resolved PK action
   * ({@link resolveConflictAction}: statement-level OR > the PK's own declared
   * action > ABORT; quereus has no `update or <action>` grammar, so for UPDATE the
   * declared action is what makes IGNORE/REPLACE reachable).
   *
   * Staging is an upsert, so this pre-stage `get()` is the only thing that notices
   * the moving row is about to land on a key a DIFFERENT row already occupies (the
   * caller only calls this when `oldKey !== newKey`). Nothing is staged here — the
   * caller resolves the secondary UNIQUE constraints against this outcome first and
   * stages once both decisions are in, so a rejection on either front leaves the
   * trees untouched.
   *
   * NOTE: deliberate divergence from the memory module on the UPDATE path. Memory's
   * `performUpdateWithPrimaryKeyChange` returns as soon as a PK REPLACE resolves and
   * never checks the secondary UNIQUE constraints, so a move that also duplicates a
   * UNIQUE value leaves the duplicate in place. Here the caller still resolves them,
   * so the constraint holds. The INSERT path keeps memory's short-circuit (a
   * PK-collision REPLACE there skips the secondary checks) because the engine
   * documents that shape as the contract for `replacedRow` — see
   * quereus's common/types.ts on `replacedRow`/`evictedRows` co-occurrence.
   */
  private async resolvePkMoveDecision(
    newKey: string,
    stmtOnConflict: ConflictResolution | undefined,
  ): Promise<PkMoveDecision> {
    if (!this.collection || !this.rowCodec) {
      throw new Error('Table not initialized');
    }
    const existing = await this.collection.get(newKey) as [string, EncodedRow] | undefined;
    if (existing === undefined) return { kind: 'clear' };

    // Decode the displaced row once from the entry value [pk, encoded].
    const existingRow = this.rowCodec.decodeRow(existing[1]);
    const onConflict = this.resolveConflictAction(stmtOnConflict, this.pkDeclaredConflict());

    // IGNORE: leave both rows put — the moving row stays at oldKey, the row at
    // newKey is untouched.
    if (onConflict === ConflictResolution.IGNORE) return { kind: 'swallow' };
    if (onConflict === ConflictResolution.REPLACE) return { kind: 'displace', row: existingRow };

    // ABORT (default; FAIL/ROLLBACK land here too — see resolveConflictAction):
    // reject the move structurally rather than throwing.
    return {
      kind: 'blocked',
      result: {
        status: 'constraint',
        constraint: 'unique',
        message: this.uniqueConstraintMessage(),
        existingRow,
      },
    };
  }

  /**
   * Decide how a DML row resolves against every SECONDARY UNIQUE constraint, with
   * the conflict action resolved PER CONSTRAINT ({@link resolveConflictAction}:
   * statement-level OR > the constraint's own declared action > ABORT). Optimystic
   * enforces only the PRIMARY KEY structurally (it is the tree key); every other
   * declared UNIQUE constraint is decided here, mirroring the in-memory vtab. The
   * control schema's single-use `StampId` (and nullable `MemberPrivateKey`)
   * anti-replay columns depend on this enforcement.
   *
   * SQL semantics honoured: a partial UNIQUE (carrying a `predicate`, synthesized
   * from `CREATE UNIQUE INDEX … WHERE …`) is skipped, and a row is exempt from a
   * constraint when ANY of that constraint's columns is NULL (multiple NULLs are
   * allowed).
   *
   * Decision shape: EVERY binding constraint is probed and its action resolved
   * BEFORE anything is staged, so a blocking outcome (ABORT/FAIL/ROLLBACK) stages
   * nothing — statement atomicity never depends on undoing a partial eviction.
   * Constraints are processed in declared order and the first IGNORE or blocking
   * hit decides the row, matching the memory module; a REPLACE hit accumulates its
   * colliding rows and keeps scanning, so several constraints can each displace a
   * different row in one write (the caller stages the evictions via
   * {@link applyUniqueEvictions}).
   *
   * `excludeKeys` are the primary keys that must NOT count as live collisions:
   * the row an UPDATE is rewriting (it cannot conflict with itself) and, on a PK
   * move the {@link resolvePkMoveDecision} resolved to REPLACE, the row about to
   * be displaced at the target key — it is on its way out, so counting it would
   * reject (or swallow) a write that is in fact legal. That is why the PK-move
   * decision is taken FIRST and fed in here.
   *
   * NOTE: one deliberate divergence from the memory module in a degenerate
   * mixed-action shape (an earlier constraint resolves REPLACE, a later one IGNORE,
   * both colliding): memory physically deletes the REPLACE collision and THEN
   * swallows the write — and the DML executor skips its delete pipeline for
   * evictions reported on a row-less result, leaving those deletes untracked. Here
   * the swallow discards the pending evictions instead, so a swallowed write
   * changes nothing at all.
   */
  private async resolveSecondaryUniqueDecision(
    values: Row,
    stmtOnConflict: ConflictResolution | undefined,
    excludeKeys?: ReadonlySet<string>,
  ): Promise<SecondaryUniqueDecision> {
    const constraints = this.tableSchema.uniqueConstraints;
    if (!constraints || constraints.length === 0) return { kind: 'clear' };
    if (!this.collection || !this.rowCodec || !this.indexManager) return { kind: 'clear' };

    // Only the constraints that actually bind THIS row: non-partial, every column
    // present and non-null (a NULL-bearing row is exempt and never probes).
    const active = constraints.filter(uc =>
      uc.predicate === undefined && uc.columns.length > 0
      && uc.columns.every(ci => values[ci] !== null && values[ci] !== undefined));

    // Keyed by PK so one row violating two REPLACE-resolved constraints evicts once.
    const evictable = new Map<string, Row>();
    for (const uc of active) {
      const collisions = await this.probeUniqueConstraint(uc, values, excludeKeys);
      if (collisions.length === 0) continue;
      const effective = this.resolveConflictAction(stmtOnConflict, uc.defaultConflict);
      if (effective === ConflictResolution.IGNORE) {
        return { kind: 'swallow' };
      }
      if (effective === ConflictResolution.REPLACE) {
        for (const collision of collisions) evictable.set(collision.pk, collision.row);
        continue;
      }
      // ABORT — and FAIL/ROLLBACK, honoured as ABORT (see resolveConflictAction).
      return {
        kind: 'blocked',
        result: {
          status: 'constraint',
          constraint: 'unique',
          message: this.uniqueConstraintMessage(uc.columns),
          existingRow: collisions[0]!.row,
        },
      };
    }
    if (evictable.size > 0) {
      return {
        kind: 'evict',
        collisions: [...evictable].map(([pk, row]) => ({ pk, row })),
      };
    }
    return { kind: 'clear' };
  }

  /**
   * Stage the physical removal of every REPLACE-evicted row — clear its main-table
   * slot and delete its index entries, exactly as the `case 'delete'` arm does —
   * and return the evicted rows for {@link UpdateResult}'s `evictedRows`, so the
   * DML executor runs its full delete pipeline (change-tracking, row-time
   * maintenance, FK cascade, delete auto-events) for each before the new row's own
   * bookkeeping. The caller must {@link markDirtyTrees} first so a rollback
   * restores the evicted rows, and must stage its own write AFTER (evict-then-write
   * journal order).
   */
  private async applyUniqueEvictions(
    collisions: readonly UniqueCollision[],
    transactor?: ITransactor,
  ): Promise<Row[]> {
    if (!this.collection || !this.indexManager) {
      throw new Error('Table not initialized');
    }
    const evicted: Row[] = [];
    for (const { pk, row } of collisions) {
      await this.collection.stage([[pk, undefined]]);
      await this.indexManager.deleteIndexEntries(row, pk, transactor);
      evicted.push(row);
    }
    return evicted;
  }

  /**
   * Fetch and decode the pre-write row image an UPDATE or DELETE is about to
   * replace, or throw if the collection has no row at that key.
   *
   * Both write paths need this image so {@link IndexManager} can compute the old
   * index-tree keys, and both must read it BEFORE any `collection.stage()` call,
   * which clears or overwrites the slot. `collection.get()` reads staged-this-tx +
   * committed state, so chained writes within one transaction see the right image.
   *
   * A miss means the engine and the collection disagree about what exists. The
   * alternative — fabricating an image from the key tuple (one cell per PK column, not
   * a full row) — would feed index maintenance wrong-shape data and corrupt index
   * entries silently, so this fails loudly instead. `keyValues` is typed as the tuple
   * precisely so a full row cannot be handed over here by mistake; see
   * test/oldkeyvalues-compact-shape.spec.ts "missing pre-write row".
   */
  private async requirePreWriteRow(
    operation: 'UPDATE' | 'DELETE',
    key: string,
    keyValues: PrimaryKeyTuple,
  ): Promise<Row> {
    if (!this.collection || !this.rowCodec) {
      throw new Error('Table not initialized');
    }
    const entry = await this.collection.get(key) as [string, EncodedRow] | undefined;
    if (!entry) {
      throw new QuereusError(
        `${operation} could not find the pre-write row in table ${this.tableSchema.name} ` +
        `at primary key ${formatKeyValues(keyValues)} — the engine and the collection ` +
        `disagree about what exists.`,
        StatusCode.ERROR,
      );
    }
    return this.rowCodec.decodeRow(entry[1]);
  }

  /**
   * Performs an INSERT, UPDATE, or DELETE operation
   */
  async update(args: UpdateArgs): Promise<UpdateResult> {
    // `args.oldKeyValues` is deliberately NOT destructured: an unbranded binding of the
    // key tuple sitting in scope is exactly the shape that gets handed to a row-taking
    // method by mistake. Each write case below converts it to a PrimaryKeyTuple and
    // binds only that. See schema/key-tuples.ts.
    const { operation, values, mutationStatement } = args;

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
    // NOTE: recording precedes every throw below (requirePreWriteRow, the
    // 'requires values'/'requires old key values' guards), so a DML that fails
    // leaves its statement in the session record. Harmless today because the
    // engine aborts the transaction on a DML error, discarding the record. If a
    // caller ever swallows a DML error and commits anyway, that record replicates
    // a statement that never applied — at which point recording must move below
    // the guards, or the bridge needs a drop-last-statement on failure.
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
              // Statement-level OR wins; else the action declared on the PK
              // itself; else ABORT (see resolveConflictAction).
              const onConflict = this.resolveConflictAction(args.onConflict, this.pkDeclaredConflict());

              if (onConflict === ConflictResolution.IGNORE) {
                // INSERT OR IGNORE / ON CONFLICT DO NOTHING: preserve the
                // original row and stage nothing.
                return { status: 'ok' };
              }

              if (onConflict === ConflictResolution.REPLACE) {
                // INSERT OR REPLACE: overwrite the row in place. Same PK, so
                // only changed indexed columns restage via updateIndexEntries.
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

            // PK is clear; now resolve any SECONDARY UNIQUE constraints (the tree
            // only guards the PK), each under its own declared action — e.g. the
            // control schema's single-use StampId column blocks, while a constraint
            // declared `on conflict replace` evicts the colliding row instead.
            const uniqueDecision = await this.resolveSecondaryUniqueDecision(values, args.onConflict);
            if (uniqueDecision.kind === 'blocked') {
              return uniqueDecision.result;
            }
            if (uniqueDecision.kind === 'swallow') {
              // IGNORE: preserve the existing row(s) and stage nothing.
              return { status: 'ok' };
            }

            const encodedRow = this.rowCodec.encodeRow(values);

            // Snapshot the trees before staging so a rollback can revert exactly
            // this mutation (flushed at commit / restored on rollback).
            this.markDirtyTrees();

            // REPLACE against a secondary UNIQUE: evict each colliding row at its
            // own PK before the new row lands (evict-then-write journal order).
            const evictedRows = uniqueDecision.kind === 'evict'
              ? await this.applyUniqueEvictions(uniqueDecision.collisions, txnState?.transactor)
              : [];

            // Stage the row in the main table. Entry format: [primaryKey, encodedRow]
            await this.collection.stage([[insertKey, [insertKey, encodedRow]]]);

            // Stage into all indexes
            await this.indexManager.insertIndexEntries(values, insertKey, txnState?.transactor);

            return { status: 'ok', row: values, ...(evictedRows.length > 0 ? { evictedRows } : {}) };
          }

        case 'update':
          if (!values) {
            throw new Error('UPDATE requires values');
          }
          if (!args.oldKeyValues) {
            throw new Error('UPDATE requires old key values');
          }
          {
            // `oldKeyValues` is the key tuple (quereus's UpdateArgs contract,
            // vtab/table.ts), NOT a full row — see schema/key-tuples.ts. The
            // conversion stays HERE, after the guard and after addStatement, so the
            // arity error keeps its current ordering relative to both.
            const oldKeyTuple = this.rowCodec.asPrimaryKeyTuple(args.oldKeyValues);
            const oldKey = this.rowCodec.createPrimaryKey(oldKeyTuple);
            const newKey = this.rowCodec.extractPrimaryKey(values);
            const encodedRow = this.rowCodec.encodeRow(values);

            // Must precede every collection.stage() below — see requirePreWriteRow.
            const oldRow = await this.requirePreWriteRow('UPDATE', oldKey, oldKeyTuple);

            // Decide the PK move FIRST when the key changes: its outcome is an
            // input to the secondary-UNIQUE probe below. A REPLACE removes the row
            // at newKey, so that row must not be counted as a live secondary
            // collision (it would otherwise reject — or silently swallow — a move
            // that is legal), and a swallowed/rejected move needs no probe at all.
            const pkMove: PkMoveDecision = oldKey !== newKey
              ? await this.resolvePkMoveDecision(newKey, args.onConflict)
              : { kind: 'clear' };
            if (pkMove.kind === 'blocked') {
              return pkMove.result;
            }
            if (pkMove.kind === 'swallow') {
              // Stage nothing and skip markDirtyTrees so the ignored move costs nothing.
              return { status: 'ok' };
            }

            // Resolve SECONDARY UNIQUE constraints against the post-update values
            // BEFORE any staging, each under its own declared action, mirroring the
            // INSERT path. Excluded from the probe: the row being updated (it cannot
            // conflict with itself) and, on a displacing move, the row leaving
            // newKey. Nothing is staged until every blocking decision is in, so a
            // rejection on either front leaves the trees untouched.
            const excludeKeys = new Set([oldKey]);
            if (pkMove.kind === 'displace') excludeKeys.add(newKey);
            const uniqueDecision = await this.resolveSecondaryUniqueDecision(values, args.onConflict, excludeKeys);
            if (uniqueDecision.kind === 'blocked') {
              return uniqueDecision.result;
            }
            if (uniqueDecision.kind === 'swallow') {
              // IGNORE: leave every row put — the updated row keeps its old
              // values. Stage nothing so the ignored write costs nothing.
              return { status: 'ok' };
            }

            // Snapshot before staging so a rollback reverts exactly this change.
            this.markDirtyTrees();

            // REPLACE-resolved secondary collisions evict first (evict-then-write).
            const evictedRows = uniqueDecision.kind === 'evict'
              ? await this.applyUniqueEvictions(uniqueDecision.collisions, txnState?.transactor)
              : [];

            // Stage the main-table change (flushed at commit / restored on
            // rollback). A PK change is staged as delete-old + insert-new so both
            // index halves revert together on rollback; staging `undefined` at
            // oldKey clears the old slot and the upsert at newKey overwrites any
            // displaced row in one shot, so a displacing move needs no separate
            // main-table delete.
            await this.collection.stage(oldKey !== newKey
              ? [[oldKey, undefined], [newKey, [newKey, encodedRow]]]
              : [[newKey, [newKey, encodedRow]]]);

            // Index maintenance for a displacing move needs both stagings, in this
            // order: first remove the DISPLACED row's entries (tree keys
            // frame(displacedIdx)‖frame(newKey)), THEN transition the MOVING row's
            // entries (frame(oldIdx)‖frame(oldKey) -> frame(newIdx)‖frame(newKey)).
            // When both rows share an indexed value they touch the identical tree
            // key frame(idx)‖frame(newKey); deleting first then re-inserting leaves
            // the surviving (moving-row) entry in place. The reverse order would
            // insert then delete, wrongly dropping the entry.
            if (pkMove.kind === 'displace') {
              await this.indexManager.deleteIndexEntries(pkMove.row, newKey, txnState?.transactor);
            }
            await this.indexManager.updateIndexEntries(
              oldRow,
              values,
              oldKey,
              newKey,
              txnState?.transactor
            );

            return {
              status: 'ok',
              row: values,
              ...(pkMove.kind === 'displace' ? { replacedRow: pkMove.row } : {}),
              ...(evictedRows.length > 0 ? { evictedRows } : {}),
            };
          }

        case 'delete':
          if (!args.oldKeyValues) {
            throw new Error('DELETE requires old key values');
          }
          {
            // Key tuple, positional — see the note on the UPDATE path's oldKey and
            // schema/key-tuples.ts.
            const oldKeyTuple = this.rowCodec.asPrimaryKeyTuple(args.oldKeyValues);
            const deleteKey = this.rowCodec.createPrimaryKey(oldKeyTuple);

            // Must precede the stage() below (which clears the slot) — see
            // requirePreWriteRow.
            const oldRow = await this.requirePreWriteRow('DELETE', deleteKey, oldKeyTuple);

            // Snapshot before staging so a rollback reverts exactly this delete.
            this.markDirtyTrees();

            // Stage the main-table delete (flushed at commit / restored on rollback)
            await this.collection.stage([[deleteKey, undefined]]);

            // Stage deletes from all indexes
            await this.indexManager.deleteIndexEntries(oldRow, deleteKey, txnState?.transactor);

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
   * A CREATE UNIQUE INDEX carries a UNIQUE constraint this vtab must enforce: the
   * index tree keys on indexCols‖pk, so duplicate index values with distinct PKs
   * coexist — it does NOT structurally guard uniqueness. Quereus synthesizes the
   * derived uniqueConstraint on a NEW TableSchema it swaps into its catalog
   * (appendIndexToTableSchema), but this cached vtab keeps its ORIGINAL tableSchema
   * reference, so the derived constraint would never reach the uniqueness probe.
   * Mirror it onto this.tableSchema so the probe considers it active; enforcement
   * then routes through the declared index tree (resolveEnforcingIndex prefers a
   * declared index), so no synthesized _uniq_ tree is needed. No-ops for non-unique
   * indexes and for constraints already present (by derived-index name, or by
   * {@link uniqueConstraintKey} — which deliberately does NOT let an existing
   * partial constraint mask a full one over the same columns).
   */
  private mirrorDerivedUniqueConstraint(indexSchema: IndexSchema): void {
    if (!indexSchema.unique) return;
    const derived: UniqueConstraintSchema = {
      columns: indexSchema.columns.map((col: { index: number }) => col.index),
      predicate: indexSchema.predicate,
      derivedFromIndex: indexSchema.name,
    };
    const key = uniqueConstraintKey(derived);
    const already = (this.tableSchema.uniqueConstraints ?? []).some(
      uc => uc.derivedFromIndex === indexSchema.name || uniqueConstraintKey(uc) === key,
    );
    if (already) return;
    this.tableSchema = {
      ...this.tableSchema,
      uniqueConstraints: [...(this.tableSchema.uniqueConstraints ?? []), derived],
    };
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

    // MUTATING path: read the catalog fresh, not through the per-instance cache.
    // The dedupe below and the write-back both reason from this value, so serving
    // a cached copy would let an index a sibling instance persisted since our
    // first read be silently dropped (or rebuilt from scratch).
    const storedSchema = await this.schemaManager.getSchemaFresh(this.tableName);
    if (!storedSchema) {
      throw new Error('Schema not found');
    }

    // Mirror the derived UNIQUE constraint BEFORE the already-persisted dedupe
    // below: a re-declared CREATE UNIQUE INDEX on a warm start hits that dedupe
    // and returns early, but this cached vtab still needs the constraint in
    // memory for the uniqueness probe (see mirrorDerivedUniqueConstraint).
    this.mirrorDerivedUniqueConstraint(indexSchema);

    const txnState = this.txnBridge.getCurrentTransaction();
    const existing = storedSchema.indexes.find(idx => idx.name === indexSchema.name);
    if (existing) {
      // Upgrade path: a schema persisted before `unique`/`predicate` were wired
      // through has the index but not its uniqueness metadata. Re-declaring the
      // index is the documented way to restore it, so persist the flags (one
      // write; subsequent re-declares see them present and skip).
      let effective = storedSchema;
      if (indexSchema.unique && !existing.unique) {
        const upgraded: StoredTableSchema = {
          ...storedSchema,
          indexes: storedSchema.indexes.map(idx =>
            idx.name === indexSchema.name
              ? { ...idx, unique: true, predicate: indexSchema.predicate }
              : idx,
          ),
        };
        // storeStoredSchema unions `indexes` with the current catalog entry at
        // write time, so honour its return value — it may carry indexes a
        // concurrent writer added after our read above. Folding it into the
        // IndexManager waits until after reconcile below has opened every tree
        // it declares: setSchema REPLACES the list the staging paths iterate,
        // and a listed index with no registered tree makes insertIndexEntries
        // throw.
        effective = await this.schemaManager.storeStoredSchema(upgraded, txnState?.transactor);
      }
      // The PERSISTED schema already carries the index, so there is nothing to
      // re-write — but that says nothing about THIS vtab's in-memory maintenance
      // state. A vtab whose IndexManager was built from a persisted schema that
      // did not yet carry the index (another writer added it since, or the schema
      // cache was refreshed in between) would take this branch and stay
      // permanently index-less for maintenance: writes silently skip the index
      // tree while the planner keeps routing seeks into it. Reconcile the
      // maintained set with the persisted one — idempotent, so the common warm
      // re-declare stays cheap.
      const attached = await this.reconcileMaintainedIndexes(effective, txnState?.transactor);
      // With every tree in `effective` now open and registered, fold in the
      // upgraded descriptors (reconcile only re-sets the schema when an index
      // was missing entirely, which the unique-flag upgrade is not).
      if (effective !== storedSchema) {
        this.indexManager.setSchema(effective);
      }
      // Rows this connection committed WHILE detached from a now-attached index
      // have no entry in it. Attaching alone would leave them invisible to every
      // index-driven lookup, forever and silently; backfill closes that gap. Runs
      // after the setSchema fold above so the helper resolves descriptors from the
      // final schema. No-op (no scan) when nothing was newly attached, which is the
      // warm re-declare.
      await this.backfillIndexTrees(attached);
      return;
    }

    // Add the index to the stored schema, carrying its uniqueness metadata so a
    // later hydrate-only open can reconstruct the derived UNIQUE constraint.
    const updatedSchema: StoredTableSchema = {
      ...storedSchema,
      indexes: [...storedSchema.indexes, {
        name: indexSchema.name,
        columns: indexSchema.columns.map((col: { index: number; desc?: boolean; collation?: string }) => ({
          index: col.index,
          desc: col.desc,
          collation: col.collation,
        })),
        unique: indexSchema.unique ? true : undefined,
        predicate: indexSchema.predicate,
      }],
    };

    // Save the updated schema. Persist the merged stored form directly — the old
    // detour through `storeSchema({...this.tableSchema, indexes})` re-mapped each
    // index to bare `{name, columns}` and silently dropped `unique`/`predicate`.
    // The write-back is a name-keyed UNION, not an overwrite: storeStoredSchema
    // merges `indexes` with the catalog entry as it stands at write time, so an
    // index a concurrent writer persisted between our fresh read above and this
    // write survives. Honour the returned (possibly wider) schema from here on.
    const writtenSchema = await this.schemaManager.storeStoredSchema(updatedSchema, txnState?.transactor);

    // Initialize the new index tree
    const indexTree = await this.openIndexTree(indexSchema.name, txnState?.transactor);

    // Register our tree first (so reconcile does not open a second instance of
    // it), then reconcile against the WRITTEN schema: that folds the schema into
    // the manager, opens a tree for any union-added sibling index (setSchema
    // alone would make staging iterate an index with no registered tree and
    // throw), and registers every index collection with the transaction bridge
    // so a session-mode coordinator sees them. CREATE INDEX normally runs
    // outside a DML transaction, so the coordinator picks the new collection up
    // before the next transaction's snapshot. (An index created mid-transaction
    // would miss that transaction's already-taken snapshot — a known,
    // documented edge.)
    this.indexManager.registerIndexTree(indexSchema.name, indexTree);
    const attached = await this.reconcileMaintainedIndexes(writtenSchema, txnState?.transactor);

    // Populate the index with existing data. Reconcile reports the index just built
    // as newly attached (the manager carried no descriptor for it until the setSchema
    // inside reconcile), so this ONE call serves both the build path and the
    // re-attach path above — there is no second populate loop to keep in step.
    await this.backfillIndexTrees(attached);
  }

  /**
   * Stage an entry for EVERY committed row into each named index tree, then flush
   * only those trees. The single populate path: `addIndex` uses it to build a
   * brand-new index, and the already-persisted branch uses it to close the gap for
   * rows committed while this connection was detached from an index it has now
   * re-attached to.
   *
   * Modelled on {@link ensureUniquePopulated}: stage into the target trees IN
   * ISOLATION and sync only those, never touching the caller's staged main-table
   * mutations. Idempotent by construction — entries are keyed `indexColumns‖primaryKey`,
   * so re-staging a row that already has an entry writes a byte-identical key and value.
   *
   * Two deliberate differences from the populate loop this replaced:
   *   - it refreshes `this.collection` first (the old loop did not), matching
   *     ensureUniquePopulated and widening coverage to rows a sibling committed since
   *     this connection last pulled;
   *   - it stages per named index and syncs only those trees, rather than staging into
   *     every maintained index and flushing all of them.
   *
   * NOTE: CREATE UNIQUE INDEX does not reject pre-existing duplicate values — entries
   * are keyed on indexCols‖pk, so duplicates coexist and the index builds successfully.
   * With the derived uniqueConstraint mirrored onto this.tableSchema, the probe rejects
   * FUTURE duplicates but the existing ones remain. This diverges from SQLite (which
   * fails the CREATE on dup data). If a pre-build integrity check is ever wanted,
   * validate uniqueness here before staging.
   *
   * NOTE: a CREATE INDEX issued inside an open transaction force-flushes the trees it
   * populates, so those entries survive a later ROLLBACK. The caveat predates this
   * helper (the old populate loop flushed every index tree; ensureUniquePopulated does
   * the same mid-DML) and is narrowed by it: only NEWLY ATTACHED trees are synced, and
   * the caller cannot have staged into those — they were attached microseconds ago.
   *
   * NOTE: `predicate` (partial indexes) is not honoured here, matching
   * insertIndexEntries on the live DML path. Backfill and live maintenance therefore
   * agree; both over-populate a partial index. Fix them together or not at all.
   *
   * NOTE: backfill only ADDS entries, never purges. An entry a detached writer left
   * behind (its UPDATE moved the row off that indexed value, or its DELETE removed the
   * row) survives the re-attach — see the stale-entry note in {@link executeIndexScan}
   * for why that is benign today and what flips it.
   *
   * NOTE: the walk stages one action per row per target index, holds them all pending
   * until the sync below, and re-stages EVERY row on every attach (an identical upsert
   * still rewrites the leaf). Fine while this is cold-path DDL on modest tables; if
   * building or re-attaching an index on a large table shows up as slow or
   * memory-hungry, batch the stage calls per chunk of rows and skip rows whose entry
   * the tree already carries.
   */
  private async backfillIndexTrees(indexNames: readonly string[]): Promise<void> {
    if (indexNames.length === 0) return;
    if (!this.collection || !this.rowCodec || !this.indexManager) return;
    const manager = this.indexManager;

    const targets = indexNames.map(name => {
      const descriptor = manager.getIndexSchema(name);
      const tree = manager.getIndexTree(name);
      if (!descriptor || !tree) {
        // reconcileMaintainedIndexes folds the descriptor in and opens the tree before
        // it reports a name as attached, so this is a wiring bug, not a data condition.
        throw new Error(
          `Cannot populate index '${name}' on '${this.tableName}': ` +
          `${descriptor ? 'tree' : 'descriptor'} not registered`,
        );
      }
      return { descriptor, tree };
    });

    await this.collection.update();
    for await (const path of this.collection.ascending(await this.collection.first())) {
      if (!this.collection.isValid(path)) continue;
      const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
      if (!entry || entry.length < 2) continue;
      const row = this.rowCodec.decodeRow(entry[1]);
      const primaryKey = this.rowCodec.extractPrimaryKey(row);
      for (const { descriptor, tree } of targets) {
        const treeKey = manager.createIndexKey(descriptor, row) + primaryKey;
        await tree.stage([[treeKey, [treeKey, primaryKey]]]);
      }
    }

    // Staging alone is not durable: addIndex runs outside the DML transaction's
    // commit, so flush the trees this call populated. Trees with nothing staged sync
    // as a no-op.
    for (const { tree } of targets) {
      await tree.sync();
    }
  }

  /**
   * Open (create-on-missing) the tree behind a named secondary index. The ONE
   * place an index sub-collection URI is derived and opened — doInitialize's
   * IndexManager factory, addIndex's build path and the reconcile path all route
   * through here so they cannot drift.
   *
   * NOTE: create-on-missing is intentional — an index whose table has no rows yet
   * has never committed a header block, so an open-only fetch would report the
   * index as missing rather than as empty.
   */
  private async openIndexTree(indexName: string, transactor?: ITransactor): Promise<Tree<string, IndexEntry>> {
    const indexOptions: ParsedOptimysticOptions = {
      ...this.options,
      collectionUri: `${this.options.collectionUri}/index/${indexName}`,
    };
    const tree = await this.collectionFactory.createOrGetCollection(
      indexOptions,
      transactor ? { transactor, isActive: true, collections: new Map(), stampId: '' } : undefined
    );
    return tree as unknown as Tree<string, IndexEntry>;
  }

  /**
   * Ensure this vtab's IndexManager maintains EVERY index the persisted schema
   * declares: descriptor folded into the manager's schema, tree open and
   * registered, collection registered with the transaction bridge — the same
   * three things addIndex's build path does for a brand-new index. Idempotent:
   * when nothing is missing this is a map lookup per index and a no-op re-set of
   * the bridge registry (itself keyed by collection id).
   *
   * RETURNS the names it newly attached — an index the manager had no descriptor for,
   * or no open tree for. Rows this vtab committed while detached from such an index
   * have no entry in it, so the caller (addIndex) must populate them: see
   * {@link backfillIndexTrees}. The set is computed BEFORE anything is mutated, since
   * the wiring below is exactly what erases the evidence. A re-declare with nothing
   * missing returns `[]`, so the warm path stays a map lookup per index and pays no
   * table scan; a re-declare that DOES attach something costs one scan of the table.
   *
   * NOTE: backfill runs only on a CREATE INDEX re-declare that actually attaches
   * something. A connection that opens the table cold and finds the index already in
   * the persisted schema attaches nothing here and therefore does NOT scan — so rows
   * orphaned by some other divergent writer stay orphaned until someone re-declares the
   * index. Making every table open pay an O(rows) verification scan is the wrong trade
   * for the common case. If orphaned entries ever show up in the field without a
   * re-declare to heal them, add an explicit repair entry point rather than a scan on
   * open.
   */
  private async reconcileMaintainedIndexes(
    storedSchema: StoredTableSchema,
    transactor?: ITransactor
  ): Promise<string[]> {
    if (!this.indexManager) {
      throw new Error('Table not initialized');
    }
    const manager = this.indexManager;
    const attached = storedSchema.indexes
      .filter(idx => manager.getIndexSchema(idx.name) === undefined
        || manager.getIndexTree(idx.name) === undefined)
      .map(idx => idx.name);
    // NOTE: setSchema REPLACES the manager's index list, so a `storedSchema` that is
    // missing an index the manager already maintains would narrow the maintained set
    // rather than widen it. The supply side is closed (mutating paths read the catalog
    // fresh, and storeStoredSchema's write-time union means the persisted list never
    // shrinks — see SchemaManager); if a narrower schema ever lands here anyway, the
    // reads still fail loudly (assertIndexMaintained), but switch this to a name-keyed
    // union of the two lists.
    if (storedSchema.indexes.some(idx => manager.getIndexSchema(idx.name) === undefined)) {
      manager.setSchema(storedSchema);
    }
    for (const idx of storedSchema.indexes) {
      let tree = manager.getIndexTree(idx.name);
      if (!tree) {
        tree = await this.openIndexTree(idx.name, transactor);
        manager.registerIndexTree(idx.name, tree);
      }
      // Idempotent (keyed by collection id) — see TransactionBridge.registerCollection.
      this.txnBridge.registerCollection(tree.getCollection());
    }
    return attached;
  }

  /**
   * Whether this table instance actually maintains `indexName` — i.e. its
   * IndexManager carries the descriptor (so INSERT/UPDATE/DELETE stage into the
   * index) AND holds its tree open (so those stages have somewhere to land).
   *
   * 'unknown' while the table has not finished (even provisional) initialization:
   * the maintained set does not exist yet, so divergence cannot be judged — the
   * caller must defer to the scan-time backstop in resolveIndexTarget rather
   * than fail a plan against half-built state.
   */
  indexMaintenanceState(indexName: string): 'maintained' | 'unmaintained' | 'unknown' {
    if (!this.indexManager || (!this.isInitialized && !this.isProvisionallyInitialized)) {
      return 'unknown';
    }
    if (
      this.indexManager.getIndexSchema(indexName) === undefined
      || this.indexManager.getIndexTree(indexName) === undefined
    ) {
      return 'unmaintained';
    }
    return 'maintained';
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

  /**
   * A committed-read view must never enlist in the engine's transaction
   * coordination: upstream's `_readCommitted` contract forbids handing such a
   * connection to `Database.registerConnection` (it would receive the writer's
   * begin/commit/rollback/savepoint broadcasts — and this connection class drives
   * the SHARED TransactionBridge, so an enlisted committed view would drive the
   * writer's transaction). Refuse loudly rather than let a generic connection
   * helper enlist this view by accident.
   */
  createConnection(): VirtualTableConnection {
    throw new QuereusError(
      'A committed-read (_readCommitted) table cannot create a transaction connection',
      StatusCode.MISUSE,
    );
  }

  /** No connection, ever: the committed-read connect path registers nothing. */
  getConnection(): VirtualTableConnection | undefined {
    return undefined;
  }

  async disconnect(): Promise<void> {
    // No-op — and correct BECAUSE nothing was registered: the committed-read
    // connect path never calls registerConnection (see resolveConnectedTable's
    // `committed` arm) and createConnection/getConnection above make sure
    // nothing can enlist this view later, so there is genuinely nothing to tear
    // down and the engine's connection registry is left exactly as the writer had
    // it. The per-scan read tracker is created and dropped inside query().
  }
}

/**
 * Optimystic Virtual Table Module
 */
export class OptimysticModule implements VirtualTableModule<VirtualTable, OptimysticModuleConfig> {
  /**
   * Concurrent `query()` calls on ONE connected table are safe (audited):
   *   - every scan's mutable state (read views, iterators, retry bookkeeping,
   *     `yieldedKeys`) is local to the generator invocation;
   *   - a committed scan reads a per-scan pinned view that never touches live state;
   *   - a live scan's `collection.update()` serializes behind the collection's own
   *     per-collection latch, and mid-scan tree mutation is already tolerated via
   *     path-invalidation retry (replicated external commits impose the same
   *     interleaving with or without concurrent reads);
   *   - the one shared field a FAILING scan writes is `setErrorMessage(...)` —
   *     diagnostics only, last writer wins; accepted as-is.
   * Writes still serialize (this mode's contract); the bridge's single-writer
   * constraint is documented at `TransactionBridge.currentTransaction` and in
   * docs/transactions.md § "One writer at a time on the shared TransactionBridge".
   *
   * `expectedLatencyMs` is deliberately NOT declared: this module fronts
   * transactors ranging from in-memory (`test`, microseconds) through local file
   * storage to libp2p network cohorts (tens to hundreds of ms), and the hint is
   * static per MODULE — any single number would misestimate most deployments.
   * Declare it if per-deployment configuration can ever feed a measured value.
   *
   * `readCommittedSnapshot` (declared below) routes eligible reads onto Quereus's
   * mutex-free concurrent path, so a committed read answers promptly and from a
   * coherent boundary even while another statement's commit is parked against an
   * unresponsive cohort. The obligation (upstream `VirtualTableModule` docs:
   * a `_readCommitted` connection serves ONE committed boundary for the life of the
   * scan; index-driven and full scans of the same connection agree) is held by:
   *   - per-scan pinned read views (`committedTreeView` → `Tree.readView`), built in
   *     one synchronous block per statement;
   *   - the snapshot-boundary pin (`CollectionSnapshot.context`): a dirty tree's
   *     committed view describes the PRE-transaction boundary even when the legacy
   *     multi-tree commit sweep has already flushed that tree but not its siblings;
   *   - session-mode publish being event-loop-atomic across collections
   *     (`TransactionCoordinator.commitOnce`'s fold loop has no await);
   *   - the degraded latch: after a partial commit, committed reads THROW until a
   *     clean commit/rollback restores a reconciled view;
   *   - first-touch isolation (`initializeForCommittedRead`): a committed read of a
   *     cold table never joins an in-flight writer transaction.
   * Proven by test/committed-read-stall.spec.ts (stalled-commit overlap in both
   * commit modes, driven through a gated transactor) and standing conformance cover
   * in test/committed-read-conformance.spec.ts. NOTE the residual, pre-existing
   * limit shared with the serialized path: after a partial commit durably splits a
   * table's trees, the cleared latch does NOT certify coherence — full-scan and
   * index-driven committed reads of the split table disagree until application-level
   * reconciliation (docs/correctness.md § "Partial landing"). The flag makes no
   * promise about a store that was already incoherent at rest.
   */
  readonly concurrencyMode = 'reentrant-reads' as const;
  readonly readCommittedSnapshot = true;

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

    const manager = new SchemaManager(async (transactor, create) => {
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
      const txnState = transactor
        ? { transactor, isActive: true, collections: new Map(), stampId: '' }
        : undefined;
      // Write paths bring the catalog into existence; read paths must observe an
      // absent catalog as absent (undefined) rather than as a table-less database.
      return create
        ? await this.collectionFactory.createOrGetCollection(schemaOptions, txnState)
        : await this.collectionFactory.getCollection(schemaOptions, txnState);
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
      // Initialization is the CALLER's job (create/resolveConnectedTable both do it,
      // each through the entry point its path requires) — initializing here would
      // force a full, transaction-joining initialize onto the committed-read path.
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
    const committed = options?._readCommitted === true;

    // The committed path resolves (and, on first touch, PROVISIONALLY initializes)
    // the table but never registers a connection: a `_readCommitted` connection must
    // not join the writer's transaction, and since such reads run outside the exec
    // mutex a first-touch committed read must not mutate the engine's connection
    // registry — or the bridge's transaction/collection state — mid-transaction
    // (see OptimysticVirtualTable.initializeForCommittedRead).
    const baseTable = await this.resolveConnectedTable(db, schemaName, tableName, committed, tableSchema);

    // Honour the committed-read flag with a per-scan read-only view; the shared table
    // is unchanged, so a concurrent live scan of it keeps its live view.
    if (committed) {
      return new OptimysticCommittedTable(baseTable);
    }
    return baseTable;
  }

  /**
   * Resolve (and initialize) the cached {@link OptimysticVirtualTable} for a
   * schema.table, instantiating it from the supplied/looked-up schema on first
   * connect. Shared by {@link connect} for both the live and committed-read paths.
   * The committed path (`committed: true`) initializes through
   * {@link OptimysticVirtualTable.initializeForCommittedRead} (which refuses to
   * join an in-flight writer transaction) and never registers a connection.
   */
  private async resolveConnectedTable(
    db: Database,
    schemaName: string,
    tableName: string,
    committed: boolean,
    tableSchema?: TableSchema
  ): Promise<OptimysticVirtualTable> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const existingTable = this.tables.get(tableKey);

    if (existingTable) {
      if (committed) {
        await existingTable.initializeForCommittedRead();
      } else {
        await existingTable.initialize();
      }
      return existingTable;
    }

    const resolvedSchema = tableSchema ?? db.schemaManager.findTable(tableName, schemaName);
    if (!resolvedSchema) {
      throw new Error(`Optimystic table definition for '${tableName}' not found. Cannot connect.`);
    }

    const table = await this.instantiateTable(db, resolvedSchema);
    if (committed) {
      await table.initializeForCommittedRead();
    } else {
      await table.initialize();
      await table.ensureConnectionRegistered();
    }

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

    // Invariant: the planner may only route a scan through an index this table
    // actually maintains. Checked at plan selection so the query fails BEFORE it
    // silently answers from a stale tree (see assertIndexMaintained).
    if (bestIndexName !== undefined && bestIndexName !== '_primary_') {
      this.assertIndexMaintained(tableInfo, bestIndexName);
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
   * Guard for the maintained-index invariant at plan selection.
   *
   * Every table carries two independent notions of "which secondary indexes
   * exist": Quereus's catalog (`TableSchema.indexes` — what the planner offers)
   * and the vtab's IndexManager (what DML actually stages into). Collapsing them
   * into one set is not feasible here: Quereus owns the catalog, and the vtab
   * initializes lazily/asynchronously, so the maintained set may not even exist
   * at (synchronous) plan time. Instead, the moment a plan selects a secondary
   * index, require the table to maintain it — a query routed through an
   * unmaintained index would descend a tree that writes silently skip and
   * honestly return too few rows, forever, with no error anywhere.
   *
   * 'unknown' (table not yet instantiated/initialized) deliberately passes: the
   * divergence cannot be judged yet, and the scan-time backstop in
   * resolveIndexTarget throws the same named error after initialization.
   *
   * NOTE: a committed read planned CONCURRENTLY with an in-flight CREATE INDEX on
   * the same table can transiently observe 'unmaintained' and fail; the window is
   * the same one resolveIndexTarget already had, and retrying the query resolves it.
   */
  private assertIndexMaintained(tableInfo: TableSchema, indexName: string): void {
    const tableKey = `${tableInfo.schemaName}.${tableInfo.name}`.toLowerCase();
    const state = this.tables.get(tableKey)?.indexMaintenanceState(indexName) ?? 'unknown';
    if (state === 'unmaintained') {
      throw new QuereusError(
        unmaintainedIndexMessage(
          tableInfo.name,
          indexName,
          'the catalog offers it to query planning, but this table instance\'s writes do not keep it up to date',
        ),
        StatusCode.ERROR,
      );
    }
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
