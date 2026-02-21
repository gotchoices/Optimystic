import type { CollectionAcl, Permission } from './struct.js';

const permissionRank: Record<Permission, number> = {
	read: 0,
	write: 1,
	admin: 2,
};

/** Returns true when `granted` is at least as permissive as `required`. */
export function hasAtLeast(granted: Permission, required: Permission): boolean {
	return permissionRank[granted] >= permissionRank[required];
}

/**
 * Check whether `peerId` satisfies the `required` permission level.
 *
 * When `acl` is undefined the collection is open (everyone has write access).
 */
export function checkPermission(
	acl: CollectionAcl | undefined,
	peerId: string,
	required: Permission,
): boolean {
	if (!acl) {
		return hasAtLeast('write', required);
	}
	const granted = acl.grants[peerId] ?? acl.defaultPermission ?? 'write';
	return hasAtLeast(granted, required);
}

/** Create a default ACL granting admin to the creator; everyone else gets read. */
export function createDefaultAcl(creatorPeerId: string): CollectionAcl {
	return {
		defaultPermission: 'read',
		grants: { [creatorPeerId]: 'admin' },
	};
}
