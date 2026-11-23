/**
 * What the specs hand the plugin's `storageFactory`, now that a network's storage is one value
 * (`NodeStorage`) rather than a block-storage factory and a blob-storage factory.
 *
 * Most specs here care only about blocks: they ran over a `FileRawStorage` or a `MemoryRawStorage`
 * and left the plugin's blob pieces and records to the in-memory default. {@link blocksOnly} says
 * exactly that, so the conversion changed no spec's behaviour.
 */

import { MemoryKVStore, MemoryPieceStore, type IRawStorage, type NodeStorage } from '@optimystic/db-p2p';

/**
 * A network's storage whose blocks are `blocks` and whose blob pieces and blob records are fresh and
 * in memory — the shape a spec that only ever supplied a block store was already running on.
 *
 * A spec that needs DURABLE blobs builds the whole value instead: `fileNodeStorage(dir)` from
 * `@optimystic/db-p2p-storage-fs` for one directory's three stores, or a value over stores it holds
 * itself and hands to each of several plugin handles, as `blob-pins-harness.ts` does for its
 * restarts.
 */
export function blocksOnly(blocks: IRawStorage): NodeStorage {
	return { blocks, kv: new MemoryKVStore(), pieces: new MemoryPieceStore() };
}
