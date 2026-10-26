/**
 * Quereus Plugin Entry Point for Optimystic
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, SqlValue, FunctionFlags } from '@quereus/quereus';
import { TEXT_TYPE } from '@quereus/quereus';
import { CollectionFactory } from './optimystic-adapter/collection-factory.js';
import { TransactionBridge } from './optimystic-adapter/txn-bridge.js';
import { OfflineMode } from './optimystic-adapter/offline-mode.js';
import { parseOfflineConfig } from './optimystic-adapter/offline-config.js';
import type { CommitFullyHeldListener, SqlCommitDurabilityListener } from './optimystic-adapter/commit-durability.js';
import { OptimysticModule } from './optimystic-module.js';
import { createStampIdFunction } from './functions/transaction-id.js';
import { createLogger } from './logger.js';

const log = createLogger('plugin');

// The error classes a caller classifies commit and write failures by (see docs/transactions.md).
// Exported from this entry as well as the root so a host that loads the plugin here can import them
// here, without relying on the two entries sharing a build chunk (test/entry-identity.spec.ts checks
// that they do anyway). The db-core classes are safe to re-export: db-core is `external` in
// tsup.config.ts, so this package never bundles its own copy of them.
export { PartialCommitError, ConcurrentModificationError } from './optimystic-adapter/txn-bridge.js';
export { CoordinatorPartialCommitError, SyncRetryExhaustedError, TornActionError } from '@optimystic/db-core';
// The predicate an `onCommitDurability` listener tests "saved" with, so a host needs no db-core import for it.
export { isFullyDurable } from '@optimystic/db-core';
export type {
	SqlCommitDurability, SqlCommitDurabilityListener, CommitFullyHeld, CommitFullyHeldListener,
} from './optimystic-adapter/commit-durability.js';
// Offline mode (README § Offline mode): the controller under `plugin.offline`, its two refusals, the
// db-core errors its queries throw, and the statuses it reports.
export { OfflineMode, OfflineModeRefusedError, SessionModeRefusedError } from './optimystic-adapter/offline-mode.js';
export type { OfflineConfig } from './optimystic-adapter/offline-config.js';
export { EntryNotDiscardableError, UnknownEntryError, QueueDisposedError } from '@optimystic/db-core';
export type {
	QueuedTransactionStatus, QueuedTransaction, TransactionOutcome, OfflineModeState, QueuedFailureReason,
} from './optimystic-adapter/offline-status.js';

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(_db: Database, config: Record<string, SqlValue> = {}) {
	if (config.debug) {
		log('Optimystic plugin loading with config: %o', config);
	}

	// Global factory instances
	const collectionFactory = new CollectionFactory();
	const txnBridge = new TransactionBridge(collectionFactory);
	// One offline queue per Database, idle until the first locally acknowledged commit. Wired before
	// any table opens: every tree the factory opens from here on reports sealed-segment refusals to it.
	const offline = new OfflineMode(txnBridge, parseOfflineConfig(config.offline));
	txnBridge.attachOfflineMode(offline);
	collectionFactory.setSealedRefusedListener(offline.onSealedRefused);
	const optimysticModule = new OptimysticModule(collectionFactory, txnBridge);

	// Create the StampId function
	const stampIdFunc = createStampIdFunction(txnBridge);

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
					flags: 1 as FunctionFlags, // UTF8
					returnType: {
						typeClass: 'scalar' as const,
						logicalType: TEXT_TYPE,
						nullable: true,
						isReadOnly: true,
					},
					implementation: stampIdFunc,
				},
			},
		],
		collations: [],
		// Expose internal components for testing and advanced usage
		collectionFactory,
		txnBridge,
		/**
		 * Hydrate Quereus's in-memory catalog from persisted Optimystic vtab
		 * schemas. Hosts that re-open a `Database` against existing storage
		 * should call this once after registering the plugin (and before
		 * running `apply schema` / DDL) so Quereus sees the existing tables in
		 * its catalog and skips re-emitting CREATE TABLE / CREATE INDEX for
		 * each one. Idempotent.
		 */
		hydrate: (db: Database) => optimysticModule.hydrateCatalog(db, config, config),
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
		 * `TransactionBridge.dispose`), the offline queue's drain (`OfflineMode.dispose`: a
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
			// Before the bridge: a submission in flight finishes its current network step, and a commit
			// it lands is reported through the bridge's follower while that is still live (a report
			// after the bridge's dispose would subscribe the follower to the node's events again, with
			// nothing left to release it). A pending `whenDrained` rejects with QueueDisposedError, and
			// entries still queued stay sealed in their collections (nothing of the application's is dropped).
			await offline.dispose();
			txnBridge.dispose();
			await collectionFactory.dispose();
		},
	};
}

