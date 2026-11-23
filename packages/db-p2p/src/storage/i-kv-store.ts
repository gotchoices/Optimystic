import type { StoreIdentity } from "./store-identity.js";

/** Portable async key-value store. Platform packages provide implementations. */
export interface IKVStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	/** Return all keys matching the given prefix */
	list(prefix: string): Promise<string[]>;
	/**
	 * Make every write that resolved before this call as durable as the store can make it, under the
	 * flush contract stated on `RawStoreDriver.flush` (`packages/db-p2p/src/storage/raw-store-driver.ts`).
	 *
	 * Optional, unlike the raw-storage `flush`, because hosts implement this interface outside this
	 * repository. Absent means every write is already as durable as it will ever be when it resolves.
	 */
	flush?(): Promise<void>;

	/**
	 * Optional: the identity of the location this store lives inside, in the scheme block stores use
	 * (`RawStoreDriver.storeIdentity`). Equal to a block store's `getStoreIdentity()` exactly when
	 * this store's records sit inside the location that block store measures whole — which is what
	 * `assertOneMeasuredLocation` (`packages/db-p2p/src/storage/store-coverage.ts`) checks of every
	 * `NodeStorage` a platform factory builds, so a node's own bookkeeping is counted toward its use
	 * by construction rather than by coincidence.
	 *
	 * The contract is `IPieceStore.storeIdentity`'s, and is ONE-DIRECTIONAL: two stores over
	 * DIFFERENT locations never report equal strings, so **equality proves one location**; two over
	 * the SAME location should report equal strings but several backends knowingly
	 * under-approximate (two handles over one database, two spellings of one directory), so
	 * **inequality proves nothing**. Omitted by a store that lives nowhere a block store measures
	 * (memory); never a stub returning `undefined`.
	 */
	storeIdentity?(): StoreIdentity;

	// NOTE: there is deliberately no `bytesUsed` on this interface. In every shipping backend this
	// store lives inside the location the block store measures whole, so a figure of its own would
	// have no consumer, and an interface member nobody implements is worse than none. A backend that
	// ever keeps its key-value store somewhere the block store does NOT measure must add a
	// `bytesUsed` to it — the assertion named above will refuse the layout first, and the accounting
	// surface would otherwise report that store's bytes as unmeasured.
}
