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
import { ConflictResolution, QuereusError, StatusCode, buildCheckConstraintSchema, buildColumnIndexMap, collectTableConstraintNames } from '@quereus/quereus';
import type { VirtualTableModule, BaseModuleConfig, Database, DatabaseInternal, TableSchema, Row, FilterInfo, BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, VirtualTableConnection, TableIndexSchema as IndexSchema, UniqueConstraintSchema, UpdateArgs, UpdateResult, SqlValue, SchemaChangeInfo } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import type { CollectionChangeEvent, ITransactor, TreeEntryGuard, TreeReadView } from '@optimystic/db-core';
import { SchemaManager, columnSetKey, mergeIndexLists, uniqueConstraintKey, uniqueEnforcementTreeName } from './schema/schema-manager.js';
import type { PersistedIndexSchema, StoredTableSchema, StoredIndexSchema, StoredColumnSchema } from './schema/schema-manager.js';
import { RowCodec, type EncodedRow } from './schema/row-codec.js';
import { defaultCollectionUri, type QualifiedTableName } from './schema/table-identity.js';
import { PhysicalType } from '@quereus/quereus';
import { IndexManager, hasNullIndexValue, indexEntryKey, indexKeyFromValues, rowImpliesEntry, type IndexEntry, type IndexKey } from './schema/index-manager.js';
import { compareIndexToRows, type IndexIntegrityReport } from './schema/index-integrity.js';
import type { PrimaryKeyTuple } from './schema/key-tuples.js';
import { createLogger, revisionToken } from './logger.js';

const log = createLogger('module');

/** Shared empty guard set — returned by {@link OptimysticVirtualTable.guardedUniqueIndexes}
 *  for the common no-secondary-UNIQUE table so the staging paths allocate nothing. */
const EMPTY_INDEX_SET: ReadonlySet<string> = new Set<string>();

/**
 * Every catch arm below that surfaces a caught error to the SQL layer funnels through
 * here, so the original error (a `BlockUnavailableError` with its `reason`, a
 * `BlockPossiblyStaleError` with its `claimedRev`, or any other typed failure db-core
 * raises) stays reachable via `Error.cause` instead of being flattened into the message
 * string. A caller reading through SQL can then walk `err.cause` to recover the typed
 * fields a plain `.message` cannot carry. The message text is identical to the
 * hand-rolled wraps this replaced, so `cause` is purely additive and message-matching
 * consumers are unaffected.
 */
function rewrapAsQueryError(prefix: string, error: unknown): Error {
  const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
  return new Error(message, { cause: error });
}

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

/**
 * Mutable scratch threaded into {@link OptimysticVirtualTable.executeIndexScan} so the
 * `index:seek` trace can report what the seek actually did, without the trace having to
 * rebuild the seek key or re-walk the entries:
 *
 * - `matched` — how many INDEX ENTRIES the seek produced, not how many rows the caller
 *   ended up keeping. The distinction is the point of the field: zero entries means the
 *   descent found nothing in the index tree, which is a different failure from "entries
 *   found, rows resolved, verification rejected them later".
 * - `rejected` — how many of those entries the scan did NOT yield: the row their primary
 *   key names is gone, or it is there but does not imply the entry (see the verification in
 *   {@link OptimysticVirtualTable.executeIndexScan}). It is otherwise invisible from the read
 *   path, which now answers correctly over a broken tree instead of visibly wrongly.
 *   `matched - rejected` is what the scan yielded. A rejection means the index tree and the
 *   main table DISAGREED AS THIS SCAN READ THEM, which has two causes and the same line carries
 *   the fields that separate them: index damage (`rev`/`main_rev` consistent — confirm with
 *   `plugin.verifyIndexes`), or the two views sitting at different moments, which rejects a
 *   perfectly healthy entry whose row the main view has not caught up to yet (see `main_rev=`
 *   in docs/debugging.md, and prefer `arm=committed`, where both views come from one moment).
 * - `key` — the framed index key the scan bracketed on, filled in once it is built.
 *   Stays `undefined` if the scan returned before framing one — in practice the NULL-arg
 *   refusal, which is a correct empty answer, not a fault — and prints as `unset` rather
 *   than as an empty seek (the empty PREFIX is a legitimate key meaning "the whole index",
 *   and the two must not read alike).
 *
 * Passed only when the trace namespace is enabled; `undefined` otherwise, so a disabled
 * namespace costs one property read per scan.
 */
interface IndexSeekProbe {
  matched: number;
  rejected: number;
  key?: string;
}

/** Code units a framed index key may print verbatim: everything else is escaped, so
 *  the rendered key is always one whitespace-free, `=`-free token. */
const SEEK_KEY_SAFE = /[^A-Za-z0-9._-]/g;

/**
 * Render a framed index key for the `index:seek` trace.
 *
 * An index key is the output of `encodeKeyTuple`, so it carries control bytes as element
 * framing and can carry any character the indexed value did — including spaces and `=`.
 * Printing it raw would break the `key=value`, whitespace-separated shape every other
 * line in this package uses, so each unsafe code unit becomes `%XX` (or `%uXXXX` above
 * `\xff`); alphanumerics and `-._` survive verbatim, so `tok-a` stays readable and the
 * framing tags render as `%01`/`%00`. `u` is not a hex digit, so the two escape widths
 * cannot be confused and the mapping is injective — two nodes' escaped keys compare
 * exactly, which is the only thing the field is for.
 *
 * Escaping per code unit rather than via `encodeURIComponent` is deliberate: that
 * function throws `URIError` on a lone surrogate, which a SQL TEXT value can legally
 * contain (`serializeIndexValue` passes strings through verbatim). This runs inside the
 * scan's `finally`, so a throw here would fail — or mask the real error of — the very
 * query the operator turned tracing on to diagnose. Total by construction is the only
 * acceptable shape for it.
 */
const printableSeekKey = (key: string): string =>
  key.replace(SEEK_KEY_SAFE, ch => {
    const code = ch.charCodeAt(0);
    return code <= 0xff
      ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
      : `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  });

/**
 * Every row a main-table collection's CURRENT view holds, decoded, with its framed primary
 * key, in ascending key order. Never refreshes: a caller that needs the latest committed rows
 * `update()`s the collection first. The index backfill, the unique-tree populate and the
 * integrity check all do, and share this walk so a row reads the same to each of them.
 */
async function* walkDecodedRows(
  collection: Tree<string, unknown>,
  rowCodec: RowCodec,
): AsyncIterable<{ row: Row; primaryKey: string }> {
  for await (const path of collection.ascending(await collection.first())) {
    if (!collection.isValid(path)) continue;
    const entry = collection.at(path) as StoredRowEntry | undefined;
    if (!entry || entry.length < 2) continue;
    const row = rowCodec.decodeRow(entry[1]);
    yield { row, primaryKey: rowCodec.extractPrimaryKey(row) };
  }
}

/** A main-table entry as the collection stores it: `[framedPrimaryKey, encodedRow]`. */
type StoredRowEntry = [string, EncodedRow];

/**
 * The decoded row at `primaryKey` in a main-table read source, or `undefined` when the
 * source holds no usable entry there. Shared by the two seek paths — the primary-key point
 * lookup and the secondary-index scan — so "fetch the row this key names" has one meaning
 * and one set of skip conditions on both. Never refreshes the source; the caller resolved it.
 */
async function readRowAt(
  read: TreeReadView<string, RowData>,
  rowCodec: RowCodec,
  primaryKey: string,
): Promise<Row | undefined> {
  const path = await read.find(primaryKey);
  if (!read.isValid(path)) return undefined;
  const entry = read.at(path) as StoredRowEntry | undefined;
  if (!entry || entry.length < 2) return undefined;
  return rowCodec.decodeRow(entry[1]);
}

/**
 * The row image a write is about to replace or remove: decoded for index maintenance,
 * and the stored entry itself for the `unchanged` guard (see {@link unchanged}). The
 * guard must carry the entry AS READ, never a re-encoding of the decoded row — the
 * comparison at replay is against the stored bytes, and a re-encoding is only equal to
 * them by luck. Holding the entry by reference is safe: the btree freezes every entry at
 * upsert and replaces, never mutates, the slot at a key.
 */
interface PreWriteImage {
  row: Row;
  entry: StoredRowEntry;
}

/**
 * The lost-update guard for a main-table upsert or delete whose staged index delta was
 * computed from `entry`: the replace handler refuses the action — at initial staging
 * and at every conflict replay — unless the entry at the key is still exactly `entry`
 * (absent counts as changed). Every main-table write derived from a pre-write image
 * carries one, so a rival's concurrent change to the same row refuses this writer
 * instead of letting its main-table action replay over the rival's row while its index
 * delta, computed against the old image, lands beside it (a stale index entry no row
 * implies, or a deleted row resurrected). See docs/internals.md, "Conflict replay
 * re-makes the uniqueness decision (entry guards)".
 */
function unchanged(entry: StoredRowEntry): TreeEntryGuard<string, StoredRowEntry> {
  return { kind: 'unchanged', expected: entry };
}

/** One existing row a secondary UNIQUE constraint collides with, keyed by its
 *  primary key so a REPLACE resolution can evict it — carrying the stored entry so
 *  the eviction's delete can be guarded {@link unchanged}. */
interface UniqueCollision extends PreWriteImage {
  pk: string;
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
 * the row occupying the slot is displaced by it (`displace`, REPLACE — carrying the
 * displaced row's image, since the move's index delta is computed from it).
 */
type PkMoveDecision =
  | { kind: 'clear' }
  | { kind: 'swallow' }
  | { kind: 'blocked'; result: UpdateResult }
  | ({ kind: 'displace' } & PreWriteImage);

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
    `(CREATE INDEX) to re-attach it — DROP INDEX it first if this connection still lists it.`
  );
}

/**
 * Hands one populated index tree to the open `APPLY SCHEMA` batch instead of flushing it
 * on the spot; the batch lands it at `endSchemaBatch`, before the catalog commit that lists
 * its index. Supplied by `OptimysticModule.createIndex` only while a batch is open — its
 * absence is what keeps every other path (direct DDL) unchanged.
 */
type DeferIndexFlush = (indexName: string, tree: Tree<string, IndexEntry>) => void;

/** Quereus's CHECK shape and its ADD CONSTRAINT AST node, reached through exported types (neither is exported by name). */
type RowConstraintSchema = TableSchema['checkConstraints'][number];
type AddedConstraint = Extract<SchemaChangeInfo, { type: 'addConstraint' }>['constraint'];

/**
 * Quereus's schema-only RENAME COLUMN, reproduced unchanged — the fallback its ALTER TABLE
 * RENAME COLUMN arm runs for a module without an `alterTable` hook: the column renamed in the
 * catalog entry, nothing written. The engine has already checked that `oldName` exists and
 * `newName` is free.
 *
 * NOTE: the rename never reaches the catalog record, so a restart that only hydrates brings the
 * old name back (tickets/backlog/bug-optimystic-rename-column-lost-on-restart). Kept exactly as
 * the engine did it so that implementing `alterTable` changed no rename behaviour; that ticket
 * owns persisting the rename or refusing it.
 */
function renameColumnSchemaOnly(tableSchema: TableSchema, oldName: string, newName: string): TableSchema {
  const colIndex = tableSchema.columnIndexMap.get(oldName.toLowerCase());
  const columns = tableSchema.columns.map((col, i) => (i === colIndex ? { ...col, name: newName } : col));
  return {
    ...tableSchema,
    columns: Object.freeze(columns),
    columnIndexMap: buildColumnIndexMap(columns),
  };
}

/**
 * How a table reaches storage — the transactor and key network it goes through, the
 * network's name and port, and the raw-storage factory — resolved the one way every path
 * resolves it: a `using optimystic(...)` argument (or, for a hydrated table, the session's
 * `default_vtab_args`) wins over the plugin's registration config (`default_transactor`
 * and friends, surfaced as `vtabAuxData`), which wins over the production defaults. The
 * argument names read here, plus `cache` (which `parseTableSchema` reads itself), are
 * exactly {@link SESSION_BINDING_VTAB_ARGS} — keep the two lists in step.
 */
function resolveBinding(
  args: Readonly<Record<string, SqlValue>>,
  aux: Readonly<Record<string, unknown>>,
): Pick<ParsedOptimysticOptions, 'transactor' | 'keyNetwork' | 'libp2pOptions' | 'rawStorageFactory'> {
  const transactor = (args['transactor'] as string) || (aux['default_transactor'] as string) || 'network';
  const keyNetwork = (args['keyNetwork'] as string) || (aux['default_key_network'] as string) || 'libp2p';
  const port = typeof args['port'] === 'number' ? args['port'] : (typeof aux['default_port'] === 'number' ? aux['default_port'] as number : 0);
  const networkName = (args['networkName'] as string) || (aux['default_network_name'] as string) || 'optimystic';
  // Plugin-level only (not exposed via per-table USING args because it's a function reference).
  const rawStorageFactory = typeof aux['rawStorageFactory'] === 'function'
    ? (aux['rawStorageFactory'] as () => IRawStorage)
    : undefined;
  return {
    transactor,
    keyNetwork,
    libp2pOptions: {
      port,
      networkName,
      bootstrapNodes: [],
    },
    rawStorageFactory,
  };
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

/** Render a schema's column list for a storage-adoption refusal: `(id, a, b)`. */
function describeColumnList(columns: readonly StoredColumnSchema[]): string {
  return `(${columns.map(col => col.name).join(', ')})`;
}

/**
 * Render a schema's primary key — column names in key order, with direction — for
 * the storage-adoption guard's identity compare and its refusal messages: `(id, b desc)`.
 * Works on both the resolved and the persisted record shape (`columns` and
 * `primaryKeyDefinition` are positional in both).
 *
 * NOTE: names and direction only, not per-column COLLATION. Correct today because the
 * collation-aware key comparator is dead code — the tree is opened with a raw
 * lexicographic string comparator, so a PK column's collation does not decide where a
 * row sits. Once debt-optimystic-true-key-ordering wires that comparator up, a
 * re-declare that changes a PK column's collation relocates every stored row and must
 * be refused here too; fold `pk.collation` into this rendering then. Direction is
 * rendered and compared for the same reason and is, today, stricter than storage
 * requires — a direction-only change is refused although nothing has moved. Erring
 * strict is the safe side of that trade and becomes exactly right once the comparator
 * is live, so it stays.
 */
function describePrimaryKey(schema: Pick<StoredTableSchema, 'columns' | 'primaryKeyDefinition'>): string {
  const parts = schema.primaryKeyDefinition.map(pk => {
    const name = schema.columns[pk.index]?.name ?? `#${pk.index}`;
    return pk.desc ? `${name} desc` : name;
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
  /**
   * Whether the DDL that declared this table supplied columns (`CREATE TABLE`, or a
   * connect carrying columns) as opposed to a hydrate/connect that must load them from
   * storage. Captured at construction: doInitialize populates `tableSchema.columns` on
   * the load arm, so re-reading the length inside would make a re-run (a retry after a
   * failed attempt, or the provisional→full upgrade) take a different branch than the
   * first pass — specifically the DDL-wins arm, which can WRITE the schema where the
   * first pass intended a read-only load.
   */
  private readonly declaredColumns: boolean;
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
    this.declaredColumns = tableSchema.columns.length > 0;
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

    // Start initialization.
    //
    // The memo must never memoize its own REJECTION: a first touch that failed for a
    // passing reason (a network hiccup, a storage node answering late) would otherwise
    // replay that one stale error for every later statement, for the life of the
    // process, long after the cohort recovered. Clearing the field in a `finally` —
    // the shape initializeForCommittedRead already uses for its provisional pass —
    // leaves the next statement free to retry. Callers that arrive while the attempt
    // is still in flight hold the same object and keep sharing it; only the SETTLED
    // case changes.
    //
    // NOTE: accepted tradeoff — a table pointed at a genuinely dead cohort re-attempts
    // initialization on every statement rather than caching the failure for a cooldown
    // window; un-damped retry weighed over a window this layer has no basis to pick
    // (the same reasoning that made this module decline to declare `expectedLatencyMs`
    // — see that note on OptimysticModule — applies unchanged to a damping window, and
    // damping would reintroduce this very bug in miniature, delaying recovery by up to
    // the window). A statement against an unreachable cohort was going to make network
    // calls and fail regardless, and every attempt is user-driven — nothing re-enters
    // initialize() in the background. Revisit if initialization storms against a dead
    // cohort ever show up in profiles — damp in the transactor layer that already
    // models unreachable blocks, not here.
    const attempt = (async () => {
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
    })().finally(() => {
      // Cleared either way: on success `isInitialized` gates re-entry; on failure the
      // next statement is free to retry against a cohort that may have recovered. The
      // identity check is defensive — this `finally` runs before any awaiting caller
      // resumes, so no newer attempt can exist yet — but it costs nothing and survives
      // future reordering.
      if (this.initializationPromise === attempt) {
        this.initializationPromise = undefined;
      }
    });
    this.initializationPromise = attempt;
    return attempt;
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
      // A failed attempt must leave no message behind for a successful retry to wear.
      // Diagnostics only (nothing in the engine reads `errorMessage` — see the note on
      // OptimysticModule), but it should not outlive the open it describes.
      this.setErrorMessage(undefined);
      const txnState = readOnly ? null : this.txnBridge.getCurrentTransaction();
      // NOTE: create-on-missing is intentional here, and stays. A table registered in the
      // schema catalog but never written to has NO committed header block — the header is
      // only committed on the first write — so "absent header" and "empty table" are
      // genuinely indistinguishable at the block layer on this path. Inventing the tree in
      // the local tracker is the correct representation of an empty table; switching this to
      // `getCollection` would make `select` from a created-but-never-written table fail.
      //
      // Built as a LOCAL, and published with the codec and index manager below only
      // once every await has succeeded — see the note at that publish point.
      const collection = await this.collectionFactory.createOrGetCollection(
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
      //
      // The branch is a function of the DECLARATION ({@link declaredColumns}), not of
      // `this.tableSchema.columns.length` — the load arm below populates that list, so
      // reading it here would send a re-run (a retry after a failed attempt, or the
      // provisional→full upgrade) down the DDL-wins arm instead.
      const persistedSchema = await this.schemaManager.getSchema(this.schemaName, this.tableName, txnState?.transactor);
      let storedSchema: StoredTableSchema;

      if (this.declaredColumns) {
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
        // (mergeWithPersisted), so what we compare against is what a write would
        // actually produce. Two things fall out: an index-free re-declare can
        // never write `indexes: []` over a real list (which would force every
        // later `addIndex()` to fail its dedupe and rebuild from scratch), and
        // a candidate that carries SOME indexes while the catalog carries more
        // still short-circuits once, instead of missing the compare and
        // re-writing a byte-identical record on every single open.
        //
        // Persisted indexes are identified by column NAME on disk and resolved
        // against whichever column list they are merged into, so a re-declare
        // that REORDERS columns re-points each surviving index at the column it
        // was declared on (its tree contents were always keyed on that column's
        // values, so nothing has to be rebuilt). A re-declare that DROPS a column
        // a persisted index still covers cannot be expressed and throws here —
        // the persisted index has to be dropped first, or the table.
        //
        // A schema persisted before uniqueness metadata was wired through misses
        // this short-circuit exactly once for a table that HAS unique
        // constraints (the candidate now carries `uniqueConstraints`; the
        // persisted side lacks the key). That single re-write persists them and
        // the second open short-circuits again. Constraint-free tables OMIT the
        // key on both sides (see tableSchemaToStored) and never miss. Likewise a
        // record persisted before indexes and CHECKs were kept in canonical (name)
        // order misses once when its lists are out of that order: both the
        // candidate and the merge come out sorted, the persisted side does not.
        const candidateStored = this.schemaManager.tableSchemaToStored(this.tableSchema);
        let mergedCandidate: StoredTableSchema = persistedSchema
          ? this.schemaManager.mergeWithPersisted(candidateStored, persistedSchema)
          : candidateStored;

        if (!persistedSchema) {
          // No live catalog record under this name, so this declaration is about to
          // ADOPT whatever the collection at its URI already holds. Storage must not
          // outlive the catalog record that describes it: check the declaration
          // against the record (gravestone, or a URI-sharing table) that still
          // describes that storage and refuse loudly rather than silently serving
          // rows the declaration cannot account for. Runs only on this arm — the
          // warm, hydrated and live-record paths never pay the catalog walk inside.
          // Returns the record's index-tree descriptions so addIndex can hold the
          // same rule over `<uri>/index/<name>` later (see that guard).
          const orphanedIndexes = await this.guardStorageAdoption(
            candidateStored,
            collection,
            txnState?.transactor,
          );
          if (orphanedIndexes) {
            mergedCandidate = { ...mergedCandidate, orphanedIndexes };
          }
        }

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
          ...this.schemaManager.storedToColumnSchema(col),
          affinity: col.affinity as any,
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

      const rowCodec = new RowCodec(storedSchema, this.options.encoding);

      // Create and initialize index manager
      const indexManager = new IndexManager(
        storedSchema,
        (indexName, transactor) => this.openIndexTree(indexName, transactor)
      );

      await indexManager.initialize(txnState?.transactor);

      // Give every point-enforceable secondary UNIQUE constraint a backing index tree
      // so probeUniqueConstraint can probe it instead of full-scanning the table per
      // DML row (an O(N) scan per row -> O(log n) point probe). Must run BEFORE
      // registerCollections so the synthesized trees are present in getIndexTrees()
      // when the bridge snapshots this table's collections.
      const uniqueEnforcementIndexes = this.buildUniqueEnforcementIndexes(storedSchema);
      await indexManager.setUniqueEnforcementIndexes(
        uniqueEnforcementIndexes,
        txnState?.transactor,
      );

      // Publish the rebuilt state in ONE synchronous step, after the last await.
      // doInitialize runs more than once for a table — the upgrade after a
      // provisional pass, and a retry after a failed attempt (see initialize()) — so
      // a rerun that throws part-way must leave the fields it would have replaced
      // exactly as the previous pass left them. Assigning as they were built instead
      // left, for example, an IndexManager that had been constructed but whose trees
      // never opened: `indexMaintenanceState` then reads 'unmaintained', and
      // OptimysticModule.assertIndexMaintained refuses every index-driven plan
      // against the table — at PLAN time, which no amount of re-initialization
      // downstream can rescue — until some non-index query happens to run a
      // successful full pass.
      this.collection = collection;
      this.rowCodec = rowCodec;
      this.indexManager = indexManager;
      this.uniqueEnforcementIndexes = uniqueEnforcementIndexes;

      if (readOnly) {
        // Provisional pass: leave the bridge's collection registry untouched (a
        // live session-mode coordinator commits from that map) and defer the
        // change subscription. The next full initialization completes both.
        this.isProvisionallyInitialized = true;
        return;
      }

      // Register the main + index collections with the bridge so a session-mode
      // coordinator shares the very trackers this vtab stages into (see
      // registerCollections). Must happen before any DML so the coordinator
      // captures their pre-stage state at the next applyActions barrier.
      this.registerCollections();

      // NOTE: this is one of two paths on which doInitialize runs TWICE for a table —
      // the upgrade after a provisional pass, and a retry after a failed attempt (see
      // initialize()) — so it replaces `rowCodec`/`indexManager` while a committed scan
      // started off the provisional state may still be iterating (scans re-read both
      // fields per row). A rerun that FAILS can no longer be seen half-applied (the
      // publish above is one synchronous step), but a rerun that SUCCEEDS still swaps
      // the fields under such a scan. Harmless while both passes resolve the same
      // schema, which they do unless DDL changed the table in between; if concurrent
      // DDL ever becomes real here, a scan must capture its codec and index manager as
      // locals alongside its pinned views.
      this.isProvisionallyInitialized = false;
      this.isInitialized = true;

      // Bridge optimystic collection-change notifications to Quereus watch
      // invalidation so reactive consumers wake on commits without polling.
      // Self-isolating: a wiring failure here never blocks initialization.
      await this.ensureChangeSubscription();
    } catch (error) {
      const wrapped = rewrapAsQueryError('Failed to initialize Optimystic table', error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
    }
  }

  /**
   * The declaration-time half of the rule "storage must not outlive the catalog
   * record that describes it": a `CREATE TABLE` (or a connect carrying columns) with
   * no live catalog record under its name is adopting whatever already sits at its
   * collection URI, and must be refused when the record that still describes that
   * storage contradicts it. Covers every shape of the problem with one rule — drop
   * then re-create under a different column list, two live tables declared over one
   * URI with no DROP anywhere, a URI reused across unrelated tables.
   *
   * Returns the record's index-tree descriptions (record.indexes ∪ its own
   * orphanedIndexes) for the caller to stash on the new live record as
   * `orphanedIndexes` — readable by addIndex's guard, never merged into `indexes`
   * (a DROP still sheds the catalog's index list; that shedding is what makes the
   * narrower-re-declare escape hatch work). Undefined when nothing describes the
   * storage or the record lists no indexes.
   *
   * HONEST LIMITS, not to be overclaimed: both lookups read the catalog, so a cohort
   * that silently answers "nothing" for the catalog while the data collection reads
   * fine leaves this guard blind — the same residual SchemaManager.getSchema
   * documents at length. And the guard compares against the RECORD, not the rows: a
   * record that has diverged from the rows it describes makes the answer wrong in
   * whichever direction the record is wrong. (Sampling rows instead cannot work: a
   * legitimately-supported re-declare that adds a column produces rows of mixed
   * shape, so "this row lacks a declared column" cannot distinguish supported from
   * corrupting.) The guard closes the local, reproducible corruption and invents no
   * certainty beyond that.
   */
  private async guardStorageAdoption(
    candidate: StoredTableSchema,
    collection: Tree<string, any>,
    transactor?: ITransactor
  ): Promise<PersistedIndexSchema[] | undefined> {
    // The record that still describes the storage this declaration adopts: the
    // gravestone under this table's own schema and name (DROP TABLE writes one — see
    // SchemaManager.deleteSchema), else any catalog record — live or gravestone —
    // declared over the same collection URI.
    const record = await this.schemaManager.getDroppedSchemaRecord(this.schemaName, this.tableName, transactor)
      ?? await this.schemaManager.findRecordForUri(this.options.collectionUri, transactor);
    // "No record" also covers the bare tombstones written by builds before
    // gravestones existed: a database dropped before this landed sails through
    // exactly as it used to. That degradation is intended — not a hole.
    if (!record) {
      return undefined;
    }

    // What the record says may still sit at `<uri>/index/<name>`. Collected BEFORE
    // the emptiness early-return below: each index tree is probed for emptiness
    // individually at CREATE INDEX time (an empty leftover tree adopts harmlessly),
    // so the descriptions must survive even when the main collection is empty today.
    const described = mergeIndexLists(record.indexes, record.orphanedIndexes ?? []);
    const orphanedIndexes = described.length > 0 ? described : undefined;

    // An EMPTY data collection cannot mangle anything — a table created, never
    // written, then dropped re-declares freely under any shape. Probed through the
    // collection the caller passes in, not `this.collection`: this guard runs mid-
    // initialization, before the pass publishes the fields it rebuilt.
    if (await this.hasNoRowsToBackfill(collection)) {
      return orphanedIndexes;
    }

    const held = record.droppedAt ? 'a dropped table' : `live table '${record.name}'`;

    // Clause (a): a declared column the record does not have. The surviving rows
    // carry no value for it, so decoding would invent NULL — including where this
    // declaration says NOT NULL.
    const recordColumns = new Map(record.columns.map(col => [col.name.toLowerCase(), col]));
    const invented = candidate.columns.filter(col => !recordColumns.has(col.name.toLowerCase()));
    if (invented.length > 0) {
      const columnWord = invented.length === 1 ? 'column' : 'columns';
      const names = invented.map(col => `'${col.name}'`).join(', ');
      throw new Error(
        `Cannot create table '${candidate.name}' over '${this.options.collectionUri}': that collection ` +
        `still holds rows from ${held} declared as ${describeColumnList(record.columns)}, and this ` +
        `declaration adds ${columnWord} ${names}, which those rows cannot supply. Use a different ` +
        `collection URI, or re-declare the columns the stored rows were written under.`
      );
    }

    // Clause (a2): a column the record HAS, re-declared under a different affinity.
    // A row is stored as a name-keyed JSON object with no type tag, so affinity is
    // the only thing that says what a stored value MEANS on the way out: RowCodec
    // base64-decodes a stored string into bytes for a BLOB-affinity column and
    // returns it verbatim for any other, so `a text` re-declared as `a blob` (or the
    // reverse) hands back a value that is neither what was written nor an error.
    // Same failure the clauses around it exist to stop — silently serving rows the
    // declaration cannot account for — so it is refused the same way.
    const retyped = candidate.columns.filter(col => {
      const stored = recordColumns.get(col.name.toLowerCase());
      return stored !== undefined && stored.affinity !== col.affinity;
    });
    if (retyped.length > 0) {
      const columnWord = retyped.length === 1 ? 'column' : 'columns';
      const changes = retyped.map(col => {
        const stored = recordColumns.get(col.name.toLowerCase())!;
        return `'${col.name}' as ${col.affinity} where the stored rows were written as ${stored.affinity}`;
      }).join(', ');
      throw new Error(
        `Cannot create table '${candidate.name}' over '${this.options.collectionUri}': that collection ` +
        `still holds rows from ${held}, and this declaration re-types ${columnWord} ${changes} — ` +
        `stored values are untagged, so they would be decoded as something other than what was ` +
        `written. Use a different collection URI, or re-declare the column types the stored rows ` +
        `were written under.`
      );
    }

    // Clause (b): a declared primary key that differs from the record's — column
    // names, order and direction. Every surviving row sits under a tree key computed
    // from the OLD primary key, so this declaration would never compute a key that
    // reaches them: point lookups miss, and the first re-write of such a row
    // relocates it.
    const declaredKey = describePrimaryKey(candidate);
    const recordKey = describePrimaryKey(record);
    if (declaredKey.toLowerCase() !== recordKey.toLowerCase()) {
      throw new Error(
        `Cannot create table '${candidate.name}' over '${this.options.collectionUri}': that collection ` +
        `still holds rows from ${held} keyed on ${recordKey}, and this declaration keys on ` +
        `${declaredKey} — rows written under the old key can never be reached through the new one. ` +
        `Use a different collection URI, or re-declare the primary key the stored rows were written under.`
      );
    }

    // Deliberately ALLOWED past this point:
    //  - a declaration that DROPS a column the record had: every declared column is
    //    still backed by real stored values, nothing is invented — and this is the
    //    documented way out of "cannot re-declare without column X: persisted index
    //    Y covers it" (README § Limitations);
    //  - an identical re-declare: declaring the same shape over the same URI is how
    //    a node states its view of a table, so the dropped rows come back (the
    //    README warns about this);
    //  - a live record under this table's OWN name never reaches this guard at all —
    //    that path goes through mergeWithPersisted, which already validates it.
    return orphanedIndexes;
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
        // ONE site covers both arms, and neither view is rebuilt to trace it. The counter
        // is filled in by the scan as it produces entries; the line is emitted in a
        // `finally` so a consumer that abandons the iteration (a LIMIT, an error mid-scan)
        // still reports what the seek had produced by then.
        const seek: IndexSeekProbe | undefined = log.enabled ? { matched: 0, rejected: 0 } : undefined;
        try {
          yield* this.executeIndexScan(mainRead, indexScan, filterInfo.args, seek);
        } finally {
          if (seek !== undefined) {
            this.logIndexSeek(indexScan, mainTree, committed, seek);
          }
        }
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
      // NOTE: a live read inside a doomed transaction can surface a concurrency
      // refusal EARLY — the tree.update() above replays this writer's pending actions,
      // and a guarded insert whose key a rival committed throws TreeKeyTakenError
      // mid-scan, as does a guarded UPDATE, DELETE or REPLACE whose row a rival changed
      // or removed (TreeEntryChangedError; test/external-commit-visibility-after-rollback.spec.ts
      // pins that shape). It reaches the client wrapped here as a plain Error reading
      // `Query failed: …`, not as the mapped `UNIQUE constraint failed: …` /
      // `concurrent modification: …` the same refusal gets at commit — and so with neither
      // the ConstraintError nor the ConcurrentModificationError type and code a commit-time
      // refusal carries (mapCommitRefusal sits only at the commit boundaries and the DML
      // catch). Not silent — the refusal stays reachable through `cause` — and the commit
      // would refuse anyway; if clients ever need the two shapes to match, map it here via
      // the bridge, as the DML catch does.
      const wrapped = rewrapAsQueryError('Query failed', error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
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
   * Emit the one line that answers "which revision did this read descend, and was it
   * allowed to refresh?" — the read-side counterpart to the bridge's
   * `commit:collections` line. How an operator reads it: `docs/debugging.md`
   * (§ "Which revision did a read descend?").
   *
   * A table's main tree and its index trees are separate collections that refresh
   * through DIFFERENT call sites, and a collection's revision advances only on an
   * explicit call on that instance (`update()`/`sync()`, or `recordCommitted()` from the
   * coordinator in session mode). So an index tree can sit at a revision older than the
   * main tree's — or at none at all, having been invented locally — and a seek down it
   * silently returns nothing while a full scan of the same table returns the row.
   * Nothing about that is visible without printing both revisions, which is what this
   * does. The field-by-field reading guide, and the decision table an operator applies
   * to the result, live in `docs/debugging.md`; what matters at THIS site is only what
   * each field is sourced from:
   *
   * - `arm=committed` is a pinned pre-transaction view that never refreshes (deliberate
   *   — see {@link committedTreeView}); `arm=live` ran `update()` on both trees
   *   immediately before the scan.
   * - `rev=` / `main_rev=` — the index and main COLLECTIONS' committed revisions, each
   *   rendered `<rev>@<actionId>` by {@link revisionToken}: `none` for a collection that
   *   has never adopted a revision, and a `@none` action half for a revision slot the log
   *   gave to a checkpoint or invalidation entry. Every collection counts
   *   its own revisions, so the two NUMBERS are not on one scale and are routinely unequal
   *   on a healthy run; do not make them look comparable by deriving one from the other
   *   here. The action ids are the exception — they are comparable across collections and
   *   across nodes, which is the whole reason they are printed.
   * - `node=` — which node emitted the line ({@link CollectionFactory.nodeTag}). Two nodes
   *   writing one collection at the same instant used to emit byte-identical lines, so an
   *   operator could only attribute them positionally.
   * - `seek=` — the framed index key the descent bracketed on, escaped by
   *   {@link printableSeekKey} so the line stays one whitespace-free token per field.
   *   Empty is the whole-index prefix; `unset` means the scan returned before framing a
   *   key at all, and the two must not be collapsed.
   * - `matched=` — index entries the seek produced, counted before the row fetch, so
   *   "descended a stale index" is distinguishable from "descended a current index that
   *   genuinely has no entry".
   * - `rejected=` — how many of those entries the scan then dropped because the row they
   *   name is gone or does not imply them. Nonzero means the index and the main table
   *   disagreed as this scan read them: either the tree is damaged — run
   *   `plugin.verifyIndexes` on this node to see which entries (docs/debugging.md, "Does an
   *   index agree with its table?") — or the two views are at different moments, which
   *   `rev=`/`main_rev=` and `arm=` above are what distinguish.
   *
   * `collection=` and `main=` are the same id strings `index:tree-open` and
   * `commit:collections` print, so all three lines join on them — and they name BOTH
   * collections this scan touched, which is what makes the line answerable on its own
   * when the failure is "the index tree is behind the table tree".
   *
   * NOTE: `rev=`/`main_rev=` report the COLLECTIONS' current revisions. For
   * `arm=committed` over a tree that was staged into this transaction, the view is
   * pinned to the transaction's first-touch boundary, which can be older than the
   * collection's current revision; for a clean tree the two are the same moment. If a
   * committed-arm investigation ever turns on that difference, print the pinned
   * `CollectionSnapshot.context.rev` as a further field rather than reinterpreting these.
   *
   * NOTE: unlike `index:tree-open` (bring-up only), this is one line PER index-driven
   * scan, so a query loop that seeks per row emits one per row. Fine now — the namespace
   * is off by default and the line costs nothing when disabled — but if the `module`
   * namespace is ever left on over a hot seek path and the volume becomes the problem,
   * sample it (every Nth scan) or move it to a dedicated `index-seek` sub-namespace
   * rather than deleting it.
   *
   * NOTE: `matched=` and `rejected=` count what the seek had produced when the iteration
   * ENDED, which for an abandoned scan (a LIMIT satisfied early, an error mid-scan) is short
   * of what the index holds. Both are floors, never overcounts — so `matched=0` still proves
   * the descent found nothing, which is the reading the two-worlds decision rule turns on,
   * and `rejected>0` still proves the tree disagrees with the table.
   */
  private logIndexSeek(
    index: IndexScanSource,
    mainTree: Tree<string, RowData>,
    committed: boolean,
    seek: IndexSeekProbe,
  ): void {
    const rev = (tree: {
      committedRevision(): number | undefined;
      committedActionId(): string | undefined;
    }): string => revisionToken(tree.committedRevision() ?? 'none', tree.committedActionId() ?? 'none');
    log(
      'index:seek table=%s index=%s collection=%s main=%s arm=%s rev=%s main_rev=%s seek=%s matched=%d rejected=%d node=%s',
      this.tableName,
      index.schema.name,
      String(index.tree.getCollection().id),
      String(mainTree.getCollection().id),
      committed ? 'committed' : 'live',
      rev(index.tree),
      rev(mainTree),
      seek.key === undefined ? 'unset' : printableSeekKey(seek.key),
      seek.matched,
      seek.rejected,
      this.collectionFactory.nodeTag(),
    );
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

    // A NULL seek arg makes the equality UNKNOWN under SQL three-valued logic, so no
    // row matches — even though key EQUALITY is NULL-self-equal and a NULL-keyed row
    // really is stored under the NULL tag (key-encoding.ts). Without this guard the
    // seek finds that row and returns it for `where pk = ?` bound to NULL.
    //
    // The engine cannot cover this for us: it folds only a *literal* NULL equality to
    // an empty result at plan time (`isLiteralNullEquality` in
    // rule-select-access-path.ts), and leaves a dynamic value — parameter, correlated
    // binding — to a per-module runtime guard (the memory backend's `seekKeyHasNull`).
    // getBestAccessPlan reports the PK equality filters as handledFilters=true, and the
    // engine drops the residual FILTER for every constraint a module claims, so nothing
    // above this seek would catch a leaked row. The secondary-index seek carries the
    // same guard for the same reason (see executeIndexScan).
    //
    // Reachable since Quereus 4.14: PRIMARY KEY no longer implies NOT NULL, so
    // `x integer null primary key` stores a NULL-keyed row (quereus
    // test/logic/43.3-nullable-primary-key.sqllogic pins `where x = null` → []).
    if (args.some(arg => arg === null || arg === undefined)) {
      return;
    }

    // Assemble the full (possibly composite) primary key from ALL seek args using
    // the SAME encoding the row codec uses to store keys (extractPrimaryKey).
    // Using only args[0] silently drops every PK column past the first, so a
    // composite-PK point lookup builds a key that can never match a stored row.
    // Seek args are the key-ordered tuple shape, not a row — see schema/key-tuples.ts.
    const key = this.rowCodec.createPrimaryKey(
      this.rowCodec.asPrimaryKeyTuple(args as readonly SqlValue[]),
    );

    const row = await readRowAt(read, this.rowCodec, key);
    if (row !== undefined) {
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
    seek?: IndexSeekProbe,
  ): AsyncIterable<Row> {
    const rowCodec = this.rowCodec;
    const indexManager = this.indexManager;
    if (!rowCodec || !indexManager) return;

    // A NULL seek arg makes the equality UNKNOWN under SQL three-valued logic, so no row
    // matches — the same guard, for the same reason, that executePointLookup carries; read
    // its comment for why the engine leaves a dynamic NULL to the module (it folds only a
    // literal one, and quereus's own memory backend guards every seek path with
    // `seekKeyHasNull`). getBestAccessPlan claims the matched equality filters as
    // handledFilters=true, so the engine drops the residual predicate and nothing above
    // this seek would catch a leaked row.
    //
    // ABOVE the key framing on purpose: indexKeyFromValues frames a NULL into a perfectly
    // valid key — NULL has its own bare tag (key-encoding.ts) — which really does find the
    // NULL-keyed row an INSERT stored. The verification below would not reject it either:
    // the entry genuinely belongs to that row. Only refusing to seek at all is correct.
    if (args.some(arg => arg === null || arg === undefined)) {
      return;
    }

    // Build the (possibly partial) framed index key from constraint values. Both this
    // and IndexManager.createIndexKey route through indexKeyFromValues, so the prefix
    // range in findEntriesIn brackets exactly the tuple an insert stored. A partial key
    // (fewer args than index columns) frames only the provided leading columns and
    // prefix-matches the rest; the planner may also hand over MORE constraint values
    // than the index covers, so the excess is truncated rather than rejected.
    const width = Math.min(args.length, index.schema.columns.length);
    // Zero constraint values would mean the plan wants the whole index: frame the empty
    // prefix directly, since asIndexColumnTuple deliberately rejects an empty tuple and
    // this case must bypass it rather than weaken that guard.
    //
    // NOTE: no planner path reaches this branch today. The secondary-index arm of
    // getBestAccessPlan names an index only once at least one equality filter matched, and
    // runQuery sets `scanIndexName` on that path only for `args.length > 0`; the other way
    // in is the legacy `filterInfo.idxNum >= 10` arm, and `idxNum` is hard-coded to `0` at
    // every construction site in `@quereus/quereus/src/vtab/filter-info.ts`, so that arm is
    // dead. Kept because it is the correct framing the day an index-served ORDER BY or a
    // whole-index plan does arrive — not because something currently uses it.
    const indexKey = width === 0
      ? indexKeyFromValues([])
      : indexManager.createIndexKeyFromTuple(
          indexManager.asIndexColumnTuple(
            index.schema,
            args.slice(0, width) as readonly SqlValue[],
          ),
        );
    // Recorded for the `index:seek` trace BEFORE the descent, so a scan that throws
    // part-way still names the key it was seeking rather than reporting `unset`.
    if (seek !== undefined) seek.key = String(indexKey);

    // Each entry is checked against the row it resolves to before that row is yielded, and
    // the check is the FULL one — `rowImpliesEntry`, the same predicate the integrity check
    // diffs on — not a prefix match against the seek key. Two things make it necessary:
    //
    //  - The engine is entitled to trust the seek. getBestAccessPlan claims the matched
    //    equality filters as handledFilters=true, and `reattachUnconsumedConstraints` in
    //    `@quereus/quereus/src/planner/rules/access/rule-select-access-path.ts` reattaches a
    //    residual FILTER only for a claimed constraint the seek did NOT consume. A consumed
    //    one gets none, so whatever this yields is the answer.
    //  - An entry can outlive its row's value: a writer not maintaining this index UPDATEs
    //    the row, and backfillIndexTrees adds the new entry on re-attach without purging the
    //    old one. That entry resolves to a LIVE row holding a different value.
    //
    // Checking the whole entry rather than the seek's prefix is what also closes the
    // duplicate: on a seek narrower than the index (`where C = 'x'` over an index on
    // `(C, D)`), a row that moved from `('x', 2)` to `('x', 9)` has two entries, and BOTH
    // prefix-match `'x'` — so a prefix check would return that row twice. Its full implied
    // key can equal only one of them.
    //
    // NOTE: the check proves the entry belongs to its ROW, not that it sits under the key
    // SOUGHT — and those coincide only because indexValueRange is an exact byte-prefix
    // bracket: the index tree is opened with a raw lexicographic string comparator
    // (collection-factory.ts), so every entry the range yields has a tree key literally
    // beginning with `indexKey`, and the framing is injective. If `debt-optimystic-true-key-ordering`
    // ever gives the index tree a collation-aware comparator, the range can bracket entries
    // under a DIFFERENT framed value, which their own rows imply and this check would pass —
    // add a prefix check of the derived key against `indexKey` then.
    //
    // NOTE: this derives the row's full index key once per entry the seek produces — one
    // serialize-and-frame per index column, over a row the fetch above has already decoded.
    // Small beside the tree descent that fetched it, and paid only on index-routed reads. If
    // a hot seek path ever shows up in a profile, the derivation is the part to narrow, not
    // the fetch: a healthy entry's own tree key already carries the answer.
    const indexKeyOf = (row: Row): IndexKey => indexManager.createIndexKey(index.schema, row);
    for await (const entry of indexManager.findEntriesIn(index.read, indexKey)) {
      // Counted HERE, before the row fetch: `matched` must mean "entries the index
      // descent produced", not "rows that survived". An entry whose row is missing or
      // that the verification rejects still proves the index held something.
      if (seek !== undefined) seek.matched++;
      const row = await readRowAt(mainRead, rowCodec, entry[1]);
      if (row === undefined || !rowImpliesEntry(row, entry, indexKeyOf)) {
        // Both halves are index damage the read path can otherwise only correct silently:
        // the row is gone (a `no-row` orphan), or it no longer implies this entry (a
        // `stale-value` or `malformed` one). Counted so a seek quietly compensating for a
        // broken tree can be SEEN on the `index:seek` line rather than inferred.
        if (seek !== undefined) seek.rejected++;
        continue;
      }
      yield row;
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
   * present in the coordinator's (shared) map before anything stages into them.
   * The coordinator re-captures newly registered collections at each applyActions,
   * so registering late is recoverable; registering AFTER a stage is not, because
   * the capture would then record already-staged state as "before". Idempotent and
   * mode-agnostic: the registry is a plain map the bridge maintains regardless of
   * whether session mode is ever wired up.
   */
  private registerCollections(): void {
    if (this.collection) {
      this.txnBridge.registerCollection(this.collection.getCollection());
      // Teach the bridge how to render a concurrency-refused duplicate key for THIS
      // table (a TreeKeyTakenError surfacing at commit from the main collection's
      // conflict replay). Registered here — after doInitialize resolved the schema,
      // before any DML — so the rendered SQL message names the real PK columns.
      this.txnBridge.registerKeyTakenMessage(
        this.collection.getCollection().id,
        this.uniqueConstraintMessage(),
      );
      // And how to render a concurrency-refused ROW CHANGE (a TreeEntryChangedError
      // from the main collection's replay: the row an UPDATE, DELETE or REPLACE read
      // was changed or removed by a rival first). Only the main collection registers
      // one — no index-tree entry carries an `unchanged` guard.
      this.txnBridge.registerEntryChangedRenderer(
        this.collection.getCollection().id,
        key => this.concurrentModificationMessage(key),
      );
    }
    if (this.indexManager) {
      for (const tree of this.indexManager.getIndexTrees()) {
        this.txnBridge.registerCollection(tree.getCollection());
      }
    }
    this.registerUniqueKeyTakenMessages();
  }

  /**
   * Teach the bridge how to render a `TreeRangeTakenError` (a concurrency-refused
   * duplicate UNIQUE VALUE) fired from a UNIQUE-enforcing index tree: map that tree's
   * collection id to `uniqueConstraintMessage(uc.columns)`, naming the violated
   * constraint's columns rather than the PK. A row can bind several UNIQUE constraints,
   * each enforced by its own tree, so this registers one message per resolvable
   * constraint. Idempotent (the bridge keys by collection id); re-run after a
   * `CREATE UNIQUE INDEX` mirrors a new constraint (see {@link addIndex}). Constraints
   * whose enforcing tree cannot yet be resolved are skipped silently — they carry no
   * live tree to fire a refusal from, so there is nothing to name.
   */
  private registerUniqueKeyTakenMessages(): void {
    const constraints = this.tableSchema.uniqueConstraints;
    if (!constraints || constraints.length === 0) return;
    for (const uc of constraints) {
      if (uc.predicate !== undefined || uc.columns.length === 0) continue;
      const enforcing = this.resolveEnforcingIndex(uc);
      if (!enforcing) continue;
      this.txnBridge.registerKeyTakenMessage(
        enforcing.tree.getCollection().id,
        this.uniqueConstraintMessage(uc.columns),
      );
    }
  }

  /**
   * The names of this table's maintained indexes whose staged entry for a row carrying
   * `values` must carry the concurrency guard (see IndexManager.uniquePrefixGuard) —
   * every UNIQUE constraint that BINDS the row (non-partial, all columns present and
   * non-null), whatever conflict action it resolves to. Computed from the row alone —
   * independent of whether this writer's own snapshot saw a collision — because the
   * guard exists precisely for the collision this snapshot did NOT see (a rival
   * committing the value concurrently). Returns an EMPTY set for a table with no
   * secondary UNIQUE constraints, so the staging paths add no guard and no cost.
   *
   * IGNORE- and REPLACE-resolved constraints are guarded too, so a concurrent
   * duplicate under them is REFUSED rather than honoured at replay. Neither
   * disposition CAN be honoured there: the rival's row lives in the main collection,
   * and an index tree's replay can neither skip this row's main entry (IGNORE) nor
   * evict the rival's (REPLACE) — an unguarded entry would silently commit two rows
   * under one unique value, the very violation the guard exists to prevent. Refusing
   * is never silent, and the application-level retry re-probes and then honours the
   * disposition the sequential way (the call the PK-move guard already makes for
   * IGNORE; see the UPDATE arm). Every collision this snapshot CAN see is still
   * settled by the pre-stage probe, so sequential IGNORE/REPLACE semantics are untouched.
   * That holds only because EVERY write path that stages a guarded entry runs
   * {@link resolveSecondaryUniqueDecision} first (fresh INSERT, INSERT's PK-REPLACE
   * arm, UPDATE). A path that stages with this guard but no probe refuses a visible
   * collision it should have resolved — and its retry re-refuses forever.
   * NOTE: accepted tradeoff — a concurrent `insert or replace` loser sees a UNIQUE
   * error instead of displacing the rival; revisit if a cross-collection replay
   * disposition (skip/evict the rival's MAIN row from an index-tree guard) ever exists.
   */
  private guardedUniqueIndexes(values: Row): ReadonlySet<string> {
    const constraints = this.tableSchema.uniqueConstraints;
    if (!constraints || constraints.length === 0) return EMPTY_INDEX_SET;
    const guarded = new Set<string>();
    for (const uc of constraints) {
      if (uc.predicate !== undefined || uc.columns.length === 0) continue;
      if (!uc.columns.every(ci => values[ci] !== null && values[ci] !== undefined)) continue;
      const enforcing = this.resolveEnforcingIndex(uc);
      if (enforcing) guarded.add(enforcing.descriptor.name);
    }
    return guarded.size === 0 ? EMPTY_INDEX_SET : guarded;
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

  /**
   * Render a concurrency-refused row change — the `unchanged` guard on this table's
   * main collection finding, at commit, that a rival changed or removed the row the
   * statement read (see {@link unchanged}). `key` is the refused entry's framed primary
   * key, decoded back to the logical values a client can match to their SQL:
   *   `concurrent modification: another writer changed or removed the row in <table> at primary key (…)`
   * A plain message, deliberately NOT the UNIQUE wording: a lost update is not a
   * uniqueness violation, and the bridge likewise raises it as `ConcurrentModificationError`
   * rather than the `ConstraintError` a uniqueness refusal becomes. Registered with the
   * bridge in {@link registerCollections}.
   */
  private concurrentModificationMessage(key: string): string {
    const values = this.rowCodec?.decodePrimaryKey(key) ?? [];
    return `concurrent modification: another writer changed or removed the row in ` +
      `${this.tableName} at primary key ${formatKeyValues(values)}`;
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
   *
   * Set matching within this one resolved schema is positional ({@link columnSetKey});
   * the descriptor's NAME is not, because it becomes the tree's URI and so outlives this
   * schema's column numbering — it is derived from the columns' names
   * ({@link uniqueEnforcementTreeName}), so a re-declare that reorders the table's
   * columns resolves to the same tree. Trees under the retired positional names
   * (`_uniq_1`) are left unreferenced in storage; a renamed tree starts empty and is
   * rebuilt from the table by {@link ensureUniquePopulated} on its first probe.
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
        name: uniqueEnforcementTreeName(uc.columns.map(index => this.columnNameAt(storedSchema, index))),
        columns: uc.columns.map(index => ({ index })),
      });
    }
    return synthesized;
  }

  /** The declared name of the column at `index` in `storedSchema`; a constraint that addresses a position the schema lacks is corrupt, not NULL-keyed. */
  private columnNameAt(storedSchema: StoredTableSchema, index: number): string {
    const column = storedSchema.columns[index];
    if (column === undefined) {
      throw new Error(
        `Table '${this.tableName}': unique constraint addresses column position ${index}, ` +
        `which is out of range for its ${storedSchema.columns.length} columns`
      );
    }
    return column.name;
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

    // No rows to copy means every step below is a no-op reached the expensive way: two
    // cache-bypassing refreshes and a walk, to stage nothing. Checked before tree.update()
    // for that reason — the probe that called this refreshes the tree itself either way,
    // so skipping ahead costs the probe no freshness.
    //
    // Soundness here is NOT hasNoRowsToBackfill's (that argues about unindexed rows; a
    // missed populate on THIS path would instead admit a duplicate). The argument is:
    // the probe reads the tree after tree.update(), so entries any writer running this
    // build maintained are visible without a populate at all. Populate exists only for
    // rows an OLDER build wrote past an unmaintained tree — and those are collidable
    // only against rows this connection can see. An empty live view means it sees none.
    // The residual hole (a stale view missing an old-build sibling's rows) is the
    // pre-existing shape of this guard, which already ran once per tree per process and
    // never re-checked after that first probe.
    //
    // Deliberately does NOT mark the tree populated: nothing was verified, so a later
    // probe over a by-then-populated table still gets its one backfill.
    // NOTE: re-checked per probed row while the table is empty; that is a cached first()
    // read and the table stops being empty after one insert. If an empty-table DML burst
    // ever shows up in a profile, memoize the emptiness answer until the first stage.
    if (await this.hasNoRowsToBackfill()) return;

    await tree.update();
    // Emptiness is "the first path is not ON an entry" — isValid() only reports whether
    // a path survived a concurrent mutation (its version), NOT whether it points at a
    // row, so at()===undefined is the on-entry signal (an empty tree's first() is
    // version-valid but sits on no entry).
    const treeEmpty = tree.at(await tree.first()) === undefined;
    if (treeEmpty) {
      await this.populateUniqueTree(descriptor, tree);
    }
    this.populatedUniqueTrees.add(descriptor.name);
  }

  /**
   * Stage one entry per current row of the table into the synthesized unique tree `tree` and
   * flush it, in isolation from whatever the caller has staged elsewhere — the same populate
   * loop as addIndex's. NULL-bearing rows are exempt from the constraint and stage no entry,
   * matching the probe's null-exemption (and keeping an all-null tree legitimately empty).
   */
  private async populateUniqueTree(descriptor: StoredIndexSchema, tree: Tree<string, IndexEntry>): Promise<void> {
    if (!this.collection || !this.rowCodec || !this.indexManager) return;
    await this.collection.update();
    for await (const { row, primaryKey } of walkDecodedRows(this.collection, this.rowCodec)) {
      if (hasNullIndexValue(descriptor, row)) {
        continue;
      }
      const treeKey = indexEntryKey(this.indexManager.createIndexKey(descriptor, row), primaryKey);
      await tree.stage([[treeKey, [treeKey, primaryKey]]]);
    }
    await tree.sync();
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
      const entry = this.collection.at(path) as StoredRowEntry | undefined;
      if (!entry || entry.length < 2) continue;
      if (excludeKeys?.has(entry[0]!)) continue;
      const existing = this.rowCodec.decodeRow(entry[1]);
      if (this.uniqueKeyFor(uc.columns, existing) === key) {
        collisions.push({ pk: entry[0], row: existing, entry });
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
      const entry = await this.collection.get(pk) as StoredRowEntry | undefined;
      if (!entry || entry.length < 2) continue;
      collisions.push({ pk, row: this.rowCodec.decodeRow(entry[1]), entry });
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
   * NOTE: deliberate divergence from the memory module. Memory's
   * `performUpdateWithPrimaryKeyChange` (UPDATE) and `performInsert`'s PK-REPLACE arm
   * (INSERT) both return as soon as a PK REPLACE resolves and never check the
   * secondary UNIQUE constraints, so a write that also duplicates a UNIQUE value
   * leaves the duplicate in place. Here both paths still resolve them (SQLite's
   * semantics), reporting `replacedRow` and `evictedRows` together when both apply —
   * the executor handles the pair (see quereus's common/types.ts on their
   * co-occurrence). The two modules disagree until the upstream arm lands
   * (blocked/quereus-memory-vtab-pk-replace-skips-unique-check).
   */
  private async resolvePkMoveDecision(
    newKey: string,
    stmtOnConflict: ConflictResolution | undefined,
  ): Promise<PkMoveDecision> {
    if (!this.collection || !this.rowCodec) {
      throw new Error('Table not initialized');
    }
    const existing = await this.collection.get(newKey) as StoredRowEntry | undefined;
    if (existing === undefined) return { kind: 'clear' };

    // Decode the displaced row once from the entry value [pk, encoded].
    const existingRow = this.rowCodec.decodeRow(existing[1]);
    const onConflict = this.resolveConflictAction(stmtOnConflict, this.pkDeclaredConflict());

    // IGNORE: leave both rows put — the moving row stays at oldKey, the row at
    // newKey is untouched.
    if (onConflict === ConflictResolution.IGNORE) return { kind: 'swallow' };
    if (onConflict === ConflictResolution.REPLACE) return { kind: 'displace', row: existingRow, entry: existing };

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
    const evictable = new Map<string, UniqueCollision>();
    for (const uc of active) {
      const collisions = await this.probeUniqueConstraint(uc, values, excludeKeys);
      if (collisions.length === 0) continue;
      const effective = this.resolveConflictAction(stmtOnConflict, uc.defaultConflict);
      if (effective === ConflictResolution.IGNORE) {
        return { kind: 'swallow' };
      }
      if (effective === ConflictResolution.REPLACE) {
        for (const collision of collisions) evictable.set(collision.pk, collision);
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
      return { kind: 'evict', collisions: [...evictable.values()] };
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
   * journal order). Each eviction's main-table delete is guarded {@link unchanged} on
   * the collision's stored entry: its index deletes were computed from that image, so a
   * rival's concurrent change to the evicted row refuses this writer rather than
   * leaving the rival's index entries orphaned.
   */
  private async applyUniqueEvictions(
    collisions: readonly UniqueCollision[],
    transactor?: ITransactor,
  ): Promise<Row[]> {
    if (!this.collection || !this.indexManager) {
      throw new Error('Table not initialized');
    }
    const evicted: Row[] = [];
    for (const { pk, row, entry } of collisions) {
      await this.collection.stage([[pk, undefined, unchanged(entry)]]);
      await this.indexManager.deleteIndexEntries(row, pk, transactor);
      evicted.push(row);
    }
    return evicted;
  }

  /**
   * Fetch the pre-write row image an UPDATE or DELETE is about to replace — decoded,
   * and as stored — or throw if the collection has no row at that key.
   *
   * Both write paths need the decoded row so {@link IndexManager} can compute the old
   * index-tree keys, and the stored entry so the main-table action can be guarded
   * {@link unchanged} on it. Both must read it BEFORE any `collection.stage()` call,
   * which clears or overwrites the slot. `collection.get()` reads staged-this-tx +
   * committed state, so chained writes within one transaction see the right image —
   * and a later statement's guard expects the earlier statement's staged entry, which
   * replay, re-running the actions in order, has put there.
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
  ): Promise<PreWriteImage> {
    if (!this.collection || !this.rowCodec) {
      throw new Error('Table not initialized');
    }
    const entry = await this.collection.get(key) as StoredRowEntry | undefined;
    if (!entry) {
      throw new QuereusError(
        `${operation} could not find the pre-write row in table ${this.tableSchema.name} ` +
        `at primary key ${formatKeyValues(keyValues)} — the engine and the collection ` +
        `disagree about what exists.`,
        StatusCode.ERROR,
      );
    }
    return { row: this.rowCodec.decodeRow(entry[1]), entry };
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
    // NOTE: this await must stay ABOVE every collection.stage in this method.
    // addStatement is what drives coordinator.applyActions, which captures pre-stage
    // tracker state for rollback — for every collection registered since the last
    // call, not only on the transaction's first. Reordering a stage above it reopens
    // the non-deterministic-snapshot race and breaks session-mode rollback.
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
            const existing = await this.collection.get(insertKey) as StoredRowEntry | undefined;
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
                // INSERT OR REPLACE: overwrite the row in place. The replacement is a
                // new row image at the SAME key, so it must clear every secondary
                // UNIQUE constraint exactly as a fresh insert does — excluding the row
                // it overwrites, which is on its way out and cannot conflict with its
                // own replacement (the UPDATE arm excludes oldKey for the same reason).
                // Decided BEFORE anything is staged: without this probe the only thing
                // standing between the replacement and a rival holding the value is the
                // concurrency guard below, which refuses — and re-refuses on every retry
                // — a collision this snapshot can plainly see.
                const uniqueDecision = await this.resolveSecondaryUniqueDecision(
                  values, args.onConflict, new Set([insertKey]));
                if (uniqueDecision.kind === 'blocked') {
                  return uniqueDecision.result;
                }
                if (uniqueDecision.kind === 'swallow') {
                  // A secondary constraint resolved IGNORE: the existing row at
                  // insertKey stays as it was and nothing is staged.
                  return { status: 'ok' };
                }

                const replacementEncoded = this.rowCodec.encodeRow(values);
                this.markDirtyTrees();

                // REPLACE-resolved secondary collisions evict first (evict-then-write),
                // so the new entry's unique guard below finds its value range free.
                const evictedRows = uniqueDecision.kind === 'evict'
                  ? await this.applyUniqueEvictions(uniqueDecision.collisions, txnState?.transactor)
                  : [];

                // Same PK, so only changed indexed columns restage via updateIndexEntries —
                // computed from `existingRow`, so the replacement is guarded on that entry:
                // a rival that changes or removes the row first refuses this writer instead
                // of letting the replacement land beside an index delta for a row image the
                // collection no longer holds.
                await this.collection.stage([[insertKey, [insertKey, replacementEncoded], unchanged(existing)]]);
                await this.indexManager.updateIndexEntries(
                  existingRow,
                  values,
                  insertKey,
                  insertKey,
                  txnState?.transactor,
                  this.guardedUniqueIndexes(values),
                );
                // replacedRow (the same-PK slot) and evictedRows (rows at OTHER PKs)
                // co-occur here; the executor runs each eviction's delete pipeline
                // before modelling the replacement as an update of replacedRow.
                return {
                  status: 'ok',
                  row: values,
                  replacedRow: existingRow,
                  ...(evictedRows.length > 0 ? { evictedRows } : {}),
                };
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

            // The probe above only proves the key is clear in THIS writer's snapshot; a
            // rival committing the same key concurrently would otherwise be silently
            // overwritten when the losing commit's conflict replay re-runs this staged
            // action as a bare upsert. Carry the INSERT's intent on the entry so the
            // replace handler re-makes the decision on every replay, against the newest
            // adopted committed state (see TreeEntryGuard). The intent is 'absent' under
            // EVERY resolved conflict action — ABORT (default; FAIL/ROLLBACK honoured as
            // ABORT), IGNORE and REPLACE alike — so a rival taking the key first refuses
            // the loser with the ordinary UNIQUE constraint error, and the disposition is
            // honoured by the sequential retry, whose probe then sees the rival's row:
            //  - IGNORE is NOT 'keepExisting': that kind skips only the main-tree entry
            //    at replay, while the index entries staged below replay independently
            //    and would land beside the rival's row, an entry no row implies.
            //  - REPLACE is NOT unguarded: an overwrite at replay would displace the
            //    rival's row without the index deletes a sequential REPLACE stages for
            //    it, leaving the rival's index entries orphaned.
            //  - ON CONFLICT (pk) DO UPDATE whose probe found no row is covered too:
            //    under concurrency the statement REFUSES rather than performing the
            //    upsert the sequential path would have; the retry takes the update arm.
            // Do not try to re-run SQL semantics inside the replay.
            // Stage the row in the main table. Entry format: [primaryKey, encodedRow]
            await this.collection.stage([[insertKey, [insertKey, encodedRow], { kind: 'absent' }]]);

            // Stage into all indexes. UNIQUE-enforcing index trees whose value this row
            // occupies carry the concurrency guard so a rival that commits the same value
            // under a different PK refuses the loser at replay (see guardedUniqueIndexes);
            // a REPLACE-resolved constraint's tree is unguarded, its eviction already staged.
            await this.indexManager.insertIndexEntries(
              values,
              insertKey,
              txnState?.transactor,
              this.guardedUniqueIndexes(values),
            );

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
            const { row: oldRow, entry: oldEntry } = await this.requirePreWriteRow('UPDATE', oldKey, oldKeyTuple);

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

            // Every main-table entry this UPDATE stages is guarded, because its index
            // delta below is computed from row images read in THIS writer's snapshot,
            // and a conflict replay would otherwise re-apply the main-table action over
            // whatever a rival committed while the delta lands beside it (see `unchanged`).
            //  - the slot the row leaves (a same-key rewrite, or the delete half of a PK
            //    move) is guarded `unchanged` on the pre-write entry: a rival that changed
            //    or removed the row refuses this writer, rather than being overwritten
            //    (or resurrected) with a stale index delta;
            //  - a PK move's insert half at a key the probe found CLEAR is guarded
            //    'absent' under every resolved conflict action, exactly as an INSERT is
            //    (see the INSERT arm). IGNORE is not 'keepExisting': skipping only the
            //    insert half at replay would still apply the delete half and lose the row.
            //    REPLACE is not unguarded: a late rival displaced at replay would leave
            //    its index entries orphaned. Refusing is never silent, and the
            //    application-level retry re-probes and then honours the disposition the
            //    sequential way (IGNORE swallows the move; REPLACE displaces the rival);
            //  - a displacing move (REPLACE onto an OCCUPIED key) is guarded `unchanged`
            //    on the displaced entry: `deleteIndexEntries(pkMove.row, newKey)` below
            //    was computed from that image.
            const moveGuard: TreeEntryGuard<string, StoredRowEntry> = pkMove.kind === 'displace'
              ? unchanged(pkMove.entry)
              : { kind: 'absent' };

            // Stage the main-table change (flushed at commit / restored on
            // rollback). A PK change is staged as delete-old + insert-new so both
            // index halves revert together on rollback; staging `undefined` at
            // oldKey clears the old slot and the upsert at newKey overwrites any
            // displaced row in one shot, so a displacing move needs no separate
            // main-table delete. The two halves are at DIFFERENT keys, which is what
            // lets the insert half's guard read the tree the delete half just wrote
            // without refusing itself.
            await this.collection.stage(oldKey !== newKey
              ? [[oldKey, undefined, unchanged(oldEntry)], [newKey, [newKey, encodedRow], moveGuard]]
              : [[newKey, [newKey, encodedRow], unchanged(oldEntry)]]);

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
              txnState?.transactor,
              // Guard the NEW entry on every binding, ABORT-resolved UNIQUE constraint —
              // the moving row's own OLD entry is deleted first in the same tree action, so
              // a value-preserving move never refuses itself (see updateIndexEntries).
              this.guardedUniqueIndexes(values),
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
            const { row: oldRow, entry: oldEntry } = await this.requirePreWriteRow('DELETE', deleteKey, oldKeyTuple);

            // Snapshot before staging so a rollback reverts exactly this delete.
            this.markDirtyTrees();

            // Stage the main-table delete (flushed at commit / restored on rollback),
            // guarded on the entry the index deletes below were computed from: a rival
            // that changed the row first refuses this writer (its index entries would
            // otherwise be orphaned), and so does a rival that already deleted it — the
            // second of two racing deletes reads a row that is gone, and its sequential
            // retry then affects zero rows.
            await this.collection.stage([[deleteKey, undefined, unchanged(oldEntry)]]);

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
      // A guard refusal at INITIAL staging: the tracker the guard scans fetched a
      // rival's commit that the pre-stage probe's view had not (observed on a two-node
      // mesh, never on one node). Same message a commit-time refusal carries; the
      // statement-level savepoint discards whatever this statement staged before it.
      const refusal = this.txnBridge.mapCommitRefusal(error);
      if (refusal !== error && refusal instanceof Error) {
        this.setErrorMessage(refusal.message);
        throw refusal;
      }
      const wrapped = rewrapAsQueryError(`${operation} failed`, error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
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
   * Add an index to the table schema.
   *
   * `deferFlush` is supplied only while an `APPLY SCHEMA` batch is open: the index trees this
   * call populates are then handed to the batch instead of flushed here (see
   * {@link backfillIndexTrees}). Absent, behaviour is exactly the unbatched one.
   */
  async addIndex(indexSchema: IndexSchema, deferFlush?: DeferIndexFlush): Promise<void> {
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
    const storedSchema = await this.schemaManager.getSchemaFresh(this.schemaName, this.tableName);
    if (!storedSchema) {
      throw new Error('Schema not found');
    }

    const txnState = this.txnBridge.getCurrentTransaction();
    const existing = storedSchema.indexes.find(idx => idx.name === indexSchema.name);

    if (!existing) {
      // Build path: `<uri>/index/<name>` is adopted create-on-missing, so a tree a
      // DROPPED table (or a URI-sharing declaration) left behind under this name is
      // silently reused. Refuse when the record that described that storage says the
      // tree was built over DIFFERENT columns — before anything is written or
      // mirrored, so a refusal leaves no trace.
      await this.guardIndexAdoption(indexSchema, storedSchema, txnState?.transactor);
    }

    // Mirror the derived UNIQUE constraint BEFORE the already-persisted dedupe
    // below: a re-declared CREATE UNIQUE INDEX on a warm start hits that dedupe
    // and returns early, but this cached vtab still needs the constraint in
    // memory for the uniqueness probe (see mirrorDerivedUniqueConstraint).
    this.mirrorDerivedUniqueConstraint(indexSchema);

    if (existing) {
      // Upgrade path: a schema persisted before `unique`/`predicate` were wired
      // through has the index but not its uniqueness metadata. Re-declaring the
      // index is the documented way to restore it, so persist the flags (one
      // write; subsequent re-declares see them present and skip).
      let effective = storedSchema;
      if (indexSchema.unique && !existing.unique) {
        const { unique, predicate } = this.schemaManager.indexSchemaToStored(indexSchema);
        const upgraded: StoredTableSchema = {
          ...storedSchema,
          indexes: storedSchema.indexes.map(idx =>
            idx.name === indexSchema.name
              ? { ...idx, unique, predicate }
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
      await this.backfillIndexTrees(attached, deferFlush);
      // A re-declared CREATE UNIQUE INDEX mirrored its constraint above; teach the
      // bridge that this (now open + registered) tree's refusal names those columns.
      this.registerUniqueKeyTakenMessages();
      return;
    }

    // Add the index to the stored schema, carrying its uniqueness metadata so a
    // later hydrate-only open can reconstruct the derived UNIQUE constraint.
    const updatedSchema: StoredTableSchema = {
      ...storedSchema,
      indexes: [...storedSchema.indexes, this.schemaManager.indexSchemaToStored(indexSchema)],
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
    // so a session-mode coordinator sees them. Registering mid-transaction is
    // fine for rollback: the coordinator re-captures newly registered collections
    // on every applyActions, not just the transaction's first. What it cannot
    // rewind is anything staged into the new tree BEFORE that next applyActions —
    // which is why backfillIndexTrees below flushes the trees it populates (or, inside
    // an `APPLY SCHEMA` batch, hands them to the batch's end-of-apply flush) instead
    // of leaving those entries staged for the enclosing transaction's commit.
    this.indexManager.registerIndexTree(indexSchema.name, indexTree);
    const attached = await this.reconcileMaintainedIndexes(writtenSchema, txnState?.transactor);

    // Populate the index with existing data. Reconcile reports the index just built
    // as newly attached (the manager carried no descriptor for it until the setSchema
    // inside reconcile), so this ONE call serves both the build path and the
    // re-attach path above — there is no second populate loop to keep in step.
    await this.backfillIndexTrees(attached, deferFlush);
    // A brand-new CREATE UNIQUE INDEX: register its tree's refusal message now that the
    // tree is open and its derived constraint is mirrored onto this.tableSchema.
    this.registerUniqueKeyTakenMessages();
  }

  /**
   * The `DROP INDEX` half of {@link addIndex}. The catalog record loses the index — its
   * description moves to `orphanedIndexes`, because the tree at `<uri>/index/<name>` stays in
   * storage ({@link SchemaManager.removeIndex}) — and then this instance stops maintaining it:
   * the descriptor and tree leave the {@link IndexManager}, so no DML stages into it again; the
   * tree leaves the transaction bridge, so nothing flushes what was already staged into it; and
   * the index and the UNIQUE constraint {@link mirrorDerivedUniqueConstraint} derived from it leave
   * this instance's own `tableSchema`, which a later re-initialize would otherwise write back. The
   * catalog write goes first so a refused write leaves the instance maintaining the index exactly
   * as before. Quereus hands over the index's STORED casing; the record and the manager are
   * matched case-insensitively regardless and keep what they hold. Last, a UNIQUE constraint the
   * dropped index was enforcing gets a synthesized tree ({@link reassignUniqueEnforcement}).
   *
   * An index the engine lists but this connection never attached (one withheld after a failed
   * batch commit; see {@link markSchemaUnpersisted}) has no tree here to withdraw; the record
   * write and the schema filter still apply.
   *
   * NOTE: the index tree is left in storage. Nothing in this plugin deletes a collection, and
   * `DROP TABLE` leaves its trees the same way. A later `CREATE INDEX` of the same name adopts it
   * (the adoption guard checks its columns against the description kept here) and re-stages every
   * row idempotently. Entries for rows DELETED between the drop and that re-create are never
   * re-staged and survive it: an index-driven seek then resolves such an entry to a row that is
   * gone — `executeIndexScan` skips it, so results stay right, but a unique-enforcement probe
   * still counts it (`bug-stale-index-entry-causes-false-unique-refusal`). The same residual a
   * failed deferred flush already leaves, except that a deliberate drop can sit in front of the
   * re-create for much longer. Deleting the tree needs a collection-delete primitive first.
   */
  async removeIndex(indexName: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (!this.schemaManager || !this.indexManager) {
      throw new Error('Table not initialized');
    }

    const txnState = this.txnBridge.getCurrentTransaction();
    await this.schemaManager.removeIndex(this.schemaName, this.tableName, indexName, txnState?.transactor);

    const tree = this.indexManager.unregisterIndex(indexName);
    if (tree) {
      this.txnBridge.forgetTree(tree);
    }
    const lower = indexName.toLowerCase();
    const uniqueConstraints = (this.tableSchema.uniqueConstraints ?? []).filter(
      uc => uc.derivedFromIndex?.toLowerCase() !== lower,
    );
    this.tableSchema = {
      ...this.tableSchema,
      indexes: (this.tableSchema.indexes ?? []).filter(idx => idx.name.toLowerCase() !== lower),
      uniqueConstraints: uniqueConstraints.length > 0 ? uniqueConstraints : undefined,
    };
    await this.reassignUniqueEnforcement(txnState?.transactor);
  }

  /**
   * After a declared index left this instance: every point-enforceable UNIQUE constraint that
   * index was enforcing gets the synthesized `_uniq_` tree it would have had without the index.
   * {@link resolveEnforcingIndex} prefers a declared index over the constraint's columns, and
   * {@link buildUniqueEnforcementIndexes} synthesizes nothing for a constraint a declared index
   * covers at initialization — so with the index gone the constraint would resolve to no tree at
   * all: the probe would fall back to a full scan and the staged entry would carry no
   * concurrency guard, until this instance re-initializes. A fresh Database over the subtracted
   * record synthesizes exactly what is built here.
   *
   * The new tree is rebuilt from the table NOW rather than backfilled on its first probe.
   * {@link ensureUniquePopulated} trusts a non-empty tree, and this tree may already exist in
   * storage: a constraint declared before its covering index was created had the tree from the
   * start, and every initialization since the index existed stopped maintaining it. This flush
   * is what makes it current for every process that opens it after the drop (a sibling still
   * enforcing through the dropped index writes past it until it re-initializes — see the NOTE in
   * {@link reconcileMaintainedIndexes}). Entries are keyed `indexKey ‖ primaryKey`, so re-staging
   * the rows the tree already holds is idempotent. A tree this instance was maintaining all
   * along (a constraint whose index was created in THIS session, so both were kept) is current
   * already and is left alone; a constraint derived from the dropped index itself is gone by now.
   *
   * Runs after the catalog write and the unregistration, so a throw here (the tree failing to
   * open, or the rebuild failing to land) leaves the drop reported failed with this instance no
   * longer maintaining the index, and the engine still listing it. Every step of the retried
   * `DROP INDEX` is idempotent, this one included: a tree is recorded on this instance only once
   * its rebuild landed, so the retry rebuilds exactly the trees the failed attempt did not.
   */
  private async reassignUniqueEnforcement(transactor?: ITransactor): Promise<void> {
    if (!this.indexManager || !this.schemaManager) return;
    const stored: StoredTableSchema = {
      ...this.schemaManager.tableSchemaToStored(this.tableSchema),
      indexes: this.indexManager.getDeclaredIndexes(),
    };
    const maintained = new Set(this.uniqueEnforcementIndexes.map(idx => idx.name));
    const added = this.buildUniqueEnforcementIndexes(stored).filter(idx => !maintained.has(idx.name));
    if (added.length === 0) return;

    await this.indexManager.setUniqueEnforcementIndexes([...this.uniqueEnforcementIndexes, ...added], transactor);
    for (const descriptor of added) {
      const tree = this.indexManager.getIndexTree(descriptor.name);
      if (!tree) {
        throw new Error(`Index tree not found: ${descriptor.name}`);
      }
      this.txnBridge.registerCollection(tree.getCollection());
      await this.populateUniqueTree(descriptor, tree);
      this.populatedUniqueTrees.add(descriptor.name);
      this.uniqueEnforcementIndexes = [...this.uniqueEnforcementIndexes, descriptor];
    }
    this.registerUniqueKeyTakenMessages();
  }

  /**
   * Persist a CHECK that `ALTER TABLE … ADD CONSTRAINT` added, and carry it on this instance's
   * own schema ({@link OptimysticModule.alterTable} builds `check` exactly as the engine
   * registers it).
   *
   * Both halves are needed. The catalog record is all a restarted machine hydrates, so without
   * the write it stops enforcing the CHECK. And this instance compares its own `tableSchema`
   * against the record whenever it (re-)initializes, rewriting the record from `tableSchema` on
   * a mismatch — so an instance that never learned of the CHECK would write it back out on its
   * next re-open (after a failed `APPLY SCHEMA` batch commit, say).
   *
   * Schema-only, like the engine's own CHECK arm and Quereus's memory tables: existing rows are
   * not validated against the new CHECK.
   */
  async addCheckConstraint(check: RowConstraintSchema): Promise<void> {
    // Initialized first so there is a record to extend: an instance whose record never landed
    // (see markSchemaUnpersisted) re-persists it here, through the storage-adoption guard.
    if (!this.isInitialized) {
      await this.initialize();
    }

    const txnState = this.txnBridge.getCurrentTransaction();
    // MUTATING path: read the catalog fresh, for the reason addIndex does.
    const storedSchema = await this.schemaManager.getSchemaFresh(this.schemaName, this.tableName, txnState?.transactor);
    if (!storedSchema) {
      throw new Error(`Schema not found for Optimystic table '${this.schemaName}.${this.tableName}'. Cannot add CHECK constraint.`);
    }
    await this.schemaManager.storeStoredSchema(
      this.schemaManager.withCheckConstraint(storedSchema, check),
      txnState?.transactor,
    );

    // Only once the write is staged, so a refused write leaves this instance as it was. Same
    // name rule as the record's (withCheckConstraint), so the two lists stay alike.
    const name = check.name?.toLowerCase();
    this.tableSchema = {
      ...this.tableSchema,
      checkConstraints: [
        ...this.tableSchema.checkConstraints.filter(existing => name === undefined || existing.name?.toLowerCase() !== name),
        check,
      ],
    };
  }

  /**
   * The CREATE INDEX half of the rule "storage must not outlive the catalog record
   * that describes it" (the table half: {@link guardStorageAdoption}). On the build
   * path, `openIndexTree` is create-on-missing, so a leftover tree at
   * `<uri>/index/<name>` — from a dropped table's index, or a URI-sharing table's —
   * would be adopted silently; adopted under a CONTRADICTING column list, such a
   * tree answers every seek empty, including for rows written after the adoption
   * (measured in test/drop-table-orphan-rows.spec.ts).
   *
   * The comparison is against the `orphanedIndexes` descriptions the table's own
   * record carries (stashed by guardStorageAdoption when the declaration adopted
   * described storage — a snapshot as of that declare, which is this guard's honest
   * limit: an index a URI-sharing LIVE table creates later is not in it). Refusal is
   * column-mismatch only, deliberately: a peer that built the same index over the
   * same columns produces a matching description and is adopted exactly as before,
   * so the multi-node re-attach and heal paths are untouched. A mismatched but
   * EMPTY leftover tree adopts harmlessly (the build's populate pass fills it), so
   * emptiness is probed before refusing — the index-tree analogue of the table
   * guard's empty-collection early-return.
   */
  private async guardIndexAdoption(
    indexSchema: IndexSchema,
    storedSchema: StoredTableSchema,
    transactor?: ITransactor
  ): Promise<void> {
    const orphan = (storedSchema.orphanedIndexes ?? []).find(idx => idx.name === indexSchema.name);
    if (!orphan) {
      return;
    }
    const declaredColumns = indexSchema.columns.map(
      col => this.tableSchema.columns[col.index]?.name ?? `#${col.index}`
    );
    const orphanColumns = orphan.columns.map(col => col.name);
    const sameColumns = declaredColumns.length === orphanColumns.length
      && declaredColumns.every((name, i) => name.toLowerCase() === orphanColumns[i]!.toLowerCase());
    if (sameColumns) {
      return;
    }
    const tree = await this.openIndexTree(indexSchema.name, transactor);
    if (tree.at(await tree.first()) === undefined) {
      return;
    }
    throw new Error(
      `Cannot create index '${indexSchema.name}' over '${this.options.collectionUri}/index/${indexSchema.name}': ` +
      `that collection still holds entries from a dropped index of the same name declared on ` +
      `(${orphanColumns.join(', ')}), not (${declaredColumns.join(', ')}). Use a different index name, ` +
      `or a different collection URI for the table.`
    );
  }

  /**
   * Stage an entry for EVERY committed row into each named index tree, then flush
   * only those trees. The single populate path: `addIndex` uses it to build a
   * brand-new index, and the already-persisted branch uses it to close the gap for
   * rows committed while this connection was detached from an index it has now
   * re-attached to.
   *
   * Inside an `APPLY SCHEMA` batch (`deferFlush` supplied) nothing is flushed here. A tree
   * that received entries is handed to the batch, which lands it at `endSchemaBatch` BEFORE
   * the catalog commit that lists its index — one commit for the whole apply rather than one
   * per index, and never a listed index whose entries are missing. A tree this instance
   * INVENTED that received nothing (the table has no rows) is neither flushed nor deferred:
   * it is left exactly as CREATE TABLE leaves an unwritten main tree (see the
   * create-on-missing NOTE in doInitialize). A later open of the never-committed collection
   * invents the same empty tree, and the first real write rides the next DML commit because
   * {@link reconcileMaintainedIndexes} has already registered it with the transaction bridge.
   *
   * Modelled on {@link ensureUniquePopulated}: stage into the target trees IN
   * ISOLATION and sync only those, never touching the caller's staged main-table
   * mutations. Idempotent by construction — entries are keyed `indexColumns‖primaryKey`,
   * so re-staging a row that already has an entry writes a byte-identical key and value.
   *
   * Two deliberate differences from the populate loop this replaced:
   *   - it stages per named index and syncs only those trees, rather than staging into
   *     every maintained index and flushing all of them;
   *   - it refreshes `this.collection` before scanning (the old loop did not), matching
   *     ensureUniquePopulated — but only once {@link hasNoRowsToBackfill} says there is
   *     something to scan, so the empty table pays neither the refresh nor the walk.
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
   * row) survives the re-attach. Queries are unaffected — {@link executeIndexScan} checks
   * every entry against the row it resolves to and skips the ones no row implies — but the
   * entry stays in the tree, where a unique-enforcement probe still counts it
   * (`bug-stale-index-entry-causes-false-unique-refusal`). `plugin.verifyIndexes` is how to
   * see it.
   *
   * NOTE: the walk stages one action per row per target index, holds them all pending
   * until the sync below, and re-stages EVERY row on every attach (an identical upsert
   * still rewrites the leaf). Fine while this is cold-path DDL on modest tables; if
   * building or re-attaching an index on a large table shows up as slow or
   * memory-hungry, batch the stage calls per chunk of rows and skip rows whose entry
   * the tree already carries.
   */
  private async backfillIndexTrees(indexNames: readonly string[], deferFlush?: DeferIndexFlush): Promise<void> {
    if (indexNames.length === 0) return;
    if (!this.collection || !this.rowCodec || !this.indexManager) return;
    const manager = this.indexManager;
    const collection = this.collection;
    const rowCodec = this.rowCodec;

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
      return { name, descriptor, tree };
    });

    // Decided ONCE per call, not per index: one scan serves every target, so the
    // question is only ever "is there anything to copy at all". Outside a batch the
    // flush below still runs when the scan is skipped — a freshly INVENTED tree holds
    // uncommitted header/root blocks even though no row staged anything into it.
    // `stagedAny` is per call for the same reason: every target receives every row.
    let stagedAny = false;
    if (!await this.hasNoRowsToBackfill()) {
      await collection.update();
      for await (const { row, primaryKey } of walkDecodedRows(collection, rowCodec)) {
        for (const { descriptor, tree } of targets) {
          const treeKey = indexEntryKey(manager.createIndexKey(descriptor, row), primaryKey);
          await tree.stage([[treeKey, [treeKey, primaryKey]]]);
        }
        stagedAny = true;
      }
    }

    if (deferFlush) {
      for (const { name, tree } of targets) {
        // Invented and given nothing: leave it unwritten, like an unwritten main tree (see
        // this method's doc). `committedRevision() === undefined` is the invented STATE,
        // which that accessor documents as safe to branch on for a freshly opened instance.
        if (!stagedAny && tree.committedRevision() === undefined) continue;
        if (!tree.hasUnsyncedChanges()) continue;
        deferFlush(name, tree);
      }
      return;
    }

    // Staging alone is not durable: addIndex runs outside the DML transaction's
    // commit, so flush the trees this call populated.
    await this.flushDirtyTrees(targets);
  }

  /**
   * Whether {@link backfillIndexTrees} provably has nothing to copy, checked WITHOUT the
   * cache-bypassing {@link Collection.update} the scan itself needs. Defaults to this
   * table's published collection; {@link guardStorageAdoption} passes its own, because it
   * runs mid-initialization before the pass publishes what it rebuilt. Attaching an index
   * to a table with no rows is the common cold-start shape (`CREATE TABLE` then
   * `CREATE INDEX`, both on an empty table), and the scan that follows is pure cost
   * there: it reads a whole log chain to copy zero rows.
   *
   * Read through the LIVE tree, so "no rows" covers both this connection's committed
   * rows and anything it has staged in an open transaction — a `CREATE INDEX` issued
   * mid-transaction still populates from the uncommitted inserts above it. Emptiness is
   * "the first path is not ON an entry": isValid() only reports whether a path survived a
   * concurrent mutation, so at()===undefined is the on-entry signal (an empty tree's
   * first() is version-valid but sits on no entry) — the same idiom as
   * {@link ensureUniquePopulated}.
   *
   * SOUNDNESS. The bar is the bug backfill exists to fix: rows THIS connection committed
   * while detached from a now-attached index must end up indexed. Those rows are by
   * construction in this collection's own view (its own commits advanced its context and
   * folded into its cache), so an empty live view proves this connection wrote none —
   * and the CREATE INDEX build path over a populated table reads non-empty and takes the
   * full scan unchanged.
   *
   * What the skip gives up against the pre-existing `update()`-first order is narrower:
   * rows a SIBLING connection committed since this one last pulled, where that sibling
   * was not itself maintaining the index. That widening was incidental, and it was never
   * general — see the note on {@link reconcileMaintainedIndexes}: a connection that opens
   * cold and finds the index already in the persisted schema attaches nothing and never
   * scans, so a divergent writer's orphans already survive every open that does not
   * re-declare. Healing those needs the explicit repair entry point named there, not a
   * refresh on this path.
   */
  private async hasNoRowsToBackfill(collection = this.collection): Promise<boolean> {
    if (!collection) return true;
    return collection.at(await collection.first()) === undefined;
  }

  /**
   * Compare every secondary index this table maintains against the table's rows, in both
   * directions: one {@link IndexIntegrityReport} per index, declared and unique-enforcement
   * alike ({@link compareIndexToRows} defines missing and orphaned). Hosts reach it through
   * `plugin.verifyIndexes`, via {@link OptimysticModule.verifyIndexes}, which resolves and
   * initializes the table first.
   *
   * Reads the LIVE trees: `update()` on the main collection and every index tree, then a full
   * walk of each. That is the view a live index seek descends (the live query arm refreshes
   * both trees immediately before scanning too). It is deliberately not a snapshot-pinned
   * committed read: the question is what THIS node's own seek sees, and a separately opened
   * tree could adopt a different lineage of the same collection id than the instance this
   * table holds (one collection id with two lineages is recorded in the blocked ticket
   * `secondary-index-repro-exhausted-upstream`). Inside an open transaction the live trees
   * include this connection's staged writes; a row and its index entries are staged together,
   * so a consistent table stays consistent mid-transaction.
   *
   * A unique-enforcement tree that has not yet been populated for rows an older build wrote
   * ({@link ensureUniquePopulated} runs at the first probe) reports those rows missing, which
   * is what the tree holds.
   *
   * Detection only: nothing is repaired. Healing an orphan needs the explicit repair entry
   * point the notes on {@link reconcileMaintainedIndexes} and {@link hasNoRowsToBackfill}
   * anticipate.
   */
  async verifyIndexes(): Promise<IndexIntegrityReport[]> {
    if (!this.collection || !this.rowCodec || !this.indexManager) {
      throw new Error('Table not initialized');
    }
    const manager = this.indexManager;
    const declared = new Set(manager.getDeclaredIndexes().map(index => index.name));
    const targets = manager.getAllMaintainedIndexes().map(index => {
      const tree = manager.getIndexTree(index.name);
      if (!tree) {
        throw new Error(`Index tree not found: ${index.name}`);
      }
      return { index, tree };
    });

    await this.collection.update();
    for (const { tree } of targets) {
      await tree.update();
    }

    const rows = new Map<string, Row>();
    for await (const { row, primaryKey } of walkDecodedRows(this.collection, this.rowCodec)) {
      rows.set(primaryKey, row);
    }

    const reports: IndexIntegrityReport[] = [];
    for (const { index, tree } of targets) {
      const entries: IndexEntry[] = [];
      for await (const entry of manager.allEntriesIn(tree)) {
        entries.push(entry);
      }
      reports.push(compareIndexToRows({
        table: this.tableName,
        index,
        kind: declared.has(index.name) ? 'declared' : 'unique-enforcement',
        rows,
        entries,
        indexKeyOf: row => manager.createIndexKey(index, row),
      }));
    }
    return reports;
  }

  /**
   * Flush the trees that actually have something to push, skipping the ones that do not.
   *
   * `Tree.sync()` is `updateAndSync()`, so syncing a tree with an empty change set is not
   * free: the update half is a deliberately cache-bypassing log walk, paid in full before
   * the commit half discovers it has nothing to do. Skipping it is provably behaviour-
   * preserving — `hasUnsyncedChanges()` is the very predicate the commit loop iterates on.
   *
   * A newly built index tree that received no entries (CREATE INDEX on an empty table) is
   * still flushed when it was INVENTED, since its header/root blocks sit uncommitted in
   * the tracker and count as unsynced.
   *
   * NOTE: that flush is one commit per direct `CREATE INDEX` on an empty table, and it is
   * avoidable. The skip the `APPLY SCHEMA` batch takes ({@link backfillIndexTrees}) would be
   * just as sound here: the never-committed tree is re-invented empty on every open and its
   * first write rides the next DML commit. It was not taken, so that direct DDL outside
   * `apply schema` stays byte-identical to its behaviour before the batch work; take it if
   * direct CREATE INDEX on empty tables ever shows up as a cost.
   */
  private async flushDirtyTrees(
    targets: readonly { tree: Tree<string, IndexEntry> }[],
  ): Promise<void> {
    for (const { tree } of targets) {
      if (!tree.hasUnsyncedChanges()) continue;
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
   *
   * Emits ONE `index:tree-open` line per open, naming the table, the index as THIS
   * vtab knows it, the derived URI, and the collection id it resolved to — the URI's
   * scheme is stripped to form the id, so the two differ and an operator joining this
   * against the bridge's `commit:collections` line (which prints ids) needs both. A
   * trailing `node=` says WHICH node resolved it ({@link CollectionFactory.nodeTag}) —
   * without it, two nodes resolving one logical index emit the same line and the
   * "did both machines mean the same collection?" question cannot be answered from a
   * merged log. How the pair is read: `docs/debugging.md` (§ "Which collections did a
   * write carry?"). Bring-up-time, not per write — callers hold the opened tree — and all
   * five arguments already exist, so a disabled namespace builds nothing worth guarding.
   */
  private async openIndexTree(indexName: string, transactor?: ITransactor): Promise<Tree<string, IndexEntry>> {
    const indexUri = `${this.options.collectionUri}/index/${indexName}`;
    const indexOptions: ParsedOptimysticOptions = {
      ...this.options,
      collectionUri: indexUri,
    };
    const tree = await this.collectionFactory.createOrGetCollection(
      indexOptions,
      transactor ? { transactor, isActive: true, collections: new Map(), stampId: '' } : undefined
    );
    log(
      'index:tree-open table=%s index=%s uri=%s collection=%s node=%s',
      this.tableName,
      indexName,
      indexUri,
      String(tree.getCollection().id),
      this.collectionFactory.nodeTag()
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
    // rather than widen it. The only write that shrinks a persisted list is DROP INDEX
    // (SchemaManager.removeIndex), and a drop through THIS instance unregisters the index
    // from the manager first, so the two agree. A drop by a SIBLING process narrows the
    // record while this manager keeps maintaining the tree until this instance
    // re-initializes: harmless (entries written into a tree nothing lists) unless the
    // dropped index was enforcing a UNIQUE constraint, whose synthesized tree (see
    // reassignUniqueEnforcement) then misses the rows this instance writes meanwhile — the
    // same stale-sibling shape as an index a sibling CREATED (producer three of
    // bug-stale-index-entry-causes-false-unique-refusal). The reads still fail loudly
    // (assertIndexMaintained) if it ever lands here narrower — switch this to a name-keyed
    // union of the two lists then.
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
      const wrapped = rewrapAsQueryError('Begin transaction failed', error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
    }
  }

  /**
   * Commit the virtual table transaction
   */
  async commit(): Promise<void> {
    try {
      await this.txnBridge.commitTransaction();
    } catch (error) {
      const wrapped = rewrapAsQueryError('Commit transaction failed', error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
    }
  }

  /**
   * Rollback the virtual table transaction
   */
  async rollback(): Promise<void> {
    try {
      await this.txnBridge.rollbackTransaction();
    } catch (error) {
      const wrapped = rewrapAsQueryError('Rollback transaction failed', error);
      this.setErrorMessage(wrapped.message);
      throw wrapped;
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
  async deleteOwnSchema(): Promise<void> {
    const txnState = this.txnBridge.getCurrentTransaction();
    await this.schemaManager.deleteSchema(this.schemaName, this.tableName, txnState?.transactor);
  }

  /**
   * The plugin's catalog manager this table's schema reads and writes go through (NOT
   * Quereus's `db.schemaManager`). Exposed so the module can checkpoint the open
   * `APPLY SCHEMA` batch around each DDL statement that touches this table.
   */
  get catalogManager(): SchemaManager {
    return this.schemaManager;
  }

  /**
   * Forget that this table's schema is persisted. Called by the module when the end-of-batch
   * catalog commit of an `APPLY SCHEMA` failed after this table was created or gained an
   * index inside it: the table is in Quereus's catalog and cached here as initialized, but
   * has no persisted record. The next touch re-runs {@link doInitialize}, whose
   * declared-columns arm finds no persisted record and writes the schema — retrying the
   * commit that failed, with the same storage-adoption guard in front of it. Nothing was
   * cached in the SchemaManager for this table (a batch seeds its cache only after its
   * commit lands), so no stale hit can mask the gap.
   *
   * The index list is refreshed from what the IndexManager maintains first: `tableSchema`
   * is the object CREATE TABLE handed over, and Quereus's CREATE INDEX REPLACES the engine's
   * TableSchema (`appendIndexToTableSchema` returns a new object) rather than mutating this
   * one — so without the refresh the re-persist would drop every index added since.
   *
   * `withheldIndexes` names indexes whose tree the batch deferred and then failed to land.
   * They are left out of the refresh, along with any UNIQUE constraint derived from them
   * (in memory only — derived constraints are never persisted): re-persisting such an index
   * would list it in the catalog over a tree missing its entries, which is exactly the
   * silently-incomplete read the batch's tree-before-catalog order exists to prevent. The
   * re-initialized table then does not maintain it, so a read the planner routes through it
   * in THIS process refuses loudly (assertIndexMaintained) until the index is dropped and
   * re-created (DROP INDEX, then CREATE INDEX — the engine still lists it, so a re-apply plans
   * nothing and a bare CREATE INDEX is refused as a duplicate). A fresh Database's
   * `apply schema` rebuilds it too.
   */
  markSchemaUnpersisted(withheldIndexes: ReadonlySet<string> = new Set()): void {
    if (this.indexManager) {
      const kept = this.indexManager.getDeclaredIndexes().filter(idx => !withheldIndexes.has(idx.name));
      this.tableSchema = {
        ...this.tableSchema,
        indexes: this.schemaManager.storedIndexesToIndexSchemas(kept),
      };
      if (withheldIndexes.size > 0 && this.tableSchema.uniqueConstraints) {
        this.tableSchema = {
          ...this.tableSchema,
          uniqueConstraints: this.tableSchema.uniqueConstraints.filter(
            uc => uc.derivedFromIndex === undefined || !withheldIndexes.has(uc.derivedFromIndex),
          ),
        };
      }
    }
    this.isInitialized = false;
    this.isProvisionallyInitialized = false;
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
   *   - a live scan's `collection.update()` serializes behind the collection
   *     INSTANCE's latch (the latch key is scoped per `Collection` instance, not per
   *     collection id). Inside a transaction every scan on a table shares the one
   *     instance cached on the TransactionState, so that latch serializes them — and
   *     `TransactionCoordinator.commitOnce`/`execute` hold the same latch for the whole
   *     commit span, so a refresh cannot interleave with a mid-flight commit either.
   *     Outside a transaction `OptimysticCollectionFactory` caches nothing, so each scan
   *     resolves its OWN instance with its own tracker and source and there is no shared
   *     collection state left to serialize (the read cache beneath the instances is
   *     separately synchronized). Mid-scan tree mutation is tolerated regardless, via
   *     path-invalidation retry (replicated external commits impose the same interleaving
   *     with or without concurrent reads);
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
  /**
   * The open `APPLY SCHEMA` catalog batch, between {@link beginSchemaBatch} and
   * {@link endSchemaBatch}. `managers` are the SchemaManagers whose catalog writes are being
   * held (every one that existed at begin, plus any created since); `written` records, per
   * manager, the tables that created or altered their persisted schema inside the batch —
   * the ones an end-commit failure on THAT manager leaves unpersisted; `dropped` the tables
   * whose DROP staged a gravestone — nothing can re-persist those, so the failure log names
   * them; `deferred` the populated index trees of each manager's tables whose flush was
   * handed to the end of the batch (keyed by tree, so a tree is flushed once however often
   * it was deferred), with the table and index each belongs to.
   */
  private schemaBatch?: {
    managers: Set<SchemaManager>;
    written: Map<SchemaManager, Set<string>>;
    dropped: Map<SchemaManager, Set<string>>;
    deferred: Map<SchemaManager, Map<Tree<string, IndexEntry>, { tableKey: string; indexName: string }>>;
  };

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
    // A manager created mid-apply joins the open batch: its tables' catalog writes must
    // coalesce like every other's, and its commit runs from endSchemaBatch.
    if (this.schemaBatch) {
      manager.beginBatch();
      this.schemaBatch.managers.add(manager);
    }
    return manager;
  }

  /**
   * `APPLY SCHEMA` is starting its migration-DDL loop (Quereus fires this only when the loop
   * is non-empty, inside its execution lock). Open a catalog batch on every SchemaManager:
   * from here to {@link endSchemaBatch} their catalog writes collect in memory and their
   * catalog reads are served from that overlay plus one catalog tree opened once, instead of
   * one commit and a growing re-read per DDL statement (see `CatalogBatch`). No I/O here.
   *
   * `schemaName` is ignored: the optimystic catalog (`tree://optimystic/schema`) is ONE
   * tree for every engine schema — each record inside it is keyed by its table's schema and
   * name (`catalogKey`) — so the batch covers the whole catalog whichever schema is being
   * applied, and needs no per-schema scoping of its own. Batches never nest — the engine's lock
   * makes an overlapping apply impossible, so a second begin is a wiring bug and throws.
   */
  async beginSchemaBatch(_db: Database, _schemaName: string): Promise<void> {
    if (this.schemaBatch) {
      throw new Error('Optimystic schema batch already open: beginSchemaBatch without a matching endSchemaBatch');
    }
    const managers = new Set<SchemaManager>();
    for (const manager of this.schemaManagers.values()) {
      manager.beginBatch();
      managers.add(manager);
    }
    this.schemaBatch = { managers, written: new Map(), dropped: new Map(), deferred: new Map() };
  }

  /**
   * The migration loop is over. For each joined SchemaManager in turn: land the populated index
   * trees its tables deferred ({@link OptimysticVirtualTable.addIndex}'s `deferFlush`), then
   * commit its catalog batch — ONE catalog commit per manager, zero I/O for a manager nothing
   * wrote through. Then close the batch. A cold apply over empty tables defers no tree at all
   * (an invented, empty index tree is left unwritten), so it costs exactly one commit.
   *
   * NOTE: commits on ERROR too, deliberately deviating from the upstream hook doc ("on error,
   * the module should discard the in-flight overlay"). The batch is a write-coalescing buffer,
   * not a transaction: the per-statement checkpoint in {@link underBatchCheckpoint} already
   * withdrew the failed statement's own catalog changes, and whatever the overlay holds when
   * this fires is what the engine's catalog holds too, so committing it is what keeps the two
   * describing the same tables. Since Quereus 4.20 an apply that fails part-way is normally
   * UNWOUND by the engine before this fires: each landed step's undo DDL (`DROP TABLE` for a
   * `CREATE TABLE`, `DROP INDEX IF EXISTS` for a `CREATE INDEX`) runs through this module's
   * ordinary hooks, inside the batch, so the overlay then holds the pre-apply state — a create
   * followed by its own gravestone, an index subtracted again — and committing it lands that
   * restored state (one commit; the create-then-gravestone pair is not elided). The exception is
   * a step the differ marks irreversible (`DROP TABLE`, which discards rows): it poisons the undo
   * journal before it runs, nothing is unwound, the apply reports the schema as partially
   * migrated, and the engine keeps the steps that landed — exactly the case the review NOTE on
   * `endSchemaBatch` in `@quereus/quereus/src/vtab/module.ts` warns about, for a module that
   * DISCARDS its overlay and so rewinds a substrate the catalog still describes as migrated.
   * Committing puts this module on the right side of that note by construction: partial or
   * restored, the overlay and the engine's catalog agree. Discarding would instead leave a
   * table the engine still lists (partial case), or one it has dropped (restored case, where the
   * gravestone is discarded with the create), in the engine's catalog and cached here as an
   * initialized instance with no matching record, so the next process hydrates something else.
   *
   * If one of a manager's deferred index trees fails to land, that manager's catalog is NOT
   * committed (see the ordering NOTE in the body) and its batch is discarded; if its catalog
   * commit itself fails, likewise nothing of it lands. Either way every table that created or
   * altered its schema through that manager is marked unpersisted
   * ({@link OptimysticVirtualTable.markSchemaUnpersisted}) so its next touch re-persists it —
   * WITHOUT any index whose tree did not land, since listing that index is the very failure the
   * ordering prevents. The remaining managers still land and commit, and the first failure is
   * rethrown — the engine rethrows it when there was no loop error and logs and swallows it when
   * there was. A table DROPPED inside the batch has no instance left to re-persist anything: its
   * gravestone is lost with the commit, the catalog keeps its live record past the DROP (the next
   * hydrate resurrects it, and a later CREATE over the same URI is not checked against it — the
   * same failure direction as the unbatched, best-effort {@link destroy}), so the log names those
   * tables too.
   */
  async endSchemaBatch(_db: Database, _schemaName: string, _error?: unknown): Promise<void> {
    const batch = this.schemaBatch;
    if (!batch) {
      throw new Error('Optimystic schema batch is not open: endSchemaBatch without a matching beginSchemaBatch');
    }
    this.schemaBatch = undefined;
    let failed = false;
    let firstFailure: unknown;
    for (const manager of batch.managers) {
      // The deferred trees of this manager's tables that have not landed yet: each is removed as
      // it lands, so whatever remains when something throws is what the recovery must withhold.
      const unlanded = new Map(batch.deferred.get(manager));
      let step = 'index-tree flush';
      try {
        // NOTE: the index trees land BEFORE the catalog commit that lists their indexes, and a
        // tree that fails to land cancels that commit. The order is the point. Trees first, a
        // tree failing: no catalog record lists the index, and whatever the tree did receive is
        // harmless — a later CREATE INDEX of the same name adopts it and re-stages every row
        // idempotently (entries are keyed indexColumns‖primaryKey). Catalog first — the
        // unbatched order — a tree failing: the planner routes seeks through a listed index
        // whose entries are missing, and gets silently wrong results. Neither order is one
        // atomic commit (`feat-cross-collection-atomic-commit`, backlog).
        // NOTE: a tree whose table was DROPPED later in the same apply still lands here, as an
        // unlisted orphan (destroy never deletes index trees). If a migration ever plans CREATE
        // INDEX then DROP TABLE on one table and that sync throws, it cancels this manager's whole
        // catalog commit, gravestone included; then have destroy remove the table's `deferred`
        // entries the way dropIndex already removes a dropped index's.
        for (const tree of [...unlanded.keys()]) {
          if (tree.hasUnsyncedChanges()) {
            await tree.sync();
          }
          unlanded.delete(tree);
        }
        step = 'catalog commit';
        await manager.commitBatch();
      } catch (error) {
        // Closes the batch when a tree flush threw before commitBatch ran; a no-op otherwise.
        manager.discardBatch();
        const withheld = new Map<string, Set<string>>();
        for (const { tableKey, indexName } of unlanded.values()) {
          withheld.set(tableKey, (withheld.get(tableKey) ?? new Set<string>()).add(indexName));
        }
        const unpersisted = [...(batch.written.get(manager) ?? [])];
        const dropped = [...(batch.dropped.get(manager) ?? [])];
        for (const tableKey of unpersisted) {
          this.tables.get(tableKey)?.markSchemaUnpersisted(withheld.get(tableKey));
        }
        log(
          'endSchemaBatch: %s failed: %s. The catalog batch was not committed. %d table(s) will re-persist ' +
          'their schema on next touch (%s), without the %d index(es) whose tree did not land (%s); %d dropped ' +
          'table(s) keep a live catalog record past their DROP — the next hydrate resurrects them and a later ' +
          'CREATE over the same URI is not checked against them (%s)',
          step, error, unpersisted.length, unpersisted.join(', '), unlanded.size,
          [...unlanded.values()].map(({ tableKey, indexName }) => `${tableKey}.${indexName}`).join(', '),
          dropped.length, dropped.join(', ')
        );
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      }
    }
    if (failed) {
      throw firstFailure;
    }
  }

  /**
   * Run one DDL statement's work for `table` under the open schema batch's per-statement
   * checkpoint: a throw withdraws every catalog write the statement staged — and only those
   * — so a refused CREATE (the storage-adoption guard, or a failure later in doInitialize
   * after the schema already reached the overlay) leaves no record for the end-of-batch
   * commit to persist. On success `tableKey` is recorded under `effect` for the table's
   * manager (the `written` / `dropped` fields of `schemaBatch`). Outside a batch this is a
   * plain call.
   */
  private async underBatchCheckpoint<T>(
    table: OptimysticVirtualTable,
    effect: 'written' | 'dropped',
    tableKey: string,
    work: () => Promise<T>
  ): Promise<T> {
    const batch = this.schemaBatch;
    if (!batch) {
      return work();
    }
    const manager = table.catalogManager;
    const checkpoint = manager.checkpointBatch();
    try {
      const result = await work();
      const affected = batch[effect].get(manager) ?? new Set<string>();
      affected.add(tableKey);
      batch[effect].set(manager, affected);
      return result;
    } catch (error) {
      if (checkpoint) {
        manager.restoreBatch(checkpoint);
      }
      throw error;
    }
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

    // Extract collection URI from first positional argument or use the default location,
    // which includes the engine schema so same-named tables in two schemas never share storage.
    const collectionUri = (args['0'] as string) || defaultCollectionUri(tableSchema.schemaName, tableSchema.name);

    return {
      collectionUri,
      ...resolveBinding(args, aux),
      cache: args['cache'] !== false,
      encoding: (args['encoding'] as 'json' | 'msgpack') || 'json',
    };
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
      // Initialization is the CALLER's job (create/resolveConnectedTable/createIndex do it,
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
    try {
      await this.underBatchCheckpoint(table, 'written', tableKey, async () => {
        await table.initialize();
        await table.ensureConnectionRegistered();
      });
    } catch (error) {
      // A refused CREATE must leave no cached instance behind. The storage-adoption
      // guard's message tells the user to re-declare (different columns, or a
      // different URI) — that retry arrives as another create() for the same key,
      // which the has-check above would reject as "already exists" if the failed
      // instance stayed cached. Nothing was registered with Quereus yet.
      this.tables.delete(tableKey);
      table.teardownChangeSubscription();
      throw error;
    }

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
   * Compare every secondary index of `schemaName.tableName` against the table's rows, in both
   * directions; see {@link OptimysticVirtualTable.verifyIndexes} for what is read and what is
   * reported. Resolves the table the way {@link connect} does, so a table hydrated into the
   * catalog that no statement has touched yet is initialized first. Throws for a table neither
   * this module's cache nor the engine's catalog knows, and for a catalog table another module
   * owns (resolving that one would build an Optimystic instance over somebody else's table).
   */
  async verifyIndexes(db: Database, tableName: string, schemaName = 'main'): Promise<IndexIntegrityReport[]> {
    const catalogEntry = db.schemaManager.findTable(tableName, schemaName);
    if (catalogEntry) {
      const owner = catalogEntry.vtabModule ?? db.schemaManager.getModule(catalogEntry.vtabModuleName)?.module;
      if (owner !== this) {
        throw new Error(
          `Cannot verify indexes of '${schemaName}.${tableName}': it is not an Optimystic table ` +
          `(module '${catalogEntry.vtabModuleName}').`,
        );
      }
    }
    const table = await this.resolveConnectedTable(db, schemaName, tableName, false);
    return await table.verifyIndexes();
  }

  /**
   * Resolve (and initialize) the cached {@link OptimysticVirtualTable} for a
   * schema.table, instantiating it from the supplied/looked-up schema on first
   * connect. Shared by {@link connect} for both the live and committed-read paths.
   * The committed path (`committed: true`) initializes through
   * {@link OptimysticVirtualTable.initializeForCommittedRead} (which refuses to
   * join an in-flight writer transaction) and never registers a connection.
   *
   * NOTE: a connect is not run under the open `APPLY SCHEMA` batch's per-statement
   * checkpoint ({@link underBatchCheckpoint} wraps create, createIndex, alterTable's CHECK arm
   * and destroy — and the first-touch initialize of createIndex and that arm runs inside it —
   * but not plain connects). A first touch of a hydrated table mid-apply whose persisted record
   * differs from the hydrated shape re-persists it from here, and that write stays in the
   * overlay if the statement then throws. One statement does reach this today: an ADD COLUMN
   * of a NOT NULL column with no default makes Quereus read a row before alterTable refuses
   * the arm. Fine while that stays rare — before the batch that write was committed before the
   * throw anyway. If a mid-apply statement that commonly fails after its connect appears, wrap
   * it too.
   */
  private async resolveConnectedTable(
    db: Database,
    schemaName: string,
    tableName: string,
    committed: boolean,
    tableSchema?: TableSchema
  ): Promise<OptimysticVirtualTable> {
    const resolved = await this.lookupOrInstantiate(db, schemaName, tableName, tableSchema);
    if (!resolved) {
      throw new Error(`Optimystic table definition for '${tableName}' not found. Cannot connect.`);
    }

    const { table, fresh } = resolved;
    if (committed) {
      await table.initializeForCommittedRead();
    } else {
      await table.initialize();
      if (fresh) {
        await table.ensureConnectionRegistered();
      }
    }

    return table;
  }

  /**
   * The cached {@link OptimysticVirtualTable} for schema.table or, on this process's first
   * touch of it (a table hydrated into Quereus's catalog that no statement has used yet), a
   * new UNINITIALIZED instance built from `tableSchema` or else the engine's catalog entry.
   * `fresh` says which. Initializing — and through which entry point — is the caller's job
   * ({@link resolveConnectedTable}, {@link createIndex}). Undefined when neither the cache
   * nor the engine's catalog knows the table. {@link destroy} deliberately does not use
   * this: see {@link instantiateForTeardown}.
   */
  private async lookupOrInstantiate(
    db: Database,
    schemaName: string,
    tableName: string,
    tableSchema?: TableSchema
  ): Promise<{ table: OptimysticVirtualTable; fresh: boolean } | undefined> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const cached = this.tables.get(tableKey);
    if (cached) {
      return { table: cached, fresh: false };
    }

    const resolvedSchema = tableSchema ?? db.schemaManager.findTable(tableName, schemaName);
    if (!resolvedSchema) {
      return undefined;
    }
    return { table: await this.instantiateTable(db, resolvedSchema), fresh: true };
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
    // How THIS session reaches storage. The record carries no binding (see
    // `identityVtabArgs`), so a hydrated table gets the session's, the way a `create table`
    // without a `using` clause would — and the catalog is opened through the same one.
    const sessionVtabArgs = this.sessionDefaultVtabArgs(db);
    const options = this.deriveDefaultOptions(config, sessionVtabArgs);
    const schemaManager = this.createSchemaManager(options);

    let tableNames: QualifiedTableName[];
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

    let tables = 0;
    let indexes = 0;
    for (const { schemaName, tableName } of tableNames) {
      // Each table goes back into the engine schema it was declared in — never the host's
      // current schema. Its schema is part of its storage location (`defaultCollectionUri`)
      // and of its catalog key, so re-stamping it elsewhere would open a different, empty
      // collection and file its next write under a different record. A schema that holds no
      // tables yet in this process is created, as a later `apply schema` of it would.
      const targetSchema = db.schemaManager.getSchema(schemaName);
      if (targetSchema?.getTable(tableName)) continue;

      const stored = await schemaManager.getSchema(schemaName, tableName);
      if (!stored) continue;

      const hydratedSchema = schemaManager.storedToTableSchema(stored, this, auxData, sessionVtabArgs);
      (targetSchema ?? db.schemaManager.addSchema(schemaName)).addTable(hydratedSchema);
      tables++;
      indexes += hydratedSchema.indexes?.length ?? 0;
    }

    return { tables, indexes };
  }

  /**
   * The session's `default_vtab_args` when THIS module is the session's default module —
   * the arguments a `create table` without a `using` clause would run with — else nothing.
   * A different default module's arguments say nothing about how optimystic tables bind.
   */
  private sessionDefaultVtabArgs(db: Database): Readonly<Record<string, SqlValue>> {
    const { name, args } = db.schemaManager.getDefaultVTabModule();
    return db.schemaManager.getModule(name)?.module === this ? args : {};
  }

  /**
   * The options the plugin-global schema catalog is opened with: the same binding
   * resolution a table goes through ({@link resolveBinding}) over the session's default
   * args and the plugin's registration config, so hydrateCatalog reaches the catalog
   * through the transactor and network the tables themselves will use.
   */
  private deriveDefaultOptions(
    config: Record<string, SqlValue>,
    sessionVtabArgs: Readonly<Record<string, SqlValue>> = {},
  ): ParsedOptimysticOptions {
    return {
      collectionUri: 'tree://optimystic/schema',
      ...resolveBinding(sessionVtabArgs, config as Record<string, unknown>),
      cache: true,
      encoding: 'json',
    };
  }

  /**
   * Creates an index on an Optimystic virtual table.
   *
   * The table need not have been touched yet: after `hydrate()` the engine's catalog lists
   * every persisted table but no instance exists until a statement uses one, and an
   * `apply schema` that only adds an index plans a lone CREATE INDEX. So an uncached table is
   * instantiated from the engine's catalog entry exactly as {@link connect} would. That entry
   * is still the PRE-index shape here — Quereus calls this hook before it appends the new
   * index to the table schema — so the first-touch initialize cannot persist the index before
   * its tree is built. The initialize runs inside the statement's batch checkpoint, so a
   * record it re-persists is withdrawn with the rest of the statement if the statement throws.
   */
  async createIndex(
    db: Database,
    schemaName: string,
    tableName: string,
    indexSchema: IndexSchema
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const resolved = await this.lookupOrInstantiate(db, schemaName, tableName);

    if (!resolved) {
      throw new Error(`Optimystic table '${tableName}' not found in schema '${schemaName}'. Cannot create index.`);
    }
    const { table, fresh } = resolved;

    // Inside an `APPLY SCHEMA` batch the index trees this statement populates land at
    // endSchemaBatch, before the catalog commit that lists them, instead of one commit here.
    // NOTE: the per-statement checkpoint below does NOT withdraw a tree deferred here when a
    // later part of this statement throws — it still lands at the end, unlisted (harmless:
    // adopted and re-staged by a later CREATE INDEX of the same name). That is today's
    // semantics kept, not a new gap: unbatched, the tree had already flushed by then. A tree
    // deferred by a statement that SUCCEEDED and is then unwound by the engine's undo journal
    // (a later step failed) is withdrawn by the unwind's DROP INDEX — see dropIndex.
    const batch = this.schemaBatch;
    const deferFlush: DeferIndexFlush | undefined = batch
      ? (indexName, tree) => {
          const manager = table.catalogManager;
          const trees = batch.deferred.get(manager) ?? new Map();
          batch.deferred.set(manager, trees.set(tree, { tableKey, indexName }));
        }
      : undefined;

    // Update the stored schema with the new index. A first touch initializes and registers
    // its connection the way connect's live path does (addIndex would initialize on its own,
    // but not register); if that initialize throws, the instance stays cached uninitialized
    // and the next touch retries, exactly as after a failed connect.
    await this.underBatchCheckpoint(table, 'written', tableKey, async () => {
      if (fresh) {
        await table.initialize();
        await table.ensureConnectionRegistered();
      }
      await table.addIndex(indexSchema, deferFlush);
    });
  }

  /**
   * `DROP INDEX` on an Optimystic table, shaped like {@link createIndex}: the table is resolved
   * the same way (a hydrated table no statement has touched yet is instantiated, and initialized
   * and registered inside the statement's batch checkpoint), and the catalog write
   * ({@link OptimysticVirtualTable.removeIndex}) runs under that checkpoint, so an open
   * `APPLY SCHEMA` batch coalesces it and a throw withdraws it. Quereus passes the index's stored
   * casing (`storedIndexName` in `@quereus/quereus/src/schema/manager.ts`) and removes the index
   * from its own catalog only after this returns.
   *
   * Inside a batch the drop also withdraws the index's tree from the batch's deferred flush.
   * Quereus 4.20 reaches this hook from its own undo journal: when a later step of an
   * `apply schema` fails, each landed `CREATE INDEX` is unwound as `DROP INDEX IF EXISTS` before
   * `endSchemaBatch` fires, and without the withdrawal the tree that `CREATE INDEX` deferred would
   * still land at the end — unlisted, and at the cost of a commit. Withdrawn only once the drop
   * succeeded: a refused drop leaves the index, tree flush included, exactly as it was.
   */
  async dropIndex(
    db: Database,
    schemaName: string,
    tableName: string,
    indexName: string
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const resolved = await this.lookupOrInstantiate(db, schemaName, tableName);

    if (!resolved) {
      throw new Error(`Optimystic table '${tableName}' not found in schema '${schemaName}'. Cannot drop index.`);
    }
    const { table, fresh } = resolved;

    await this.underBatchCheckpoint(table, 'written', tableKey, async () => {
      if (fresh) {
        await table.initialize();
        await table.ensureConnectionRegistered();
      }
      await table.removeIndex(indexName);
    });

    const deferred = this.schemaBatch?.deferred.get(table.catalogManager);
    if (deferred) {
      const lower = indexName.toLowerCase();
      for (const [tree, entry] of deferred) {
        if (entry.tableKey === tableKey && entry.indexName.toLowerCase() === lower) {
          deferred.delete(tree);
        }
      }
    }
  }

  /**
   * ALTER TABLE on an Optimystic table. The hook exists for ONE arm: a CHECK added by
   * `ADD CONSTRAINT` — what `apply schema` emits when a later schema version declares a new
   * named table-level CHECK — which must reach the table's catalog record
   * ({@link OptimysticVirtualTable.addCheckConstraint}). Without the hook Quereus keeps such a
   * CHECK in its in-memory catalog only, and a restarted machine that only hydrates stops
   * enforcing it.
   *
   * Having the hook takes every other arm off Quereus's path for modules without one, so each
   * answers here as it did there: RENAME COLUMN renames schema-only
   * ({@link renameColumnSchemaOnly}); the rest are refused as UNSUPPORTED in Quereus's own
   * words. ALTER PRIMARY KEY's final refusal is still Quereus's: it takes UNSUPPORTED from here
   * as "fall back to a rebuild", which it then refuses because this module has no `renameTable`.
   *
   * NOTE: what does change is precedence. Quereus runs an arm's pre-dispatch checks only for a
   * module that has the hook, and those now come before these refusals — ADD COLUMN of a
   * NOT NULL column with no default over a table with rows reports the missing default (after
   * reading one row), a malformed ADD UNIQUE / FOREIGN KEY reports what is malformed. Both are
   * still refused and change nothing; only the message differs.
   *
   * NOTE: Quereus's materialized-view reshape paths also call this hook, but only for a module
   * with `getBackingHost`, which this one lacks. If it ever gains it, those reshapes get these
   * refusals mid-sequence and the unsaved RENAME COLUMN — revisit the arms then.
   *
   * Returns the engine's catalog entry with the change applied, built as the engine's own
   * fallbacks built it. Emits no schema-change event: this module has no emitter, so Quereus
   * announces the statement itself.
   */
  async alterTable(
    db: Database,
    schemaName: string,
    tableName: string,
    change: SchemaChangeInfo
  ): Promise<TableSchema> {
    const tableSchema = db.schemaManager.findTable(tableName, schemaName);
    if (!tableSchema) {
      throw new QuereusError(`Optimystic table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`, StatusCode.ERROR);
    }
    const refuse = (operation: string): never => {
      throw new QuereusError(`Module for table '${tableSchema.name}' does not support ${operation}`, StatusCode.UNSUPPORTED);
    };

    switch (change.type) {
      case 'addConstraint':
        return change.constraint.type === 'check'
          ? await this.addCheckConstraint(db, tableSchema, change.constraint)
          : refuse('ADD CONSTRAINT');
      case 'renameColumn':
        return renameColumnSchemaOnly(tableSchema, change.oldName, change.newName);
      case 'addColumn':
        return refuse('ALTER TABLE ADD COLUMN');
      case 'dropColumn':
        return refuse('ALTER TABLE DROP COLUMN');
      case 'dropConstraint':
        return refuse('ALTER TABLE DROP CONSTRAINT');
      case 'renameConstraint':
        return refuse('ALTER TABLE RENAME CONSTRAINT');
      case 'alterColumn':
        return refuse('ALTER COLUMN');
      case 'alterPrimaryKey':
        return refuse('ALTER PRIMARY KEY');
    }
  }

  /**
   * The CHECK arm of {@link alterTable}. The constraint is built by Quereus's own builder over
   * the engine's catalog entry, exactly as its CHECK arm for a module without `alterTable` did,
   * so an unnamed CHECK gets the same minted name. The table is resolved as {@link createIndex}
   * resolves it — a hydrated table no statement has touched yet is instantiated and, inside the
   * statement's batch checkpoint, initialized and registered — so the persisted write lands in
   * an open `APPLY SCHEMA` batch and commits with the rest of the apply.
   */
  private async addCheckConstraint(
    db: Database,
    tableSchema: TableSchema,
    constraint: AddedConstraint
  ): Promise<TableSchema> {
    const check = buildCheckConstraintSchema(
      constraint,
      tableSchema.checkConstraints.length,
      collectTableConstraintNames(tableSchema),
    );

    const { schemaName, name: tableName } = tableSchema;
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const resolved = await this.lookupOrInstantiate(db, schemaName, tableName, tableSchema);
    if (!resolved) {
      throw new Error(`Optimystic table '${tableName}' not found in schema '${schemaName}'. Cannot add CHECK constraint.`);
    }
    const { table, fresh } = resolved;

    await this.underBatchCheckpoint(table, 'written', tableKey, async () => {
      if (fresh) {
        await table.initialize();
        await table.ensureConnectionRegistered();
      }
      await table.addCheckConstraint(check);
    });

    return {
      ...tableSchema,
      checkConstraints: Object.freeze([...tableSchema.checkConstraints, check]),
    };
  }

  /**
   * Modern access planning interface using BestAccessPlanRequest/Result
   */
  getBestAccessPlan(
    _db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult {
    // Quereus 4.19 retired the flat `TableSchema.estimatedRows` this used to read. The row
    // count now reaches a module through the REQUEST — `rule-select-access-path` passes the
    // catalog's number down as `request.estimatedRows`, `undefined` when the table has never
    // been ANALYZEd — which is also the field a module that can size itself would substitute
    // its own count into. Reading the request rather than `tableInfo.statistics` directly is
    // what keeps this module's answer consistent with the plan costed around it.
    //
    // `||` rather than `??`, matching the shipped memory module's `request.estimatedRows || 1000`:
    // it collapses an ANALYZEd-empty table (a real 0) into the default. Quereus documents that
    // collapse at its own `|| default` sites and calls it harmless — any plan over 0 rows is
    // cheap either way — so this stays deliberately identical to the reference implementation
    // rather than quietly diverging from it.
    //
    // NOTE: the default is 1,000,000 where the memory module uses 1,000. Unchanged here on
    // purpose: it predates this migration, it biases an unanalyzed table toward index seeks
    // (the right instinct for a distributed store where a full scan is a network cost), and
    // retuning it is a costing decision that wants its own measurement, not a drive-by.
    const tableRowCount = request.estimatedRows || 1000000;
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
   * and gravestones the persisted schema entry so a subsequent CREATE TABLE with
   * the same name picks up the new shape rather than the old one, and so the
   * storage the drop leaves behind stays described (see
   * {@link SchemaManager.deleteSchema} and the storage-adoption guards).
   *
   * The catalog write must happen whether or not this session ever TOUCHED the
   * table: a table hydrated into Quereus's catalog and dropped without being
   * queried has no cached instance here, and skipping the write in that case
   * leaves the record LIVE past its own DROP — the next `hydrate()` resurrects
   * the table, and a later CREATE at the same URI reads a live persisted schema
   * and so never reaches {@link OptimysticVirtualTable.guardStorageAdoption}.
   * So the uncached path instantiates from the catalog entry Quereus still holds
   * at destroy time. That instance is deliberately NOT initialized: deleting its
   * own schema needs only its SchemaManager and the bridge's current transactor,
   * and initializing a table on its way out would re-persist the record being
   * deleted.
   */
  async destroy(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const table = this.tables.get(tableKey)
      ?? await this.instantiateForTeardown(db, schemaName, tableName);
    if (table) {
      // Release the collection-change → watch bridge before forgetting the table
      // so the storage listener doesn't leak past the table's lifetime.
      table.teardownChangeSubscription();
      try {
        await this.underBatchCheckpoint(table, 'dropped', tableKey, () => table.deleteOwnSchema());
      } catch (error) {
        // Best-effort: a schema-tree write failure shouldn't stop teardown. But it
        // does leave the record LIVE past its own DROP, which blinds the
        // storage-adoption guards for this table's URI, so say so rather than
        // dropping in silence.
        log(
          'destroy(%s.%s): gravestone write failed; the catalog record outlives its DROP ' +
          'and a later CREATE over the same URI will not be checked against it: %s',
          schemaName, tableName, error
        );
      }
    }
    this.tables.delete(tableKey);
  }

  /**
   * Build an UNINITIALIZED table instance for {@link destroy}'s benefit when the
   * drop is the first thing this session does to the table. Returns undefined when
   * the catalog no longer describes it (nothing to delete) or when the schema
   * cannot be parsed into options — a drop must never fail on teardown bookkeeping,
   * and the pre-existing behaviour for an unresolvable table was to skip the
   * catalog write entirely.
   */
  private async instantiateForTeardown(
    db: Database,
    schemaName: string,
    tableName: string
  ): Promise<OptimysticVirtualTable | undefined> {
    const resolvedSchema = db.schemaManager.findTable(tableName, schemaName);
    if (!resolvedSchema) {
      return undefined;
    }
    try {
      return await this.instantiateTable(db, resolvedSchema);
    } catch {
      return undefined;
    }
  }
}
