import type { PieceId } from './blob-ref.js';

/** Where a builder puts the pieces it makes, in an order where every piece follows the pieces it names. */
export interface PieceSink {
	put(id: PieceId, bytes: Uint8Array): Promise<void>;
}

/** Where a reader gets pieces from. A node's piece store satisfies both this and {@link PieceSink}. */
export interface PieceSource {
	get(id: PieceId): Promise<Uint8Array | undefined>;
	/** Optional: lets a tree walk learn whether a data piece is here without reading it. */
	has?(id: PieceId): Promise<boolean>;
	/** True only when every piece `get` returns has already been checked against its id, as a piece store's are (it admits only checked pieces). The reader then skips hashing; it still decodes and bounds every list piece. A source that returns bytes from another machine unchecked must leave this unset. */
	readonly verified?: boolean;
}
