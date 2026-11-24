/**
 * The domain-wide name of one block. Either a base64url-encoded random id (256-bit, what a writer
 * mints for an ordinary block) or a human-named `/`-separated collection path such as
 * `default/app/Ledger` — a store may lay the latter out as nested directories. Not every string is
 * one: see `isValidBlockId` in `block-id.ts` for the rule, and `assertValidBlockId` for where it is
 * enforced.
 */
export type BlockId = string;
export type BlockType = string;	// Generally a short code

export type BlockHeader = {
	id: BlockId;  // Domain wide block identifier
	type: BlockType;
	collectionId: BlockId;
}

/** A simple block with only a header.  Blocks should be treated as immutable */
export type IBlock = {
	header: BlockHeader;
}

export type BlockOperation = [entity: string, index: number, deleteCount: number, inserted: unknown[] | unknown]
export type BlockOperations = BlockOperation[];

