import type { BlockId } from "../blocks/index.js";
import type { ReadDependency } from "./transaction.js";

/** Accumulates the read dependencies of one transaction. Keyed by block id, keeping
 *  the HIGHEST revision observed for each id (never downgrades — a re-read from cache
 *  must not overwrite a higher revision seen earlier). Cleared at each txn boundary.
 *
 *  One instance is shared by a collection's {@link TransactorSource} (direct structural
 *  reads — bootstrap, header) and its {@link CacheSource} (every cache hit/miss), so a
 *  block read from either layer produces a dependency. Because both feed the same
 *  collector, a cache miss records the id once from each layer at the same revision;
 *  max-wins collapses those to a single entry. */
export class ReadDependencyCollector {
	private revisions = new Map<BlockId, number>();

	record(blockId: BlockId, revision: number): void {
		const prev = this.revisions.get(blockId);
		if (prev === undefined || revision > prev) {
			this.revisions.set(blockId, revision);
		}
	}

	getReadDependencies(): ReadDependency[] {
		return [...this.revisions].map(([blockId, revision]) => ({ blockId, revision }));
	}

	clear(): void {
		this.revisions.clear();
	}
}
