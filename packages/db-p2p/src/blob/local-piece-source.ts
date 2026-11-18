import type { PieceSource } from '@optimystic/db-core';
import type { IPieceStore } from './piece-store.js';

/**
 * A node's own pieces as a `PieceSource` marked `verified`: every piece in the store was produced by
 * this node's builder from the bytes themselves, or checked against its id before it was stored, so
 * a local read is not hashed again (the `verified` contract on `PieceSource`).
 */
// NOTE: accepted tradeoff — a data piece whose bytes the disk altered without changing their length
// is served unnoticed by a local read (list pieces are still decoded and bounded, and every size is
// still checked). Hashing every local read was rejected: pure JavaScript hashing costs about 19 s
// per MB on an older phone (docs/blobs.md §References and pieces). Revisit if stores that can
// corrupt in place become a reported fault; replacing a corrupt piece is the transfer ticket's repair.
export function localPieceSource(pieces: IPieceStore): PieceSource {
	return {
		get: id => pieces.get(id),
		has: id => pieces.has(id),
		verified: true,
	};
}
