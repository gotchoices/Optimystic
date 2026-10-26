import type {
  ITransactionEngine, ITransactor, Collection, CollectionId, IBlockDurabilityNotifier, Transaction, TransactionDurability,
  WriteDurability,
} from '@optimystic/db-core';
import {
  TransactionCoordinator, TransactionSession, CoordinatorPartialCommitError, TreeEntryChangedError, TreeGuardRefusedError,
  TreeKeyTakenError, createTransactionId, createTransactionStamp, recordCollectionDurability, transactionDurability,
  visitEveryThenThrow,
} from '@optimystic/db-core';
import { ConstraintError, QuereusError, StatusCode } from '@quereus/quereus';
import type { TransactionState, ParsedOptimysticOptions } from '../types.js';
import { CollectionFactory } from './collection-factory.js';
import { sqlCommitDurability, type CommitFullyHeldListener, type SqlCommitDurability, type SqlCommitDurabilityListener } from './commit-durability.js';
import { DurabilityFollower } from './durability-follower.js';
import { addListener, notifyListeners } from './listeners.js';
import { SessionModeRefusedError } from './offline-mode.js';
import type { OfflineMode } from './offline-mode.js';
import { generateStampId } from '../util/generate-stamp-id.js';
import { createLogger, revisionToken } from '../logger.js';

const log = createLogger('txn-bridge');

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
  /**
   * Flush this tree's staged changes, resolving to who holds what the flush wrote — or
   * `undefined` when the tree had nothing staged (and so wrote nothing). The per-tree sweep
   * ({@link TransactionBridge.sweepDirtyTreesLegacy}) folds these into the commit's
   * durability report; a test double may resolve nothing, which reads as "wrote nothing".
   */
  sync(): Promise<WriteDurability | undefined>;
  snapshot(): unknown;
  /**
   * Restore the staged state `snapshot` captured. Resolves once the restore is complete: a
   * restore across a change to the collection's sealed segments (an offline-sync entry drained
   * or refused while the transaction was open) replays them, which runs the action handlers
   * (`Collection.restorePending`).
   */
  restore(snapshot: unknown): Promise<void>;
  /**
   * Optional refresh-without-flush (a Tree forwards to `Collection.update()`): adopt the
   * newest committed revision and replay this tree's staged actions against it. Only the
   * per-tree fallback sweep ({@link TransactionBridge.sweepDirtyTreesLegacy}) uses it, as a
   * pre-flight over every staged tree before flushing any — a guarded entry a rival has
   * already contradicted is refused there, while nothing is durable. Optional so test
   * doubles need not implement it; a tree without it is flushed without the pre-flight.
   */
  update?(): Promise<void>;
  /**
   * Optional access to the `Collection` this tree stages into (a Tree returns its own). A
   * legacy commit that has several trees to push hands exactly these collections to a
   * per-commit `TransactionCoordinator`, so that every tree is pended before any is
   * committed ({@link TransactionBridge.commitBatchLegacy}). Optional so test doubles need
   * not implement it; a commit that includes a tree without it takes the per-tree sweep.
   */
  getCollection?(): Collection<any>;
  /**
   * Optional human-readable identifier (a Tree returns its collection id) used
   * only to name persisted vs. unpersisted trees in a {@link PartialCommitError}.
   * Optional so test doubles need not implement it; the bridge falls back to a
   * positional label when absent.
   */
  describe?(): string;
  /**
   * Optional "does this tree still have something to push?" predicate (a Tree
   * forwards to `Collection.hasUnsyncedChanges()`). Used ONLY by the
   * `commit:collections` trace to say staged-vs-clean per collection; the commit
   * sweep itself does not branch on it. Optional so test doubles need not
   * implement it — the trace reports `unknown` when absent.
   */
  hasUnsyncedChanges?(): boolean;
  /**
   * Optional "which committed revision is this tree reading at?" (a Tree
   * forwards to `Collection.committedRevision()`; `undefined` means the collection was
   * invented locally and never adopted a committed revision). Used ONLY by the
   * `commit:collections` trace; the commit sweep itself does not branch on it. Optional
   * so test doubles need not implement it — the trace reports `:unknown` when absent,
   * which is distinct from `:none` (implemented, and the collection is invented).
   */
  committedRevision?(): number | undefined;
  /**
   * Optional "which action produced the revision this tree is reading at?" (a Tree
   * forwards to `Collection.committedActionId()`; `undefined` means the collection's
   * action context holds no entry at that revision — including an invented collection,
   * which has no context at all). Used ONLY by the `commit:collections` trace; the commit
   * sweep itself does not branch on it. Optional on the same terms as
   * {@link committedRevision}, and reported as `unknown` when absent — distinct from
   * `none`, which is "asked, and there is none".
   */
  committedActionId?(): string | undefined;
}

/**
 * Name a dirty tree for diagnostics: its collection id, or a positional label when
 * the tree is a double that does not implement {@link DirtyTree.describe}. Shared by
 * the `commit:collections` trace and {@link PartialCommitError}'s persisted/unpersisted
 * lists so both name the same tree the same way.
 */
const treeLabel = (tree: DirtyTree, index: number): string => tree.describe?.() ?? `tree#${index}`;

/** What a commit wrote, from the per-collection answers gathered so far: `undefined` when none
 * was gathered — nothing was written, or no tree that wrote could say (a test double). */
const writtenDurability = (written: ReadonlyMap<CollectionId, WriteDurability | undefined>): TransactionDurability | undefined =>
  written.size === 0 ? undefined : transactionDurability(written);

/**
 * The committed revision to print for a dirty tree in the `commit:collections` trace.
 * Keeps the two "no number" cases apart, because they mean opposite things: `unknown`
 * is "nobody asked" (a double without the method), `none` is "asked, and this
 * collection has never adopted a committed revision" — i.e. it was invented locally,
 * which is itself a finding.
 */
const treeRevision = (tree: DirtyTree): number | 'none' | 'unknown' =>
  tree.committedRevision === undefined ? 'unknown' : (tree.committedRevision() ?? 'none');

/**
 * The lineage marker to print beside {@link treeRevision} — the action that produced the
 * revision the tree is reading at. Same two "no answer" words, meaning the same two
 * things: `unknown` is "nobody asked" (a double without the method), `none` is "asked,
 * and there is no action recorded at that revision" (an invented collection, or a
 * revision slot the log gave to a checkpoint or invalidation entry — see
 * `Collection.committedActionId`).
 *
 * The revision alone cannot separate "one collection, this node behind" from "two
 * separately-built collections under one id"; this can — see {@link revisionToken}.
 */
const treeActionId = (tree: DirtyTree): string | 'none' | 'unknown' =>
  tree.committedActionId === undefined ? 'unknown' : (tree.committedActionId() ?? 'none');

/** One collection's row in a {@link TransactionBridge} `commit:collections` trace line. */
interface CommitCollectionTrace {
  /** The collection id — the same string `openIndexTree`'s `index:tree-open` line prints. */
  id: string;
  /** Whether the collection still holds unflushed changes; `undefined` when unknowable. */
  staged: boolean | undefined;
  /**
   * The committed revision the collection READS at when the line is emitted — which is
   * BEFORE the flush, so the commit this line announces lands at this value plus one
   * (`none` lands at 1). Or:
   * - `'none'` — the collection is INVENTED: it has no committed revision because
   *   nothing was ever committed under its id and this process staged a fresh empty
   *   one (`Collection.createOrOpen`'s create branch).
   * - `'unknown'` — the source could not be asked (a {@link DirtyTree} double that
   *   omits `committedRevision`).
   *
   * Emitted in the line's `revs=` field, never folded into the id token — see
   * {@link TransactionBridge.logCommitCollections}.
   */
  rev: number | 'none' | 'unknown';
  /**
   * The action that produced {@link rev} — this collection's lineage marker at that
   * revision, printed as the `@` half of the `revs=` pair. `'none'` when the collection's
   * committed list holds no entry at that revision (an invented collection has none at
   * all); `'unknown'` when the source could not be asked.
   *
   * This is the discriminator between "two nodes committed into one lineage" and "each
   * node built its own separate collection under one id". The collection ID cannot fork
   * (a collection's header block id IS its id) and the revision alone cannot tell the two
   * apart — under "two copies" each copy honestly reports its own count, which reads as
   * ordinary lag. Same revision + same action id = one copy, one node behind; same
   * revision + different action ids = two copies.
   */
  action: string | 'none' | 'unknown';
}

/**
 * Thrown by {@link TransactionBridge.commitTransaction} in LEGACY (no-coordinator)
 * mode when the per-tree FALLBACK sweep ({@link TransactionBridge.sweepDirtyTreesLegacy})
 * fails AFTER at least one tree was already durably flushed to storage this commit.
 *
 * Only the fallback raises this. A legacy commit with several trees to push normally
 * pends all of them before committing any, through a per-commit coordinator, and a
 * commit-phase split there surfaces as db-core's `CoordinatorPartialCommitError` — the
 * same class session mode raises — so a caller that catches by class must handle both
 * (see `docs/transactions.md` § "Legacy (single-node) commit"). The sweep remains only
 * for a commit whose trees cannot share one pend batch: collections on different
 * transactor instances, or test doubles with no collection.
 *
 * ## Why this exists (and why we can't just "roll back")
 *
 * The sweep flushes each dirty tree with an independent `tree.sync()`
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
 * (§ "Legacy (single-node) commit").
 */
export class PartialCommitError extends Error {
  constructor(
    /** Ids of trees durably committed to storage before the failure (NOT rolled back). */
    public readonly persisted: readonly string[],
    /** Ids of trees never flushed this commit (rolled back in-memory only). */
    public readonly unpersisted: readonly string[],
    /** The underlying flush failure that aborted the commit sweep. */
    public readonly reason?: unknown,
    /**
     * Who holds the {@link persisted} half — the same shape, folded the same way, as the
     * report a successful commit delivers and as `CoordinatorPartialCommitError.durability`.
     * Absent only when no persisted tree reported one (a test double).
     */
    public readonly durability?: TransactionDurability,
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
 * A commit refused because another writer changed or removed the row this statement read — the
 * lost-update refusal ({@link TransactionBridge.mapCommitRefusal} maps a `TreeEntryChangedError`
 * to it). Deliberately NOT a `ConstraintError`: no uniqueness or integrity rule was violated, and
 * dressing a lost update as one would misreport it to every client. It carries
 * `StatusCode.BUSY`, the code the engine's own memory table raises for the same
 * optimistic-concurrency loss, so a caller can classify by class (`instanceof`) or by code
 * (`code === StatusCode.BUSY`). The refusal is reachable through `cause`; retrying the statement
 * sequentially re-reads the row and decides again.
 */
export class ConcurrentModificationError extends QuereusError {
  constructor(message: string, cause?: Error) {
    super(message, StatusCode.BUSY, cause);
    this.name = 'ConcurrentModificationError';
    Object.setPrototypeOf(this, ConcurrentModificationError.prototype);
  }
}

/**
 * How one guard refusal renders to SQL: the message registered for its collection, and the
 * engine error type that class of refusal raises over it (see
 * {@link TransactionBridge.mapRefusal}). `raise` takes the failure being rewrapped as the
 * new error's `cause`, so the structured refusal stays reachable.
 */
interface MappedRefusal {
  readonly message: string;
  readonly raise: (cause: Error) => Error;
}

/**
 * The engine id stamped on a legacy multi-tree commit's transaction. Purely descriptive: the
 * pend carries no validation payload, so no member ever resolves an engine by it — it only
 * says, to anyone reading the stamp, that the rows were staged straight into the trees rather
 * than produced by re-executable statements.
 */
const LegacyCommitEngineId = 'legacy';

/**
 * Time-to-live of a legacy multi-tree commit's transaction stamp. Members never see the
 * stamp (an unvalidated pend carries no transaction), so this expiry is only the
 * coordinator's own ceiling, checked before each attempt. Set well above the default retry
 * budget (about 21 s of backoff across 10 attempts, plus round trips) so that the budget,
 * not the clock, ends a contended commit — the single-tree `Collection.sync` path has no
 * clock at all.
 */
const LegacyCommitTtlMs = 5 * 60_000;

/** The collections a multi-tree legacy commit pends as one batch, on the one transactor
 * they all share. See {@link TransactionBridge.legacyBatch}. */
interface LegacyBatch {
  collections: readonly Collection<any>[];
  transactor: ITransactor;
}

/**
 * Transaction bridge between Quereus and Optimystic.
 *
 * This bridge handles both:
 * 1. Legacy mode: Direct collection sync (when no coordinator/engine is set)
 * 2. Transaction mode: Using TransactionSession for distributed consensus
 */
export class TransactionBridge {
  // NOTE: single-valued transaction state — ONE writer at a time is a standing
  // constraint of this bridge. `currentTransaction`, `session`, `dirtyTrees`,
  // `savepoints`, and `accumulatedStatements` all describe THE transaction, not a
  // transaction per connection; a second concurrent WRITER would overwrite them
  // wholesale. The bridge cannot enforce this itself without breaking SQLite's
  // "BEGIN inside a transaction is a no-op" semantics (beginTransaction
  // deliberately returns the existing transaction, so a second writer's BEGIN is
  // indistinguishable from a nested BEGIN). Quereus serializes writers behind its
  // exec mutex and the concurrent `_readCommitted` path is read-only, so the
  // constraint holds today. If a host ever drives two writers concurrently, each
  // needs its OWN bridge. See docs/transactions.md § "One writer at a time on the
  // shared TransactionBridge" for the shared-vs-single-writer state table.
  private currentTransaction: TransactionState | null = null;
  /**
   * The libp2p peer id of the node this bridge writes from, resolved at {@link beginTransaction}
   * (undefined for a node with no exposed key: local, test and injected transactors). Session
   * mode stamps it on the session; legacy mode stamps it on the per-commit transaction a
   * multi-tree commit hands its coordinator ({@link legacyTransaction}).
   */
  private peerId: string | undefined;
  /**
   * Non-null while the store is in a known-degraded state: a partial commit
   * (`CoordinatorPartialCommitError` from a pended batch in either mode, or
   * {@link PartialCommitError} from the legacy per-tree fallback sweep) left some trees
   * durably committed and others not, so NO single
   * tree set is a coherent commit boundary. While latched, committed
   * (`_readCommitted`) reads must refuse to answer — the vtab checks
   * {@link getDegradedReason} at the first pull and throws, per upstream's
   * committed-snapshot contract ("throw rather than answer from a state that
   * cannot serve a coherent committed snapshot"). Live reads are unaffected: they
   * report whatever the trees hold, which honestly mirrors storage. Cleared by the
   * next successful commit or rollback — the point at which a reconciled local
   * state is back in view.
   *
   * NOTE: the latch is an advisory "I know I am broken" signal, not a repair. It
   * narrows the window in which committed reads serve an incoherent state; it does
   * not heal the split, and the clearing rule is deliberately coarse — an unrelated
   * transaction's clean commit or rollback releases it even though the durably-split
   * trees are untouched. Concretely, after a legacy split that persisted the main
   * table but not its index, a post-clear committed FULL SCAN and a committed
   * INDEX-DRIVEN scan of the same table disagree, and always will: only the
   * application-level reconciliation described in docs/correctness.md § "Partial
   * landing" fixes that. `readCommittedSnapshot` IS now declared, and deliberately
   * does NOT treat a cleared latch as proof of a coherent store: the declared
   * obligation is scoped to reads not tearing across a CONCURRENT commit, and the
   * at-rest split above afflicts the serialized path identically (documented at the
   * declaration site and in docs/transactions.md § "Committed reads run concurrently
   * with a stalled commit"). If the clearing rule is ever asked to certify at-rest
   * coherence, it needs to become a real reconciliation check first, not a
   * next-commit-wins heuristic.
   */
  private degradedReason: string | null = null;
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
   * The tables (`schema.table`) each registered collection backs — its main tree or one of its
   * index trees — recorded by {@link registerCollection}. A set because two tables declared over
   * one collection URI share its collections. Read to build a commit report's per-table view
   * ({@link reportCommitDurability}) and, through {@link tablesOf}, the table-level statuses of the
   * offline queue.
   */
  private collectionTables = new Map<CollectionId, Set<string>>();
  /**
   * Listeners registered with {@link onCommitDurability}, called in registration order once per
   * commit that wrote something.
   */
  private durabilityListeners = new Set<SqlCommitDurabilityListener>();
  /** Listeners registered with {@link onCommitFullyHeld}. */
  private fullyHeldListeners = new Set<CommitFullyHeldListener>();
  /** Follows each reported commit saved below full replication until its whole cohort holds it. */
  private durabilityFollower = new DurabilityFollower({
    onFullyHeld: transactionId => this.reportFullyHeld(transactionId),
  });
  /**
   * The full-replication event source of the node this bridge writes through, resolved at
   * {@link beginTransaction} beside {@link peerId}; `undefined` for a transactor that keeps no
   * under-replication ledger.
   */
  private durabilityNotifier: IBlockDurabilityNotifier | undefined;
  /**
   * Per-collection SQL rendering of a concurrency-refused duplicate: the
   * `UNIQUE constraint failed: <table>.<col>[, …]` message the vtab registers for its
   * MAIN collection (naming the PRIMARY KEY columns) and for each UNIQUE-enforcing
   * index tree (naming that constraint's columns) as it initializes (see
   * OptimysticVirtualTable.registerCollections). A `TreeKeyTakenError` — or its
   * `TreeRangeTakenError` subclass out of a unique index tree — surfacing at commit,
   * the losing writer's conflict replay refusing a key (or a unique value) a rival
   * already committed, is rewrapped via {@link mapCommitRefusal} into the engine's
   * `ConstraintError` carrying the exact message a sequential duplicate INSERT produces,
   * so a client classifying by type or code sees no difference between the two.
   */
  private keyTakenMessages = new Map<CollectionId, string>();
  /**
   * Per-collection SQL rendering of a concurrency-refused ROW CHANGE: the
   * `concurrent modification: another writer changed or removed the row in <table> at
   * primary key (…)` message the vtab registers for its MAIN collection (see
   * OptimysticVirtualTable.registerCollections). A `TreeEntryChangedError` surfacing at
   * commit — the losing writer's conflict replay finding that the row image its UPDATE,
   * DELETE, or REPLACE was computed from is no longer what the collection holds — is
   * rewrapped via {@link mapCommitRefusal} through this renderer, which decodes the framed
   * key into the row's logical primary-key values, into a {@link ConcurrentModificationError}
   * — deliberately not a `ConstraintError`, since a lost update violates no constraint. A
   * renderer rather than a fixed string because the message names the refused row, which
   * only the error carries.
   */
  private entryChangedRenderers = new Map<CollectionId, (key: string) => string>();
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
   * its clean staged state here, so rollback returns it to clean. A tree
   * *registered* after the savepoint (e.g. a table that finishes initializing
   * mid-statement) is topped up into every open savepoint at registration time
   * instead — see {@link registerCollection} — which is sound because
   * registration always precedes any DML staged into that tree, so the top-up
   * capture holds no staged DML at any open depth, same as this create-time set.
   *
   * "No staged DML" is not the same as "empty": an INVENTED collection carries its
   * header/log blocks in the tracker from construction (see
   * `Collection.createOrOpen`), and both capture paths record those, so a rollback
   * returns such a tree to readable-but-unwritten rather than destroying it.
   * NOTE: that also means rolling back to a savepoint does NOT un-create a tree
   * invented while the savepoint was open — `CREATE INDEX` inside an explicit
   * transaction leaves the new tree's structural blocks staged even if the
   * statement is rolled back. Harmless today (addIndex's backfill flushes those
   * trees eagerly, so the create is already durable by then); if DDL ever becomes
   * savepoint-reversible, capture invented trees as absent instead.
   *
   * Empty in session mode: there the coordinator owns tracker rollback (see
   * {@link rollbackTransaction}), so a statement-level savepoint rollback is NOT
   * applied to the coordinator's staged transforms — a documented gap. The
   * primary bug this fixes (a failed/aborted statement flushing its partial rows
   * at commit) is a legacy / staged-tracker concern; session mode routes rollback
   * through the coordinator's own snapshot restore instead, and closing the
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
  /**
   * The offline-mode controller of the `Database` this bridge serves ({@link attachOfflineMode}):
   * read when a transaction begins, to fix its acknowledgement, and handed the dirty trees of a
   * locally acknowledged commit to seal ({@link sealForLocalAcknowledgement}). Absent for a bridge
   * built bare (tests); every transaction is then network-acknowledged.
   */
  private offline: OfflineMode | undefined;

  constructor(collectionFactory: CollectionFactory) {
    this.collectionFactory = collectionFactory;
  }

  /**
   * Attach the offline-mode controller. A setter rather than a constructor argument because the two
   * refer to each other (the controller reports drained commits through this bridge) and the bare
   * constructor is what tests build. Set once by the plugin's `register`.
   */
  attachOfflineMode(offline: OfflineMode): void {
    if (this.offline !== undefined) throw new Error('an offline-mode controller is already attached to this bridge');
    this.offline = offline;
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
   * ## Refused while offline mode is in use
   *
   * A queued session transaction would be stale by the time it drains (docs/offline-sync.md
   * §Session mode), so the two modes cannot be combined in either order: this throws
   * `SessionModeRefusedError` while offline mode is entered or locally acknowledged transactions are
   * queued, and `plugin.offline.enter()` throws while session mode is configured.
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
    if (this.offline?.isEntered()) throw new SessionModeRefusedError('offline-mode');
    if (this.offline?.hasQueuedEntries()) throw new SessionModeRefusedError('queued-entries');
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
   * them at rollback, and so LEGACY-mode savepoints (see {@link savepoints}) cover
   * it too. Idempotent (keyed by collection id) and mode-agnostic: registration
   * must always precede any DML staged into the collection — a capture taken
   * after staging would record already-dirty state as "before" — which holds
   * because this is always called as a table initializes, before any DML.
   *
   * The registry is the live map handed to the coordinator, so registering after
   * the coordinator was constructed still makes the collection visible to it.
   *
   * Also tops up every currently-open legacy savepoint with a clean capture of
   * this collection, so a savepoint created before this collection existed still
   * restores it correctly (see {@link savepoints}).
   *
   * The load-bearing guard is the per-savepoint `has` check: registration is
   * idempotent (`reconcileMaintainedIndexes` re-registers already-open index
   * trees, by which point they may hold this statement's staged rows), and
   * re-capturing then would record that dirty state as "before" and defeat the
   * savepoint it belongs to. It is keyed by object IDENTITY, not id, so a NEW
   * instance registered under an already-known id (a table re-initializing
   * mid-transaction) still gets its own clean capture while the old instance's
   * capture is left alone.
   *
   * `table` is the qualified `schema.table` the collection backs, which a commit's durability
   * report groups its collections under (see {@link onCommitDurability}).
   */
  registerCollection(collection: Collection<any>, table?: string): void {
    if (table !== undefined) {
      this.recordCollectionTable(collection.id, table);
    }
    const known = this.collectionRegistry.get(collection.id);
    this.collectionRegistry.set(collection.id, collection);
    // Fast path only: a re-registration of a known INSTANCE is already present in
    // every open savepoint (captured either by createSavepoint's sweep or by this
    // loop's first pass), so the `has` check below would skip it anyway.
    if (known === collection) {
      return;
    }
    // One snapshotPending() per open savepoint that doesn't already have this
    // collection. Savepoint depth is shallow (statement/row nesting) and a
    // just-registered collection has staged no DML, so this is negligible.
    for (const snapshots of this.savepoints.values()) {
      if (!snapshots.has(collection)) {
        snapshots.set(collection, collection.snapshotPending());
      }
    }
  }

  private recordCollectionTable(id: CollectionId, table: string): void {
    const tables = this.collectionTables.get(id);
    if (tables === undefined) {
      this.collectionTables.set(id, new Set([table]));
    } else {
      tables.add(table);
    }
  }

  /**
   * Stop naming `table` (`schema.table`) in commit reports — for a table that was dropped, or
   * whose CREATE was refused. Its collections stay registered (a DROP has never unregistered
   * them), so without this a later table declared over the same URI would report its writes
   * under the dropped table's name as well as its own.
   */
  forgetTable(table: string): void {
    for (const [id, tables] of this.collectionTables) {
      if (tables.delete(table) && tables.size === 0) {
        this.collectionTables.delete(id);
      }
    }
  }

  /** The tables (`schema.table`) collection `id` backs, as {@link registerCollection} recorded them;
   * `undefined` for a collection no table was registered for (a test double). Read by the
   * offline-mode controller to name tables on its statuses. */
  tablesOf(id: CollectionId): ReadonlySet<string> | undefined {
    return this.collectionTables.get(id);
  }

  /**
   * Subscribe to the durability of every SQL commit that wrote something: after the commit
   * succeeds and the bridge has torn its transaction down, and before `commitTransaction`
   * returns, each listener is called once, synchronously, in registration order, with a frozen
   * {@link SqlCommitDurability}. A commit that wrote nothing (a read-only transaction, a
   * statement that matched no rows) calls nobody, and a commit that fails reports through its
   * error instead (`CoordinatorPartialCommitError.durability`, {@link PartialCommitError.durability}).
   *
   * Quereus serializes writers behind its exec mutex, so every report delivered while a host's
   * `await db.exec(...)` is running belongs to that exec. A listener that throws is logged and
   * the rest still run; it never turns an acknowledged commit into a reported failure.
   *
   * Returns an idempotent unsubscribe.
   */
  onCommitDurability(listener: SqlCommitDurabilityListener): () => void {
    return addListener(this.durabilityListeners, listener);
  }

  /**
   * Subscribe to the moment a followed commit becomes fully held: one whose
   * {@link SqlCommitDurability} said `followed` while it was held below full replication. Each
   * listener is called once per such commit, synchronously, in registration order, with its
   * `transactionId` — from the event that covered the last of its blocks, or from a later commit
   * through this bridge that wrote those blocks at full replication. A commit already fully held
   * when reported is never reported here. Same listener discipline as {@link onCommitDurability}.
   *
   * Followed commits live in memory: a restart, {@link dispose}, or the follower's cap on pending
   * commits forgets them, and they are then never reported.
   *
   * Returns an idempotent unsubscribe.
   */
  onCommitFullyHeld(listener: CommitFullyHeldListener): () => void {
    return addListener(this.fullyHeldListeners, listener);
  }

  /**
   * Stop following commits: release the full-replication subscriptions and forget every pending
   * commit, so no {@link onCommitFullyHeld} listener is called again for one. Commits made after
   * this are followed afresh.
   */
  dispose(): void {
    this.durabilityFollower.dispose();
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
   * Register the SQL message a `TreeKeyTakenError` from `collectionId` maps to at
   * commit (see {@link keyTakenMessages}). Idempotent; called by the vtab as each
   * table initializes, alongside {@link registerCollection} — once for the main
   * collection (the PRIMARY KEY message) and once per UNIQUE-enforcing index tree
   * (that constraint's columns), since a `TreeRangeTakenError` out of an index
   * collection's replay names the violated UNIQUE constraint by its collection id.
   */
  registerKeyTakenMessage(collectionId: CollectionId, message: string): void {
    this.keyTakenMessages.set(collectionId, message);
  }

  /**
   * Register how a `TreeEntryChangedError` from `collectionId` renders at commit (see
   * {@link entryChangedRenderers}): `render` receives the refused entry's framed key and
   * returns the SQL-facing message. Idempotent; called by the vtab for its main
   * collection alongside {@link registerKeyTakenMessage}. Index trees register none —
   * no index-tree write carries an `unchanged` guard, because a stale index delta can
   * only be prevented by refusing the main-table action it was derived from, never
   * repaired from inside the index tree.
   */
  registerEntryChangedRenderer(collectionId: CollectionId, render: (key: string) => string): void {
    this.entryChangedRenderers.set(collectionId, render);
  }

  /**
   * Rewrap a commit failure caused by a guard refusal (`TreeGuardRefusedError` anywhere
   * in the cause chain — a losing writer's conflict replay refusing what a rival already
   * committed) into a typed engine error whose MESSAGE is the SQL rendering registered for
   * the refusing collection, keeping the structured refusal reachable via `cause`. Message
   * and type are both chosen by the refusal's class, because the two mean different things
   * to a client:
   *
   * - a `TreeKeyTakenError` (its `TreeRangeTakenError` subclass included) is a uniqueness
   *   violation. It renders as the registered `UNIQUE constraint failed: …` message and
   *   becomes the engine's `ConstraintError` (`StatusCode.CONSTRAINT`), so a refused
   *   concurrent duplicate differs from a sequential one in nothing a client can observe.
   * - a `TreeEntryChangedError` is a lost update — the row the statement read was changed
   *   or removed. It renders through the registered concurrent-modification renderer and
   *   becomes a {@link ConcurrentModificationError} (`StatusCode.BUSY`), NOT a
   *   `ConstraintError`: no integrity rule was violated, and a constraint error would also
   *   be rewrapped by the engine's `or fail` / `or rollback` handling into keeping the
   *   statement's prior rows, which is wrong for a lost update.
   *
   * Both types extend `QuereusError`, which is what makes the vtab's DML catch rethrow a
   * mapped error verbatim instead of wrapping it again. Anything else — no guard refusal in
   * the chain, an unregistered collection, or an error already carrying the mapped message
   * (the legacy sweep maps before rethrowing, and commitTransaction's catch maps again) —
   * passes through unchanged.
   *
   * Public because the vtab's DML catch maps through it too: a guard is enforced at
   * INITIAL staging as well as at replay, and a staging-time refusal (the tracker
   * fetched a rival's commit the pre-stage probe's view had not) must reach the client
   * as the same message a commit-time one does.
   *
   * NOTE: a STAGING-time `ConstraintError` is the one mapped error the engine may replace
   * rather than propagate — `translateConflictError` in
   * `@quereus/quereus/src/runtime/emit/dml-executor.ts` rebuilds it as `FailConflictError` /
   * `RollbackConflictError` under `or fail` / `or rollback`, copying message and code but NOT
   * `cause`, so the structured refusal is unreachable on those two dispositions. That is the
   * same treatment a sequential duplicate gets, which is the point; only the `cause` promise is
   * narrower there than at a commit-time refusal, which never passes through that translation.
   */
  mapCommitRefusal(error: unknown): unknown {
    for (let cursor: unknown = error; cursor instanceof Error; cursor = cursor.cause) {
      if (cursor instanceof TreeGuardRefusedError) {
        const mapped = this.mapRefusal(cursor);
        if (mapped === undefined || !(error instanceof Error) || error.message === mapped.message) {
          return error;
        }
        return mapped.raise(error);
      }
    }
    return error;
  }

  /**
   * How one guard refusal surfaces to SQL — the registered message and the engine error type
   * that carries it — or `undefined` when its collection registered nothing for that class.
   * Both halves are dispatched here, in ONE place: a future `TreeGuardRefusedError` subclass
   * that registers a message must also say which error type raises it, rather than acquiring
   * a message in one dispatch and silently inheriting the lost-update type from another.
   */
  private mapRefusal(refusal: TreeGuardRefusedError): MappedRefusal | undefined {
    if (refusal instanceof TreeKeyTakenError) {
      const message = this.keyTakenMessages.get(refusal.collectionId);
      return message === undefined
        ? undefined
        : { message, raise: cause => new ConstraintError(message, StatusCode.CONSTRAINT, cause) };
    }
    if (refusal instanceof TreeEntryChangedError) {
      const message = this.entryChangedRenderers.get(refusal.collectionId)?.(String(refusal.key));
      return message === undefined
        ? undefined
        : { message, raise: cause => new ConcurrentModificationError(message, cause) };
    }
    return undefined;
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
    this.peerId = peerId;
    this.durabilityNotifier = this.collectionFactory.getBlockDurabilityNotifier(options);
    // Before the commit is sent: an event for its blocks can fire before its answer reaches us.
    if (this.durabilityNotifier !== undefined) {
      this.durabilityFollower.watch(this.durabilityNotifier);
    }

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
      // Fixed here, not at commit: a mode change during an open transaction changes nothing about
      // it (docs/offline-sync.md §Entering and leaving the mode). Never 'local' in session mode,
      // which offline mode refuses to enter beside, and vice versa.
      acknowledgement: this.offline?.isEntered() === true ? 'local' : 'network',
    };

    return this.currentTransaction;
  }

  /**
   * Commit the current transaction.
   *
   * If transaction mode is enabled, commits through TransactionSession for distributed consensus.
   * A transaction that began with local acknowledgement (offline mode, `TransactionState.acknowledgement`)
   * is sealed into the offline queue instead of reaching storage ({@link sealForLocalAcknowledgement}).
   * Otherwise, uses legacy direct sync.
   */
  async commitTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to commit');
    }
    const transactionId = this.currentTransaction.stampId;

    let durability: TransactionDurability | undefined;
    // A local acknowledgement reaches no storage, so it reconciles nothing: the degraded latch is
    // left as it was rather than released (see degradedReason).
    let reconciled = true;
    try {
      if (this.session) {
        durability = await this.commitSession(this.session);
      } else if (this.currentTransaction.acknowledgement === 'local' && this.sealForLocalAcknowledgement(transactionId)) {
        reconciled = false;
      } else {
        // Legacy mode: push every tree that staged DML this transaction. This
        // replaces the inline updateAndSync that Tree.replace() used to perform
        // at DML time — deferring the flush to commit is what lets a deferred
        // (subquery-bearing) CHECK rejection roll back cleanly: the constraint
        // throws before this point, so the staged trees are rolled back never
        // having touched storage.
        //
        // A commit with several trees to push (a table and its indexes, or two
        // tables) pends ALL of them before committing ANY, through a per-commit
        // coordinator — so a refusal at pend (the common failure: a rival took a
        // key, a unique value, or changed a row this write read) leaves nothing
        // durable and rolls back cleanly. What remains is the commit-phase
        // residual session mode shares: a permanent loss on one tree's commit
        // after every pend succeeded, surfaced as CoordinatorPartialCommitError
        // rather than papered over. See commitDirtyTreesLegacy and
        // docs/transactions.md (§ "Legacy (single-node) commit").
        durability = await this.commitDirtyTreesLegacy();
      }

      this.currentTransaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;
      this.dirtyTrees.clear();
      this.savepoints.clear();
      // A clean commit reconciles the local view — release the degraded latch so
      // committed reads answer again (see degradedReason).
      if (reconciled) this.degradedReason = null;

    } catch (error) {
      if (error instanceof PartialCommitError) {
        // The legacy fallback sweep already cleaned up: it restored the trees that
        // never touched storage and left the durably-committed trees alone (their
        // in-memory state correctly mirrors storage). Running rollbackTransaction
        // here would restore the committed trees too, re-introducing exactly the
        // memory/storage divergence this error exists to prevent. Latch the
        // degraded state (committed reads must refuse until the next clean
        // commit/rollback) and propagate.
        this.degradedReason = error.message;
        throw error;
      }
      if (error instanceof CoordinatorPartialCommitError) {
        // A pended batch's commit half-landed — in session mode, or a legacy
        // multi-tree commit (commitBatchLegacy): some collections durably committed
        // via consensus and CANNOT be rolled back. The coordinator ALREADY did the
        // split local handling (folded the committed collections' trackers to cache
        // + reset, restored the failed ones to their pre-append state; the legacy
        // path then restored those failed trees to their pre-transaction snapshots,
        // as the fallback sweep does). Running rollbackTransaction here would
        // clean-restore the committed collections' trackers too, cementing the
        // memory/storage divergence and falsely reporting a rollback that did not
        // happen. So latch the degraded state (committed reads must refuse until the
        // next clean commit/rollback), tear down transaction state WITHOUT
        // restoring, and propagate the structured signal for reconciliation.
        this.degradedReason = error.message;
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
      // A concurrency-refused duplicate key (TreeKeyTakenError anywhere in the cause
      // chain — session mode surfaces it raw out of the coordinator's inter-attempt
      // refresh; the legacy sweep has already mapped it, which mapCommitRefusal
      // detects and passes through) is rewrapped as the ordinary UNIQUE-constraint
      // error so the loser sees the same refusal a sequential duplicate produces.
      // The commit's failure is the answer; a restore that fails inside this rollback has
      // already been logged and latched by rollbackTransaction (which tears the transaction
      // down either way), and must not replace it.
      try {
        await this.rollbackTransaction();
      } catch (rollbackError) {
        log('commit:rollback-failed error=%s', rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
      throw this.mapCommitRefusal(error);
    }
    if (durability !== undefined) this.reportCommitDurability(transactionId, durability);
  }

  /**
   * The offline route of a commit whose transaction began with local acknowledgement: seal every
   * staged dirty tree's open segment into one queue entry under the transaction's id, so the commit
   * resolves once the entry is queued and the drain commits it later under that same id
   * (docs/offline-sync.md §Entry lifecycle). The `queued` status is delivered synchronously inside
   * the enqueue, before this commit returns. Answers `false`, sealing nothing, when the dirty set
   * cannot be one entry ({@link localAcknowledgementSet}): the caller then takes the network route
   * for this transaction. `true` otherwise, including when nothing was staged — nothing is queued
   * and nothing is reported then, as a commit that wrote nothing reports nothing.
   */
  private sealForLocalAcknowledgement(transactionId: string): boolean {
    const offline = this.offline;
    if (offline === undefined) return false;
    const trees = [...this.dirtyTrees.keys()];
    const collections = this.localAcknowledgementSet(trees);
    if (collections === undefined) return false;
    if (log.enabled) {
      this.logCommitCollections('offline', trees.map((tree, i) => ({
        id: treeLabel(tree, i),
        staged: tree.hasUnsyncedChanges?.(),
        rev: treeRevision(tree),
        action: treeActionId(tree),
      })));
    }
    offline.enqueue(collections, transactionId);
    return true;
  }

  /**
   * The collections one locally acknowledged commit seals: every staged dirty tree's, or `undefined`
   * when the set cannot be one entry. The shape is {@link legacyBatch}'s, with the single-tree case
   * allowed (the queue commits one collection through `Collection.commitHead`): a tree with no
   * collection to seal, collections on different transactor instances (an entry is one network
   * transaction on one transactor), or two trees that are separate instances over one collection id,
   * whose two segments under one entry id the per-entry coordinator's id-keyed map would collapse —
   * the reason the sweep refuses to batch them too. A refused set is logged
   * `offline:local-ack-unavailable` with its reason.
   */
  private localAcknowledgementSet(trees: readonly DirtyTree[]): Collection<any>[] | undefined {
    const staged = trees.filter(tree => tree.hasUnsyncedChanges?.() !== false);
    const collections: Collection<any>[] = [];
    for (const [index, tree] of staged.entries()) {
      const collection = tree.getCollection?.();
      if (collection === undefined) {
        return this.localAcknowledgementUnavailable(`${treeLabel(tree, index)} has no collection to seal`);
      }
      collections.push(collection);
    }
    const transactor = collections[0]?.transactor;
    if (collections.some(collection => collection.transactor !== transactor)) {
      return this.localAcknowledgementUnavailable('the collections sit on different transactors');
    }
    if (new Set(collections.map(collection => collection.id)).size !== collections.length) {
      return this.localAcknowledgementUnavailable('two trees are separate instances over one collection id');
    }
    return collections;
  }

  private localAcknowledgementUnavailable(reason: string): undefined {
    log('offline:local-ack-unavailable reason=%s: this transaction is acknowledged by the network', reason);
    return undefined;
  }

  /**
   * Session-mode commit: hand the staged transforms to the session's coordinator for
   * distributed consensus. Resolves to who holds what the commit wrote, or `undefined` when
   * it wrote nothing.
   */
  private async commitSession(session: TransactionSession): Promise<TransactionDurability | undefined> {
    // The DML path STAGES into the collection trackers (no inline sync), and
    // the coordinator's commit() iterates its collection map and reads each
    // `tracker.transforms` directly. Because that map is the SAME live
    // registry the vtab stages into (see registerCollection /
    // getCollectionRegistry), the staged transforms are exactly what
    // consensus pends/commits — so we deliberately do NOT tree.sync() here;
    // flushing would reset the trackers out from under consensus.
    // NOTE: session.commit() with no options inherits the coordinator's default
    // bounded backoff+jitter retry of a clean stale loss (~10 attempts, up to a
    // few seconds under sustained contention) before surfacing an error. That is
    // the intended safe default; if the SQL layer ever needs faster failure here,
    // thread a SyncOptions ({ maxAttempts, deadlineMs, signal }) through commit().
    //
    // Trace what the coordinator is about to carry BEFORE handing off: in session
    // mode the commit set is the whole live registry (the coordinator iterates its
    // collection map), not just the trees the vtab happened to mark dirty.
    if (log.enabled) {
      this.logCommitCollections('session', [...this.collectionRegistry].map(([id, collection]) => ({
        id: String(id),
        staged: collection.hasUnsyncedChanges(),
        // A real Collection always implements these, so `unknown` is unreachable here;
        // `none` still is: for the revision it means the collection was invented in
        // this process, and for the action id it additionally covers a revision slot
        // the log gave to a checkpoint or invalidation entry.
        rev: collection.committedRevision() ?? 'none' as const,
        action: collection.committedActionId() ?? 'none' as const,
      })));
    }
    const result = await session.commit();
    if (!result.success) {
      throw new Error(result.error || 'Transaction commit failed');
    }
    return result.durability;
  }

  /**
   * Deliver one commit's durability to every {@link onCommitDurability} listener, following it
   * first so the report can say whether {@link onCommitFullyHeld} will fire for it, and answer the
   * report it built. With no listener of either kind, and nobody demanding the report, the commit is
   * neither followed nor reported (`undefined`). Each listener runs isolated: a throw is logged and
   * the next still runs.
   *
   * Whatever the listeners, the collections the commit wrote at full replication then cover any
   * earlier followed commit waiting on those blocks.
   *
   * Called for an online commit that wrote something by {@link commitTransaction}, and for a drained
   * offline-queue entry by the offline-mode controller, which `demands` the report (its `committed`
   * status IS the report, and it retains it), so a drained commit reaches `onCommitDurability`
   * listeners, the follower and `onCommitFullyHeld` exactly as an online one does
   * (docs/offline-sync.md §Durability reports and the full-replication event).
   */
  reportCommitDurability(transactionId: string, durability: TransactionDurability, demanded: true): SqlCommitDurability;
  reportCommitDurability(transactionId: string, durability: TransactionDurability, demanded?: boolean): SqlCommitDurability | undefined;
  reportCommitDurability(transactionId: string, durability: TransactionDurability, demanded = false): SqlCommitDurability | undefined {
    let report: SqlCommitDurability | undefined;
    if (demanded || this.durabilityListeners.size > 0 || this.fullyHeldListeners.size > 0) {
      const verdict = this.durabilityFollower.follow(
        transactionId, durability, { selfPeerId: this.peerId, notifier: this.durabilityNotifier });
      report = sqlCommitDurability(transactionId, durability, id => this.collectionTables.get(id), verdict !== 'unfollowed');
      notifyListeners(this.durabilityListeners, report,
        error => log('commit:durability-listener-threw transaction=%s: %o', transactionId, error));
      // Every block's event came before the commit's answer did: fully held already, but reported
      // so only after the commit itself has been.
      if (verdict === 'covered') {
        this.reportFullyHeld(transactionId);
      }
    }
    this.durabilityFollower.coverHeld(durability, this.durabilityNotifier);
    return report;
  }

  /** Tell every {@link onCommitFullyHeld} listener that a followed commit is fully held. */
  private reportFullyHeld(transactionId: string): void {
    notifyListeners(this.fullyHeldListeners, Object.freeze({ transactionId }),
      error => log('commit:fully-held-listener-threw transaction=%s: %o', transactionId, error));
  }

  /**
   * Emit the one line that answers "which collections did this write carry?" (`mode=offline` for a
   * commit sealed into the offline queue, which carries them to the network later) — a
   * table with a secondary index is backed by several collections (the table tree
   * plus one tree per maintained index, opened by `OptimysticTable.openIndexTree`,
   * which prints the companion `index:tree-open` line), and a write has to carry all
   * of them. How an operator reads the pair: `docs/debugging.md`
   * (§ "Which collections did a write carry?").
   *
   * Ids are real collection ids, not tree labels or array indexes, so the two lines
   * join. Sorted so two nodes' lines compare by eye (on a copy — the sweep's own
   * order is untouched). `count` precedes the list so a truncated line still reports
   * how many there were. `unknown` appears only for a {@link DirtyTree} double that
   * omits `hasUnsyncedChanges`.
   *
   * The revisions follow the id list as ONE trailing `revs=<id>:<rev>,...` field, in the
   * same sorted order. Each is the revision that collection is READING at as this line is
   * emitted, which is BEFORE the flush — so the commit being announced lands at that value
   * plus one (`none` lands at 1). Printing the pre-commit revision is deliberate: it is the
   * only revision that exists yet, and it is what the staged actions were computed against.
   * But it means a reader whose `index:seek` `rev=` equals the number here is one revision
   * STALE, not converged; `docs/debugging.md` (§ "Which collections did a write carry?")
   * spells the +1 out because reading it as the landing revision inverts the whole
   * two-worlds decision rule these lines exist to serve.
   *
   * Strictly ADDITIVE on purpose: the `<id>=staged|clean|unknown`
   * tokens stay byte-identical to what this line has always emitted, so an operator's
   * existing grep or parser keyed on a collection id keeps matching. Folding the
   * revision into the id token instead (`<id>@7=staged`) would have been shorter and
   * would silently break every such parser into reporting the collection ABSENT — the
   * exact false negative this line exists to rule out.
   *
   * Each revision is rendered `<rev>@<actionId>` ({@link revisionToken}). `:none` is an
   * invented collection (no committed revision at all); `:unknown` is a double that omits
   * `committedRevision`; the same two words carry the same two meanings in the action
   * half. The revision is the discriminator the id cannot be — a collection's header block
   * IS its id, so two nodes naming one id are addressing one header, and what can still
   * differ is which revision of it each reads — and the ACTION ID is the discriminator the
   * revision cannot be, because two nodes that each built their own copy of a collection
   * each count their own revisions and so report numbers that look like ordinary lag.
   *
   * SPLITTING A PAIR, in this order — `,` first, then the LAST `@`, then the LAST `:`.
   * The id half may contain `:` (it is a URI path) and, in principle, `@`; the revision
   * half contains neither; the action id half routinely contains `:` — db-core stamps
   * session-mode action ids as `tx:<hash>`, which is the mode a multi-node deployment
   * actually runs — but can contain neither `@` nor `,`, because {@link revisionToken}
   * escapes those. So: take everything after the LAST `@` as the action id, then split
   * what is left on its LAST `:` into id and revision. Splitting on the FIRST `@`, or on
   * the last `:` of the whole pair, tears a `tx:`-shaped action id in half.
   *
   * A trailing `node=` names the node that emitted the line
   * ({@link CollectionFactory.nodeTag}) — appended last for the same additive reason the
   * revisions were: every token that predates it stays where it was.
   *
   * NOTE: pairs are `,`-separated and the whole field is one whitespace-free token, but
   * nothing ENFORCES that a collection id contains neither — `parseCollectionId`
   * (collection-factory.ts) accepts a table's `collectionUri` verbatim after stripping
   * `tree://`. A URI like `tree://a,b` would make this field, and the `<id>=staged`
   * tokens that predate it, ambiguous to parse. Harmless while every id in practice is a
   * slash path; if arbitrary URIs ever become reachable, validate the id at parse time
   * rather than escaping it here — the id has to be greppable across all three lines.
   *
   * Costs nothing when the namespace is off: both call sites build their entry array
   * inside an `if (log.enabled)` guard.
   */
  private logCommitCollections(mode: 'legacy' | 'session' | 'offline', entries: readonly CommitCollectionTrace[]): void {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const marks = sorted
      .map(e => `${e.id}=${e.staged === undefined ? 'unknown' : e.staged ? 'staged' : 'clean'}`)
      .join(' ');
    log(
      // `count=0` yields an empty mark list; the conditional space keeps that case from
      // emitting a double space, and leaves the count>0 spacing exactly as it always was.
      'commit:collections mode=%s count=%d%s revs=%s node=%s',
      mode,
      sorted.length,
      marks ? ` ${marks}` : '',
      sorted.map(e => `${e.id}:${revisionToken(e.rev, e.action)}`).join(','),
      this.collectionFactory.nodeTag()
    );
  }

  /**
   * Legacy (no-coordinator) commit: push every tree that staged DML this transaction.
   *
   * Which mechanism pushes them depends on how many trees actually have something to push:
   * - **One tree** (a single table with no index — the common write): that tree's own
   *   `sync()`, which is all-or-nothing by itself. Byte-identical to what this path has
   *   always done; the clean trees are swept exactly as before.
   * - **Several trees** (a table and its indexes, or two tables in one SQL transaction):
   *   one pend-all-then-commit-all batch through a per-commit coordinator over exactly
   *   those trees' collections ({@link commitBatchLegacy}). Two writers racing on a
   *   unique value collide at pend, where nothing is durable yet, so the loser is
   *   refused with nothing stored — the tear the per-tree sweep could not avoid.
   * - **The per-tree sweep** ({@link sweepDirtyTreesLegacy}) only when the trees cannot
   *   share one batch — see {@link legacyBatch} for the two cases.
   *
   * Resolves to who holds what the commit wrote, or `undefined` when no tree wrote anything.
   */
  private async commitDirtyTreesLegacy(): Promise<TransactionDurability | undefined> {
    const trees = [...this.dirtyTrees.keys()];

    // Trace what this commit is about to carry. Legacy mode's commit set is the
    // dirty set (a tree only lands here once markDirty saw DML stage into it), so
    // an index collection missing from THIS line means the index was never staged
    // into — which is exactly the question the trace exists to answer.
    if (log.enabled) {
      this.logCommitCollections('legacy', trees.map((tree, i) => ({
        id: treeLabel(tree, i),
        staged: tree.hasUnsyncedChanges?.(),
        // `unknown` (method absent on a double) and `none` (present, collection invented)
        // are deliberately different answers — collapsing them would hide the invention case.
        rev: treeRevision(tree),
        action: treeActionId(tree),
      })));
    }

    const batch = this.legacyBatch(trees);
    return batch === undefined
      ? await this.sweepDirtyTreesLegacy(trees)
      : await this.commitBatchLegacy(batch);
  }

  /**
   * The collections a legacy commit pends as one batch, on the transactor they all share —
   * or `undefined` when this commit takes the per-tree sweep instead. That is the case when:
   * - fewer than two trees have anything to push (a single tree's `sync()` is already
   *   all-or-nothing, and keeping it is what keeps the common write byte-identical);
   * - a tree is a test double with no collection to hand a coordinator;
   * - the collections sit on different transactor instances; or
   * - two trees are separate instances over one collection id (two tables declared over
   *   the same URI in one Database), which one id-keyed batch cannot hold.
   *
   * A tree without `hasUnsyncedChanges` counts as staged: the sweep's `sync()` is a
   * safe no-op for a clean tree, whereas wrongly leaving a staged one out would drop DML.
   *
   * NOTE: tables declared on different transactors in one SQL transaction cannot share a
   * pend batch — each transactor is its own storage, with no consensus spanning them — so
   * that commit keeps the per-tree sweep and its tear window. No host declares such a mix
   * today; if one ever does, it needs one batch per transactor, committed in turn.
   */
  private legacyBatch(trees: readonly DirtyTree[]): LegacyBatch | undefined {
    const staged = trees.filter(tree => tree.hasUnsyncedChanges?.() !== false);
    if (staged.length < 2) {
      return undefined;
    }
    const collections: Collection<any>[] = [];
    for (const tree of staged) {
      const collection = tree.getCollection?.();
      if (collection === undefined) {
        return undefined;
      }
      collections.push(collection);
    }
    const transactor = collections[0]!.transactor;
    if (collections.some(collection => collection.transactor !== transactor)) {
      return undefined;
    }
    // Two instances over ONE collection id would collapse in the coordinator's id-keyed
    // map, and the dropped instance's staged rows would be skipped by a commit that
    // reports success (test/legacy-batch-shared-collection-id.spec.ts). The sweep pushes
    // both: the second instance's sync refreshes onto the first's commit and replays.
    if (new Set(collections.map(collection => collection.id)).size !== collections.length) {
      return undefined;
    }
    return { collections, transactor };
  }

  /**
   * Pend every collection of `batch`, then commit every one, through a coordinator built
   * for this commit alone over exactly those collections — not the whole registry, whose
   * clean members would only cost the coordinator refreshes between attempts.
   *
   * `pendValidation: 'none'` is what makes the coordinator usable here: legacy staging has
   * no statements for a member to re-execute, so the pends carry bare transforms — the same
   * shape every legacy write has always sent — with the aged retry priority on the pend
   * itself. Members accept that shape under the default `unvalidatablePendPolicy`.
   *
   * Failures reach {@link commitTransaction}'s catch, which already handles both shapes:
   * - **Nothing durable** (a pend refused, the retry budget spent on clean losses, or a guard
   *   refusal thrown by the coordinator's refresh between attempts — the losing writer's
   *   replay of a key, unique value or row a rival won): the coordinator restored every
   *   tracker to its pre-append state and threw; the bridge rolls the trees back to their
   *   pre-transaction snapshots and maps a guard refusal to the ordinary constraint message.
   * - **A commit-phase split** (`CoordinatorPartialCommitError`: some collections committed
   *   durably after every pend succeeded, and one was still refused when the coordinator's
   *   retry budget ended — a returned refusal, such as this node's own replica being behind
   *   on that tree, is retried forward by the coordinator, re-driving the refused tree alone,
   *   so only a refusal that never clears or a hard failure after a sibling committed reaches
   *   here): the coordinator gave the committed collections the success-path fold and left
   *   the failed ones holding their staged DML; THIS method then restores the failed trees to
   *   their pre-transaction snapshots — memory mirrors storage for both halves, exactly as
   *   the fallback sweep leaves a torn commit — and the catch latches the degraded state.
   *   Nothing rolls the committed half back.
   *
   * On success, resolves to the coordinator's answer: who holds each collection it wrote.
   */
  private async commitBatchLegacy({ collections, transactor }: LegacyBatch): Promise<TransactionDurability | undefined> {
    // NOTE: the batch pends each tree at the revision this handle currently holds for it — the
    // coordinator does not refresh before its first attempt, where the sweep's `updateAndSync`
    // did. A tree a rival advanced since this handle last refreshed it therefore costs one
    // refused attempt plus the first backoff (about 50–100 ms) before the retry pends fresh; a
    // tree this node's own replica is behind on is accepted at pend and costs a refused commit
    // plus a retry round instead, which the coordinator finishes forward. Fine at current
    // scale; if contended legacy commits ever show that latency, refresh the batch's
    // collections here before committing.
    const coordinator = new TransactionCoordinator(
      transactor,
      new Map(collections.map(collection => [collection.id, collection])),
      { pendValidation: 'none' },
    );
    try {
      return await coordinator.commit(await this.legacyTransaction());
    } catch (error) {
      if (error instanceof CoordinatorPartialCommitError) {
        await this.restoreUncommittedTrees(new Set(error.committedCollections));
      }
      throw error;
    }
  }

  /**
   * The transaction identity a legacy multi-tree commit hands its coordinator. Legacy
   * staging has no statements (the rows went straight into the trees) and records no
   * reads (the single-tree sync never did either), so the coordinator uses it for three
   * things only: the action id every participant's log entry carries (`id`), the expiry it
   * checks before each attempt (`stamp.expiration`), and its one-open-stamp check
   * (`stamp.id`). No member ever sees it — the pend carries no validation payload.
   */
  private async legacyTransaction(): Promise<Transaction> {
    const stamp = await createTransactionStamp(this.peerId ?? 'local', Date.now(), '', LegacyCommitEngineId, LegacyCommitTtlMs);
    return { stamp, statements: [], reads: [], id: await createTransactionId(stamp.id, [], []) };
  }

  /**
   * After a pended batch half-landed: restore every dirty tree whose collection is NOT in
   * `committed` to the pre-transaction snapshot {@link markDirty} captured, so its memory
   * matches storage (nothing of this transaction reached that collection). The committed
   * trees are left alone — the coordinator already folded them, and their memory matches
   * storage too. Restoring a clean tree is a no-op, as in the fallback sweep.
   *
   * Never throws: the partial-commit error the caller is about to raise is the structured signal
   * the host reconciles from, and a restore's own failure must not replace it — a bare error in
   * its place would send `commitTransaction` down its clean-rollback path, which rewinds the
   * committed trees too. So every uncommitted tree is restored, and a failed restore is logged
   * (`commit:restore-failed`) and reflected in the degraded latch the caller is about to set.
   */
  private async restoreUncommittedTrees(committed: ReadonlySet<CollectionId>): Promise<void> {
    const uncommitted = [...this.dirtyTrees].filter(([tree]) => {
      const id = tree.getCollection?.()?.id;
      return id === undefined || !committed.has(id);
    });
    await this.restoreOrLog(uncommitted);
  }

  /**
   * Restore every tree in `entries`, letting no throw stop the rest, and log rather than raise a
   * failed restore — for the paths that already hold the error they will raise (a partial
   * commit, a failed commit's rollback), where the restore's own failure is a consequence to
   * record, not the answer. The paths whose answer IS the restore ({@link rollbackTransaction},
   * {@link rollbackToSavepoint}) let it propagate instead.
   */
  private async restoreOrLog(entries: Iterable<[DirtyTree, unknown]>): Promise<void> {
    try {
      await visitEveryThenThrow(entries, ([tree, snapshot]) => tree.restore(snapshot));
    } catch (error) {
      log('commit:restore-failed error=%s', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The per-tree FALLBACK: flush each dirty tree in turn with its own `sync()`. Reached
   * only when {@link legacyBatch} found no batch to pend, so in practice a commit whose
   * tables sit on different transactors, or one driven through test doubles.
   *
   * ⚠️ NOT DURABLY ATOMIC ACROSS TREES. Each `sync()` is its own pend+commit against the
   * transactor; there is no cross-tree undo here. On failure the correct recovery depends
   * on how far the sweep got:
   * - **No tree synced yet** (failure on the first tree): nothing is durably
   *   committed, so re-throw untouched and let {@link commitTransaction}'s catch
   *   run the ordinary snapshot-restore {@link rollbackTransaction} — a genuinely
   *   clean rollback.
   * - **At least one tree already synced**: trees 1..N are durably committed and
   *   cannot be un-committed locally. Restore ONLY the trees that never touched
   *   storage (they revert cleanly), leave the committed trees' in-memory state
   *   as-is (it matches storage), tear down the transaction, and throw a
   *   {@link PartialCommitError} naming both sets, with who holds the persisted half.
   *   We do NOT report success and do NOT falsely claim a rollback.
   *
   * On success, resolves to who holds what the sweep wrote — each tree's `sync()` answer,
   * keyed by its collection id (two trees over one id merge, weakest first) — or `undefined`
   * when no tree had anything to push.
   */
  private async sweepDirtyTreesLegacy(trees: readonly DirtyTree[]): Promise<TransactionDurability | undefined> {
    const synced: DirtyTree[] = [];
    const written = new Map<CollectionId, WriteDurability | undefined>();

    // PRE-FLIGHT: refresh every staged tree against storage BEFORE the first flush, so a
    // guarded entry a rival has ALREADY contradicted (a duplicate key or unique value, a
    // row it changed or removed) is refused here — while nothing is durable — rather than
    // mid-sweep, after an earlier tree committed. Each `sync()` below opens with this same
    // refresh, but at flush time it fires only when that tree's turn comes, and the main
    // table always flushes before its index trees. Narrows the sweep's tear window to a
    // rival landing between this refresh and the tree's own flush; only a pended batch
    // closes it, which is why the batch is the normal path and this the fallback.
    if (trees.length > 1) {
      for (const tree of trees) {
        if (tree.update !== undefined && tree.hasUnsyncedChanges?.() !== false) {
          try {
            await tree.update();
          } catch (rawError) {
            // Nothing persisted: map a refusal and let commitTransaction's catch run
            // the ordinary clean rollback (same exit as a first-tree flush failure).
            throw this.mapCommitRefusal(rawError);
          }
        }
      }
    }

    for (const [index, tree] of trees.entries()) {
      try {
        const durability = await tree.sync();
        synced.push(tree);
        if (durability !== undefined) {
          recordCollectionDurability(written, tree.getCollection?.()?.id ?? treeLabel(tree, index), durability);
        }
      } catch (rawError) {
        // Map a concurrency-refused duplicate key (TreeKeyTakenError out of this
        // tree's conflict replay) to its table's UNIQUE-constraint message HERE, so
        // both exits below carry it: the first-tree rethrow reaches the client with
        // the ordinary duplicate-key message, and a mid-sweep refusal's
        // PartialCommitError names it as the underlying failure (the refusal stays
        // reachable as the cause either way).
        const error = this.mapCommitRefusal(rawError);
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
        await this.restoreOrLog(unsynced.map(t => [t, this.dirtyTrees.get(t)]));

        const label = (t: DirtyTree) => treeLabel(t, trees.indexOf(t));
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

        throw new PartialCommitError(persisted, unpersisted, error, writtenDurability(written));
      }
    }
    return writtenDurability(written);
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

    // Quereus ends its transaction whether or not this hook throws (its transaction manager
    // resets in a `finally` and logs a connection's throw), so the bridge's transaction ends
    // here too, whatever the restores below do: a transaction left active would make the next
    // BEGIN a no-op over this one's state. A restore that threw leaves its collection
    // un-reconciled (half re-staged, see Collection.updateInternal's note on a throw out of
    // replayActions), so the degraded latch is set from it rather than released, and the throw
    // propagates once every tree has been restored.
    const transaction = this.currentTransaction;
    let restoreFailure: unknown;
    try {
      await this.restoreForRollback();
    } catch (error) {
      restoreFailure = error;
      this.degradedReason = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.dirtyTrees.clear();
      this.savepoints.clear();
      transaction.collections.clear();
      transaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;
      // A clean rollback restores a reconciled local view (memory matches what each
      // tree's storage holds) — release the degraded latch (see degradedReason).
      if (restoreFailure === undefined) this.degradedReason = null;
    }

    // Note: We intentionally do NOT clear the collection factory cache here.
    // The transactor cache contains pre-registered transactors that should persist
    // across transactions. Clearing them would cause the factory to create new
    // disconnected transactors instead of using the registered ones.
  }

  /** The restoring half of {@link rollbackTransaction}: the session's own rollback in session
   * mode (the coordinator restores every participant, then throws the first failure), each dirty
   * tree's restore otherwise — every tree, even after one throws, since each restore is
   * independent and a tree left un-restored would carry the rolled-back statements into the next
   * transaction. Throws the first restore failure after every collection has been visited; the
   * caller tears the transaction down and latches the degraded state either way. */
  private async restoreForRollback(): Promise<void> {
    if (this.session && !this.session.isRolledBack()) {
      await this.session.rollback();
    }

    // Roll back staged-but-unsynced DML. Quereus runs deferred row constraints
    // BEFORE connection.commit(), so a constraint-failure rollback reaches here
    // while every staged tree is still un-synced. Tracker rollback has a single
    // owner per mode:
    //   - Session mode: the coordinator owns it. session.rollback() (above)
    //     already restored every registered collection's tracker AND its pending
    //     action queue to the coordinator's pre-stamp capture. The dirty trees ARE
    //     those registered collections, so a second per-tree restore is redundant
    //     in the usual case, where the two baselines coincide: markDirty snapshots
    //     a tree before its first stage, and the coordinator captured that same
    //     pre-stage state at or before then (optimystic-module.ts stages only after
    //     an awaited applyActions). Where the two can diverge, markDirty's is never
    //     the earlier — so restoring it over the already-rewound collection could
    //     only re-install staged state the coordinator just discarded. Skip it.
    //   - Legacy mode (no coordinator): restore each dirty tree from its
    //     pre-stage snapshot — this reverts in-memory reads and leaves storage
    //     untouched, the actual fix for the deferred-constraint atomicity bug.
    //     Restoring the snapshot (rather than clearing the tracker) keeps a
    //     never-synced collection's header/root intact so it stays readable.
    if (!this.session) {
      await visitEveryThenThrow(this.dirtyTrees, ([tree, snapshot]) => tree.restore(snapshot));
    }
  }

  /**
   * Get the current transaction state.
   */
  getCurrentTransaction(): TransactionState | null {
    return this.currentTransaction;
  }

  /**
   * True while a partial commit has left the trees split (some durably committed,
   * some not) and no clean commit/rollback has since restored a reconciled view.
   * Committed (`_readCommitted`) reads must refuse to answer while this holds —
   * see {@link degradedReason}.
   */
  isDegraded(): boolean {
    return this.degradedReason !== null;
  }

  /**
   * The reason the bridge is degraded (the partial-commit error's message, naming
   * the persisted vs. unpersisted trees/collections), or undefined when healthy.
   */
  getDegradedReason(): string | undefined {
    return this.degradedReason ?? undefined;
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
   * The reverse of {@link markDirty} and {@link registerCollection}, for a tree the vtab has
   * stopped maintaining (`DROP INDEX`). It leaves the dirty set, so a legacy commit does not flush
   * what DML staged into it this transaction and a rollback does not restore it; and its collection
   * leaves the registry, with the tables recorded for it — only while the registered instance IS
   * this tree's, so a newer instance under the same id (a re-created index) is left alone. Without
   * the registry half a session-mode coordinator, which commits every registered collection with
   * unsynced changes, would carry a dropped index's staged entries into a tree nothing lists. Open
   * savepoints keep whatever they captured for it: restoring an abandoned tree changes nothing
   * anyone reads.
   */
  forgetTree(tree: DirtyTree): void {
    this.dirtyTrees.delete(tree);
    const collection = tree.getCollection?.();
    if (collection && this.collectionRegistry.get(collection.id) === collection) {
      this.collectionRegistry.delete(collection.id);
      this.collectionTables.delete(collection.id);
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
   * re-execute, diverging their operation set. The empty-actions apply also captures
   * the coordinator's rollback snapshots — on the first call for the stamp, and again
   * for any collection registered since the previous call — so awaiting here (before
   * the caller stages rows) makes that capture's timing deterministic: it records
   * pre-stage state, which session-mode rollback needs.
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
   *
   * Awaited per collection: a restore across a change to the collection's sealed segments
   * (an offline-sync entry drained or refused while the transaction was open) replays them
   * (`Collection.restorePending`). Quereus awaits each connection's hook in turn
   * (`_rollbackToSavepointBroadcast` in `@quereus/quereus/src/core/database.ts`) before the
   * statement continues, so no two restores of one collection overlap and nothing is staged
   * into it while one runs — the latch-free contract `restorePending` relies on. While no
   * segment is sealed the restore is the verbatim arm, as it was when this was synchronous.
   */
  async rollbackToSavepoint(depth: number): Promise<void> {
    const snapshots = this.savepoints.get(depth);
    if (!snapshots) {
      return;
    }
    // Every collection is restored even after one throws, and the deeper savepoints are
    // discarded either way: Quereus has already unwound its own savepoint stack to `depth`
    // before broadcasting, and a collection left un-restored would keep the statements the
    // savepoint was meant to discard — committed with the transaction, were the engine to
    // swallow this throw (its statement-level savepoint path does). The first failure
    // propagates once every collection has been visited.
    try {
      await visitEveryThenThrow(snapshots, ([collection, snapshot]) =>
        collection.restorePending(snapshot as Parameters<Collection<any>['restorePending']>[0]));
    } finally {
      for (const openDepth of this.savepoints.keys()) {
        if (openDepth > depth) {
          this.savepoints.delete(openDepth);
        }
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
