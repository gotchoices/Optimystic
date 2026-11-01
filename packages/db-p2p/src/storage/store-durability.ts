/**
 * What a write survives once a `flush()` called after it has resolved.
 * - 'none'          — nothing survives a restart (in-memory).
 * - 'process-crash' — survives this process crashing; NOT an operating-system crash or power cut.
 * - 'power-loss'    — survives a power cut or operating-system crash.
 *
 * A store's value is fixed at construction and never changes over its life, the same as its
 * `storeIdentity`. See the flush contract on `RawStoreDriver.flush`.
 */
export type StoreDurability = 'none' | 'process-crash' | 'power-loss';

/**
 * Options of `flush()` on `RawStoreDriver` and `IRawStorage`; the contract is on `RawStoreDriver.flush`
 * in `packages/db-p2p/src/storage/raw-store-driver.ts`.
 */
export interface FlushOptions {
	/**
	 * How long after this call the writes it covers may stay exposed to a crash the store's
	 * `durability` names. Absent or 0: the flush resolves only once they survive it (the contract
	 * before this option). A store that cannot defer a sync treats every value as 0.
	 */
	readonly withinMs?: number;
}
