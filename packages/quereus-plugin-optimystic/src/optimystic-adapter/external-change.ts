import type { Database } from '@quereus/quereus';
import type { QualifiedTableName } from '../schema/table-identity.js';

/**
 * How a table's rows reached this machine's view without a Quereus statement of the `Database`:
 * - `'hint'`: this node's storage applied a commit to the table, or its network watch woke. It may be
 *   this machine's own commit, so it says only that the rows may have changed.
 * - `'changed'`: they did change, with no log entry to adopt — a queued offline transaction removed
 *   from this machine's view, or one whose network-acknowledged commit timed out and stayed.
 */
export type ExternalChangeKind = 'hint' | 'changed';

/** What hears of such a change beside the watchers: the materialized-view follower (`MaterializedViewFollower`). */
export interface ExternalChangeFollower {
	/** Synchronous and never throws: called from callbacks a follower must not interrupt. */
	noteExternalChange(table: QualifiedTableName, kind: ExternalChangeKind): void;
}

/**
 * Tell `db` that `table`'s rows changed without a Quereus commit of `db` saying so — a commit this node's
 * storage applied for another writer, a network change notification, or a queued offline transaction
 * removed from this machine's view: `follower` (when there is one) keeps the materialized views over the
 * table in step, and every `Database.watch` over it re-queries (a coarse whole-table invalidation,
 * `Database.notifyExternalChange`). One helper for both, so no site can tell one and not the other.
 *
 * Fire-and-forget: a synchronous throw and a rejection both go to `onError` and nowhere else, since
 * every caller is a callback that a watcher must not interrupt (a storage commit's change event, the
 * offline drain). A closed `Database` rejects, so its watchers see nothing and the caller logs it.
 */
export function announceExternalChange(
	db: Database,
	table: QualifiedTableName,
	kind: ExternalChangeKind,
	follower: ExternalChangeFollower | undefined,
	onError: (error: unknown) => void,
): void {
	follower?.noteExternalChange(table, kind);
	try {
		void Promise.resolve(db.notifyExternalChange(table.tableName, table.schemaName)).catch(onError);
	} catch (error) {
		onError(error);
	}
}
