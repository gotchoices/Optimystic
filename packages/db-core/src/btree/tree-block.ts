import type { BlockId, IBlock } from "../blocks/index.js";
import { registerBlockType } from "../blocks/index.js";
import { nameof } from "../utility/nameof.js";

export const TreeRootBlockType = registerBlockType("TR", "TreeRoot");

export interface TreeBlock extends IBlock {
	rootId: BlockId;
}

export const rootId$ = nameof<TreeBlock>("rootId");
