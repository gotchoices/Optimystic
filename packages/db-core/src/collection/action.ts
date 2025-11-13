import type { BlockStore } from "../index.js";
import type { IBlock } from "../index.js";

export type ActionId = string;

export type ActionType = string;

export type Action<T> = {
	type: ActionType;
	data: T;
};

export type ActionHandler<T> = (action: Action<T>, store: BlockStore<IBlock>) => Promise<void>;

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

