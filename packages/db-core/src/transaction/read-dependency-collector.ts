import type { BlockId, ReadPurpose } from "../blocks/index.js";
import type { ReadDependency } from "./transaction.js";

/** One captured read: the highest revision observed for the block, plus its {@link ReadPurpose}. */
type ReadEntry = { revision: number; purpose: ReadPurpose };

/** Accumulates the read dependencies of one transaction. Keyed by block id. For each id it keeps:
 *
 *  - the HIGHEST revision observed (never downgrades — a re-read from cache must not overwrite a
 *    higher revision seen earlier), and
 *  - the read's PURPOSE with value-wins semantics: once a block is recorded as a `value` read from
 *    ANY path it stays `value`; `navigation` sticks only for a block that was never read as a value.
 *    This is the exact analogue of the max-wins rule on revision, and it makes the classification
 *    order-independent (so it is deterministic regardless of cache/timing — required for the
 *    transaction id and client signature to match across a re-executing validator; Theorem 4).
 *
 *  {@link getReadDependencies} returns only the CONFLICT set (value reads); purely-structural
 *  `navigation` reads — interior B-tree branches walked through to reach a captured leaf — are
 *  dropped. See {@link markValue} and docs/correctness.md Theorem 5.
 *
 *  One instance is shared by a collection's {@link TransactorSource} (direct structural reads —
 *  bootstrap, header) and its {@link CacheSource} (every cache hit/miss), so a block read from
 *  either layer produces a dependency. Because both feed the same collector, a cache miss records
 *  the id once from each layer at the same revision/purpose; the merge collapses those to one
 *  entry. Cleared at each txn boundary. */
export class ReadDependencyCollector {
	private reads = new Map<BlockId, ReadEntry>();

	/** Record a read of `blockId` at `revision`. `purpose` defaults to `value` (retained); pass
	 *  `navigation` for an interior structural read that a later {@link markValue} may or may not
	 *  upgrade. Revision is max-wins; purpose is value-wins (see class doc). */
	record(blockId: BlockId, revision: number, purpose: ReadPurpose = 'value'): void {
		const prev = this.reads.get(blockId);
		if (prev === undefined) {
			this.reads.set(blockId, { revision, purpose });
			return;
		}
		if (revision > prev.revision) {
			prev.revision = revision;
		}
		// value-wins: a value read anywhere pins the block as value; navigation never downgrades it.
		if (purpose === 'value') {
			prev.purpose = 'value';
		}
	}

	/** Upgrade an already-recorded read to `value` (keeping its revision), retaining it in the
	 *  conflict set. The B-tree point-lookup path uses this to mark the terminal leaf — the
	 *  load-bearing read whose content the result depends on — after its interior descent nodes
	 *  were recorded as `navigation`. No-op if the id was never recorded (e.g. a leaf served from
	 *  an uncommitted staged insert, which records no dependency at all). */
	markValue(blockId: BlockId): void {
		const prev = this.reads.get(blockId);
		if (prev) {
			prev.purpose = 'value';
		}
	}

	/** The optimistic-concurrency conflict (read) set: every `value` read, with `navigation`
	 *  reads excluded. Dropping a covered navigation read cannot admit a lost update — any
	 *  concurrent change to the queried result also bumps a retained value read (the target
	 *  leaf) — but it removes the false-positive stale rejections that structural block reads
	 *  otherwise caused (Theorem 5 Bound). Deterministic in query shape, so a coordinator and a
	 *  re-executing validator derive the identical set. */
	getReadDependencies(): ReadDependency[] {
		const result: ReadDependency[] = [];
		for (const [blockId, entry] of this.reads) {
			if (entry.purpose === 'value') {
				result.push({ blockId, revision: entry.revision });
			}
		}
		return result;
	}

	clear(): void {
		this.reads.clear();
	}
}
