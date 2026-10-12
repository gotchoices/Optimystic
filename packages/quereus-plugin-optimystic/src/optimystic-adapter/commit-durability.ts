import type { CollectionId, TransactionDurability, WriteDurability } from '@optimystic/db-core';
import { transactionDurability } from '@optimystic/db-core';

/** What one SQL commit wrote, and who holds it. Delivered to every listener registered with
 * `onCommitDurability` (on the object the plugin's `register` returns) once per commit that
 * wrote something. */
export interface SqlCommitDurability {
	/** The committed transaction's id: what `StampId()` returned inside it (`TransactionState.stampId`).
	 *  A host that wants to tag rows with it selects `StampId()` in the transaction. */
	readonly transactionId: string;
	/** db-core's answer, per collection (each table's main tree and each index tree) and overall.
	 *  Test "saved" through `overall !== undefined && isFullyDurable(overall)`; an absent `overall`
	 *  means a collection is saved with its holders unknown — show the commit as pending. */
	readonly durability: TransactionDurability;
	/** The same, per table — keyed by the qualified name `schema.table` — folding each table's
	 *  collections with `mergeDurability`; `undefined` when any of that table's collections is
	 *  unknown. A collection the bridge cannot name a table for (a test double) is left out here
	 *  but stays in `durability`. Two tables declared over one collection URI share its
	 *  collections, so a write to either lists both. */
	readonly tables: ReadonlyMap<string, WriteDurability | undefined>;
	/** `true` exactly when `onCommitFullyHeld` will be called for this commit once its whole cohort
	 *  holds it — or when it is already fully held (`isFullyDurable(durability.overall)`), which is
	 *  "saved now" and is not reported again. `false` on a pending commit means the plugin cannot say
	 *  when it becomes fully held: only a commit whose missing copies THIS node owes can be followed. */
	readonly followed: boolean;
}

/** Called synchronously after a SQL commit that wrote something; see {@link SqlCommitDurability}. */
export type SqlCommitDurabilityListener = (report: SqlCommitDurability) => void;

/** A followed commit (`SqlCommitDurability.followed`) that was saved below full replication is now
 *  held by every member of its cohort. Delivered to every `onCommitFullyHeld` listener, once. */
export interface CommitFullyHeld {
	/** The commit's `SqlCommitDurability.transactionId`. */
	readonly transactionId: string;
}

/** Called synchronously when a followed commit becomes fully held; see {@link CommitFullyHeld}. */
export type CommitFullyHeldListener = (event: CommitFullyHeld) => void;

/**
 * Build the report for one commit. Every map is a fresh copy, so a listener holds nothing the
 * bridge (or db-core) goes on to change, and the report object itself is frozen.
 *
 * `tablesOf` names the tables a collection backs; a collection it names none for is reported in
 * `durability` only. `followed` is the bridge's follower's decision (see `DurabilityFollower`).
 */
export function sqlCommitDurability(
	transactionId: string,
	durability: TransactionDurability,
	tablesOf: (id: CollectionId) => Iterable<string> | undefined,
	followed: boolean,
): SqlCommitDurability {
	return Object.freeze({
		transactionId,
		durability: transactionDurability(durability.collections),
		tables: tableDurability(durability.collections, tablesOf),
		followed,
	});
}

/** Fold each table's collections into one answer per table — the same fold, and the same
 * "absent when any collection is unknown" rule, a transaction's `overall` uses. */
function tableDurability(
	collections: ReadonlyMap<CollectionId, WriteDurability | undefined>,
	tablesOf: (id: CollectionId) => Iterable<string> | undefined,
): Map<string, WriteDurability | undefined> {
	const byTable = new Map<string, Map<CollectionId, WriteDurability | undefined>>();
	for (const [id, durability] of collections) {
		for (const table of tablesOf(id) ?? []) {
			let own = byTable.get(table);
			if (own === undefined) {
				own = new Map();
				byTable.set(table, own);
			}
			own.set(id, durability);
		}
	}
	const tables = new Map<string, WriteDurability | undefined>();
	for (const [table, own] of byTable) {
		tables.set(table, transactionDurability(own).overall);
	}
	return tables;
}
