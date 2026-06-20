import type { TransactionCoordinator, ITransactionEngine, Collection, CollectionId } from '@optimystic/db-core';
import { TransactionSession } from '@optimystic/db-core';
import type { TransactionState, ParsedOptimysticOptions } from '../types.js';
import { CollectionFactory } from './collection-factory.js';
import { generateStampId } from '../util/generate-stamp-id.js';

/**
 * Minimal tree surface the bridge needs to flush (at commit) or roll back (on
 * rollback) DML that was staged into the collection tracker but not yet pushed
 * to the transactor. `@optimystic/db-core`'s `Tree` satisfies this structurally,
 * so both the main-table tree and index trees can share one dirty map without
 * generic-parameter friction.
 *
 * Rollback restores a per-tree {@link snapshot} captured BEFORE the first stage
 * (rather than blanket-clearing the tracker) so a brand-new collection's
 * header/root — which live in the tracker until the first sync — survive the
 * rollback and the collection stays readable.
 */
export interface DirtyTree {
  sync(): Promise<void>;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

/**
 * Transaction bridge between Quereus and Optimystic.
 *
 * This bridge handles both:
 * 1. Legacy mode: Direct collection sync (when no coordinator/engine is set)
 * 2. Transaction mode: Using TransactionSession for distributed consensus
 */
export class TransactionBridge {
  private currentTransaction: TransactionState | null = null;
  private collectionFactory: CollectionFactory;
  /** Accumulated SQL statements for the current transaction */
  private accumulatedStatements: string[] = [];
  /**
   * Trees with DML staged this transaction (main table + touched index trees),
   * each mapped to a snapshot of its staged state captured the first time it was
   * marked (i.e. before its first stage). Populated by {@link markDirty} at DML
   * time; flushed at commit (legacy mode) or restored from the snapshot at
   * rollback. This is the authoritative set rather than
   * `currentTransaction.collections` because the vtab's main collection is
   * long-lived (created before the txn) and index trees are created with a
   * throwaway txnState, so neither reliably lands in that map.
   */
  private dirtyTrees = new Map<DirtyTree, unknown>();
  /**
   * Live registry of every collection the vtab stages into (main table + each
   * index tree), keyed by collection id. Maintained unconditionally as tables
   * initialize — independent of transaction mode — because the coordinator a
   * host wires via {@link configureTransactionMode} is constructed from THIS
   * same map (see {@link getCollectionRegistry}). Sharing one live map is what
   * makes session-mode commit correct: `coordinator.commit()` iterates its
   * collection map and reads each `tracker.transforms`, so the trackers the vtab
   * stages into must BE the coordinator's collections. A tree created mid-run
   * (e.g. a new index) registers here and is therefore visible to the
   * already-constructed coordinator before commit.
   *
   * Typed `Collection<any>` to mirror {@link TransactionCoordinator}'s own
   * constructor signature (the trees registered here carry heterogeneous action
   * types — main-table rows vs. index entries — that the coordinator treats
   * uniformly).
   */
  private collectionRegistry = new Map<CollectionId, Collection<any>>();
  /** Optional transaction session for distributed consensus */
  private session: TransactionSession | null = null;
  /** Optional coordinator for transaction mode */
  private coordinator: TransactionCoordinator | null = null;
  /** Optional engine for transaction mode */
  private engine: ITransactionEngine | null = null;
  /** Schema hash provider function */
  private schemaHashProvider: (() => Promise<string>) | null = null;

  constructor(collectionFactory: CollectionFactory) {
    this.collectionFactory = collectionFactory;
  }

  /**
   * Configure the transaction bridge for distributed consensus mode.
   *
   * When configured, transactions will use TransactionSession for
   * coordinated commit with validation.
   *
   * ## `schemaHashProvider` MUST be non-re-entrant, and the hash MUST be kept warm
   *
   * {@link beginTransaction} awaits this provider, and `begin` runs INSIDE a
   * statement's exec — the host's `db.exec(…)` (DML, an explicit `begin`, even a
   * `create table`/`create index`) is holding Quereus's exec mutex when the vtab's
   * transaction opens. A provider that re-enters the same `Database` to compute its
   * value (e.g. runs `db.eval('select … from schema()')`) would try to re-acquire
   * that mutex → circular wait → permanent hang. Quereus exposes
   * `Database._isExecuting()` as the sanctioned re-entrancy signal for exactly this.
   *
   * The intended wiring is `() => engine.getSchemaHash()` on a {@link QuereusEngine}.
   * That engine NEVER re-enters the db from `begin`: it serves a cached hash, and if
   * the cache is cold while a statement is in flight it THROWS an actionable error
   * rather than deadlocking. The flip side of that safety is a host obligation: keep
   * the hash warm OUT OF BAND. After your DDL (and after any later schema change made
   * while session mode is live), call `engine.getSchemaHash()` once outside any
   * statement to populate the cache before the next transaction. The engine
   * invalidates the cache on schema change but does NOT auto-recompute (a background
   * recompute would pollute `_isExecuting()` for other callers — see
   * {@link QuereusEngine.getSchemaHash}). Any custom provider passed here must offer
   * the same guarantee: resolve from a warm cache, never by re-entering the db while
   * a statement is in flight.
   *
   * @param coordinator - The transaction coordinator
   * @param engine - The transaction engine (e.g., QuereusEngine)
   * @param schemaHashProvider - Non-re-entrant function to get the current schema hash
   */
  configureTransactionMode(
    coordinator: TransactionCoordinator,
    engine: ITransactionEngine,
    schemaHashProvider: () => Promise<string>
  ): void {
    this.coordinator = coordinator;
    this.engine = engine;
    this.schemaHashProvider = schemaHashProvider;
  }

  /**
   * Check if transaction mode is enabled.
   */
  isTransactionModeEnabled(): boolean {
    return this.coordinator !== null && this.engine !== null;
  }

  /**
   * Register a collection the vtab stages into (main table or index tree) so a
   * session-mode coordinator can read its staged transforms at commit and revert
   * them at rollback. Idempotent (keyed by collection id) and mode-agnostic:
   * always called as a table initializes, BEFORE any DML, so the collection is
   * present when the coordinator snapshots on the transaction's first action.
   *
   * The registry is the live map handed to the coordinator, so registering after
   * the coordinator was constructed still makes the collection visible to it.
   */
  registerCollection(collection: Collection<any>): void {
    this.collectionRegistry.set(collection.id, collection);
  }

  /**
   * The live collection registry. A host wiring session mode builds its
   * {@link TransactionCoordinator} from this exact map so the coordinator and the
   * vtab share one set of {@link Collection} instances (and thus one set of
   * trackers). See {@link registerCollection}.
   */
  getCollectionRegistry(): Map<CollectionId, Collection<any>> {
    return this.collectionRegistry;
  }

  /**
   * Begin a new transaction.
   *
   * If transaction mode is enabled, creates a TransactionSession for
   * distributed consensus. Otherwise, uses legacy direct sync mode.
   *
   * Following SQLite semantics: if a transaction is already active,
   * this is a no-op and returns the existing transaction.
   */
  async beginTransaction(options: ParsedOptimysticOptions): Promise<TransactionState> {
    if (this.currentTransaction?.isActive) {
      // Already in transaction - SQLite semantics: BEGIN is a no-op
      return this.currentTransaction;
    }

    const transactor = await this.collectionFactory.getOrCreateTransactor(options);
    const peerId = this.collectionFactory.getPeerId(options);

    // Clear any previously accumulated statements + staged-tree tracking
    this.accumulatedStatements = [];
    this.dirtyTrees.clear();

    // Create TransactionSession if transaction mode is enabled
    if (this.coordinator && this.engine && this.schemaHashProvider) {
      const schemaHash = await this.schemaHashProvider();
      this.session = await TransactionSession.create(
        this.coordinator,
        this.engine,
        peerId,
        schemaHash
      );
    } else {
      this.session = null;
    }

    // Generate transaction ID from session or legacy method
    const transactionId = this.session
      ? this.session.getStampId()
      : generateStampId(peerId);

    this.currentTransaction = {
      transactor,
      isActive: true,
      collections: new Map(),
      stampId: transactionId,
    };

    return this.currentTransaction;
  }

  /**
   * Commit the current transaction.
   *
   * If transaction mode is enabled, commits through TransactionSession
   * for distributed consensus. Otherwise, uses legacy direct sync.
   */
  async commitTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to commit');
    }

    try {
      if (this.session) {
        // Transaction mode: commit through the session for distributed consensus.
        // The DML path STAGES into the collection trackers (no inline sync), and
        // the coordinator's commit() iterates its collection map and reads each
        // `tracker.transforms` directly. Because that map is the SAME live
        // registry the vtab stages into (see registerCollection /
        // getCollectionRegistry), the staged transforms are exactly what
        // consensus pends/commits — so we deliberately do NOT tree.sync() here;
        // flushing would reset the trackers out from under consensus.
        const result = await this.session.commit();
        if (!result.success) {
          throw new Error(result.error || 'Transaction commit failed');
        }
      } else {
        // Legacy mode: flush every tree that staged DML this transaction. This
        // replaces the inline updateAndSync that Tree.replace() used to perform
        // at DML time — deferring the flush to commit is what lets a deferred
        // (subquery-bearing) CHECK rejection roll back cleanly: the constraint
        // throws before this point, so the staged trees are rolled back never
        // having touched storage.
        for (const tree of this.dirtyTrees.keys()) {
          await tree.sync();
        }
      }

      this.currentTransaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;
      this.dirtyTrees.clear();

    } catch (error) {
      // If commit fails, rollback
      await this.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Rollback the current transaction.
   *
   * Discards local changes and clears session state.
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to rollback');
    }

    // Rollback session if in transaction mode
    if (this.session && !this.session.isRolledBack()) {
      try {
        await this.session.rollback();
      } catch {
        // Ignore rollback errors - we're already cleaning up
      }
    }

    // Roll back staged-but-unsynced DML. Quereus runs deferred row constraints
    // BEFORE connection.commit(), so a constraint-failure rollback reaches here
    // while every staged tree is still un-synced. Tracker rollback has a single
    // owner per mode:
    //   - Session mode: the coordinator owns it. session.rollback() (above)
    //     already restored every registered collection's tracker to the
    //     pre-session snapshot (and replays any interleaved sessions). The dirty
    //     trees ARE those registered collections, so a second per-tree restore
    //     here would be redundant and, against a multi-session coordinator, would
    //     clobber that careful replay. Skip it.
    //   - Legacy mode (no coordinator): restore each dirty tree from its
    //     pre-stage snapshot — this reverts in-memory reads and leaves storage
    //     untouched, the actual fix for the deferred-constraint atomicity bug.
    //     Restoring the snapshot (rather than clearing the tracker) keeps a
    //     never-synced collection's header/root intact so it stays readable.
    if (!this.session) {
      for (const [tree, snapshot] of this.dirtyTrees) {
        tree.restore(snapshot);
      }
    }
    this.dirtyTrees.clear();

    // Clean up local state
    this.currentTransaction.collections.clear();
    this.currentTransaction.isActive = false;

    this.accumulatedStatements = [];
    this.session = null;

    // Note: We intentionally do NOT clear the collection factory cache here.
    // The transactor cache contains pre-registered transactors that should persist
    // across transactions. Clearing them would cause the factory to create new
    // disconnected transactors instead of using the registered ones.
  }

  /**
   * Get the current transaction state.
   */
  getCurrentTransaction(): TransactionState | null {
    return this.currentTransaction;
  }

  /**
   * Get the current transaction session (if in transaction mode).
   */
  getSession(): TransactionSession | null {
    return this.session;
  }

  /**
   * Check if a transaction is currently active.
   */
  isTransactionActive(): boolean {
    return this.currentTransaction?.isActive ?? false;
  }

  /**
   * Register a tree that is about to stage DML this transaction so it is flushed
   * at commit (legacy mode) or rolled back at rollback. MUST be called BEFORE the
   * tree is staged: the first mark snapshots the tree's current (pre-stage) state,
   * which rollback restores. Repeated marks of the same tree keep the original
   * snapshot, so a multi-statement transaction rolls back to its starting state.
   */
  markDirty(tree: DirtyTree): void {
    if (!this.dirtyTrees.has(tree)) {
      this.dirtyTrees.set(tree, tree.snapshot());
    }
  }

  /**
   * The pre-transaction snapshot captured for `tree` by {@link markDirty} this
   * transaction, or undefined when the tree has not been staged this transaction.
   *
   * This is the committed (pre-stage) state a `_readCommitted` scan must read from:
   * a dirtied tree's live tracker holds this transaction's in-flight inserts, while
   * the captured snapshot excludes them. A clean tree (undefined here) has no staged
   * changes this transaction, so its live state already IS the committed state and
   * the caller can read it directly. The snapshot is opaque; pass it back to the
   * originating tree's `readView` to materialise the committed view.
   */
  getDirtySnapshot(tree: DirtyTree): unknown | undefined {
    return this.dirtyTrees.get(tree);
  }

  /**
   * Add a SQL statement to the accumulated statements for the current transaction.
   * Statements are only accumulated when a transaction is active.
   *
   * In transaction mode, this also forwards the statement to the TransactionSession
   * for distributed consensus tracking.
   *
   * @param statement The deterministic SQL statement to accumulate
   */
  addStatement(statement: string): void {
    if (!this.currentTransaction?.isActive) {
      return;
    }

    this.accumulatedStatements.push(statement);

    // In transaction mode, also track in session
    // Note: We pass empty actions since the virtual table already applied changes
    // The session just needs to track the statement for the Transaction record
    if (this.session) {
      // We don't await here - statement tracking is synchronous
      // The session's execute() will just accumulate the statement
      // Actions are already applied by the virtual table
      void this.session.execute(statement, []);
    }
  }

  /**
   * Get all accumulated SQL statements for the current transaction.
   * @returns Array of SQL statements in execution order
   */
  getStatements(): readonly string[] {
    return this.accumulatedStatements;
  }

  /**
   * Get the count of accumulated statements
   */
  getStatementCount(): number {
    return this.accumulatedStatements.length;
  }

  /**
   * Savepoint support (if needed by Quereus)
   */
  async savepoint(_name: string): Promise<void> {
    // Optimystic doesn't have explicit savepoint support
    // This would need to be implemented using collection snapshots
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Release savepoint
   */
  async releaseSavepoint(_name: string): Promise<void> {
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Rollback to savepoint
   */
  async rollbackToSavepoint(_name: string): Promise<void> {
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.currentTransaction?.isActive) {
      await this.rollbackTransaction();
    }
    this.currentTransaction = null;
  }
}
