import type { TransactionCoordinator, ITransactionEngine, Collection, CollectionId } from '@optimystic/db-core';
import { TransactionSession, CoordinatorPartialCommitError } from '@optimystic/db-core';
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
  /**
   * Optional human-readable identifier (a Tree returns its collection id) used
   * only to name persisted vs. unpersisted trees in a {@link PartialCommitError}.
   * Optional so test doubles need not implement it; the bridge falls back to a
   * positional label when absent.
   */
  describe?(): string;
}

/**
 * Thrown by {@link TransactionBridge.commitTransaction} in LEGACY (no-coordinator)
 * mode when a multi-tree commit fails AFTER at least one tree was already durably
 * flushed to storage this commit.
 *
 * ## Why this exists (and why we can't just "roll back")
 *
 * Legacy commit flushes each dirty tree with an independent `tree.sync()`
 * (its own pend+commit against the transactor). Those flushes are NOT a single
 * atomic unit: once tree N is committed to storage, a failure flushing tree N+1
 * cannot un-commit tree N locally (`StorageRepo.commit` is per-block; there is no
 * cross-tree undo outside the distributed consensus path). Silently restoring the
 * already-committed trees' in-memory snapshots would make memory disagree with
 * storage AND falsely report "rolled back" — so instead we surface THIS error,
 * naming exactly which trees persisted and which did not, and we deliberately do
 * NOT touch the persisted trees' in-memory state (it correctly reflects storage).
 *
 * The {@link persisted} trees and {@link unpersisted} trees are now out of sync on
 * disk; recovering them is a caller/operator concern (re-run the transaction, or
 * reconcile). See the commit-site comment in this file and `docs/transactions.md`
 * (§ "Legacy (single-node) commit is not atomic across trees").
 */
export class PartialCommitError extends Error {
  constructor(
    /** Ids of trees durably committed to storage before the failure (NOT rolled back). */
    public readonly persisted: readonly string[],
    /** Ids of trees never flushed this commit (rolled back in-memory only). */
    public readonly unpersisted: readonly string[],
    /** The underlying flush failure that aborted the commit sweep. */
    public readonly reason?: unknown,
  ) {
    super(
      `Legacy multi-tree commit was not atomic: ${persisted.length} tree(s) were durably ` +
      `committed to storage before the commit failed and CANNOT be rolled back. ` +
      `Persisted (now out of sync with the unpersisted trees): [${persisted.join(', ')}]. ` +
      `Not persisted (reverted in-memory only): [${unpersisted.join(', ')}]. ` +
      `Underlying failure: ${reason instanceof Error ? reason.message : String(reason)}`
    );
    this.name = 'PartialCommitError';
  }
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
  /**
   * Depth-indexed savepoint snapshots for LEGACY (staged-tracker) mode. Each
   * entry captures the staged state of EVERY registered collection (main table +
   * all index trees) at the moment the savepoint was created, keyed by the
   * numeric depth Quereus broadcasts (a stack index). {@link rollbackToSavepoint}
   * restores from the captured snapshots to discard exactly the DML staged since;
   * {@link releaseSavepoint} drops the snapshots without restoring.
   *
   * Snapshotting the full {@link collectionRegistry} — rather than only the trees
   * marked dirty so far — is what covers "the tree set the bridge could flush":
   * a tree still clean at create time but dirtied within the savepoint captures
   * its clean staged state here, so rollback returns it to clean. (A tree
   * *created* after the savepoint, e.g. a brand-new index mid-statement, is not in
   * that create-time set — an accepted edge case, unreachable via the DML
   * executor's per-statement savepoints since schema is stable within a statement.)
   *
   * Empty in session mode: there the coordinator owns tracker rollback (see
   * {@link rollbackTransaction}), so a statement-level savepoint rollback is NOT
   * applied to the coordinator's staged transforms — a documented gap. The
   * primary bug this fixes (a failed/aborted statement flushing its partial rows
   * at commit) is a legacy / staged-tracker concern; session mode routes rollback
   * through the coordinator's own snapshot replay instead, and closing the
   * statement-level gap there means teaching the coordinator per-statement
   * checkpoints — out of scope here. See {@link createSavepoint}.
   *
   * NOTE: each savepoint re-snapshots every registered collection; the DML
   * executor opens a statement-level savepoint around every non-FAIL statement, so
   * this is O(collections × staged-transforms) per statement. Fine at current
   * scale; if a schema with many indexes shows savepoint overhead, capture only
   * the dirty set plus copy-on-first-dirty into open savepoints instead.
   */
  private savepoints = new Map<number, Map<Collection<any>, unknown>>();
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
    this.savepoints.clear();

    // Create TransactionSession if transaction mode is enabled
    if (this.coordinator && this.engine && this.schemaHashProvider) {
      const schemaHash = await this.schemaHashProvider();
      // Bind the client signer to this node's libp2p key when one exists. `undefined` (legacy/local
      // mode, or a node with no exposed key) leaves the session unsigned — unchanged behavior. Signing
      // is always safe: it only adds a `signature` field, verified only by nodes that enforce it.
      const signer = this.collectionFactory.getSigner(options);
      this.session = await TransactionSession.create(
        this.coordinator,
        this.engine,
        peerId,
        schemaHash,
        undefined,
        signer
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
        //
        // ⚠️ NOT DURABLY ATOMIC ACROSS TREES. Each tree.sync() is its own
        // pend+commit against the transactor; there is no cross-tree undo here.
        // If the sweep fails AFTER the first tree has synced, trees 1..N are
        // already durably committed and trees N+1.. are not — a real split on
        // disk. We surface that as a loud {@link PartialCommitError} rather than
        // pretending to roll back (see commitDirtyTreesLegacy). True all-or-
        // nothing across independent block clusters is the distributed consensus
        // path's job (GATHER/PEND/COMMIT); see docs/transactions.md
        // (§ "Legacy (single-node) commit is not atomic across trees") for the
        // residual window and the planned pend-all-then-commit-all narrowing.
        await this.commitDirtyTreesLegacy();
      }

      this.currentTransaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;
      this.dirtyTrees.clear();
      this.savepoints.clear();

    } catch (error) {
      if (error instanceof PartialCommitError) {
        // commitDirtyTreesLegacy already cleaned up: it restored the trees that
        // never touched storage and left the durably-committed trees alone (their
        // in-memory state correctly mirrors storage). Running rollbackTransaction
        // here would restore the committed trees too, re-introducing exactly the
        // memory/storage divergence this error exists to prevent. Just propagate.
        throw error;
      }
      if (error instanceof CoordinatorPartialCommitError) {
        // Session-mode analog of the legacy branch above: the coordinator's commit
        // half-landed — some collections durably committed via consensus and CANNOT
        // be rolled back. The coordinator ALREADY did the split local handling (folded
        // the committed collections' trackers to cache + reset, restored the failed
        // ones). Running rollbackTransaction here would clean-restore the committed
        // collections' trackers too, cementing the memory/storage divergence and
        // falsely reporting a rollback that did not happen. So tear down transaction
        // state WITHOUT restoring, and propagate the structured signal for reconciliation.
        this.currentTransaction!.collections.clear();
        this.currentTransaction!.isActive = false;
        this.accumulatedStatements = [];
        this.session = null;
        this.dirtyTrees.clear();
        this.savepoints.clear();
        throw error;
      }
      // Nothing durably committed (a clean session-mode commit failure, or a legacy
      // failure on the FIRST tree): a clean snapshot-restore rollback is correct.
      await this.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Legacy (no-coordinator) commit sweep: flush each dirty tree in turn.
   *
   * On failure the correct recovery depends on how far the sweep got:
   * - **No tree synced yet** (failure on the first tree): nothing is durably
   *   committed, so re-throw untouched and let {@link commitTransaction}'s catch
   *   run the ordinary snapshot-restore {@link rollbackTransaction} — a genuinely
   *   clean rollback.
   * - **At least one tree already synced**: trees 1..N are durably committed and
   *   cannot be un-committed locally. Restore ONLY the trees that never touched
   *   storage (they revert cleanly), leave the committed trees' in-memory state
   *   as-is (it matches storage), tear down the transaction, and throw a
   *   {@link PartialCommitError} naming both sets. We do NOT report success and do
   *   NOT falsely claim a rollback.
   */
  private async commitDirtyTreesLegacy(): Promise<void> {
    const trees = [...this.dirtyTrees.keys()];
    const synced: DirtyTree[] = [];

    for (const tree of trees) {
      try {
        await tree.sync();
        synced.push(tree);
      } catch (error) {
        if (synced.length === 0) {
          // First tree failed — nothing persisted. Let the caller roll back cleanly.
          throw error;
        }

        // Partial persistence. Restore only the trees that never synced; the
        // failed tree itself is among them (its sync cancelled its own pend, so it
        // never reached storage) and reverts cleanly.
        //
        // NOTE: this treats the failing tree as fully unpersisted. That holds while
        // a single tree's flush is all-or-nothing (a conflict/stale rejection
        // cancels its pend before any block commits). It stops holding if one
        // tree's OWN commit spans multiple block commits and fails mid-loop —
        // StorageRepo.commit emits per-block eagerly ("blocks that land before a
        // mid-loop failure stay durably committed"), so that tree would itself be
        // split and restoring its memory reintroduces divergence FOR THAT TREE. If
        // large single-collection commits ever fail mid-block-loop in practice,
        // classify a partially-committed failing tree as persisted here.
        const unsynced = trees.filter(t => !synced.includes(t));
        for (const t of unsynced) {
          t.restore(this.dirtyTrees.get(t));
        }

        const label = (t: DirtyTree) => t.describe?.() ?? `tree#${trees.indexOf(t)}`;
        const persisted = synced.map(label);
        const unpersisted = unsynced.map(label);

        // Tear down transaction state to mirror rollbackTransaction's non-restore
        // cleanup — WITHOUT restoring the persisted trees (that is the whole point).
        this.dirtyTrees.clear();
        this.savepoints.clear();
        this.currentTransaction!.collections.clear();
        this.currentTransaction!.isActive = false;
        this.accumulatedStatements = [];
        this.session = null;

        throw new PartialCommitError(persisted, unpersisted, error);
      }
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
    this.savepoints.clear();

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
   * for distributed consensus tracking. This MUST be awaited: `session.execute`
   * pushes the statement onto the session's own array (the source of truth the
   * replicated Transaction record is compiled from) only AFTER awaiting
   * `coordinator.applyActions`. Firing it off unawaited raced the finalize at
   * commit — a statement could be silently absent from the record validator peers
   * re-execute, diverging their operation set. The empty-actions apply also
   * creates the coordinator's per-transaction rollback snapshot on its first call,
   * so awaiting here (before the caller stages rows) makes that snapshot's timing
   * deterministic — it captures pre-stage state, which session-mode rollback needs.
   *
   * NOTE: statements recorded here are engine-REBUILT from evaluated row values
   * (see buildInsertStatement / buildUpdateStatement in @quereus/quereus), NOT
   * from the source SQL text. A secret passed as a function ARGUMENT (e.g. the
   * private key in `sign(data, key)`) is evaluated away before the rebuild — it
   * never reaches the record. The only secret-exposure vector is a secret stored
   * as a persisted COLUMN VALUE (which any replicated store must replicate). See
   * docs/transactions.md § "Secrets and the replicated statement record" and the
   * regression guard in test/statement-secret-arg-redaction.spec.ts.
   *
   * @param statement The deterministic SQL statement to accumulate
   */
  async addStatement(statement: string): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      return;
    }

    this.accumulatedStatements.push(statement);

    // In transaction mode, also track in session. We pass empty actions since the
    // virtual table already applied the changes directly to the collection tracker;
    // the session just needs to record the statement (and, on its first call, have
    // the coordinator snapshot state for rollback). Await so a failure surfaces as a
    // failed DML rather than a silently dropped statement or unhandled rejection.
    if (this.session) {
      const result = await this.session.execute(statement, []);
      if (!result.success) {
        throw new Error(`Failed to record statement in transaction: ${result.error}`);
      }
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
   * Create a savepoint at the numeric `depth` Quereus broadcasts (a stack index).
   *
   * Captures the staged state of every registered collection so
   * {@link rollbackToSavepoint} can revert exactly the DML staged since. Quereus
   * wraps every non-FAIL DML statement (and every OR FAIL row) in an internal
   * savepoint and rolls back to it on a mid-statement violation, so this is what
   * makes an ordinary failed/aborted statement actually discard its partial rows
   * rather than leaving them staged to flush at the next commit.
   *
   * Idempotent per depth: ONE bridge is shared across every table connection and
   * Quereus broadcasts createSavepoint(depth) once per connection, so the bridge
   * sees the same depth N times — only the first capture is kept.
   *
   * Legacy (staged-tracker) mode only — see {@link savepoints}.
   */
  createSavepoint(depth: number): void {
    if (this.session) {
      return;
    }
    // NOTE: keeping only the FIRST capture per depth is correct only while Quereus
    // releases/rolls-back a savepoint before any later savepoint reuses its depth
    // (verified by the primary-repro test: two statements in one txn reuse the same
    // __stmt_atomic depth, and row 1 survives). If Quereus ever left statement
    // savepoints open and reused a depth, this dedup would return a stale snapshot —
    // capture per (depth, generation) instead.
    if (this.savepoints.has(depth)) {
      return;
    }
    const snapshots = new Map<Collection<any>, unknown>();
    for (const collection of this.collectionRegistry.values()) {
      snapshots.set(collection, collection.snapshotPending());
    }
    this.savepoints.set(depth, snapshots);
  }

  /**
   * Roll back to the savepoint at `depth`, restoring every collection to the
   * staged state captured at create time and discarding savepoints nested ABOVE
   * `depth`. The target itself is PRESERVED (SQL standard: it can be rolled back
   * to again), mirroring Quereus's own memory-layer connection.
   *
   * Idempotent / no-op when `depth` is absent (session mode, or already released).
   * `restorePending` is itself idempotent, so the repeated per-connection
   * broadcast restores to the same state each time.
   */
  rollbackToSavepoint(depth: number): void {
    const snapshots = this.savepoints.get(depth);
    if (!snapshots) {
      return;
    }
    for (const [collection, snapshot] of snapshots) {
      collection.restorePending(snapshot as Parameters<Collection<any>['restorePending']>[0]);
    }
    for (const openDepth of this.savepoints.keys()) {
      if (openDepth > depth) {
        this.savepoints.delete(openDepth);
      }
    }
  }

  /**
   * Release the savepoint at `depth` and every savepoint nested above it WITHOUT
   * restoring — the staged changes are absorbed into the enclosing scope and stay
   * staged (flushed at commit). Never flushes. Idempotent / no-op when absent.
   */
  releaseSavepoint(depth: number): void {
    for (const openDepth of this.savepoints.keys()) {
      if (openDepth >= depth) {
        this.savepoints.delete(openDepth);
      }
    }
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
