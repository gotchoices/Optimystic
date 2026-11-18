import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';

/** One child of a list piece: the piece it names and the sizes kubo records for it. */
export interface ListChild {
	readonly cid: CID;
	/** Bytes of blob content under the child (its leaf length, or the sum of its own children's). */
	readonly fileBytes: number;
	/** Bytes of every piece under the child, the child included: a leaf's length, or a list piece's own encoded length plus its children's `treeBytes`. */
	readonly treeBytes: number;
}

/**
 * dag-pb bytes of a UnixFS file node over `children`, in order, exactly as kubo writes it. Three
 * details decide the bytes and the vectors in `test/blob-builder.spec.ts` pin them: every link
 * carries an empty `Name` (an absent name encodes differently), `Tsize` is the child's cumulative
 * size, and `marshal` writes `filesize` as the sum of `blockSizes` with no mode or mtime.
 */
export function encodeListPiece(children: readonly ListChild[]): Uint8Array {
	const data = new UnixFS({ type: 'file', blockSizes: children.map(child => BigInt(child.fileBytes)) });
	return dagPb.encode({
		Data: data.marshal(),
		Links: children.map(child => ({ Hash: child.cid, Name: '', Tsize: child.treeBytes })),
	});
}
