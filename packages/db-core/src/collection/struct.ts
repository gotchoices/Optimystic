import type { IBlock, BlockId, Action } from "../index.js";
import type { IChainHeader } from "../chain/chain-nodes.js";

export type CollectionId = BlockId;

export type CollectionHeaderType = 'CH';

export type CollectionHeaderBlock = IBlock & Partial<IChainHeader> & {
	header: {
		type: CollectionHeaderType;
	};
};

export interface ICollection<TAction> {
	update(): Promise<void>;
	sync(): Promise<void>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
