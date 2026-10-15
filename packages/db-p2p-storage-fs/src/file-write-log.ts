import { promises as fs } from 'fs';
import * as path from 'path';
import { crc32 } from 'zlib';
import { StoreFailedError, type StoreIdentity } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';
import { acquireStoreLock, StoreLockedError, type StoreLock } from './store-lock.js';

const log = createLogger('write-log');

export const WRITE_LOG_FILENAME = 'write-ahead.log';

/**
 * The log's fixed header: the magic bytes `OPTIMYSTIC-WAL`, then one format-version byte. A file
 * that does not start with exactly this is not a log this build wrote, and replay applies nothing
 * from it.
 */
export const WRITE_LOG_FORMAT_VERSION = 1;

// `TextEncoder` is fine at module scope everywhere (see the Hermes note in eslint.config.js); a
// `TextDecoder` is built on first use, like every other one in library source.
const encoder = new TextEncoder();
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

export const WRITE_LOG_HEADER: Uint8Array = concat([encoder.encode('OPTIMYSTIC-WAL'), Uint8Array.of(WRITE_LOG_FORMAT_VERSION)]);

/**
 * One write of a batch. `path` is relative to the store's directory, with forward slashes
 * whatever the platform, so a log written on one platform replays on another.
 */
export type WriteLogEntry =
	| { readonly kind: 'put'; readonly path: string; readonly value: Uint8Array }
	| { readonly kind: 'delete'; readonly path: string };

const KIND_PUT = 1;
const KIND_DELETE = 2;
const RECORD_HEAD_BYTES = 8;
const ENTRY_HEAD_BYTES = 1 + 2 + 4;
const EMPTY = new Uint8Array(0);

// --- record codec ---

/**
 * One record: `[u32 payload length][u32 CRC-32 of the payload][payload]`, little-endian, where the
 * payload is the batch's entries in order, each `[u8 kind][u16 path length][path, UTF-8][u32 value
 * length][value]`. A delete carries a zero-length value.
 */
export function encodeWriteLogRecord(entries: readonly WriteLogEntry[]): Uint8Array {
	const payload = encodePayload(entries);
	const record = new Uint8Array(RECORD_HEAD_BYTES + payload.length);
	const view = new DataView(record.buffer);
	view.setUint32(0, payload.length, true);
	view.setUint32(4, crc32(payload), true);
	record.set(payload, RECORD_HEAD_BYTES);
	return record;
}

function encodePayload(entries: readonly WriteLogEntry[]): Uint8Array {
	const encoded = entries.map(entry => {
		const pathBytes = encoder.encode(entry.path);
		if (pathBytes.length > 0xffff) {
			throw new Error(`write-ahead log path is ${pathBytes.length} bytes, over the 65535 the record format holds: ${entry.path}`);
		}
		return { kind: entry.kind === 'put' ? KIND_PUT : KIND_DELETE, pathBytes, value: entry.kind === 'put' ? entry.value : EMPTY };
	});
	const payload = new Uint8Array(encoded.reduce((total, { pathBytes, value }) => total + ENTRY_HEAD_BYTES + pathBytes.length + value.length, 0));
	const view = new DataView(payload.buffer);
	let offset = 0;
	for (const { kind, pathBytes, value } of encoded) {
		payload[offset] = kind;
		view.setUint16(offset + 1, pathBytes.length, true);
		payload.set(pathBytes, offset + 3);
		view.setUint32(offset + 3 + pathBytes.length, value.length, true);
		payload.set(value, offset + ENTRY_HEAD_BYTES + pathBytes.length);
		offset += ENTRY_HEAD_BYTES + pathBytes.length + value.length;
	}
	return payload;
}

/** Why a strict read of the log stopped before the end of the file. */
export type WriteLogStop = 'bad-header' | 'torn-record' | 'crc-mismatch' | 'bad-entry';

export interface DecodedWriteLog {
	/** Every batch read, in log order. */
	readonly batches: readonly (readonly WriteLogEntry[])[];
	/** The byte offset reading stopped at: the file's length when every byte parsed. */
	readonly stoppedAt: number;
	/** Set when reading stopped short; the batches before the offending record are in `batches`. */
	readonly stoppedBy?: WriteLogStop;
}

/**
 * Read a log strictly: a header that is not ours, a record whose length runs past the end of the
 * file, a CRC that does not match, or an entry that does not parse stops the read before that
 * record. What precedes it is returned in order.
 */
export function decodeWriteLog(bytes: Uint8Array): DecodedWriteLog {
	if (!startsWith(bytes, WRITE_LOG_HEADER)) {
		return { batches: [], stoppedAt: 0, stoppedBy: 'bad-header' };
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const batches: (readonly WriteLogEntry[])[] = [];
	let offset = WRITE_LOG_HEADER.length;
	const stop = (stoppedBy: WriteLogStop): DecodedWriteLog => ({ batches, stoppedAt: offset, stoppedBy });
	while (offset < bytes.length) {
		if (bytes.length - offset < RECORD_HEAD_BYTES) return stop('torn-record');
		const length = view.getUint32(offset, true);
		const crc = view.getUint32(offset + 4, true);
		if (bytes.length - offset - RECORD_HEAD_BYTES < length) return stop('torn-record');
		const payload = bytes.subarray(offset + RECORD_HEAD_BYTES, offset + RECORD_HEAD_BYTES + length);
		if (crc32(payload) !== crc) return stop('crc-mismatch');
		const entries = decodePayload(payload);
		if (entries === undefined) return stop('bad-entry');
		batches.push(entries);
		offset += RECORD_HEAD_BYTES + length;
	}
	return { batches, stoppedAt: offset };
}

/** The payload's entries, or `undefined` when they do not exactly fill it. */
function decodePayload(payload: Uint8Array): WriteLogEntry[] | undefined {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const entries: WriteLogEntry[] = [];
	let offset = 0;
	while (offset < payload.length) {
		if (payload.length - offset < ENTRY_HEAD_BYTES) return undefined;
		const kind = payload[offset]!;
		const pathLength = view.getUint16(offset + 1, true);
		if (payload.length - offset - 3 < pathLength + 4) return undefined;
		const entryPath = decoder().decode(payload.subarray(offset + 3, offset + 3 + pathLength));
		const valueLength = view.getUint32(offset + 3 + pathLength, true);
		const valueStart = offset + ENTRY_HEAD_BYTES + pathLength;
		if (payload.length - valueStart < valueLength) return undefined;
		if (kind === KIND_PUT) {
			entries.push({ kind: 'put', path: entryPath, value: payload.slice(valueStart, valueStart + valueLength) });
		} else if (kind === KIND_DELETE && valueLength === 0) {
			entries.push({ kind: 'delete', path: entryPath });
		} else {
			return undefined;
		}
		offset = valueStart + valueLength;
	}
	return entries;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	if (bytes.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (bytes[i] !== prefix[i]) return false;
	}
	return true;
}

// --- filesystem helpers shared with the backend ---

/** The file's bytes, or `undefined` when there is no such file. Any other error propagates. */
export async function readFileIfExists(filePath: string): Promise<Uint8Array | undefined> {
	try {
		return await fs.readFile(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

/**
 * Best-effort fsync of a directory, so an entry added to, removed from or renamed within it
 * survives power loss. POSIX needs this; platforms that reject opening a directory for fsync
 * throw, and the throw is ignored rather than failing the write.
 *
 * Skipped outright on win32: there `fs.open(dir, 'r')` SUCCEEDS and only the following
 * `handle.sync()` fails with EPERM, so the open/close pair was guaranteed wasted work. Durability
 * is unchanged on win32 (the sync never succeeded there).
 */
export async function fsyncDir(dir: string): Promise<void> {
	if (process.platform === 'win32') return;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(dir, 'r');
		await handle.sync();
	} catch {
		// Directory fsync unsupported here — nothing to do.
	} finally {
		if (handle) await handle.close().catch(() => { /* best-effort */ });
	}
}

/** fsync a file in place; a file that no longer exists is skipped. Opened `r+`: Windows refuses to flush a read-only handle. */
export async function fsyncFile(filePath: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, 'r+');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * The identity every store over `basePath` reports (`RawStoreDriver.storeIdentity`): `file:` and
 * the directory resolved once, here. `path.resolve` is cwd-dependent, and resolving at construction
 * is the correct reading — two stores built from the same RELATIVE path under different cwds
 * genuinely address different directories and must not compare equal. An empty basePath resolves
 * to the cwd; nothing special-cases it. (A whitespace-only basePath is NOT the cwd — `path.resolve`
 * is pure string work, so `' '` names a child directory called `' '`.)
 *
 * Lowercased on win32 because Windows paths are case-insensitive: `C:\Foo` and `C:\foo` are one
 * directory and must produce one identity.
 *
 * NOTE: aliases of one directory that this does NOT collapse, and so read as two identities:
 * symlinks, junctions, UNC-versus-mapped-drive spellings, and case-differing spellings on a
 * case-INSENSITIVE non-Windows volume (the default on macOS) — platform is the only signal
 * available synchronously, and case-folding every darwin path would be wrong on a case-sensitive
 * volume. `fs.realpath` resolves all of these, but it is async (a store's constructor is not) and
 * requires the directory to already exist. Revisit if an alias ever bites. All of these fail in
 * the SAFE direction for the read cache: a missed alias reports two identities for one directory,
 * so an identity-keyed consumer declines to merge and gets today's behavior. For the write-ahead
 * log they fail less safely: two stores over two spellings of one directory open two logs, and
 * the second is refused by the lock.
 * NOTE: the win32 fold is the one branch that can err in the UNSAFE direction — Windows 10+
 * supports per-directory case sensitivity (`fsutil file setCaseSensitiveInfo`), and on such a
 * directory `X:\p\Foo` and `X:\p\foo` are two directories folded onto ONE identity. The merging
 * consumers — `withReadCache` (one read cache per identity) and the log registry below (one log
 * per identity) — would then read and write two directories through one cache and one log. Not
 * addressable synchronously either (the flag is a per-directory filesystem query). Revisit if
 * Optimystic ever targets a case-sensitive-enabled Windows directory; until then the fold is
 * right for every ordinary Windows volume.
 */
export function fileStoreIdentity(basePath: string): StoreIdentity {
	const resolved = path.resolve(basePath);
	return `file:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}

// --- the log ---

/** Paths the tree has been written to since the log was last truncated; the checkpoint's work list. */
export interface DirtyPaths {
	/** Absolute paths of files written, less those deleted since. */
	readonly files: Set<string>;
	/** Absolute paths of directories whose entries changed: a file written or deleted in them, or a directory created in them. */
	readonly directories: Set<string>;
}

const noop = (): void => { };

/**
 * The write-ahead log of one store directory: `<basePath>/write-ahead.log`, every batch of writes
 * appended as one record and synced once, then applied to the readable file tree without waiting
 * for the disk.
 *
 * The write-ahead rule: a tree file only ever holds content whose log record is durable. So what
 * survives a crash is the log's durable prefix plus whatever the tree already held, and {@link open}
 * reconstructs it by replaying the log in order (puts and deletes are idempotent) before anything
 * is served. A replay of a put over a newer tree file cannot happen: every tree write has a log
 * record, and the log is replayed in order, so the last record for a path is the newest content
 * the tree was ever given. A store written by a build before the log has no log file and opens
 * with nothing to replay.
 *
 * One instance per directory per process, shared by reference count through {@link acquire}, so
 * two stores over one directory in one process share one log and one lock rather than deadlocking
 * on the lock or interleaving two writers into one file. Each keeps its own overlay above this,
 * which is why a second store opened beside a first cannot see the first's unflushed writes.
 *
 * NOTE: nothing truncates the log once it is open — it grows by one record per flush until the
 * store is reopened, and `dirty` grows with it. `file-store-checkpoint-and-shared-log` adds the
 * checkpoint that syncs the dirty tree and discards the log on a size threshold, an idle timer and
 * `close`.
 */
export class FileWriteLog {
	private static readonly registry = new Map<StoreIdentity, FileWriteLog>();
	/** Logs whose last reference was released and whose handle and lock are still being let go of. */
	private static readonly closing = new Map<StoreIdentity, Promise<void>>();

	/**
	 * The shared log for the directory, counted once more. Synchronous, so two acquirers in one
	 * tick get one instance. Balance every call with one {@link release}.
	 */
	static acquire(basePath: string): FileWriteLog {
		const identity = fileStoreIdentity(basePath);
		let shared = FileWriteLog.registry.get(identity);
		if (!shared) {
			shared = new FileWriteLog(path.resolve(basePath), identity, FileWriteLog.closing.get(identity));
			FileWriteLog.registry.set(identity, shared);
		}
		shared.refs += 1;
		return shared;
	}

	readonly logPath: string;
	/** What the tree has been given since the log was last truncated; see {@link DirtyPaths}. */
	readonly dirty: DirtyPaths = { files: new Set(), directories: new Set() };

	private refs = 0;
	private opening: Promise<void> | undefined;
	private handle: fs.FileHandle | undefined;
	private lock: StoreLock | undefined;
	/** Commits run one at a time, in order, on this chain; it never rejects. */
	private queue: Promise<void> = Promise.resolve();
	private fault: { cause: unknown } | undefined;
	private closed = false;

	private constructor(
		readonly basePath: string,
		readonly identity: StoreIdentity,
		/** A previous log over this directory still releasing its handle and lock; opening waits for it. */
		private readonly predecessorClosed: Promise<void> | undefined,
	) {
		this.logPath = path.join(basePath, WRITE_LOG_FILENAME);
	}

	/** True once an open, an append or an apply failed; every later commit then throws {@link StoreFailedError}. */
	get failed(): boolean {
		return this.fault !== undefined;
	}

	/**
	 * Take the lock, replay the log into the tree, truncate it and hold it open. Memoized: the first
	 * operation opens, every later one waits for that. A directory another live process holds throws
	 * {@link StoreLockedError} from every operation; an I/O failure latches the log failed and throws
	 * {@link StoreFailedError} from every operation.
	 */
	open(): Promise<void> {
		return this.opening ??= this.openOnce();
	}

	/**
	 * Append the batch as one record, sync the log, then apply the batch to the tree, in order, and
	 * resolve. Batches commit one at a time in the order they were submitted.
	 *
	 * NOTE: the apply is inside the commit's latency on purpose — resolving after it keeps one
	 * overlay above this, which serves a key until the tree holds it, so no in-process reader sees a
	 * half-written file. If the apply ever shows up in commit latency, resolve after the sync and
	 * keep the unapplied entries readable here.
	 */
	commit(entries: readonly WriteLogEntry[]): Promise<void> {
		return this.enqueue(async () => {
			await this.open();
			if (this.closed) throw new Error(`write-ahead log at ${this.basePath} is closed`);
			this.throwIfFailed();
			try {
				await writeAll(this.handle!, encodeWriteLogRecord(entries));
				await this.handle!.sync();
				await this.applyBatch(entries, this.dirty);
			} catch (err) {
				this.fault ??= { cause: err };
				throw new StoreFailedError(err);
			}
		});
	}

	/**
	 * Give back one reference. The last release waits for the commit in flight, closes the log
	 * handle and removes the lock; a log acquired for the directory meanwhile opens after that.
	 */
	async release(): Promise<void> {
		if (this.refs === 0) throw new Error(`write-ahead log at ${this.basePath} was released more often than acquired`);
		this.refs -= 1;
		if (this.refs > 0) return;
		FileWriteLog.registry.delete(this.identity);
		const done = this.shutDown();
		const tracked: Promise<void> = done.catch(noop).finally(() => {
			if (FileWriteLog.closing.get(this.identity) === tracked) FileWriteLog.closing.delete(this.identity);
		});
		FileWriteLog.closing.set(this.identity, tracked);
		await done;
	}

	private throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.queue.then(task);
		this.queue = run.catch(noop);
		return run;
	}

	private async openOnce(): Promise<void> {
		try {
			await this.predecessorClosed;
			await fs.mkdir(this.basePath, { recursive: true });
			this.lock = await acquireStoreLock(this.basePath);
			await this.replay();
			this.handle = await fs.open(this.logPath, 'w');
			await writeAll(this.handle, WRITE_LOG_HEADER);
			await this.handle.sync();
			await fsyncDir(this.basePath);
		} catch (err) {
			await this.releaseResources().catch(closeErr => log('releasing after a failed open: %o', closeErr));
			if (err instanceof StoreLockedError) throw err;
			this.fault ??= { cause: err };
			throw new StoreFailedError(err);
		}
	}

	/** Apply every intact record in order, make what it touched durable, and report a short read. */
	private async replay(): Promise<void> {
		// NOTE: the whole log is read into memory for one decode. Fine while a log is bounded by the
		// checkpoint `file-store-checkpoint-and-shared-log` adds (16 MiB by default); if a log is
		// ever found larger than that, decode it record by record from a stream instead.
		const bytes = await readFileIfExists(this.logPath);
		if (bytes === undefined) return;
		const decoded = decodeWriteLog(bytes);
		const touched: DirtyPaths = { files: new Set(), directories: new Set() };
		for (const batch of decoded.batches) {
			await this.applyBatch(batch, touched);
		}
		if (decoded.stoppedBy) {
			log('replay of %s stopped at byte %d of %d (%s): %d batch(es) before it applied, the rest discarded',
				this.logPath, decoded.stoppedAt, bytes.length, decoded.stoppedBy, decoded.batches.length);
		}
		for (const file of touched.files) await fsyncFile(file);
		for (const dir of touched.directories) await fsyncDir(dir);
	}

	/** Write each entry to its canonical path, creating missing directories; record what the tree was given. */
	private async applyBatch(entries: readonly WriteLogEntry[], touched: DirtyPaths): Promise<void> {
		for (const entry of entries) {
			const target = path.join(this.basePath, entry.path);
			const dir = path.dirname(target);
			if (entry.kind === 'put') {
				const created = await fs.mkdir(dir, { recursive: true });
				if (created !== undefined) this.noteCreated(dir, touched);
				await fs.writeFile(target, entry.value);
				touched.files.add(target);
			} else {
				await unlinkIfExists(target);
				touched.files.delete(target);
			}
			touched.directories.add(dir);
		}
	}

	/**
	 * `mkdir` created at least `dir`'s topmost missing ancestor, whose parent's entry is new too, so
	 * every directory from `dir` up to the store's root is marked — a superset of what was created,
	 * at most the layout's depth of extra directory syncs per checkpoint. (The created path `mkdir`
	 * returns is not compared against: on win32 it comes back in `\\?\` long-path form.)
	 */
	private noteCreated(dir: string, touched: DirtyPaths): void {
		for (let current = dir; ; current = path.dirname(current)) {
			touched.directories.add(current);
			if (current === this.basePath || path.dirname(current) === current) return;
		}
	}

	private async shutDown(): Promise<void> {
		this.closed = true;
		await this.queue;
		if (this.opening) await this.opening.catch(noop);
		await this.releaseResources();
	}

	private async releaseResources(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await handle.close();
		const lock = this.lock;
		this.lock = undefined;
		if (lock) await lock.release();
	}
}

async function writeAll(handle: fs.FileHandle, bytes: Uint8Array): Promise<void> {
	let written = 0;
	while (written < bytes.length) {
		const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
		if (bytesWritten <= 0) throw new Error('write-ahead log append wrote nothing');
		written += bytesWritten;
	}
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}
