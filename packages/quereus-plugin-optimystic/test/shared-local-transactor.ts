/**
 * A `local`-style transactor over one `MemoryRawStorage`, built ONCE so several `Database`s can
 * share it: each `CollectionFactory` normally caches transactors per plugin instance, so two
 * plugin instances would otherwise build two transactors with two independent trackers and
 * never see each other's commits. Sharing one repo is what lets a fresh `Database` plus
 * `plugin.hydrate(db)` prove what actually reached storage — the warm-restart harness used by
 * `catalog-hydration.spec.ts`, `same-named-tables-across-schemas.spec.ts` and
 * `hydrate-restores-declared-table.spec.ts`.
 */

import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';

export function buildSharedLocalTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_trxRefs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

/** How many times each transactor entry point was called since construction (or `reset`). */
export interface TransactorCallCounts {
	get: number;
	pend: number;
	commit: number;
	cancel: number;
	reset(): void;
}

/**
 * Wrap `inner` so every call is counted — for a spec that must show WHICH transactor a table's
 * reads went through (register two wrappers over one store under two keys), or that a step
 * committed nothing.
 */
export function countingTransactor(inner: ITransactor): { transactor: ITransactor; counts: TransactorCallCounts } {
	const counts: TransactorCallCounts = {
		get: 0,
		pend: 0,
		commit: 0,
		cancel: 0,
		reset() { this.get = 0; this.pend = 0; this.commit = 0; this.cancel = 0; },
	};
	const transactor = {
		async get(blockGets) { counts.get++; return await inner.get(blockGets); },
		async getStatus(trxRefs) { return await inner.getStatus(trxRefs); },
		async pend(request) { counts.pend++; return await inner.pend(request); },
		async commit(request) { counts.commit++; return await inner.commit(request); },
		async cancel(trxRef) { counts.cancel++; return await inner.cancel(trxRef); },
	} as ITransactor;
	return { transactor, counts };
}
