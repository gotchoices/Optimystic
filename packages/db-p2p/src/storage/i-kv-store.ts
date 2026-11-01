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
}
