import { assertBlockStoreCountsPieces, type OpenNodeStorage, type StoreIdentity } from '@optimystic/db-p2p';
import { FileRawStorage, type FileRawStorageOptions } from './file-storage.js';
import { FileKVStore, type FileKVStoreOptions } from './file-kv-store.js';
import { FilePieceStore } from './file-piece-store.js';
import { fileStoreIdentity } from './file-write-log.js';

/**
 * Everything the stores over one base path take: the write group's `idleFlushMs` and the directory
 * log's `checkpointBytes` and `checkpointIdleMs`. `FilePieceStore` takes none.
 */
export type FileNodeStorageOptions = FileRawStorageOptions & FileKVStoreOptions;

/** The three stores over one directory, and the holders that have not closed them. */
interface OpenDirectory {
	readonly identity: StoreIdentity;
	readonly blocks: FileRawStorage;
	readonly kv: FileKVStore;
	readonly pieces: FilePieceStore;
	/** Calls of {@link fileNodeStorage} for this directory whose returned `close` has not run. */
	holders: number;
}

/**
 * One set of stores per directory in this process, so two calls over one directory cannot produce
 * two piece stores over it — which `FilePieceStore` does not support, since the second's open
 * deletes the first's in-flight temps and fails its next put.
 */
// NOTE: keyed by `fileStoreIdentity`, the same key the directory's log registry uses, which resolves
// the path and folds case on win32 but does not follow symlinks. So two spellings that resolve
// differently — a symlink and its target, or two cases of one directory on a case-insensitive volume
// off win32 — are two entries and two sets of stores over one directory, which double-counts the
// node's blob pieces and breaks the piece store as above. The same under-approximation
// `identityForHandle` and the log registry make deliberately (the alias NOTE at `fileStoreIdentity`);
// if a host ever reports it, key on `fs.realpath` and make this factory asynchronous.
const openDirectories = new Map<StoreIdentity, OpenDirectory>();

/**
 * All of a node's storage over one directory: the blocks, the node-local records that must survive a
 * restart, and the blob pieces, as the one value `NodeOptions.storage` takes. The three share the
 * base path, so they share one write-ahead log, one lock and one checkpoint, and the block store's
 * byte count already measures the pieces.
 *
 * **One directory means one set of stores.** Two calls over one directory (however spelled, see the
 * `NOTE:` above {@link openDirectories}) hand back the same three store instances, counted; the
 * stores are closed when the last holder closes, and the entry is dropped then, so a call after that
 * opens them afresh. Each returned value's `close` releases its own holder once, so closing twice
 * does not release another holder's stores.
 *
 * Two consequences for a caller that is not an ordinary host:
 *
 * - Holders share the stores' in-memory write groups, where two hand-built instances would each have
 *   their own. A test that needs two INDEPENDENT instances over one directory — one that reads
 *   another's flushed writes from a cold start — constructs `FileRawStorage`, `FileKVStore` and
 *   `FilePieceStore` itself; this factory is for hosts.
 * - A `close()` by a holder that is not the last is a no-op for the stores. A caller that closes to
 *   force a checkpoint and then expects a read from disk gets neither while another holder is alive,
 *   the same shape as a read-cache lease (`packages/db-p2p/docs/storage.md` §6).
 *
 * The node closes nothing it was handed, so the host calls `close()` after `stop()`.
 */
// NOTE: the options are the FIRST caller's. A call over a directory already open shares the stores
// that call opened, so its own options are ignored without a word — the same rule the directory's log
// already applies to its checkpoint settings (`FileWriteLog.acquire`), which at least logs the
// difference. Silent here because a second caller constructs nothing for the log to compare. If a
// host ever needs two option sets over one directory, that is the signal it wants two independent
// sets of stores, which is what constructing them directly is for.
export function fileNodeStorage(basePath: string, options: FileNodeStorageOptions = {}): OpenNodeStorage {
	const identity = fileStoreIdentity(basePath);
	const held = openDirectories.get(identity) ?? openDirectory(identity, basePath, options);
	held.holders += 1;
	return holderOf(held);
}

/**
 * The value one holder gets: the shared stores, and a `close` that releases this holder at most
 * once. A fresh object per call rather than the shared one, because a holder's double `close()` must
 * not be mistaken for two holders each closing.
 */
function holderOf(held: OpenDirectory): OpenNodeStorage {
	let released = false;
	return {
		blocks: held.blocks,
		kv: held.kv,
		pieces: held.pieces,
		close: async () => {
			if (released) return;
			released = true;
			await release(held);
		},
	};
}

/**
 * Opens the three stores and registers them. Synchronous, like each store's constructor, so two
 * callers in one tick cannot both open the directory: nothing is opened on disk until the first
 * operation.
 */
function openDirectory(identity: StoreIdentity, basePath: string, options: FileNodeStorageOptions): OpenDirectory {
	const blocks = new FileRawStorage(basePath, options);
	const kv = new FileKVStore(basePath, options);
	const pieces = new FilePieceStore(basePath);
	// The piece store lives inside the base path, which the block store's byte count measures.
	assertBlockStoreCountsPieces(blocks, pieces, basePath);
	const opened: OpenDirectory = { identity, blocks, kv, pieces, holders: 0 };
	openDirectories.set(identity, opened);
	return opened;
}

/** Gives back one holder; the last one closes the stores. */
async function release(held: OpenDirectory): Promise<void> {
	held.holders -= 1;
	if (held.holders > 0) return;
	// Dropped before the closes are awaited, so a call made during them opens a fresh set rather than
	// being handed stores that are closing. The directory's log already serializes that handover for
	// the block and key-value stores (`FileWriteLog.acquire` waits for a log still letting go of its
	// handle and lock); the piece store holds no handle to wait for.
	if (openDirectories.get(held.identity) === held) openDirectories.delete(held.identity);
	// The block store closes last because the last store over the directory is what checkpoints the
	// shared write-ahead log and removes the lock — the order `openBackend` in
	// `packages/upgrade-check/test/current-build.ts` still uses by hand, that package keeping its own
	// two-directory layout. A rejected close still closes the stores under it, and the holder is gone
	// either way: a host cannot usefully retry a half-closed set.
	try {
		await held.pieces.close();
	} finally {
		try {
			await held.kv.close();
		} finally {
			await held.blocks.close();
		}
	}
}
