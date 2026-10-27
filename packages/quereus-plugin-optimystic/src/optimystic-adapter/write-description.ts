import type { TableWrite } from '@quereus/quereus';
import type { CollectionId } from '@optimystic/db-core';
import type { EntryFacts } from './commit-outlook.js';

/**
 * Everything that reads a Quereus write description (`TableWrite`, the object `UpdateArgs.writeScope`
 * carries once a table sets `wantWriteScope`; the contract is
 * `@quereus/quereus/src/planner/analysis/write-scope.ts`, documented in the sibling checkout's
 * docs/write-scope.md) on the vtab's behalf, and the facts it turns the description into. Pure: no
 * table, bridge or queue state, so the rules are unit-tested over prepared statements alone
 * (test/write-description.spec.ts). The plugin trusts the description's labels and does no provenance
 * reasoning of its own: a `fresh` column is fresh, anything else is not.
 */

/** A staged element whose value came from a fresh source: the primary key of a main-tree entry, the
 *  unique value of a unique-index entry (docs/offline-sync.md §Judging each guard). */
export type WriteFact = { readonly kind: 'fresh'; readonly collectionId: CollectionId; readonly key: string };

/**
 * The facts a transaction has recorded so far, as `TransactionState.writeFacts` keeps them: the records
 * in staging order, and at each open savepoint's creation the record count (`marks`, keyed by the
 * depth Quereus broadcasts) so a rollback to it discards the records of the statements it discards.
 */
export type TransactionWriteFacts = { records: WriteFact[]; marks: Map<number, number> };

/** The facts of a transaction that has recorded none: what every transaction state starts with. */
export function emptyWriteFacts(): TransactionWriteFacts {
	return { records: [], marks: new Map() };
}

/** One entry a row's write stages in a UNIQUE-enforcing index tree, as {@link freshElementsOf} needs it. */
export type UniqueEntryOf = {
	readonly collectionId: CollectionId;
	/** The tree key the entry is staged under (`indexEntryKey` in schema/index-manager.ts). */
	readonly key: string;
	/** The constraint's column names. */
	readonly columns: readonly string[];
};

/** The elements one `update()` arm stages for a row, as {@link freshElementsOf} needs them. */
export type StagedRowOf = {
	readonly mainCollectionId: CollectionId;
	/** The framed primary key the row is staged under. */
	readonly key: string;
	/** The primary-key column names, in any order. */
	readonly keyColumns: readonly string[];
	readonly uniqueEntries: readonly UniqueEntryOf[];
};

/**
 * The fresh elements one row's write stages, from the provenance of the columns the statement wrote
 * (docs/offline-sync.md §Judging each guard):
 *
 * - no description (a cascade child write), or a description of another operation than the arm
 *   staging the row — the upsert `DO UPDATE` arm receives the INSERT's — describes none of the row's
 *   values: nothing is fresh;
 * - a column is fresh when the description labels it `fresh`; a column the statement did not write
 *   (an UPDATE's unassigned columns) is not;
 * - the main-tree element is fresh when ANY primary-key column is fresh, the composite rule;
 * - a unique entry is fresh when any of its constraint's columns is.
 *
 * Column names are compared lowercased: Quereus lowercases `WrittenColumn.column`, the schema keeps
 * the declared spelling.
 */
export function freshElementsOf(write: TableWrite | undefined, arm: 'insert' | 'update', row: StagedRowOf): WriteFact[] {
	if (write === undefined || write.operation !== arm) return [];
	const fresh = freshColumnsOf(write);
	if (fresh.size === 0) return [];
	const facts: WriteFact[] = [];
	if (anyFresh(fresh, row.keyColumns)) facts.push({ kind: 'fresh', collectionId: row.mainCollectionId, key: row.key });
	for (const entry of row.uniqueEntries) {
		if (anyFresh(fresh, entry.columns)) facts.push({ kind: 'fresh', collectionId: entry.collectionId, key: entry.key });
	}
	return facts;
}

/** The lowercased names of the columns `write` labels `fresh`. */
function freshColumnsOf(write: TableWrite): Set<string> {
	const fresh = new Set<string>();
	for (const column of write.columns) {
		if (column.provenance.kind === 'fresh') fresh.add(column.column.toLowerCase());
	}
	return fresh;
}

function anyFresh(fresh: ReadonlySet<string>, columns: readonly string[]): boolean {
	return columns.some(column => fresh.has(column.toLowerCase()));
}

/**
 * The facts a transaction's records amount to, merged by `(collectionId, key)`: a key written twice in
 * one transaction is fresh if either write produced it fresh, since freshness is a property of where
 * the value came from, and a value minted fresh inside this uncommitted transaction cannot be known to
 * another machine however later statements refer to it. A rolled-back statement's record is gone before
 * this runs (`TransactionBridge.rollbackToSavepoint`), so this never credits a key a surviving statement
 * supplied from a parameter.
 */
export function foldWriteFacts(records: readonly WriteFact[]): EntryFacts {
	const fresh = new Map<CollectionId, Set<string>>();
	for (const record of records) {
		let keys = fresh.get(record.collectionId);
		if (keys === undefined) {
			keys = new Set();
			fresh.set(record.collectionId, keys);
		}
		keys.add(record.key);
	}
	return { fresh };
}
