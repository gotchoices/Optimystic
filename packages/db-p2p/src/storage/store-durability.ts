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
