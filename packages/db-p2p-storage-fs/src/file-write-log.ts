import { promises as fs } from 'fs';
import * as path from 'path';
// NOTE: `zlib.crc32` exists from Node 22.2 (and 20.15); the repository declares no engine floor,
// and this import is what sets it for this package. On an older Node it is `undefined` and the
// first commit throws a TypeError. If an older Node must be supported, compute the CRC here.
import { crc32 } from 'zlib';
import { armUnrefTimer } from '@optimystic/db-core';
import { StoreFailedError, SyncDeadlines, type CommittedBatch, type SetTimer, type SinkCommitOptions, type StoreIdentity } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';
import { acquireStoreLock, StoreLockedError, type StoreLock } from './store-lock.js';

const log = createLogger('write-log');

export const WRITE_LOG_FILENAME = 'write-ahead.log';

/**
 * The log a checkpoint has sealed and is syncing the tree under. Present on disk only between a
 * checkpoint's seal and its truncate; an open replays it ahead of {@link WRITE_LOG_FILENAME}.
 */
export const SEALED_WRITE_LOG_FILENAME = 'write-ahead.log.sealed';

/** {@link FileWriteLogOptions.checkpointBytes}'s default: 16 MiB. */
export const DEFAULT_CHECKPOINT_BYTES = 16 * 1024 * 1024;

/** {@link FileWriteLogOptions.checkpointIdleMs}'s default. */
export const DEFAULT_CHECKPOINT_IDLE_MS = 5000;

/** How many files, then directories, a checkpoint syncs at once. */
const CHECKPOINT_SYNC_CONCURRENCY = 16;

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
 *
 * NOTE: every error is swallowed, an I/O error included, and a checkpoint discards its sealed log
 * on the strength of these syncs. A directory sync that fails with EIO therefore lets the log go
 * while a directory entry it covered may not be durable. If that is ever seen, swallow only the
 * codes a filesystem uses to refuse a directory sync (EINVAL, ENOTSUP, EISDIR, EPERM, EBADF) and
 * ENOENT, and let the rest fail the checkpoint.
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

/** Paths the tree has been written to since the log was last checkpointed; the checkpoint's work list. */
export interface DirtyPaths {
	/** Absolute paths of files written, less those deleted since. */
	readonly files: Set<string>;
	/** Absolute paths of directories whose entries changed: a file written or deleted in them, or a directory created in them. */
	readonly directories: Set<string>;
}

/** When the log is checkpointed. Shared by every store over the directory; see {@link FileWriteLog.acquire}. */
export interface FileWriteLogOptions {
	/**
	 * Checkpoint once the log holds at least this many bytes of records, checked after each append.
	 * Default {@link DEFAULT_CHECKPOINT_BYTES}.
	 */
	checkpointBytes?: number;
	/**
	 * Checkpoint this long after the last append, so a store that stops writing does not keep its
	 * log until it closes. Re-armed by every append. Default {@link DEFAULT_CHECKPOINT_IDLE_MS}.
	 */
	checkpointIdleMs?: number;
	/** Arms the idle checkpoint; defaults to an unref'd `setTimeout`, so it never holds a process open. Injected by tests. */
	setTimer?: SetTimer;
}

interface CheckpointSettings {
	readonly checkpointBytes: number;
	readonly checkpointIdleMs: number;
	readonly setTimer: SetTimer;
}

/** Throws a `RangeError` for a checkpoint setting out of range; a store's constructor calls it, so a bad setting fails there rather than at the first write. */
export function assertFileWriteLogOptions(options: FileWriteLogOptions): void {
	checkpointSettings(options);
}

function checkpointSettings(options: FileWriteLogOptions): CheckpointSettings {
	const checkpointBytes = options.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;
	const checkpointIdleMs = options.checkpointIdleMs ?? DEFAULT_CHECKPOINT_IDLE_MS;
	if (!(checkpointBytes > 0)) throw new RangeError(`checkpointBytes must be positive, got ${checkpointBytes}`);
	if (!(checkpointIdleMs >= 0) || !Number.isFinite(checkpointIdleMs)) {
		throw new RangeError(`checkpointIdleMs must be a finite number of milliseconds, got ${checkpointIdleMs}`);
	}
	return { checkpointBytes, checkpointIdleMs, setTimer: options.setTimer ?? armUnrefTimer };
}

const noop = (): void => { };
const emptyDirty = (): DirtyPaths => ({ files: new Set(), directories: new Set() });

/**
 * The write-ahead log of one store directory: `<basePath>/write-ahead.log`, every batch of writes
 * appended as one record, synced by the earliest deadline any batch was given, and applied to the
 * readable file tree once it is durable.
 *
 * The write-ahead rule: a tree file only ever holds content whose log record is durable. So what
 * survives a crash is the log's durable prefix plus whatever the tree already held, and {@link open}
 * reconstructs it by replaying the log in order (puts and deletes are idempotent) before anything
 * is served. A replay of a put over a newer tree file cannot happen: every tree write has a log
 * record, and the log is replayed in order, so the last record for a path is the newest content
 * the tree was ever given. A store written by a build before the log has no log file and opens
 * with nothing to replay.
 *
 * A record reaches the operating system in its commit, so it survives a crash of this process from
 * then on: the next open's replay applies it. What the sync adds is surviving a power cut, and a
 * {@link commit} allowed to wait for that (`syncWithinMs` above 0) resolves without it, so that one
 * sync, made by the earliest deadline, covers every record appended since the last. The rules are
 * at {@link commit} and {@link syncUnsynced}.
 *
 * A {@link checkpoint} makes the tree as durable as the log and then discards the log, so the log
 * never grows without bound: it runs when the log passes `checkpointBytes`, `checkpointIdleMs` after
 * the last append, and on the last {@link release}. Its three steps are under {@link checkpointOnce}.
 *
 * One instance per directory per process, shared by reference count through {@link acquire}, so
 * every store over one directory in one process — `FileRawStorage` and `FileKVStore` alike — shares
 * one log, one lock and one checkpoint, rather than deadlocking on the lock or interleaving two
 * writers into one file. Each keeps its own overlay above this, which is why a second store opened
 * beside a first cannot see the first's unflushed writes.
 */
export class FileWriteLog {
	private static readonly registry = new Map<StoreIdentity, FileWriteLog>();
	/** Logs whose last reference was released and whose handle and lock are still being let go of. */
	private static readonly closing = new Map<StoreIdentity, Promise<void>>();

	/**
	 * The shared log for the directory, counted once more. Synchronous, so two acquirers in one
	 * tick get one instance. Balance every call with one {@link release}.
	 *
	 * The checkpoint settings are the first acquirer's: a store opened over a directory whose log is
	 * already open shares that log's settings, and a setting it names that differs is logged and
	 * not applied.
	 */
	static acquire(basePath: string, options: FileWriteLogOptions = {}): FileWriteLog {
		const identity = fileStoreIdentity(basePath);
		let shared = FileWriteLog.registry.get(identity);
		if (shared) {
			shared.noteDifferingSettings(options);
		} else {
			shared = new FileWriteLog(path.resolve(basePath), identity, checkpointSettings(options), FileWriteLog.closing.get(identity));
			FileWriteLog.registry.set(identity, shared);
		}
		shared.refs += 1;
		return shared;
	}

	readonly logPath: string;
	readonly sealedPath: string;

	/** What the tree has been given since the log was last sealed; see {@link DirtyPaths}. Swapped for an empty set by each seal. */
	private dirty: DirtyPaths = emptyDirty();
	/** Bytes of records in the current log, the size threshold's measure. Zero means there is nothing to checkpoint. */
	private appendedBytes = 0;
	private refs = 0;
	private opening: Promise<void> | undefined;
	private handle: fs.FileHandle | undefined;
	private lock: StoreLock | undefined;
	/** Commits and seals run one at a time, in order, on this chain; it never rejects. */
	private queue: Promise<unknown> = Promise.resolve();
	private fault: { cause: unknown } | undefined;
	private closed = false;
	/** The checkpoint running now, if any, which also runs every one asked for while it ran. */
	private checkpointRun: Promise<void> | undefined;
	/** A checkpoint was asked for while {@link checkpointRun} was running: run one more after it. */
	private checkpointAgain = false;
	private cancelIdleCheckpoint: (() => void) | undefined;
	/**
	 * Records appended and not yet synced, in log order, each held with the entries the sync step
	 * writes to the tree and the `durable` it settles; with them the earliest deadline, the timer
	 * armed for it, and the `window-overrun` episode. Emptied by every sync step and by the latch.
	 * Bounded by the window: it holds what was committed since the last sync, and the earliest
	 * deadline among them forces one.
	 */
	private readonly unsynced: SyncDeadlines<readonly WriteLogEntry[]>;

	private constructor(
		readonly basePath: string,
		readonly identity: StoreIdentity,
		private readonly settings: CheckpointSettings,
		/** A previous log over this directory still releasing its handle and lock; opening waits for it. */
		private readonly predecessorClosed: Promise<void> | undefined,
	) {
		this.logPath = path.join(basePath, WRITE_LOG_FILENAME);
		this.sealedPath = path.join(basePath, SEALED_WRITE_LOG_FILENAME);
		this.unsynced = new SyncDeadlines({
			onDue: firedAt => this.syncInBackground(firedAt),
			setTimer: settings.setTimer,
			log,
			subject: basePath,
		});
	}

	/** True once an open, an append, an apply or a checkpoint failed; every later commit then throws {@link StoreFailedError}. */
	get failed(): boolean {
		return this.fault !== undefined;
	}

	/**
	 * Take the lock, replay the log into the tree, truncate it and hold it open. Memoized: the first
	 * operation opens, every later one waits for that. A directory another live process holds throws
	 * {@link StoreLockedError} from every operation; an I/O failure latches the log failed and throws
	 * {@link StoreFailedError} from every operation. Either outcome is kept for the life of the
	 * instance, and the instance is shared by every store over the directory until each has released
	 * it: to retry after the holder has exited, close those stores and open a new one.
	 */
	open(): Promise<void> {
		return this.opening ??= this.openOnce();
	}

	/**
	 * Append the batch as one record and resolve with its `durable`, which settles once the record is
	 * synced and the batch written to the tree. Batches commit one at a time in the order they were
	 * submitted, and their `durable` settle in that order. `WriteGroupSink.commit`'s contract:
	 *
	 * - `syncWithinMs` 0 (**strict**): the sync step runs before this resolves, so the returned
	 *   `durable` is already settled and every earlier batch is durable too.
	 * - Otherwise (**relaxed**): the record is in the operating system and the batch waits in
	 *   {@link unsynced} with the deadline `syncWithinMs` after this was CALLED, not after the queue got
	 *   to it, so a commit that waited in line past its own deadline is treated as overdue. A timer
	 *   armed for the earliest deadline runs the sync step; a strict commit or a checkpoint meanwhile
	 *   runs it sooner, for every batch waiting.
	 * - **Backpressure:** a commit that finds the earliest unsynced deadline already passed runs the
	 *   sync step before it resolves, whatever its own window. When the disk falls behind, writers
	 *   wait for it instead of the window quietly growing.
	 *
	 * The deadlines, the timer and the backpressure test are the rules of `SyncDeadlines`, from
	 * `@optimystic/db-p2p`, which every store that defers its sync shares.
	 *
	 * The tree is written at the sync, not here, so a reader of the tree never sees a batch whose
	 * record a power cut could still take; the overlay above each store serves the batch until its
	 * `durable` resolves.
	 */
	commit(entries: readonly WriteLogEntry[], { syncWithinMs }: SinkCommitOptions): Promise<CommittedBatch> {
		if (!(syncWithinMs >= 0) || !Number.isFinite(syncWithinMs)) {
			return Promise.reject(new RangeError(`syncWithinMs must be a finite number of milliseconds at or above 0, got ${syncWithinMs}`));
		}
		const deadline = this.unsynced.deadlineFor(syncWithinMs);
		return this.enqueue(async () => {
			await this.open();
			if (this.closed) throw new Error(`write-ahead log at ${this.basePath} is closed`);
			this.throwIfFailed();
			await this.append(entries);
			const durable = this.unsynced.defer(entries, deadline);
			if (this.unsynced.mustSyncNow(deadline)) await this.syncUnsynced();
			this.scheduleCheckpoint();
			return { durable };
		});
	}

	/**
	 * Hasten: make every record appended before this call durable, and write its batch to the tree.
	 * Queued, so it covers exactly those records; with nothing unsynced it touches no disk.
	 * `WriteGroupSink.sync`'s contract.
	 */
	sync(): Promise<void> {
		return this.enqueue(async () => {
			this.throwIfFailed();
			await this.syncUnsynced();
		});
	}

	/**
	 * Make the tree as durable as the log, then discard the log. One at a time: asked for while one
	 * runs, it runs once more after that one, and resolves when that has. Skipped when the log has
	 * failed, was never opened, or holds no record. A failure latches the log failed, like a rejected
	 * commit: a half-synced tree under a discarded log cannot be recovered.
	 */
	checkpoint(): Promise<void> {
		if (this.checkpointRun) {
			this.checkpointAgain = true;
			return this.checkpointRun;
		}
		return this.checkpointRun = this.runCheckpoints();
	}

	/**
	 * Give back one reference. The last release waits for the commit in flight and for a checkpoint
	 * in flight, runs a final checkpoint, closes the log handle and removes the lock; a log acquired
	 * for the directory meanwhile opens after that. Rejects only when that final checkpoint fails,
	 * and lets go of the handle and the lock either way.
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

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(noop);
		return run;
	}

	private noteDifferingSettings(options: FileWriteLogOptions): void {
		const differing = (['checkpointBytes', 'checkpointIdleMs'] as const)
			.filter(name => options[name] !== undefined && options[name] !== this.settings[name]);
		if (differing.length > 0) {
			log('a store over %s asked for %o; the log already open there keeps %o', this.basePath,
				Object.fromEntries(differing.map(name => [name, options[name]])),
				Object.fromEntries(differing.map(name => [name, this.settings[name]])));
		}
	}

	// --- open and replay ---

	private async openOnce(): Promise<void> {
		try {
			await this.predecessorClosed;
			await fs.mkdir(this.basePath, { recursive: true });
			this.lock = await acquireStoreLock(this.basePath);
			await this.replay();
			this.handle = await this.createEmptyLog();
		} catch (err) {
			await this.releaseResources().catch(closeErr => log('releasing after a failed open: %o', closeErr));
			if (err instanceof StoreLockedError) throw err;
			throw this.latch(err);
		}
	}

	/**
	 * Apply the sealed segment's records, then the current log's, in order; make what they touched
	 * durable; then remove the sealed segment. The two files are one log: a sealed segment that
	 * stops short ends the replay there, and the current log is discarded with the rest of it.
	 *
	 * Re-applying a sealed segment whose checkpoint already synced the tree is harmless, because the
	 * current log holds every later write of the same paths, in order, and is applied after it. What
	 * must never happen is the sealed segment outliving the current log's truncation, since replaying
	 * it alone would put older content over newer: so the sealed segment is removed, and the
	 * directory synced, before {@link openOnce} truncates the current log. (On win32, where
	 * {@link fsyncDir} is skipped, NTFS commits the unlink and the later truncation through its
	 * metadata journal in order.)
	 */
	private async replay(): Promise<void> {
		const touched = emptyDirty();
		const sealed = await this.replaySegment(this.sealedPath, touched);
		if (sealed === 'stopped-short') {
			// NOTE: the current log is discarded only by the truncation after the sealed segment is
			// removed, so a crash between the two replays the current log alone on the next open. A
			// sealed segment holds only synced records, so it stops short only when its bytes were
			// damaged on disk; if that is ever seen, truncate the current log before removing it.
			log('replay of %s stopped short, so %s was not applied', this.sealedPath, this.logPath);
		} else {
			await this.replaySegment(this.logPath, touched);
		}
		await syncDirtyPaths(touched);
		if (sealed !== 'absent') {
			await fs.unlink(this.sealedPath);
			await fsyncDir(this.basePath);
		}
	}

	/** Apply one log file's intact records, in order, into `touched`. */
	private async replaySegment(filePath: string, touched: DirtyPaths): Promise<'absent' | 'complete' | 'stopped-short'> {
		// NOTE: a log file is read into memory for one decode. A checkpoint bounds the current log to
		// about `checkpointBytes` plus what is appended while a checkpoint runs, and a sealed segment
		// to one such log; if a log is ever found much larger than that, decode it record by record
		// from a stream instead.
		const bytes = await readFileIfExists(filePath);
		if (bytes === undefined) return 'absent';
		const decoded = decodeWriteLog(bytes);
		for (const batch of decoded.batches) {
			await this.applyBatch(batch, touched);
		}
		if (!decoded.stoppedBy) return 'complete';
		log('replay of %s stopped at byte %d of %d (%s): %d batch(es) before it applied, the rest discarded',
			filePath, decoded.stoppedAt, bytes.length, decoded.stoppedBy, decoded.batches.length);
		return 'stopped-short';
	}

	/** Create (or truncate) the current log to its header, and make it and its directory entry durable before any record goes in. */
	private async createEmptyLog(): Promise<fs.FileHandle> {
		const handle = await fs.open(this.logPath, 'w');
		try {
			await writeAll(handle, WRITE_LOG_HEADER);
			await handle.sync();
			await fsyncDir(this.basePath);
		} catch (err) {
			await handle.close().catch(noop);
			throw err;
		}
		return handle;
	}

	// --- append and sync ---

	/**
	 * Append the batch as one record. The record has reached the operating system when this
	 * resolves, so it survives a crash of this process: the next open's replay applies it. A failed
	 * append latches the log, and rejects every batch still waiting for its sync, since no sync will
	 * ever be made for them.
	 *
	 * A checkpoint syncs the tree outside the queue, so its failure can latch the log while this
	 * append is in flight. The commit is then refused like every later one, its record left to the
	 * next open's replay: nothing would ever sync a batch held after the latch.
	 */
	private async append(entries: readonly WriteLogEntry[]): Promise<void> {
		try {
			const record = encodeWriteLogRecord(entries);
			await writeAll(this.handle!, record);
			this.appendedBytes += record.length;
		} catch (err) {
			throw this.latch(err);
		}
		this.throwIfFailed();
	}

	/**
	 * The sync step: one sync of the log makes every record appended so far durable; then each waiting
	 * batch is written to the tree, in order, and its `durable` resolved, in order. Called only from a
	 * queued task — a commit, {@link sync}, the timer's task or a checkpoint's seal — so it covers
	 * exactly the records appended before that task began, and a sealed segment only ever holds
	 * synced records whose tree writes are done. Nothing waiting: nothing is touched.
	 *
	 * A failure anywhere latches the log and rejects every covered `durable`, the ones whose tree
	 * write succeeded included: the records are durable and the next open's replay rebuilds the tree
	 * from them, but a `durable` is a promise that this process finished the work, and it did not.
	 *
	 * `owedSince` is the moment the timer fired, when the timer's task runs this: `SyncDeadlines.take`
	 * counts the sync's lateness from it rather than from a deadline the timer's own slop missed, and
	 * the cover says `window-overrun` once per episode of syncs that started late.
	 */
	private async syncUnsynced(owedSince?: number): Promise<void> {
		const cover = this.unsynced.take(owedSince);
		if (cover.items.length === 0) return;
		try {
			await this.handle!.sync();
			for (const entries of cover.items) await this.applyBatch(entries, this.dirty);
		} catch (err) {
			const failure = this.latch(err);
			cover.fail(err);
			throw failure;
		}
		cover.settle();
	}

	/** The timer fired: run the sync step in the queue. Its failure has latched the log, so it is only logged here, like a background checkpoint's. */
	private syncInBackground(firedAt: number): void {
		this.enqueue(() => this.syncUnsynced(firedAt)).catch((err: unknown) => {
			log('deferred sync of %s failed; the store refuses every later write: %o', this.basePath, err);
		});
	}

	/**
	 * Latch the log failed on its first fault and reject every batch waiting for a sync that will now
	 * never be made, so no caller waits on a `durable` for ever. Returns the error to throw.
	 */
	private latch(err: unknown): StoreFailedError {
		this.fault ??= { cause: err };
		this.unsynced.failAll(err);
		return new StoreFailedError(err);
	}

	// --- apply ---

	/**
	 * Write each entry to its canonical path, creating missing directories; record what the tree was given.
	 *
	 * NOTE: the write goes straight to the canonical path, so a reader of that path can see it
	 * half-written. The committing store's own readers are served from its overlay until the batch's
	 * `durable` resolves, and the two store kinds over one directory never share a path, so only a
	 * second store of the same kind over the same directory can read a torn file — a shape Invariant
	 * 5 already excludes. If that shape is ever supported, write through a temp file and rename.
	 */
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

	// --- checkpoint ---

	/**
	 * After an append: re-arm the idle checkpoint, and start one now when the log has passed its size
	 * threshold. Nothing once the last release has begun, since it runs the final checkpoint itself.
	 */
	private scheduleCheckpoint(): void {
		if (this.closed) return;
		this.disarmIdleCheckpoint();
		this.cancelIdleCheckpoint = this.settings.setTimer(() => {
			this.cancelIdleCheckpoint = undefined;
			this.checkpointInBackground('idle');
		}, this.settings.checkpointIdleMs);
		if (this.appendedBytes >= this.settings.checkpointBytes) this.checkpointInBackground('size');
	}

	/** Never awaited by a commit: a commit holds the queue the checkpoint's seal waits in. Its failure has latched the log. */
	private checkpointInBackground(trigger: 'idle' | 'size'): void {
		this.checkpoint().catch((err: unknown) => {
			log('checkpoint (%s) of %s failed; the store refuses every later write: %o', trigger, this.basePath, err);
		});
	}

	private disarmIdleCheckpoint(): void {
		this.cancelIdleCheckpoint?.();
		this.cancelIdleCheckpoint = undefined;
	}

	private async runCheckpoints(): Promise<void> {
		try {
			do {
				this.checkpointAgain = false;
				await this.checkpointOnce();
			} while (this.checkpointAgain);
		} finally {
			// Cleared before this promise settles, so a checkpoint asked for from here on starts afresh.
			this.checkpointRun = undefined;
		}
	}

	/**
	 * 1. **Seal**, in the commit queue so no apply is in flight: run the sync step for whatever is
	 *    still waiting, rename the log to {@link SEALED_WRITE_LOG_FILENAME} and start an empty one, and
	 *    take the dirty set, leaving an empty one. Commits resume on the new log at once; only this
	 *    step waits in the queue.
	 * 2. **Sync**, off the commit path: every file in the taken set, then every directory. A file
	 *    deleted since is skipped; one rewritten since is synced with its newer content, which the
	 *    new log covers too.
	 * 3. **Truncate**: unlink the sealed segment and sync the directory.
	 *
	 * A crash anywhere in this leaves the sealed segment, the current log or both, and the next open
	 * replays them in that order (see {@link replay}).
	 */
	private async checkpointOnce(): Promise<void> {
		if (!this.opening || this.fault) return;
		await this.opening.catch(noop);
		const sealed = await this.seal();
		if (!sealed) return;
		try {
			await syncDirtyPaths(sealed);
			await fs.unlink(this.sealedPath);
			await fsyncDir(this.basePath);
		} catch (err) {
			throw this.latch(err);
		}
	}

	/**
	 * Step 1 of {@link checkpointOnce}: the dirty set the sealed segment covers, or `undefined` when
	 * there is nothing to seal. The sync step runs first, so the sealed segment holds only synced
	 * records whose tree writes are in the set the checkpoint goes on to sync. An unsynced record
	 * always has bytes, so `appendedBytes` is never 0 while one waits: the early return cannot skip
	 * one, and the final checkpoint on the last release syncs whatever is still waiting.
	 */
	private seal(): Promise<DirtyPaths | undefined> {
		return this.enqueue(async () => {
			if (this.fault || this.appendedBytes === 0) return undefined;
			await this.syncUnsynced();
			try {
				const handle = this.handle!;
				this.handle = undefined;
				await handle.close();
				await fs.rename(this.logPath, this.sealedPath);
				this.handle = await this.createEmptyLog();
			} catch (err) {
				throw this.latch(err);
			}
			const sealed = this.dirty;
			this.dirty = emptyDirty();
			this.appendedBytes = 0;
			return sealed;
		});
	}

	// --- close ---

	private async shutDown(): Promise<void> {
		this.closed = true;
		this.disarmIdleCheckpoint();
		// The final checkpoint's seal syncs whatever is still waiting (see `seal`), which disarms the
		// sync timer; one that fires before then enqueues a sync step that covers it sooner.
		await this.queue;
		try {
			// A failure of the checkpoint in flight has been logged by whatever started it, and has
			// latched the log, which skips the final one.
			await this.checkpointRun?.catch(noop);
			await this.checkpoint();
		} finally {
			await this.releaseResources();
		}
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

/**
 * Sync every file, then every directory, {@link CHECKPOINT_SYNC_CONCURRENCY} at a time.
 *
 * NOTE: a checkpoint's file sync holds a handle open while later commits may delete and re-create
 * the same path. libuv opens with delete sharing and, on Windows 10 1809 and later, unlinks with
 * POSIX semantics, so the name goes at once; on an older Windows the re-create would fail with
 * EPERM while the deleted name lingers, latching the store. If that is ever seen, retry the apply's
 * write on EPERM for the length of one sync.
 */
async function syncDirtyPaths(dirty: DirtyPaths): Promise<void> {
	await forEachConcurrently(dirty.files, CHECKPOINT_SYNC_CONCURRENCY, fsyncFile);
	await forEachConcurrently(dirty.directories, CHECKPOINT_SYNC_CONCURRENCY, fsyncDir);
}

/** Run `fn` over `items` with at most `limit` in flight; after the first failure no more start, and it is thrown once all in flight have settled. */
async function forEachConcurrently<T>(items: Iterable<T>, limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	const iterator = items[Symbol.iterator]();
	let failure: { cause: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (!failure) {
			const next = iterator.next();
			if (next.done) return;
			try {
				await fn(next.value);
			} catch (err) {
				failure ??= { cause: err };
			}
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));
	if (failure) throw failure.cause;
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
