import type { Database } from '@quereus/quereus';
import type { QualifiedTableName } from '../schema/table-identity.js';

/**
 * Tell `db`'s watchers that `table`'s rows changed without a Quereus commit of `db` saying so — a
 * commit this node's storage applied for another writer, a network change notification, or a queued
 * offline transaction removed from this machine's view — so every `Database.watch` over it re-queries
 * (a coarse whole-table invalidation, `Database.notifyExternalChange`).
 *
 * Fire-and-forget: a synchronous throw and a rejection both go to `onError` and nowhere else, since
 * every caller is a callback that a watcher must not interrupt (a storage commit's change event, the
 * offline drain). A closed `Database` rejects, so its watchers see nothing and the caller logs it.
 */
export function announceExternalChange(db: Database, table: QualifiedTableName, onError: (error: unknown) => void): void {
	try {
		void Promise.resolve(db.notifyExternalChange(table.tableName, table.schemaName)).catch(onError);
	} catch (error) {
		onError(error);
	}
}
