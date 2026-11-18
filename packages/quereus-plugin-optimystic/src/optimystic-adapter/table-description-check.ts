/**
 * The commit-time check that a write was made under the table description the catalog holds now.
 *
 * Each machine copies table descriptions from the shared catalog into its engine when it hydrates,
 * and nothing tells it about a later change another machine makes. A table instance builds its row
 * codec and index maintenance from its description once, and the engine plans and checks every
 * statement against its own copy, so a write made under an older description can leave a row out of
 * an index this machine does not know, or break a rule it has not seen. So before a transaction that
 * wrote a table commits, the table's description is compared with the catalog's record of it, and a
 * write made under a description another machine replaced or dropped is refused with
 * {@link StaleTableDescriptionError}. The machine then takes the record's description, so the
 * retried statement is planned and maintained under it (docs/internals.md §A first touch writes only
 * what the table owes; docs/transactions.md §A write is checked against the table's current
 * description).
 *
 * The bridge drives the check ({@link judgeTableDescriptions}, `TransactionBridge.commitTransaction`)
 * without knowing descriptions: each table hands it a {@link TableDescriptionCheck} the first time
 * the transaction marks its trees dirty.
 */

import { isCohortUnreachableRead } from '@optimystic/db-core';
import type { ITransactor } from '@optimystic/db-core';
import { QuereusError, StatusCode } from '@quereus/quereus';
import type { CatalogRecordState, StoredTableSchema } from '../schema/schema-manager.js';
import { qualifiedTableName } from '../schema/table-identity.js';
import type { QualifiedTableName } from '../schema/table-identity.js';
import { createLogger } from '../logger.js';

const log = createLogger('txn-bridge');

/** Reads the catalog's record of several tables at once (`SchemaManager.readRecordsFresh`). */
export interface CatalogRecordReader {
	readRecordsFresh(tables: readonly QualifiedTableName[], transactor?: ITransactor): Promise<ReadonlyMap<string, CatalogRecordState>>;
}

/**
 * How a table's description stands against the catalog's record of it:
 *
 * - **current** — the record describes the table as this machine's instance does, or the instance
 *   owes the catalog its description (it is the one about to be written).
 * - **unknown** — no live record and no gravestone. The write proceeds: "nothing" can be a catalog
 *   this machine could not read (`SchemaManager.getSchema`), and refusing on it would refuse every
 *   write while the catalog is unreachable.
 * - **replaced** — the record describes the table differently; `difference` names the first part
 *   that differs, and `record` is what the machine follows.
 * - **dropped** — the catalog holds a gravestone: another machine dropped the table.
 */
export type DescriptionVerdict =
	| { readonly kind: 'current' }
	| { readonly kind: 'unknown' }
	| { readonly kind: 'replaced'; readonly difference: string; readonly record: StoredTableSchema }
	| { readonly kind: 'dropped' };

/** A verdict that refuses the commit. */
export type StaleVerdict = Extract<DescriptionVerdict, { kind: 'replaced' | 'dropped' }>;

/** One table's part in the check, built by its vtab instance (`OptimysticVirtualTable.descriptionCheck`). */
export interface TableDescriptionCheck {
	readonly table: QualifiedTableName;
	/** The catalog the table's record is read from; checks sharing one share one read. */
	readonly catalog: CatalogRecordReader;
	/** Whether the transaction staged anything into the table's trees: a table it only read is not checked. */
	staged(): boolean;
	/** Judge the instance's description against what the catalog holds for the table. */
	judge(state: CatalogRecordState): DescriptionVerdict;
	/**
	 * Take what the catalog holds into the engine and the instance: the record's description for
	 * `replaced`, the table's removal for `dropped`. Called after the refused transaction has rolled
	 * back. Writes nothing to the catalog.
	 */
	follow(verdict: StaleVerdict): void;
}

/** One table a commit was refused for. */
export interface StaleTableDescription {
	readonly table: QualifiedTableName;
	readonly kind: StaleVerdict['kind'];
	/** For `replaced`, the first part of the description that differs. */
	readonly difference?: string;
}

/**
 * A commit refused because a table it wrote was described differently by the catalog than by this
 * machine, or dropped from it, by another machine. Nothing was written. This machine then holds the
 * catalog's description, so the statement can be retried: it is planned again under the new
 * description, or fails as on a table that does not exist. `StatusCode.SCHEMA`, the code Quereus
 * raises when a connection's definition of a table is stale (`assertCatalogMatchesModule` in
 * `@quereus/quereus/src/runtime/stale-catalog-guard.ts`); a `QuereusError`, so every rethrow path
 * passes it through unwrapped.
 */
export class StaleTableDescriptionError extends QuereusError {
	constructor(readonly tables: readonly StaleTableDescription[]) {
		super(staleMessage(tables), StatusCode.SCHEMA);
		this.name = 'StaleTableDescriptionError';
		Object.setPrototypeOf(this, StaleTableDescriptionError.prototype);
	}
}

function staleMessage(tables: readonly StaleTableDescription[]): string {
	const each = tables.map(({ table, kind, difference }) => kind === 'dropped'
		? `table ${qualifiedTableName(table)} was dropped by another machine`
		: `table ${qualifiedTableName(table)} was changed by another machine (${difference})`);
	return `Transaction not committed: ${each.join('; ')} after this machine read its description. `
		+ 'This machine now holds the current description; retry the statement.';
}

/** A check whose verdict refuses the commit. */
export interface StaleJudgement {
	readonly check: TableDescriptionCheck;
	readonly verdict: StaleVerdict;
}

/**
 * Judge every check whose table the transaction staged into, reading each catalog once, and answer
 * the ones that refuse the commit. A catalog that cannot be read throws, except under
 * `whenUnreachable: 'skip'`, where a read that failed because the cohort could not be reached
 * (`isCohortUnreachableRead`) leaves its tables unchecked — the offline queue's routes, whose
 * transaction is acknowledged without reaching the cohort.
 *
 * NOTE: a transaction whose check ran just before another machine's change landed still commits under
 * the old description. For a CHECK, a NOT NULL or a new column that window is one commit's network
 * time; for CREATE INDEX it is the whole index build on the other machine, which writes the record
 * only after populating the index from the rows it read
 * (`bug-optimystic-a-write-during-another-machines-index-build-can-miss-the-index`, backlog).
 *
 * NOTE: a transaction queued by the offline queue is checked when it is sealed, not when it drains,
 * so one queued while the catalog could not be read, or before a change another machine made while it
 * waited, commits under the description it was written with. Checking at the drain would need the
 * queue to know descriptions; revisit if hosts keep machines offline across schema changes.
 */
export async function judgeTableDescriptions(
	checks: Iterable<TableDescriptionCheck>,
	transactor: ITransactor | undefined,
	whenUnreachable: 'throw' | 'skip',
): Promise<StaleJudgement[]> {
	const stale: StaleJudgement[] = [];
	for (const [catalog, group] of stagedChecksByCatalog(checks)) {
		const states = await readOrSkip(catalog, group, transactor, whenUnreachable);
		if (states === undefined) continue;
		for (const check of group) {
			const verdict = check.judge(states.get(qualifiedTableName(check.table)) ?? { kind: 'absent' });
			if (verdict.kind === 'replaced' || verdict.kind === 'dropped') {
				log('commit:description-stale table=%s verdict=%s difference=%s',
					qualifiedTableName(check.table), verdict.kind, verdict.kind === 'replaced' ? verdict.difference : '-');
				stale.push({ check, verdict });
			}
		}
	}
	return stale;
}

function stagedChecksByCatalog(checks: Iterable<TableDescriptionCheck>): Map<CatalogRecordReader, TableDescriptionCheck[]> {
	const byCatalog = new Map<CatalogRecordReader, TableDescriptionCheck[]>();
	for (const check of checks) {
		if (!check.staged()) continue;
		const group = byCatalog.get(check.catalog);
		if (group === undefined) byCatalog.set(check.catalog, [check]);
		else group.push(check);
	}
	return byCatalog;
}

async function readOrSkip(
	catalog: CatalogRecordReader,
	group: readonly TableDescriptionCheck[],
	transactor: ITransactor | undefined,
	whenUnreachable: 'throw' | 'skip',
): Promise<ReadonlyMap<string, CatalogRecordState> | undefined> {
	try {
		return await catalog.readRecordsFresh(group.map(check => check.table), transactor);
	} catch (error) {
		if (whenUnreachable === 'skip' && isCohortUnreachableRead(error)) {
			log('commit:description-unchecked reason=%s tables=%s: the catalog cannot be reached, so the queued transaction is not checked',
				error.reason, group.map(check => qualifiedTableName(check.table)).join(','));
			return undefined;
		}
		throw error;
	}
}

/**
 * After a refused commit has rolled back: have each refused table follow the catalog. A follow that
 * throws is logged and leaves that table as it was, so its next commit is refused and followed again.
 */
export function followStaleDescriptions(stale: readonly StaleJudgement[]): void {
	for (const { check, verdict } of stale) {
		try {
			check.follow(verdict);
		} catch (error) {
			log('WARN: commit:description-follow-failed table=%s: %s',
				qualifiedTableName(check.table), error instanceof Error ? error.message : String(error));
		}
	}
}

/** The public description of each refused table, for {@link StaleTableDescriptionError}. */
export function staleTables(stale: readonly StaleJudgement[]): StaleTableDescription[] {
	return stale.map(({ check, verdict }) => ({
		table: { ...check.table },
		kind: verdict.kind,
		...(verdict.kind === 'replaced' ? { difference: verdict.difference } : {}),
	}));
}
