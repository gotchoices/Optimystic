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
	/** Optional uncommitted pending action to read through. A repo overlays this action's pending
	 *  transform on each block where it holds a pending record of it, and answers every other block
	 *  exactly as a plain read with the same context would; the overlay answer's `state.pendings`
	 *  names the action, the plain one's does not.
	 *
	 *  No production code sets it. It is reserved for tentative reads in long-lived pend (backlog
	 *  `feat-long-lived-pend-completes-as-members-appear`), where a read that observes a
	 *  pended-but-uncommitted revision makes the reading transaction tentative too. It is
	 *  deliberately not used for early abort: the only certain abort signal — a latest revision at
	 *  or past the pended one under another action — is already on a plain read's `state.latest`.
	 *  Whoever sets it must keep the overlay answer out of every cache as committed content: mark it
	 *  `mayRetain: false` through `TransactorSource.describeServed`, and record no read dependency
	 *  for it. The content is no committed revision, and the answer's `materialized` revision names
	 *  the base under the overlay, not the content (see "Staged Edits Keep Their Base" in
	 *  `docs/internals.md`). */
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
