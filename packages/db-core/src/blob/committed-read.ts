import type { CollectionId } from '../collection/struct.js';
import { Tree } from '../collections/tree/tree.js';
import { createLogger } from '../logger.js';
import { BlockPossiblyStaleError, BlockUnavailableError } from '../network/struct.js';
import type { ITransactor } from '../transactor/transactor.js';

const log = createLogger('blob');

/** The key of a reference-tree or scope-registry entry: its first element. Both trees are opened
 * with it and the default comparator, so the SQL plugin's collection factory, whose key extractor is
 * the same, opens the same trees. */
export function pairEntryKey(entry: readonly [string, string]): string {
	return entry[0];
}

/** What a committed read established besides what its pass collected: whether the tree has ever
 * been written, and whether an answer it did not find is known to be absent. */
export type CommittedTreeRead = { exists: boolean; certain: boolean };

/**
 * Open the committed tree `id` on a fresh, read-only handle (`Tree.open`) and run `pass` over it.
 * The handle is never staged into, so the pass reads committed state only; a fresh open adopts the
 * newest committed revision it is told of; and nothing else touches the handle, so no path the
 * pass holds is invalidated mid-pass. Shared by every blob reader so they cannot differ on what is
 * certain.
 *
 * Certain exactly when the open and the pass completed, neither threw `BlockUnavailableError` or
 * `BlockPossiblyStaleError`, and the handle received no below-floor answer. A tree never written is
 * `{ exists: false, certain: true }`. The two errors are caught, logged and answered uncertain,
 * keeping whatever the pass had already collected; any other error propagates, since it is a fault
 * and every caller already treats a throw as "not certain".
 *
 * Limit: a fresh handle's floors come from the entries of its log tail block, so a stale answer for
 * a block last changed by an entry in an older log block has no floor and is not detected — the
 * limit every reader here has (docs/blobs.md §Registering references).
 */
export async function readCommittedTree<TEntry extends [string, string]>(
	transactor: ITransactor,
	id: CollectionId,
	pass: (tree: Tree<string, TEntry>) => Promise<void>,
): Promise<CommittedTreeRead> {
	let tree: Tree<string, TEntry> | undefined;
	try {
		tree = await Tree.open<string, TEntry>(transactor, id, pairEntryKey);
	} catch (error) {
		// Something answered that the header might exist; the caller reads `certain: false` either way.
		return { exists: true, certain: uncertainOrRethrow(id, error) };
	}
	if (tree === undefined) {
		return { exists: false, certain: true };
	}
	try {
		await pass(tree);
	} catch (error) {
		return { exists: true, certain: uncertainOrRethrow(id, error) };
	}
	const belowFloor = tree.getCollection().belowFloorAnswerCount();
	if (belowFloor > 0) {
		log('blob:read-uncertain id=%s cause=below-floor detail=%d', id, belowFloor);
		return { exists: true, certain: false };
	}
	return { exists: true, certain: true };
}

/** Log a read that could not be trusted and answer `false` (not certain); rethrow anything else. */
function uncertainOrRethrow(id: CollectionId, error: unknown): false {
	if (error instanceof BlockUnavailableError) {
		log('blob:read-uncertain id=%s cause=unavailable detail=%s', id, error.reason);
	} else if (error instanceof BlockPossiblyStaleError) {
		log('blob:read-uncertain id=%s cause=possibly-stale detail=%d', id, error.claimedRev);
	} else {
		throw error;
	}
	return false;
}
