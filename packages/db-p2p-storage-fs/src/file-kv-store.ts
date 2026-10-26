import { promises as fs } from 'fs';
import * as path from 'path';
import { WriteGroup, type CommittedBatch, type FlushOptions, type IKVStore, type SinkCommitOptions, type WriteGroupEntry, type WriteGroupOptions } from '@optimystic/db-p2p';
import { FileWriteLog, assertFileWriteLogOptions, readFileIfExists, type FileWriteLogOptions, type WriteLogEntry } from './file-write-log.js';

/** The write group's `idleFlushMs` and the log's checkpoint settings; `setTimer` (test-only) arms both. */
export type FileKVStoreOptions = WriteGroupOptions & FileWriteLogOptions;

const encoder = new TextEncoder();
// Built on first use rather than at module load, like every other `TextDecoder` in library source
// (see NO_MODULE_SCOPE_TEXT_DECODER in eslint.config.js).
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

/**
 * Filesystem-backed {@link IKVStore}: each key is the file `<basePath>/<key>.json`, a `/` in the key
 * a subdirectory. Writes go through a {@link WriteGroup} over the directory's {@link FileWriteLog} —
 * the same log a `FileRawStorage` over the same directory holds, so the two share one log, one
 * lock and one checkpoint. A `set` or `delete` resolves into memory, served from there to `get` and
 * `list`; `flush()` appends everything written since the last flush to the log as one record, synced
 * before the flush resolves or within the window the flush allows (`FileWriteLog.commit`). A write
 * no flush reaches is flushed by the group's idle timer.
 *
 * The constructor is synchronous and holds nothing: the log is acquired, the lock taken and the log
 * replayed on the first operation. `close()` flushes what is still held and releases this store's
 * reference to the log.
 */
export class FileKVStore implements IKVStore {
	private readonly basePath: string;
	private readonly options: FileWriteLogOptions;
	private readonly group: WriteGroup<string>;
	private log: FileWriteLog | undefined;

	constructor(basePath: string, options: FileKVStoreOptions = {}) {
		assertFileWriteLogOptions(options);
		this.basePath = path.resolve(basePath);
		this.options = options;
		this.group = new WriteGroup<string>(key => key, {
			commit: (entries, commitOptions) => this.commit(entries, commitOptions),
			// A store that never committed holds no log, and so has nothing to hasten.
			sync: () => this.log?.sync() ?? Promise.resolve(),
		}, options);
	}

	async get(key: string): Promise<string | undefined> {
		const held = this.group.lookup(key);
		if (held !== undefined) return held === null ? undefined : decoder().decode(held);
		await this.open();
		const bytes = await readFileIfExists(this.keyToPath(key));
		return bytes === undefined ? undefined : decoder().decode(bytes);
	}

	async set(key: string, value: string): Promise<void> {
		this.group.put(key, encoder.encode(value));
	}

	async delete(key: string): Promise<void> {
		this.group.delete(key);
	}

	/**
	 * Every key under `prefix`, which names a directory: it ends in `/`, as every prefix the node
	 * lists by does. The tree's keys, plus those written and not yet flushed, less those deleted and
	 * not yet flushed.
	 */
	async list(prefix: string): Promise<string[]> {
		// Taken before awaiting the tree: a commit resolving meanwhile drops entries from the overlay
		// that the listing below may have been taken without.
		const held = [...this.group.entries()].filter(([key]) => key.startsWith(prefix));
		await this.open();
		const keys = new Set<string>();
		await this.listRecursive(path.join(this.basePath, ...prefix.split('/').filter(Boolean)), prefix, keys);
		for (const [key, value] of held) {
			if (value === null) keys.delete(key);
			else keys.add(key);
		}
		return [...keys];
	}

	/** Make every write resolved before this call durable, at once or within `options.withinMs`: one log record, synced by then. The contract is `RawStoreDriver.flush`'s. */
	flush(options?: FlushOptions): Promise<void> {
		return this.group.flush(options);
	}

	/** Resolves once every write covered by a flush that resolved before this call is durable; `RawStoreDriver.whenDurable`'s contract. */
	whenDurable(): Promise<void> {
		return this.group.whenDurable();
	}

	/** Flush what is still held, then release this store's reference to the directory's log. */
	async close(): Promise<void> {
		try {
			await this.group.close();
		} finally {
			const shared = this.log;
			this.log = undefined;
			await shared?.release();
		}
	}

	private commit(entries: readonly WriteGroupEntry<string>[], options: SinkCommitOptions): Promise<CommittedBatch> {
		return this.shared().commit(entries.map(({ key, value }): WriteLogEntry => value === undefined
			? { kind: 'delete', path: this.keyToRelative(key) }
			: { kind: 'put', path: this.keyToRelative(key), value }), options);
	}

	private shared(): FileWriteLog {
		return this.log ??= FileWriteLog.acquire(this.basePath, this.options);
	}

	private open(): Promise<void> {
		return this.shared().open();
	}

	private async listRecursive(dirPath: string, prefix: string, results: Set<string>): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await this.listRecursive(path.join(dirPath, entry.name), prefix + entry.name + '/', results);
			} else if (entry.isFile() && entry.name.endsWith('.json')) {
				results.add(prefix + entry.name.slice(0, -5));
			}
		}
	}

	/** The key's file relative to the store's directory, forward slashes, as the log records it. */
	private keyToRelative(key: string): string {
		return `${key}.json`;
	}

	private keyToPath(key: string): string {
		// NOTE: `/`-separated keys become nested dirs, so a key's first segment shares the top-level
		// namespace with FileRawStorage's <blockId>/ dirs. Safe while no block id's first segment
		// (a block id containing `/` nests too) equals a key's first segment — the node's keys all start with a fixed word (`under-replicated`,
		// `coordinator`, `participant`, `executed`, and the Quereus plugin's offline journal's `optimystic-offline`) — and if one ever could, give the two stores
		// separate basePaths (see README Usage). FileRawStorage.listBlockIds walks the tree but skips
		// these root namespaces (db-p2p's NODE_KV_NAMESPACES — a new namespace must be added there),
		// so a KV key whose last segment is `meta` is never enumerated as a block. Their bytes do
		// count toward FileRawStorage.getApproximateBytesUsed.
		return path.join(this.basePath, ...key.split('/')) + '.json';
	}
}
