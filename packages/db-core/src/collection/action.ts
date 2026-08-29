import type { BlockStore } from "../index.js";
import type { IBlock } from "../index.js";
import type { TransactionRef } from "../transaction/index.js";

export type ActionId = string;

export type ActionType = string;

export type Action<T> = {
	type: ActionType;
	data: T;
	/** Optional reference to the transaction this action came from */
	transaction?: TransactionRef;
};

export type ActionHandler<T, TResult = void> = (action: Action<T>, store: BlockStore<IBlock>) => Promise<TResult>;

export type ActionRev = {
	actionId: ActionId;
	rev: number;
};

/** Situational awareness of the action state */
export type ActionContext = {
	/** Actions that may not have been checkpointed */
	committed: ActionRev[];
	/** The latest known revision number */
	rev: number;
	/** Optional uncommitted pending action ID */
	actionId?: ActionId;
};

/** The id of the action that produced `rev` within `context`'s uncheckpointed committed list,
 * or `undefined` when the list names no action at that revision.
 *
 * `undefined` is legitimate, not an error, and has three causes: the revision's log slot belongs
 * to an entry that carries no action (a CHECKPOINT or an INVALIDATION entry takes a revision of
 * its own); `rev` predates the most recent checkpoint, which is as far back as a context read off
 * a log reaches (`Log.getActionContext`, `Log.getFrom`); or the context was never built from a
 * log at all. A caller printing this must carry a placeholder rather than invent an id.
 *
 * NOTE: linear in `committed`, which grows one entry per commit between context reads; fine now —
 * every caller is a `debug`-gated diagnostic, so this does not run on a normal path at all. If a
 * non-diagnostic caller ever appears, index the lookup or search from the end (the entry at the
 * context's own `rev` is normally the last one). */
export function actionIdAt(context: ActionContext, rev: number): ActionId | undefined {
	return context.committed.find(entry => entry.rev === rev)?.actionId;
}
