/**
 * Introspection of a `RepoMessage`'s own operations — what a record touches and which action it
 * names. Pure functions of their arguments, with no dependency on cluster member state, so the
 * conflict/race path and the membership admission gate can share one definition of each.
 */
import type { BlockId, RepoMessage, RepoOperation } from "@optimystic/db-core";
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
 * same action" and need not serialize. A message of several operations is a batch, which names one
 * action ({@link batchShapeFault}), so the first operation that carries an id names the message's.
 */
export function getActionId(operations: RepoMessage['operations']): string | undefined {
	for (const operation of operations) {
		const actionId = actionIdOf(operation);
		if (actionId !== undefined) {
			return actionId;
		}
	}
	return undefined;
}

/** The action id one operation names; see {@link getActionId} for which operations name none. */
function actionIdOf(operation: RepoOperation): string | undefined {
	if ('pend' in operation) return operation.pend.actionId;
	if ('commit' in operation) return operation.commit.actionId;
	if ('cancel' in operation) return operation.cancel.actionRef.actionId;
	return undefined;
}

/**
 * Why `operations` is not a batch — the shape `RepoMessage.operations` requires of a message of more
 * than one operation: all `pend` or all `commit`, one action id, and no block named by two
 * operations — or `undefined` when it is one. A single operation is trivially a batch. So is an empty
 * list, as far as this check goes: a record carrying no operations binds no coordinating block, and the
 * membership admission gate refuses it with a signed vote rather than this check with a throw.
 *
 * The reason is plain prose for a log line or an error; never branch on it.
 */
export function batchShapeFault(operations: readonly RepoOperation[]): string | undefined {
	if (operations.length <= 1) {
		return undefined;
	}
	const kind = batchKindOf(operations[0]!);
	if (kind === undefined || operations.some(operation => batchKindOf(operation) !== kind)) {
		return `a message of ${operations.length} operations must be all pends or all commits`;
	}
	const actionIds = new Set(operations.map(actionIdOf));
	if (actionIds.size !== 1) {
		return `a batch must name one action; it names ${actionIds.size}`;
	}
	const seen = new Set<BlockId>();
	for (const operation of operations) {
		for (const blockId of batchBlockIdsOf(operation)) {
			if (seen.has(blockId)) {
				return `block ${blockId} appears in two operations of one batch`;
			}
			seen.add(blockId);
		}
	}
	return undefined;
}

/** Which of the two batchable kinds `operation` is, or `undefined` for any other. */
function batchKindOf(operation: RepoOperation): 'pend' | 'commit' | undefined {
	if ('pend' in operation) return 'pend';
	if ('commit' in operation) return 'commit';
	return undefined;
}

/** The blocks one batchable operation writes, each once. */
function batchBlockIdsOf(operation: RepoOperation): ReadonlySet<BlockId> {
	if ('pend' in operation) return new Set(blockIdsForTransforms(operation.pend.transforms));
	if ('commit' in operation) return new Set(operation.commit.blockIds);
	return new Set();
}
