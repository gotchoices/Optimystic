/**
 * Break one of IndexManager's staging methods on purpose, for the duration of a callback, to
 * leave an exact, known index discrepancy behind: a missing entry (the insert's staging
 * skipped), a no-row orphan (the delete's), or a stale-value orphan (the update's, whole or
 * half).
 *
 * For self-tests of the checks that detect those discrepancies. Their real producers are
 * defects due to be fixed, and a check's self-test must not depend on a bug surviving.
 */

import type register from '../dist/plugin.js';

type Plugin = ReturnType<typeof register>;

/** The IndexManager methods through which DML stages index entries. */
export type IndexStagingMethod = 'insertIndexEntries' | 'deleteIndexEntries' | 'updateIndexEntries';

interface IndexStager {
	insertIndexEntries(...args: unknown[]): Promise<void>;
}

/** A stand-in for one of those methods; `this` is the table's IndexManager. */
export type IndexStagingImpl = (this: IndexStager, ...args: unknown[]) => Promise<void>;

/** Stages nothing: the statement's row change lands and its index entries do not. */
export const stageNothing: IndexStagingImpl = async () => {
	// Deliberately empty.
};

/**
 * For `updateIndexEntries`: stages the row's NEW entry and never removes the old one. That
 * leaves a stale-value orphan with no missing entry beside it, so every value some row still
 * holds keeps looking up correctly.
 */
export const stageNewEntryOnly: IndexStagingImpl = async function (...args) {
	// updateIndexEntries(oldRow, newRow, oldPrimaryKey, newPrimaryKey, transactor, uniqueIndexes)
	const [, newRow, , newPrimaryKey, transactor, uniqueIndexes] = args;
	await this.insertIndexEntries(newRow, newPrimaryKey, transactor, uniqueIndexes);
};

/**
 * Run `body` with IndexManager's `method` replaced by `replacement`, restoring the original
 * even when `body` throws.
 *
 * The patch is on IndexManager's PROTOTYPE, reached through `table`'s live instance (the class
 * is not exported). Every Optimystic table in the process shares that prototype, so an undo
 * that failed to run would break every later spec.
 */
export async function withIndexStagingPatched(
	plugin: Plugin,
	table: string,
	method: IndexStagingMethod,
	replacement: IndexStagingImpl,
	body: () => Promise<void>,
): Promise<void> {
	const prototype = indexManagerPrototype(plugin, table);
	const original = prototype[method];
	prototype[method] = replacement;
	try {
		await body();
	} finally {
		prototype[method] = original;
	}
}

/** IndexManager's prototype, via the live IndexManager of `main.<table>`. */
function indexManagerPrototype(plugin: Plugin, table: string): Record<IndexStagingMethod, IndexStagingImpl> {
	const module = plugin.vtables[0]!.module as unknown as {
		tables: Map<string, { indexManager?: object }>;
	};
	const key = `main.${table}`.toLowerCase();
	const manager = module.tables.get(key)?.indexManager;
	if (manager === undefined) {
		throw new Error(`withIndexStagingPatched: no initialized Optimystic table '${key}'`);
	}
	return Object.getPrototypeOf(manager) as Record<IndexStagingMethod, IndexStagingImpl>;
}
