import type { IBlock, BlockId, Action } from "../index.js";

export type CollectionId = BlockId;

export type CollectionHeaderType = 'CH';

/** Access permission levels, ordered: read < write < admin. */
export type Permission = 'read' | 'write' | 'admin';

/** Per-collection access control list stored in the header block. */
export type CollectionAcl = {
	/** Default permission for peers not explicitly listed. Defaults to 'write' (open) when absent. */
	defaultPermission?: Permission;
	/** Per-peer grants keyed by PeerId string. */
	grants: Record<string, Permission>;
};

export type CollectionHeaderBlock = IBlock & {
	header: {
		type: CollectionHeaderType;
	};
	/** Collection-level access control. When undefined, the collection is open. */
	acl?: CollectionAcl;
};

export interface ICollection<TAction> {
	update(): Promise<void>;
	sync(): Promise<void>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
