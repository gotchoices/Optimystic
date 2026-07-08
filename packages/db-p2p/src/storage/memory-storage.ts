import { KvRawStorage } from "./kv-raw-storage.js";
import { MemoryStoreDriver } from "./memory-store-driver.js";

/**
 * In-memory {@link IRawStorage}, now a thin shell over the shared
 * {@link KvRawStorage} kernel backed by a {@link MemoryStoreDriver}.
 *
 * @pitfall The old hand-rolled version had to `structuredClone` on every get and
 * put — otherwise callers mutating a returned/stored object corrupted the store
 * (see docs/internals.md "Storage Returns References"). That discipline is GONE
 * and must not be reintroduced: values cross the driver boundary as
 * `Uint8Array` produced by `JSON`-encode and consumed by `JSON`-decode, so every
 * read decodes a fresh object and every write stored an independent byte
 * snapshot BY CONSTRUCTION. The clone-on-store / clone-on-read invariant is now
 * structural, not a rule. The conformance suite asserts it so a future driver
 * that shortcuts the byte boundary is caught.
 *
 * The name is kept stable so existing imports (`from '@optimystic/db-p2p'`)
 * continue to resolve.
 */
export class MemoryRawStorage extends KvRawStorage {
	constructor() {
		super(new MemoryStoreDriver());
	}
}
