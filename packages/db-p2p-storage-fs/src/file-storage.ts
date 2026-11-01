import type { BlockId } from "@optimystic/db-core";
import { KvRawStorage, WriteGroupDriver, type StoreIdentity, type WriteGroupOptions } from "@optimystic/db-p2p";
import { FileBatchBackend } from './file-batch-backend.js';
import type { FileWriteLogOptions } from './file-write-log.js';

/**
 * The write group's `idleFlushMs` and the directory log's `checkpointBytes` and `checkpointIdleMs`
 * (see `WriteGroupOptions` and `FileWriteLogOptions`); the test-only `setTimer` arms both.
 */
export type FileRawStorageOptions = WriteGroupOptions & FileWriteLogOptions;

/**
 * Filesystem-backed {@link IRawStorage}: the shared {@link KvRawStorage} kernel over a
 * {@link WriteGroupDriver} over a {@link FileBatchBackend}. Every write resolves into the driver's
 * in-memory overlay; `flush()` hands the group to the backend as one batch, which appends it to
 * `<basePath>/write-ahead.log` with one sync and then writes the tree. The public constructor
 * (`new FileRawStorage(basePath, options?)`) is synchronous: the lock is taken and the log replayed
 * on the first operation.
 *
 * `listBlockIds`/`getApproximateBytesUsed`/`getStoreIdentity`/`close` are re-declared here as
 * always-present (the fs backend always implements the first three, so the driver and kernel always
 * wire them, and the driver always has a `close`) — the base declares them optional, but every fs
 * consumer relies on them. `close()` flushes what is still held, releases this store's reference to
 * the directory's shared log, and — for the last store over the directory — checkpoints the log,
 * closes it and removes the lock.
 */
export class FileRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;
	declare getStoreIdentity: () => StoreIdentity;
	declare close: () => Promise<void>;

	constructor(basePath: string, options: FileRawStorageOptions = {}) {
		super(new WriteGroupDriver(new FileBatchBackend(basePath, options), options));
	}
}
