/**
 * Quereus Plugin Entry Point for Optimystic
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { FunctionFlags, INTEGER_TYPE, TEXT_TYPE } from '@quereus/quereus';
import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OfflineMode } from './optimystic-adapter/offline-mode.js';
import { MaterializedViewFollower } from './optimystic-adapter/materialized-view-follower.js';
import { parseOfflineConfig } from './optimystic-adapter/offline-config.js';
import { moduleCostProfile } from './optimystic-adapter/cost-profile.js';
import type { CommitFullyHeldListener, SqlCommitDurabilityListener } from './optimystic-adapter/commit-durability.js';
import { OptimysticModule, defaultTransactorOf } from './optimystic-module.js';
import { BLOBREF_TYPE } from './schema/blobref-type.js';
import { createStampIdFunction } from './functions/transaction-id.js';
import { createCommitOutlookFunction } from './functions/commit-outlook.js';
import { createBlobLocalityFunction, createBlobSizeFunction } from './functions/blob-functions.js';
import { SqlBlobService } from './optimystic-adapter/sql-blob-service.js';
import { SqlBlobPins, parseUnstagedHoldingMs } from './optimystic-adapter/blob-pins.js';
import { createLogger } from './logger.js';

const log = createLogger('plugin');
/** The blob sub-namespace, for the one blob line this entry logs (docs/debugging.md
 * §quereus-plugin sub-namespaces). */
const blobLog = createLogger('blob');

// The error classes a caller classifies commit and write failures by (see docs/transactions.md).
// Exported from this entry as well as the root so a host that loads the plugin here can import them
// here, without relying on the two entries sharing a build chunk (test/entry-identity.spec.ts checks
// that they do anyway). The db-core classes are safe to re-export: db-core is `external` in
// tsup.config.ts, so this package never bundles its own copy of them.
export { PartialCommitError, ConcurrentModificationError } from './optimystic-adapter/txn-bridge.js';
export { StaleTableDescriptionError } from './optimystic-adapter/table-description-check.js';
export type { StaleTableDescription } from './optimystic-adapter/table-description-check.js';
export { CoordinatorPartialCommitError, SyncRetryExhaustedError, TornActionError } from '@optimystic/db-core';
// The predicate an `onCommitDurability` listener tests "saved" with, so a host needs no db-core import for it.
export { isFullyDurable } from '@optimystic/db-core';
export type {
	SqlCommitDurability, SqlCommitDurabilityListener, CommitFullyHeld, CommitFullyHeldListener,
} from './optimystic-adapter/commit-durability.js';
// Offline mode (README § Offline mode): the controller under `plugin.offline`, its two refusals, the
// timeout a commit waiting behind the queue throws, the refusal of DDL while queued transactions wrote
// the table, the db-core errors its queries throw, and the statuses it reports.
export { OfflineMode, OfflineModeRefusedError, SessionModeRefusedError, OfflineCommitTimeoutError, QueuedEntriesBlockSchemaChangeError } from './optimystic-adapter/offline-mode.js';
export type { StorageShapeChange } from './optimystic-adapter/offline-mode.js';
export { OfflineJournalError } from './optimystic-adapter/offline-journal.js';
export type { OfflineConfig } from './optimystic-adapter/offline-config.js';
export { EntryNotDiscardableError, UnknownEntryError, QueueDisposedError } from '@optimystic/db-core';
export type {
	QueuedTransactionStatus, QueuedTransaction, TransactionOutcome, OfflineModeState, QueuedFailureReason,
} from './optimystic-adapter/offline-status.js';
export type { CommitOutlook, Exposure, OutlookDependency, UncheckedDecision } from './optimystic-adapter/commit-outlook.js';
// Blobs (README § Large values — the `blobref` column type; docs/blobs.md §SQL): the service type
// `plugin.blobs` and `plugin.blobsFor` hand out, and the backend one network's tables share.
export { SqlBlobService } from './optimystic-adapter/sql-blob-service.js';
export type { BlobBackend, SqlBlobBackendService } from './optimystic-adapter/collection-factory.js';

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(db: Database, config: Record<string, SqlValue> = {}) {
	if (config.debug) {
		log('Optimystic plugin loading with config: %o', config);
	}

	// The planner's read cost for every table registered here: the config's `cost_profile`, else the
	// default transactor's storage category (README § Plugin-Level Configuration). A bad value throws
	// here, before anything is built.
	const costProfile = moduleCostProfile(defaultTransactorOf(config), config.cost_profile);
	// How long a blob put outside any transaction and never referenced keeps its `unstaged` pin
	// (README § Plugin-Level Configuration). Read here, as `cost_profile` is, so a bad value throws
	// before anything is built.
	const unstagedHoldingMs = parseUnstagedHoldingMs(config);

	// Global factory instances
	const collectionFactory = new CollectionFactory();
	const txnBridge = new TransactionBridge(collectionFactory);
	// Keeps the materialized views over this Database's Optimystic tables in step with rows other writers
	// commit (README § Materialized views over Optimystic tables). Wired before any table opens, as the
	// offline queue is: every tree the factory opens reports the other writers' commits it adopts to it.
	const materializedViews = new MaterializedViewFollower(db, txnBridge);
	txnBridge.attachMaterializedViewFollower(materializedViews);
	collectionFactory.setExternalCommitsListener(materializedViews.onExternalCommits);
	// One offline queue per Database, idle until the first locally acknowledged commit. Wired before
	// any table opens: every tree the factory opens from here on reports sealed-segment refusals to it.
	// It announces a failed transaction's tables to this Database's watchers.
	const offline = new OfflineMode(txnBridge, db, parseOfflineConfig(config.offline));
	txnBridge.attachOfflineMode(offline);
	collectionFactory.setSealedRefusedListener(offline.onSealedRefused);
	// The pins a committing transaction's blob references are held under, and their release once it
	// lands or, for a queued transaction, once the queue has finished with it — plus the holding
	// period that expires the pin of a blob put outside any transaction and never referenced (README
	// § Large values; docs/blobs.md §Committing a reference). Built AFTER the controller, which it
	// reads, and attached to both before any table opens: a commit asks the bridge for them, and a
	// terminal queue status settles the ones its transaction left behind.
	const blobPins = new SqlBlobPins({
		backendByKey: key => collectionFactory.blobBackendForKey(key),
		registration: collectionFactory.blobScopes,
		knownBackends: () => collectionFactory.knownBlobBackends(),
		tablesOf: scope => txnBridge.tablesOf(scope),
		whenTransactionIdle: () => txnBridge.whenTransactionIdle(),
		isLive: transactionId => {
			const open = txnBridge.getCurrentTransaction();
			return (open?.isActive === true && open.stampId === transactionId) || offline.holdsTransaction(transactionId);
		},
		reconcileReady: () => offline.reconcileReady(),
		openReferences: () => txnBridge.openBlobReferences(),
		now: () => Date.now(),
		unstagedHoldingMs,
	});
	txnBridge.attachBlobPins(blobPins);
	offline.attachBlobPins(blobPins);
	// Every network's blob store this process opens, the ones already open replayed at once: a store
	// this process has not looked at may hold a pin a PREVIOUS process left behind, and the pass that
	// judges those pins has nothing to look at until some store is known. The unsubscribe is dropped
	// deliberately — the factory and the pins live and die with this registration.
	collectionFactory.onBlobBackendResolved(backend => blobPins.backendResolved(backend));
	const optimysticModule = new OptimysticModule(collectionFactory, txnBridge, costProfile);
	// The restore after a restart initializes each journaled transaction's tables through the module.
	offline.attachTableResolver(optimysticModule);

	// Create the StampId and CommitOutlook functions
	const stampIdFunc = createStampIdFunction(txnBridge);
	const commitOutlookFunc = createCommitOutlookFunction(txnBridge, offline);
	// The blob service of the DEFAULT network (docs/blobs.md §SQL). Its binding is derived on each
	// use, not here, because a host may set the session's `default_vtab_args` after `register`
	// returns — and because resolving it builds the libp2p node of a `network` transactor, which must
	// not happen merely because the plugin was registered.
	const blobs = new SqlBlobService(
		() => collectionFactory.getBlobBackend(optimysticModule.defaultBindingOptions(db, config)),
		txnBridge,
	);
	// Both functions read the default network: a scalar function has no table context. A host with
	// tables on several networks reads `stat` through `plugin.blobsFor(table)` instead.
	const blobLocalityFunc = createBlobLocalityFunction(blobs);
	const blobSizeFunc = createBlobSizeFunction(blobs);

	// Note: Transaction hooks are handled by the virtual table's begin, commit, rollback methods

	return {
		vtables: [
			{
				name: 'optimystic',
				module: optimysticModule,
				auxData: config,
			},
		],
		functions: [
			{
				schema: {
					name: 'StampId',
					numArgs: 0,
					// FRESH: a promise to Quereus's write-provenance analysis that no OTHER writer can produce the
					// value (16 random bytes beside a hash of this peer's id), so an insert keyed by StampId() is
					// judged assured offline (docs/offline-sync.md §Judging each guard). Quereus words the flag
					// as "unique per call"; StampId() answers the same value for every call inside one
					// transaction, which the outlook does not need to be otherwise — two rows inserted under it
					// in one transaction collide with each other sequentially, and the pre-stage probe refuses
					// the second before anything is queued (README § Offline mode).
					flags: FunctionFlags.UTF8 | FunctionFlags.FRESH,
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: TEXT_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: stampIdFunc,
				},
			},
			{
				schema: {
					name: 'CommitOutlook',
					numArgs: 0,
					flags: FunctionFlags.UTF8,
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: TEXT_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: commitOutlookFunc,
				},
			},
			{
				schema: {
					name: 'BlobLocality',
					numArgs: 1,
					// Not DETERMINISTIC: the answer changes as bytes move between machines. See
					// `createBlobLocalityFunction` for why neither function's value may be written into a row.
					flags: FunctionFlags.UTF8,
					isAsync: true,
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: TEXT_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: blobLocalityFunc,
				},
			},
			{
				schema: {
					name: 'BlobSize',
					numArgs: 1,
					flags: FunctionFlags.UTF8,
					isAsync: true,
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: INTEGER_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: blobSizeFunc,
				},
			},
		],
		collations: [],
		// The `blobref` column type (README § Large values — the `blobref` column type). The
		// registry Quereus resolves types through is process-wide, so one registration serves every
		// Database in the process; `registerPlugin` registers these before a host calls
		// `plugin.hydrate`, which is early enough for every path that reads a column's type. A host
		// registering the plugin's parts by hand must register these too — a table with a `blobref`
		// column refuses to open without them rather than reading the column as a `blob`.
		types: [{ name: 'blobref', definition: BLOBREF_TYPE }],
		// Expose internal components for testing and advanced usage
		collectionFactory,
		txnBridge,
		/**
		 * The blob pins a committing transaction's references are held under (`SqlBlobPins`). A
		 * queued transaction's pins are released when the queue finishes with it, off the commit, so
		 * `blobPins.settled()` is how a caller waits for those releases — and for the reconciliation
		 * of the pins a previous process left behind, which {@link hydrate} triggers. Never await it
		 * inside a transaction: the work it waits on waits for the transaction to end.
		 *
		 * `blobPins.sweepUnstaged(now?)` is the holding-period sweep, which otherwise runs on its own
		 * interval: it releases the pin of every blob put outside any transaction and never
		 * referenced, past `blob_unstaged_holding_ms`. A test drives it with an explicit `now` rather
		 * than waiting for that interval.
		 */
		blobPins,
		/**
		 * The blob service of the plugin's DEFAULT network — the one a table declared with no
		 * `using` clause binds to (docs/blobs.md §SQL; README § Large values). `put` a stream to
		 * get a reference a `blobref` column can hold, `read` it back, `stat` it. The network is
		 * resolved on first use, so a host may still set the session's `default_vtab_args`.
		 *
		 * A blob put through this is PINNED, and the pin follows the transaction open when the put
		 * started: it is released when that transaction commits (after the blob has been announced to
		 * its cohort), rolls back, or is queued. A put made outside any transaction keeps an
		 * `unstaged` pin until a transaction that references the blob commits, or until that pin
		 * passes the holding period `blob_unstaged_holding_ms` names (24 hours by default), after
		 * which it is released and the bytes go with this machine's next sweep. So a blob a committed
		 * row references is kept, and a blob put inside a transaction that never referenced it is
		 * NOT — put it outside any transaction and reference it within the holding period, or pass
		 * an explicit `owner` and release that pin yourself, to keep one no row references.
		 *
		 * `await blobs.pathAccess()` is the pair of FILE PATH forms — store a blob straight from a
		 * file, write one straight out to a file, the bytes never passing through JavaScript — for a
		 * network whose store offers them, and `undefined` for one that does not (docs/blobs.md
		 * §Putting and reading by file path). A path put is pinned exactly as `put` is.
		 */
		blobs,
		/**
		 * The blob service of the network `table` uses. Rejects for a table that is not a known
		 * Optimystic table. A reference means something only in the network whose machines hold the
		 * bytes, so a host with tables on several networks goes through this rather than
		 * {@link blobs}.
		 *
		 * A fresh wrapper per call, and NOT reference-equal to `plugin.blobs` even for the default
		 * network: the wrapper is thin and the sharing is in `CollectionFactory.getBlobBackend`, so
		 * two wrappers over one network read the same blob records, hold the same pins and each
		 * receive the same events. Compare networks, never these objects.
		 *
		 * `async` though nothing in it awaits, so an unknown table arrives as a REJECTION — what
		 * the README and docs/blobs.md §SQL promise — rather than a synchronous throw.
		 */
		blobsFor: async (table: string, schema?: string): Promise<SqlBlobService> => {
			// Read once here so a bad table name rejects THIS call rather than the service's first
			// use; the binding is fixed at the table's declaration, so re-reading it per use would
			// answer the same thing.
			const options = optimysticModule.bindingOptionsOfTable(db, table, schema);
			return new SqlBlobService(() => collectionFactory.getBlobBackend(options), txnBridge);
		},
		/**
		 * Hydrate Quereus's in-memory catalog from persisted Optimystic vtab
		 * schemas, then put the offline queue's journaled transactions back
		 * (`plugin.offline.restore()`; README § Offline mode, "Restarting")
		 * and reconcile the blob reference pins a previous process left behind
		 * (`SqlBlobPins.reconcile`, awaited here: a pin whose transaction
		 * committed is announced and released, one whose transaction never did
		 * is released, and one whose scope cannot be read with confidence is
		 * kept for the next restart or reachability wake).
		 * Hosts that re-open a `Database` against existing storage should call
		 * this once after registering the plugin (and before running `apply
		 * schema` / DDL) so Quereus sees the existing tables in its catalog and
		 * skips re-emitting CREATE TABLE / CREATE INDEX for each one, and so the
		 * first statement sees the queued transactions. Idempotent. Resolves to
		 * the catalog counts; rejects with `OfflineJournalError` for a journal
		 * record written by a newer build (every record before it is restored).
		 *
		 * When it puts at least one table back, and the `Database` has no Optimystic connection
		 * yet, it also leaves ONE registered under one of those tables' names, so the transaction
		 * Quereus opens for the first autocommit write statement reaches the plugin and
		 * `StampId()` inside it answers that statement's stamp rather than NULL (see
		 * `OptimysticModule.registerBridgeConnection` and README § StampId() Function). A host
		 * that counts `getConnectionsForTable` will see it.
		 */
		hydrate: async (db: Database) => {
			const counts = await optimysticModule.hydrateCatalog(db, config, config);
			// Puts the journaled transactions back, and then AWAITS the reconciliation of the blob
			// reference pins a previous process left behind (`OfflineMode.restore`, which never throws
			// out of that reconciliation), so a restart's pin reconciliation has happened by the time
			// this resolves.
			await offline.restore();
			// The DEFAULT network's blob store, so the reconciliation has somewhere to look in a host that
			// has hydrated and not yet opened a table: its pass walks the stores of the transactor keys
			// the factory has seen options for, and resolving this one reports the backend to
			// `SqlBlobPins`, which chains a pass over it — `settled()` below is what waits for that pass.
			// A table on ANOTHER network gets its own pass when that table first initializes and its
			// backend resolves. It builds no libp2p node `hydrateCatalog` has not already built — it reads
			// the catalog through the same transactor — so this adds a piece store, not a network, and a
			// failure is logged rather than failing the hydrate.
			// NOTE: a host that uses NO blobs pays one empty single-machine blob store, and its piece
			// sweeper, per hydrate; if that ever shows up on a cold start, resolve it lazily on the first
			// trigger that finds a pin instead of here.
			try {
				await collectionFactory.getBlobBackend(optimysticModule.defaultBindingOptions(db, config));
			} catch (error) {
				blobLog('blob:backend-resolution-failed step=hydrate %o', error);
			}
			await blobPins.settled();
			return counts;
		},
		/**
		 * Compare every secondary index of one table against the table's rows, in both
		 * directions, and report each disagreement: a row the index holds no entry for
		 * (`missing`), or an entry pointing at a row that is gone or no longer holds the indexed
		 * value (`orphaned`). One report per index the table maintains, including the internal
		 * tree that enforces a `unique` column with no declared index. Queries cannot show an
		 * orphaned entry — an index lookup checks every entry against the row it resolves to and
		 * skips the ones that row does not imply, so a leftover entry and no entry look the same
		 * from a query — which is why this exists.
		 *
		 * Reads this node's live trees, including an open transaction's uncommitted writes, and
		 * repairs nothing. `schema` defaults to `main`. Throws for a table that is not a known
		 * Optimystic table. How to read a report: docs/debugging.md, "Does an index agree with
		 * its table?".
		 */
		verifyIndexes: (db: Database, table: string, schema?: string) =>
			optimysticModule.verifyIndexes(db, table, schema),
		/**
		 * Be told, after every SQL commit that wrote something, who holds what it wrote: per
		 * collection, per table (`schema.table`) and overall, with the transaction's `StampId()`.
		 * The commit is "saved" when `overall !== undefined && isFullyDurable(overall)`; anything
		 * else is pending. Called synchronously before the commit returns, so every report a
		 * listener receives while a host's `await db.exec(...)` is running belongs to that exec
		 * (Quereus runs one writer at a time). A commit that wrote nothing calls nobody; a failed
		 * commit reports through its error's `durability` instead. Returns an idempotent
		 * unsubscribe. See `TransactionBridge.onCommitDurability`.
		 */
		onCommitDurability: (listener: SqlCommitDurabilityListener) =>
			txnBridge.onCommitDurability(listener),
		/**
		 * Be told when a commit that was saved below full replication — its report said `followed`
		 * and was not yet fully held — becomes held by every member of its cohort. Called once per
		 * such commit with its `transactionId`. A commit already fully held when reported is "saved
		 * now" and is not reported again; a pending commit reported with `followed: false` will never
		 * be reported here (only commits whose missing copies this node itself owes can be followed).
		 * Followed commits live in memory, so a restart or `dispose()` forgets them. Same listener
		 * discipline as `onCommitDurability`. See `TransactionBridge.onCommitFullyHeld`.
		 */
		onCommitFullyHeld: (listener: CommitFullyHeldListener) =>
			txnBridge.onCommitFullyHeld(listener),
		/**
		 * Offline mode (README § Offline mode): `enter()` makes every transaction begun from then on
		 * resolve its commit once the transaction is queued on this machine, to be submitted to the
		 * network in order as soon as the cohort can be reached; `exit()` returns to network
		 * acknowledgement. Follow each queued transaction through `onStatus`, the queue through
		 * `onQueueState`, and query it through `entries`, `status`, `outcomes`; `discard` withdraws a
		 * never-sent transaction and `whenDrained` resolves once the queue is empty. Configured by the
		 * registration config's `offline` block.
		 */
		offline,
		/**
		 * Materialized views over Optimystic tables (README § Materialized views over Optimystic tables):
		 * when another machine's commit reaches this one, every materialized view reading the changed
		 * table is rebuilt (`refresh materialized view`), after the statement running then and outside
		 * any explicit transaction, with a burst of commits folded into one rebuild. `settled()` resolves
		 * once nothing is pending — no change waiting, no rebuild running or owed, except rebuilds that
		 * failed and are waiting to retry (logged). It waits for an open explicit transaction to end
		 * first, so never await it inside one or inside a statement.
		 */
		materializedViews: {
			settled: (): Promise<void> => materializedViews.settled(),
		},
		/**
		 * Resolves once every tag change made so far on an Optimystic table is saved to the table's
		 * catalog record — so a later `hydrate` restores it. A tag change made by `apply schema` is
		 * saved before the apply returns; an imperative `alter … set|add|drop tags` (on a table, a
		 * column, a named constraint or an index) returns BEFORE its save lands, because Quereus
		 * applies it to its own catalog and only announces it to the plugin. A host that closes a
		 * `Database` and reopens the same storage in this process awaits this (or `dispose()`) in
		 * between; a process that exits right after such a statement can lose the change. A save
		 * that fails is logged and the table keeps its old tags in storage. Never rejects.
		 */
		whenCatalogPersisted: () => optimysticModule.whenCatalogPersisted(),
		/**
		 * Release what the plugin holds outside the `Database` — its subscriptions to the node's
		 * full-replication events (forgetting every commit still followed, see
		 * `TransactionBridge.dispose`), the pin releases a settled queued transaction still owes
		 * (`SqlBlobPins.dispose`: what is running finishes, nothing further is released, and the pins
		 * left are the restart reconciliation's), the materialized-view follower (a rebuild in flight
		 * is let finish, nothing further is rebuilt), the offline queue's drain (`OfflineMode.dispose`: a
		 * submission in flight is aborted after its current network step, nothing further is sent,
		 * and queued entries stay sealed in their collections), and its LEASES on the raw-storage read caches behind
		 * `local` transactors over host-supplied storage (see `CollectionFactory.dispose`). Call
		 * after `db.close()`. Quereus has no close hook that reaches the plugin, so this is explicit.
		 *
		 * A cache is shared by every consumer of one backing store and is cleared only when the
		 * LAST lease on it releases, so skipping this is not a correctness problem — but it keeps
		 * that store's cache warm for the process, and a later `Database` over the same store then
		 * reads it instead of the backend. Anything that mutates the store behind Optimystic's
		 * back between two `Database`s must dispose in between. See `withReadCache` in
		 * `@optimystic/db-p2p`. Waits for the tag changes still being saved first
		 * (`whenCatalogPersisted`).
		 */
		dispose: async () => {
			await optimysticModule.whenCatalogPersisted();
			// Before the offline controller: a pin release still chained may read it. A step parked on
			// an open transaction stops waiting here, since the host has closed the `Database` (which
			// ends that transaction) before calling this.
			await blobPins.dispose();
			// Before the bridge: a submission in flight finishes its current network step, and a commit
			// it lands is reported through the bridge's follower while that is still live (a report
			// after the bridge's dispose would subscribe the follower to the node's events again, with
			// nothing left to release it). A pending `whenDrained` rejects with QueueDisposedError, and
			// entries still queued stay sealed in their collections (nothing of the application's is dropped).
			await offline.dispose();
			// After the queue, whose last removals may still report changed tables; before the bridge, which it reads.
			await materializedViews.dispose();
			txnBridge.dispose();
			await collectionFactory.dispose();
		},
	};
}

