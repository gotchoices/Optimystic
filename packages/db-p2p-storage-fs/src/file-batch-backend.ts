import { promises as fs } from 'fs';
import * as path from 'path';
import type { BlockId, ActionId } from '@optimystic/db-core';
import type { BatchBackend, BatchEntry, CommittedBatch, StoreDurability, StoreIdentity, StoreKey } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';
import { FileWriteLog, SYNCED_BATCH, assertFileWriteLogOptions, fileStoreIdentity, readFileIfExists, type FileWriteLogOptions, type WriteLogEntry } from './file-write-log.js';

const log = createLogger('storage:file');

// Built on first use rather than at module load, like every other `TextDecoder` in library source
// (see NO_MODULE_SCOPE_TEXT_DECODER in eslint.config.js). Harmless on Node; kept uniform so the lint
// rule needs no per-package exemption.
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

// Colons are illegal in Windows filenames; encode them so action ids like
// `tx:<hash>` and `stamp:<hash>` round-trip safely on all platforms.
function encodeActionIdForFilename(actionId: ActionId): string {
	return actionId.replace(/:/g, '%3A');
}

function decodeFilenameToActionId(filename: string): ActionId {
	return filename.replace(/%3A/g, ':') as ActionId;
}

// A torn write leaves valid-prefix JSON cut off mid-token — JSON.parse throws
// SyntaxError. Used as the "corrupt content → treat as missing" guard so a
// crash-truncated file reads as absent (letting recover() make progress) instead
// of surfacing a parse error forever. Only the JSON-valued stores use this; the
// revisions store holds a bare ActionId string (not JSON) and is never guarded.
// NOTE: every guarded read parses the JSON here (validate, discard) and the kernel's
// decodeJson parses the same bytes AGAIN to build the value — 2× parse per get. The
// guard is intrinsic to the backend's "corrupt→missing" contract (the kernel can't
// express it), so it can't simply be dropped. Fine at current read volumes; if a read
// path ever shows up hot, parse once and thread the parsed value through the backend.
function isParseableJson(bytes: Uint8Array): boolean {
	try {
		JSON.parse(decoder().decode(bytes));
		return true;
	} catch (err) {
		if (err instanceof SyntaxError) return false;
		throw err;
	}
}

type ActionScopedStore = 'pending' | 'transactions' | 'materialized';

const ACTION_SCOPED_DIRS: Record<ActionScopedStore, string> = {
	pending: 'pend',
	transactions: 'actions',
	materialized: 'blocks',
};

/**
 * Filesystem {@link BatchBackend}: the six logical block-storage stores mapped to six paths under
 * `basePath/<blockId>/` (`{meta.json,revs/,pend/,actions/,proofs/,blocks/}`), every batch committed
 * through the directory's {@link FileWriteLog}. The directory tree is a deliberate,
 * human-inspectable layout — it is NOT flattened into encoded-filename KV keys.
 *
 * `KvRawStorage` owns all JSON serialization, so this backend reads raw `Uint8Array` bytes and
 * never does `JSON.stringify/parse` on values. What is fs-specific lives here: the path per
 * {@link StoreKey}, the corrupt-content-as-missing read guard, colon-encoded action-id filenames
 * with the legacy raw-colon read fallback and win32 guards, and the directory listings.
 *
 * Every operation opens the shared log first — on the first one: take the lock, replay, then
 * serve — so no read ever sees a tree the log has not been replayed into. The log is acquired on
 * that first operation rather than in the constructor, so an instance that is constructed and
 * never used (one `withReadCache` dedupes away) holds no handle and no lock.
 */
export class FileBatchBackend implements BatchBackend {
	/** A committed batch's record is synced to the log before the batch resolves; replay rebuilds the tree from it. */
	readonly durability: StoreDurability = 'power-loss';

	readonly basePath: string;
	private readonly identity: StoreIdentity;
	private log: FileWriteLog | undefined;

	/** `options` are the directory log's checkpoint settings, applied when this is the first store to open it. */
	constructor(basePath: string, private readonly options: FileWriteLogOptions = {}) {
		assertFileWriteLogOptions(options);
		this.basePath = path.resolve(basePath);
		this.identity = fileStoreIdentity(basePath);
	}

	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	// --- reads ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		await this.open();
		switch (key.store) {
			case 'metadata':
				return this.readBytesIfExists(this.metadataPath(key.blockId), true);
			// The revisions store value is a bare ActionId string (kernel `encodeActionId`, NOT JSON),
			// so it is read WITHOUT the JSON guard — any bytes are a valid string and `decodeActionId`
			// never throws.
			// NOTE: because there is no guard here, a *torn* revision file reads back as a wrong
			// (truncated) ActionId rather than as missing — unlike the JSON stores, which torn-read as
			// undefined. A tree file can only be torn by a crash during its write, and that write's log
			// record is durable before the write starts, so the next open's replay rewrites it whole.
			// Only a file written by a build before the log can stay torn, and recover() re-derives
			// revisions from the actions store anyway. If revisions ever move outside the log, add a
			// checksum/length guard here.
			case 'revisions':
				return this.readBytesIfExists(this.revisionPath(key.blockId, key.rev), false);
			// Keyed by (blockId, rev) like the revisions store, but JSON-valued like the action stores —
			// so it takes the corrupt-content-as-missing guard the revisions store does not, and the
			// filename carries no colon to encode. Deliberately no delete: a proof lives and dies with
			// its revision record (see RawStoreDriver.getProof).
			case 'proofs':
				return this.readBytesIfExists(this.proofPath(key.blockId, key.rev), true);
			case 'pending':
			case 'transactions':
			case 'materialized':
				return this.readActionScopedBytes(
					this.actionScopedPath(key.store, key.blockId, key.actionId),
					this.actionScopedPath(key.store, key.blockId, key.actionId, false),
				);
		}
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		await this.open();
		// The fs backend has no cursor: walk the bounded [lo, hi] range rev-by-rev, reading each
		// present rev. The range is caller-bounded, so this avoids listing an unbounded revs/ directory.
		const results: [number, Uint8Array][] = [];
		for (let rev = lo; rev <= hi; rev++) {
			const value = await this.readBytesIfExists(this.revisionPath(blockId, rev), false);
			if (value !== undefined) {
				results.push([rev, value]);
			}
		}
		return results;
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		await this.open();
		const pendingPath = path.join(this.blockPath(blockId), ACTION_SCOPED_DIRS.pending);

		// Only a genuinely-absent directory (ENOENT) maps to "no pendings". Any other error
		// (EACCES, EIO, ENOTDIR, ...) must surface — swallowing it here would make listPendingActionIds
		// silently report an empty directory, so pend's conflict detection would be skipped. Mirrors
		// directoryByteSize's ENOENT-vs-other discrimination.
		const files = await fs.readdir(pendingPath).catch((err) => {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [] as string[];
			log('listPendingActionIds readdir failed for %s - %o', blockId, err);
			throw err;
		});
		const ids: ActionId[] = [];
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const actionId = decodeFilenameToActionId(file.slice(0, -5));
			// Accept every realistic action id: legacy UUIDs (`[0-9a-f-]`), consensus
			// tx:/stamp: ids (base64url-encoded SHA-256, alphabet `[A-Za-z0-9_-]` — see
			// db-core hashString, NOT lowercase hex), AND the bare-alphanumeric ids the
			// cross-backend conformance suite uses (`a1`, `b1`, ...). This is deliberately
			// broad-but-not-total: an id is any `[A-Za-z0-9_-]` string, optionally prefixed
			// with `tx:`/`stamp:`. It is NOT a total accept — a file whose decoded name
			// carries other punctuation (a dot, a space) is genuine junk in pend/ and is
			// logged-and-skipped rather than surfaced as a phantom pending. The memory/db
			// reference drivers key on the raw id and never see a filesystem name, so this
			// filter is fs-only; it must not drop an id those backends would list, hence the
			// widened class (an earlier hex-only class silently dropped real consensus ids —
			// see `optimystic-filestorage-colon-actionid-windows`).
			if (!/^(?:tx:|stamp:)?[A-Za-z0-9_-]+$/.test(actionId)) {
				// Leave a breadcrumb rather than silently dropping: the .json + decode guard
				// already excludes the `*.tmp` orphans an older build's atomic writer could leave, so
				// anything reaching here is an unexpected filename a maintainer should see.
				log('listPendingActionIds skipping unrecognized action-id file %s for %s', file, blockId);
				continue;
			}
			ids.push(actionId);
		}
		return ids;
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		await this.open();
		// The block layout is `basePath/<blockId>/{meta.json,revs/,pend/,actions/,proofs/,blocks/}`
		// (see blockPath), so the direct children of basePath are the per-block directories and each
		// directory NAME is the blockId (used raw, no encoding). Filter to directories so a stray file
		// can't be mistaken for a block: `write-ahead.log` and `store.lock` sit at basePath root and
		// are skipped by that alone.
		//
		// A directory alone is NOT sufficient: pending a transform straight through this backend
		// creates `<blockId>/pend/` — hence a root directory entry — via the apply's recursive mkdir,
		// without writing meta.json. So we gate on meta.json existence: `meta.json` IS this backend's
		// metadata store, so gating on it enumerates exactly the same population the metadata-keyed
		// backends (sqlite/leveldb/indexeddb) get for free. That population is every block with ANY
		// durable metadata — which on the node path INCLUDES a pend-only block, because
		// `BlockStorage.savePendingTransaction` seeds metadata for a block that has none before
		// storing the transform. Do not "improve" this into a committed-revision filter: reading and
		// parsing every meta.json would turn a cheap access() sweep into a per-block read at startup
		// (see the `listBlockIds` contract in i-raw-storage.ts). Existence (fs.access), not parse,
		// matches key-existence semantics: a torn/corrupt meta.json still counts as a key, exactly as
		// a corrupt value would in the other backends.
		//
		// ENOENT (basePath not created yet, or a dir without meta.json) maps to "not owned" — same
		// discrimination as directoryByteSize. Any OTHER readdir/access error must surface:
		// swallowing it would make the seed falsely report an empty store and under-protect data
		// already on disk.
		// NOTE: reads the whole root listing up front + one meta.json stat per block dir; if a store
		// ever grows to millions of block subdirs and this becomes a startup-latency problem, page it
		// (e.g. opendir cursor) — fine at current scale.
		const entries = await fs.readdir(this.basePath, { withFileTypes: true })
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
				log('listBlockIds readdir failed for %s - %o', this.basePath, err);
				throw err;
			});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const blockId = entry.name as BlockId;
			const hasMeta = await fs.access(this.metadataPath(blockId))
				.then(() => true)
				.catch((err) => {
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
					log('listBlockIds access failed for %s - %o', blockId, err);
					throw err;
				});
			if (hasMeta) yield blockId;
		}
	}

	/** The tree's bytes, the write-ahead log and the lock included: all of it is what the store occupies. */
	async approximateBytesUsed(): Promise<number> {
		await this.open();
		return this.directoryByteSize(this.basePath);
	}

	// --- the one write ---

	/** Syncs before resolving whatever `syncWithinMs` allows (see `SYNCED_BATCH`). */
	async commit(entries: readonly BatchEntry[], _options: { readonly syncWithinMs: number }): Promise<CommittedBatch> {
		await this.shared().commit(entries.flatMap(entry => this.toLogEntries(entry)));
		return SYNCED_BATCH;
	}

	/** Every committed batch is already synced, so there is nothing to hasten. */
	sync(): Promise<void> {
		return Promise.resolve();
	}

	async close(): Promise<void> {
		const shared = this.log;
		this.log = undefined;
		await shared?.release();
	}

	// --- the log ---

	private shared(): FileWriteLog {
		return this.log ??= FileWriteLog.acquire(this.basePath, this.options);
	}

	private open(): Promise<void> {
		return this.shared().open();
	}

	/**
	 * A put is one entry at the key's canonical path. A delete of an action-scoped record is that
	 * path's entry plus, off win32 and when the id carries a colon, the pre-encode raw-colon sibling's,
	 * so a deleted item cannot resurface through the read fallback in readActionScopedBytes — in the
	 * log, so a replay removes the sibling too.
	 *
	 * NOTE: that sibling entry names a path with a colon, which only a POSIX build writes; a log
	 * carrying one and moved unreplayed to a win32 machine replays it as an unlink of an NTFS
	 * stream path, where anything but ENOENT fails the open. A store is not moved across platforms
	 * mid-log today; if it ever is, have the replay skip a delete it cannot spell on this platform.
	 */
	private toLogEntries(entry: BatchEntry): WriteLogEntry[] {
		const relative = this.relativePath(entry.key);
		if (entry.value !== undefined) return [{ kind: 'put', path: relative, value: entry.value }];
		const entries: WriteLogEntry[] = [{ kind: 'delete', path: relative }];
		const { key } = entry;
		if (key.store === 'pending' || key.store === 'materialized') {
			const raw = this.relativeActionScopedPath(key.store, key.blockId, key.actionId, false);
			if (process.platform !== 'win32' && raw !== relative) entries.push({ kind: 'delete', path: raw });
		}
		return entries;
	}

	// --- paths: relative with forward slashes for the log, absolute for reads ---

	private relativePath(key: StoreKey): string {
		switch (key.store) {
			case 'metadata':
				return `${key.blockId}/meta.json`;
			case 'revisions':
				return `${key.blockId}/revs/${key.rev}.json`;
			case 'proofs':
				return `${key.blockId}/proofs/${key.rev}.json`;
			case 'pending':
			case 'transactions':
			case 'materialized':
				return this.relativeActionScopedPath(key.store, key.blockId, key.actionId);
		}
	}

	// `encoded` controls colon handling: writes and canonical reads use the percent-encoded filename
	// (encoded = true); the legacy raw-colon fallback (see readActionScopedBytes) passes
	// encoded = false to reach pre-encode POSIX files like `actions/tx:<hash>.json`.
	private relativeActionScopedPath(store: ActionScopedStore, blockId: BlockId, actionId: ActionId, encoded = true): string {
		const filename = encoded ? encodeActionIdForFilename(actionId) : actionId;
		return `${blockId}/${ACTION_SCOPED_DIRS[store]}/${filename}.json`;
	}

	private blockPath(blockId: BlockId): string {
		return path.join(this.basePath, blockId);
	}

	private metadataPath(blockId: BlockId): string {
		return path.join(this.blockPath(blockId), 'meta.json');
	}

	private revisionPath(blockId: BlockId, rev: number): string {
		return path.join(this.blockPath(blockId), 'revs', `${rev}.json`);
	}

	private proofPath(blockId: BlockId, rev: number): string {
		return path.join(this.blockPath(blockId), 'proofs', `${rev}.json`);
	}

	private actionScopedPath(store: ActionScopedStore, blockId: BlockId, actionId: ActionId, encoded = true): string {
		return path.join(this.basePath, this.relativeActionScopedPath(store, blockId, actionId, encoded));
	}

	// --- reads with the fs guards ---

	// Reads an action-id-keyed file (JSON-valued) by its canonical (percent-encoded)
	// path, falling back on a miss to the legacy raw-colon path written by pre-encode
	// nodes (e.g. POSIX files literally named `actions/tx:<hash>.json`).
	//
	// Tradeoff: this reads legacy files in place and never renames them, so a
	// store upgraded from a pre-encode node keeps mixed naming on disk. That is
	// acceptable pre-1.0; a future migration sweep can normalize if desired. We
	// deliberately do NOT migrate-on-read here — reads stay side-effect-free.
	//
	// win32 guard: a raw-colon path is not a benign miss on Windows — the colon
	// is parsed as an NTFS alternate-data-stream separator and a read there can
	// throw a non-ENOENT error rather than cleanly missing. Raw-colon files
	// cannot have been written on win32 anyway, so we skip the fallback there
	// (losing nothing) and swallow ALL fallback errors elsewhere, guaranteeing
	// the fallback never surfaces a new throw to callers.
	private async readActionScopedBytes(encodedPath: string, rawPath: string): Promise<Uint8Array | undefined> {
		const hit = await this.readBytesIfExists(encodedPath, true);
		if (hit !== undefined) return hit;
		if (process.platform === 'win32' || rawPath === encodedPath) return undefined;
		return fs.readFile(rawPath)
			.then(bytes => (isParseableJson(bytes) ? bytes : undefined))
			.catch(() => undefined);
	}

	// Reads a file's raw bytes. ENOENT → undefined. When `jsonGuard` is set, a
	// present-but-corrupt file (JSON.parse fails — a torn write of a build before the log, or a
	// crash mid-write that the next open's replay has not yet rewritten) is treated as "missing" so
	// recover() and normal reads make progress instead of rethrowing forever. A real I/O error
	// (permissions, EIO, EISDIR, ...) still throws — it must not be masked.
	private async readBytesIfExists(filePath: string, jsonGuard: boolean): Promise<Uint8Array | undefined> {
		const bytes = await readFileIfExists(filePath);
		if (bytes === undefined) return undefined;
		if (jsonGuard && !isParseableJson(bytes)) {
			log('readBytesIfExists: corrupt JSON at %s, treating as missing', filePath);
			return undefined;
		}
		return bytes;
	}

	private async directoryByteSize(dir: string): Promise<number> {
		const entries = await fs.readdir(dir, { withFileTypes: true })
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
				log('directoryByteSize readdir failed for %s - %o', dir, err);
				return [];
			});

		let total = 0;
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				total += await this.directoryByteSize(entryPath);
			} else if (entry.isFile()) {
				const size = await fs.stat(entryPath)
					.then(st => st.size)
					.catch((err) => {
						if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
						log('directoryByteSize stat failed for %s - %o', entryPath, err);
						return 0;
					});
				total += size;
			}
		}
		return total;
	}
}
