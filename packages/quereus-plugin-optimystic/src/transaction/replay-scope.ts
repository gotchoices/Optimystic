/**
 * replay-scope — whether the statements running on a `Database` right now are a REPLAY of a
 * replicated transaction rather than a host's own write (docs/blobs.md §Registering references,
 * *Under transaction validation*).
 *
 * A validating member re-executes a transaction's statements through
 * {@link QuereusEngine.execute}, so its vtab stages the same rows and the same reference-tree
 * entries as the writer's — which is the point. What it must NOT do is act on the bytes: it has
 * none, so it must neither pin a reference nor announce one ("Members never check whether the
 * bytes exist"). The vtab cannot tell the two apart from anything it holds, so the engine says so
 * for the duration of the re-execution and the recording site asks.
 *
 * A counter rather than a flag, so nesting counts; per `Database` rather than global, so one
 * process validating for one `Database` while a host writes through another is exact. Quereus runs
 * one writer at a time per `Database` (its exec mutex), so a count per `Database` cannot be shared
 * by two overlapping executions.
 */

import type { Database } from '@quereus/quereus';

/** How many replays are running on each `Database`; absent means none. */
const depths = new WeakMap<Database, number>();

/** Run `run` with `db` marked as re-executing a replicated transaction. Nested calls count. */
export async function duringReplay<T>(db: Database, run: () => Promise<T>): Promise<T> {
	depths.set(db, (depths.get(db) ?? 0) + 1);
	try {
		return await run();
	} finally {
		const left = (depths.get(db) ?? 1) - 1;
		if (left > 0) depths.set(db, left); else depths.delete(db);
	}
}

/** Whether a replay is running on `db` now. */
export function isReplaying(db: Database): boolean {
	return (depths.get(db) ?? 0) > 0;
}
