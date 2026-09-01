/**
 * Introspection of a `RepoMessage`'s own operations — what a record touches and which action it
 * names. Pure functions of their arguments, with no dependency on cluster member state, so the
 * conflict/race path and the membership admission gate can share one definition of each.
 */
import type { RepoMessage } from "@optimystic/db-core";
import { blockIdsForTransforms } from "@optimystic/db-core";

/**
 * Every block id the message's own operations name. Two consumers, deliberately sharing one
 * definition: conflict detection (which writes must serialize against each other) and the membership
 * admission gate's binding check in `cluster-repo.ts` (the set a legitimate `coordinatingBlockIds[0]`
 * must come from — the check inside `deriveExpectedClusterView`, which makes a record naming anything
 * else inadmissible). If the two ever disagreed, a coordinator could name a block the record is not
 * judged to touch — so keep exactly one definition of this function and import it, never copy it.
 */
export function getAffectedBlockIds(operations: RepoMessage['operations']): string[] {
	const blockIds = new Set<string>();

	for (const operation of operations) {
		if ('get' in operation) {
			operation.get.blockIds.forEach(id => blockIds.add(id));
		} else if ('pend' in operation) {
			// Use blockIdsForTransforms to correctly extract block IDs from Transforms structure
			blockIdsForTransforms(operation.pend.transforms).forEach(id => blockIds.add(id));
		} else if ('commit' in operation) {
			operation.commit.blockIds.forEach(id => blockIds.add(id));
		} else if ('cancel' in operation) {
			operation.cancel.actionRef.blockIds.forEach(id => blockIds.add(id));
		} else if ('invalidate' in operation) {
			// The invalidation writes compensating revisions to these blocks; surfacing them lets
			// conflict detection serialize a concurrent commit racing the invalidation on a block.
			operation.invalidate.blockIds.forEach(id => blockIds.add(id));
		}
	}

	return Array.from(blockIds);
}

/**
 * The action id the message names, or `undefined` if it names none. `pend`, `commit` and `cancel`
 * each carry one; `get` and `invalidate` do not — an `invalidate` deliberately does NOT surface its
 * `invalidatedActionId`, which names the action being reversed rather than this message's own, and
 * would otherwise tell `operationsConflict` that an invalidation and the pend it reverses are "the
 * same action" and need not serialize. `RepoMessage.operations` is a one-element tuple, so the scan
 * is a formality; it returns on the first operation that carries an id either way.
 */
export function getActionId(operations: RepoMessage['operations']): string | undefined {
	for (const operation of operations) {
		if ('pend' in operation) {
			return operation.pend.actionId;
		} else if ('commit' in operation) {
			return operation.commit.actionId;
		} else if ('cancel' in operation) {
			return operation.cancel.actionRef.actionId;
		}
	}
	return undefined;
}
