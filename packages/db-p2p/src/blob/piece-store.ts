import type { PieceId } from '@optimystic/db-core';
import type { StoreDurability } from '../storage/store-durability.js';
import type { StoreIdentity } from '../storage/store-identity.js';

/**
 * A node's store of blob pieces: immutable bytes keyed by the piece's content identifier, in the one
 * canonical spelling `PieceId` has. Equal bytes have one key, so a raw piece and a list piece with
 * the same bytes share one entry.
 *
 * The store never hashes. Its one writer, the blob service, checks every piece against its id
 * before `put`; a store handed bytes that do not hash to their id keeps them as given.
 *
 * Deliberately not a logical store of `RawStoreDriver`: that kernel JSON-encodes every value and
 * stages writes in memory, which is wrong for megabytes of immutable bytes that need no cross-key
 * atomicity (docs/blobs.md §The local store). Every implementation passes `runPieceStoreConformance`
 * (`@optimystic/db-p2p/testing/conformance`).
 */
export interface IPieceStore {
	/** Whether a complete piece is stored under `id`. */
	has(id: PieceId): Promise<boolean>;
	/**
	 * The stored bytes, or `undefined`. Each call returns bytes no one else holds: the caller may
	 * modify them without changing what is stored or what a later `get` returns. A backend may return
	 * a `Uint8Array` subclass (Node's `Buffer`).
	 */
	get(id: PieceId): Promise<Uint8Array | undefined>;
	/**
	 * Store `bytes` under `id`. Once it resolves, `has` and `get` see the piece (in this process).
	 * When `id` is already present it writes nothing and resolves, whatever `bytes` holds. Two
	 * concurrent puts of one id both resolve, with the piece stored once. The store keeps its own
	 * copy: the caller may modify `bytes` once the call has resolved. A zero-length piece is a piece.
	 */
	put(id: PieceId, bytes: Uint8Array): Promise<void>;
	/** Remove the piece; resolves without effect when it is absent. */
	delete(id: PieceId): Promise<void>;
	/**
	 * Every stored id, each once. The backend drains each native cursor or directory listing before
	 * yielding from it (the drain-before-yield rule on `RawStoreDriver`). Against concurrent writes it
	 * promises only this: every id present for the whole of the call is yielded; an id put during the
	 * call may be missing, and an id deleted during the call may still be yielded. Nothing that is
	 * not a complete piece is ever yielded.
	 */
	list(): AsyncIterable<PieceId>;
	/** The bytes the stored pieces occupy, by the backend's cheapest honest measure. */
	bytesUsed(): Promise<number>;
	/**
	 * Make every put and delete that resolved before this call survive the crashes `durability`
	 * names, before resolving. Rules 1, 2 and 4 of the flush contract on `RawStoreDriver.flush` apply
	 * (with no `withinMs`: every piece-store flush is strict). Rule 3, the prefix rule, does not:
	 * pieces are independent, and a piece may survive a crash that took one put before it. The one
	 * ordering a caller needs (pieces before the record naming them) it gets by awaiting `flush`
	 * before writing the record. A rejected flush is a storage fault: the caller treats every write
	 * it covered as possibly lost.
	 */
	flush(): Promise<void>;
	/** What a flushed write survives. Fixed at construction. */
	readonly durability: StoreDurability;
	/**
	 * Optional: the identity of the location this store lives inside, in the scheme block stores use
	 * (`RawStoreDriver.storeIdentity`). Equal to a block store's `getStoreIdentity()` exactly when
	 * that block store's `getApproximateBytesUsed` already measures this store's bytes, which is
	 * what `StorageMonitor` reads it for (`blockStoreCountsPieces`). Omitted by a store that lives
	 * nowhere a block store measures (memory); never a stub returning `undefined`.
	 */
	storeIdentity?(): StoreIdentity;
	/** Optional: flush, then release any handle. */
	close?(): Promise<void>;
}
