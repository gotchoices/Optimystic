import type { IPieceStore } from '../blob/piece-store.js';
import type { IRawStorage } from './i-raw-storage.js';
import type { NodeStorage } from './node-storage.js';

/**
 * Whether `storage`'s `getApproximateBytesUsed` already measures `pieces`' bytes. Every disk block
 * store measures its whole directory or database, so a piece store inside the same location is
 * counted there and adding its own figure would count it twice. Decided by store identity, whose
 * contract is one-directional: equal identities prove one location, so the piece bytes are left
 * out; anything else (either identity absent, two different strings, or a block store with no
 * `getApproximateBytesUsed`, which measures nothing) adds them.
 *
 * This is the fallback rule for a hand-built or memory `NodeStorage`, where no identity is
 * reported; a storage a platform factory built has passed {@link assertOneMeasuredLocation}, so the
 * answer there is always "yes".
 */
// NOTE: two spellings of one location read as two identities, so a piece store over a differently
// spelled path to the block store's directory is counted twice. That errs toward reporting the node
// fuller than it is, which delays nothing and moves a ring outward at worst; revisit if a host reports it.
export function blockStoreCountsPieces(storage: IRawStorage, pieces: IPieceStore): boolean {
	if (typeof storage.getApproximateBytesUsed !== 'function') return false;
	const blockIdentity = storage.getStoreIdentity?.();
	return blockIdentity !== undefined && blockIdentity === pieces.storeIdentity?.();
}

/**
 * Throws unless all three of a {@link NodeStorage}'s stores live inside ONE location the block
 * store measures whole: the block store has a `getApproximateBytesUsed`, it reports a
 * `getStoreIdentity()`, and both the key-value store's and the piece store's `storeIdentity()`
 * equal it. Each storage package's `*NodeStorage` factory calls this before it returns, so an edit
 * that moved either of the other two elsewhere — a sibling directory, a second handle opened inside
 * the factory — fails loudly on the first open instead of quietly leaving those bytes out of every
 * figure the node reports about itself. Two comparisons of strings.
 *
 * What each part would cost silently: pieces outside the measured location are counted twice (the
 * block store's figure plus the piece store's, which is what {@link blockStoreCountsPieces} decides
 * and what this assertion makes unnecessary to decide), while a key-value store outside it is
 * counted not at all — nothing reports its bytes, because `IKVStore` has no `bytesUsed` and the
 * reason it has none is this assertion (see the `NOTE:` at `IKVStore.storeIdentity`).
 *
 * `location` is the one place all three were built over, named for the message: a base path, or a
 * phrase for a handle the caller passed.
 */
export function assertOneMeasuredLocation(storage: NodeStorage, location: string): void {
	const { blocks, kv, pieces } = storage;
	if (typeof blocks.getApproximateBytesUsed !== 'function') {
		throw new Error(`The block store opened over ${location} measures no bytes, so a node over it could not report how much of its allotment it has used`);
	}
	const measured = blocks.getStoreIdentity?.();
	if (measured === undefined) {
		throw new Error(`The block store opened over ${location} reports no store identity, so nothing can check that the node's other stores are inside what it measures`);
	}
	const disagreeing = [
		['kv', kv.storeIdentity?.()] as const,
		['pieces', pieces.storeIdentity?.()] as const,
	].filter(([, identity]) => identity !== measured);
	if (disagreeing.length > 0) {
		const named = disagreeing.map(([part, identity]) => `${part} ${identity}`).join(', ');
		throw new Error(`The stores opened over ${location} report more than one location (blocks ${measured}, ${named}), so a node over them would not count every byte it stores against one allotment`);
	}
}
