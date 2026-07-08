import { promises as fs } from 'fs';
import * as path from 'path';
import type { BlockId, ActionId } from "@optimystic/db-core";
import { KvRawStorage, type RawStoreDriver } from "@optimystic/db-p2p";
import { createLogger } from './logger.js';
import { atomicWriteFile } from './atomic-write.js';

const log = createLogger('storage:file');

const decoder = new TextDecoder();

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
function isParseableJson(bytes: Uint8Array): boolean {
	try {
		JSON.parse(decoder.decode(bytes));
		return true;
	} catch (err) {
		if (err instanceof SyntaxError) return false;
		throw err;
	}
}

/**
 * Filesystem {@link RawStoreDriver}: the five logical block-storage stores mapped
 * to five subdirectories under `basePath/<blockId>/`
 * (`{meta.json,revs/,pend/,actions/,blocks/}`). The directory tree is a
 * deliberate, human-inspectable/debuggable layout — it is NOT flattened into
 * encoded-filename KV keys.
 *
 * `KvRawStorage` now owns all JSON serialization, so this driver reads/writes raw
 * `Uint8Array` bytes and never does `JSON.stringify/parse` on values. Everything
 * else fs-specific lives here: atomic (temp-file + rename) writes, the
 * corrupt-content-as-missing read guard, colon-encoded action-id filenames with
 * the legacy raw-colon read fallback + win32 guards, and rename-based promote.
 */
export class FileStoreDriver implements RawStoreDriver {
	constructor(private readonly basePath: string) {
		// TODO: use https://www.npmjs.com/package/proper-lockfile to take a lock on the basePath, also introduce explicit dispose pattern
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		return this.readBytesIfExists(this.getMetadataPath(blockId), true);
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		await atomicWriteFile(this.getMetadataPath(blockId), value);
	}

	// --- revisions ---

	// The revisions store value is a bare ActionId string (kernel `encodeActionId`,
	// NOT JSON), so it is read WITHOUT the JSON guard — any bytes are a valid string
	// and `decodeActionId` never throws.
	// NOTE: because there is no guard here, a *torn* revision file reads back as a wrong
	// (truncated) ActionId rather than as missing — unlike the JSON stores, which torn-read
	// as undefined. Atomic writes (temp+rename) make a new torn revision impossible; only a
	// legacy pre-atomic-write torn rev could hit this, and recover() re-derives revisions
	// from the actions store anyway. If revisions ever move to a non-atomic writer, add a
	// checksum/length guard here.
	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		return this.readBytesIfExists(this.getRevisionPath(blockId, rev), false);
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await atomicWriteFile(this.getRevisionPath(blockId, rev), value);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		// The fs backend has no cursor: walk the bounded [lo, hi] range rev-by-rev,
		// reading each present rev. The range is caller-bounded, so this avoids
		// listing an unbounded revs/ directory. Drain into an array BEFORE yielding
		// (drain-before-yield contract) — matches the memory/native drivers and keeps
		// the consumer's interleaved awaits from straddling any in-flight read.
		const results: [number, Uint8Array][] = [];
		for (let rev = lo; rev <= hi; rev++) {
			const value = await this.readBytesIfExists(this.getRevisionPath(blockId, rev), false);
			if (value !== undefined) {
				results.push([rev, value]);
			}
		}
		if (reverse) {
			results.reverse();
		}
		for (const result of results) {
			yield result;
		}
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.readActionScopedBytes(
			this.getPendingActionPath(blockId, actionId),
			this.getPendingActionPath(blockId, actionId, false)
		);
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await atomicWriteFile(this.getPendingActionPath(blockId, actionId), value);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingPath = this.getPendingActionPath(blockId, actionId);
		await fs.unlink(pendingPath)
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('deletePending unlink failed for %s/%s - %o', blockId, actionId, err);
			});
		await this.unlinkRawColon(pendingPath, this.getPendingActionPath(blockId, actionId, false));
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		// Only a genuinely-absent directory (ENOENT) maps to "no pendings". Any other error
		// (EACCES, EIO, ENOTDIR, ...) must surface — swallowing it here would make
		// listPendingActionIds silently report an empty directory, so pend's conflict
		// detection would be skipped. Mirrors directoryByteSize's ENOENT-vs-other discrimination.
		const files = await fs.readdir(pendingPath).catch((err) => {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [] as string[];
			log('listPendingActionIds readdir failed for %s - %o', blockId, err);
			throw err;
		});
		// Drain into an array before yielding (drain-before-yield): readdir has already
		// resolved the full listing, so this just decodes/filters up front.
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
				// already excludes *.tmp orphans, so anything reaching here is an unexpected
				// filename a maintainer should see.
				log('listPendingActionIds skipping unrecognized action-id file %s for %s', file, blockId);
				continue;
			}
			ids.push(actionId);
		}
		for (const id of ids) {
			yield id;
		}
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.readActionScopedBytes(
			this.getActionPath(blockId, actionId),
			this.getActionPath(blockId, actionId, false)
		);
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await atomicWriteFile(this.getActionPath(blockId, actionId), value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		return this.readActionScopedBytes(
			this.getMaterializedPath(blockId, actionId),
			this.getMaterializedPath(blockId, actionId, false)
		);
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await atomicWriteFile(this.getMaterializedPath(blockId, actionId), value);
	}

	// The kernel owns the put-or-delete branch of `saveMaterializedBlock`, so the
	// driver exposes delete as a separate op.
	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		const matPath = this.getMaterializedPath(blockId, actionId);
		await fs.unlink(matPath)
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('deleteMaterialized unlink failed for %s/%s - %o', blockId, actionId, err);
			});
		await this.unlinkRawColon(matPath, this.getMaterializedPath(blockId, actionId, false));
	}

	// --- promote (the only cross-key atomic op) ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingPath = this.getPendingActionPath(blockId, actionId);
		const actionPath = this.getActionPath(blockId, actionId);

		await fs.mkdir(path.dirname(actionPath), { recursive: true });

		// This single rename IS the atomic move — it is why fs honors the kernel's
		// promote contract without a WAL. A crash leaves either the pending or the
		// committed file, never both/neither. Do NOT replace with read-write-delete.
		return fs.rename(pendingPath, actionPath)
			.catch(err => {
				if (err.code === 'ENOENT') {
					throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
				}
				log('promote rename failed for %s/%s - %o', blockId, actionId, err);
				throw err;
			});
	}

	// --- optional passthroughs ---

	async *listBlockIds(): AsyncIterable<BlockId> {
		// The block layout is `basePath/<blockId>/{meta.json,revs/,pend/,actions/,blocks/}`
		// (see getBlockPath), so the direct children of basePath are the per-block directories
		// and each directory NAME is the blockId (used raw, no encoding). Filter to directories
		// so a stray file can't be mistaken for a block; `*.tmp` atomic-write orphans live inside
		// block subdirs, never at basePath root, so the root is clean.
		//
		// A directory alone is NOT sufficient to call a block "durable owned": a block that was
		// only PENDED (never committed) still creates `<blockId>/pend/` — hence a root directory
		// entry — via atomicWriteFile's recursive mkdir, but has no meta.json. So we gate on
		// meta.json existence: `meta.json` IS this backend's metadata store, and enumerating it
		// yields exactly the blocks with a committed revision / persisted replica (the same
		// "owned" population the live change feed tracks, and the same one the metadata-keyed
		// backends — sqlite/leveldb/indexeddb — enumerate for free). Existence (fs.access), not
		// parse, matches key-existence semantics: a torn/corrupt meta.json still counts as a key,
		// exactly as a corrupt value would in the other backends.
		//
		// ENOENT (basePath not created yet, or a dir without meta.json) maps to "not owned" —
		// same discrimination as directoryByteSize. Any OTHER readdir/access error must surface:
		// swallowing it would make the seed falsely report an empty store and under-protect data
		// already on disk.
		// NOTE: reads the whole root listing up front + one meta.json stat per block dir; if a
		// store ever grows to millions of block subdirs and this becomes a startup-latency
		// problem, page it (e.g. opendir cursor) — fine at current scale.
		const entries = await fs.readdir(this.basePath, { withFileTypes: true })
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
				log('listBlockIds readdir failed for %s - %o', this.basePath, err);
				throw err;
			});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const blockId = entry.name as BlockId;
			const hasMeta = await fs.access(this.getMetadataPath(blockId))
				.then(() => true)
				.catch((err) => {
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
					log('listBlockIds access failed for %s - %o', blockId, err);
					throw err;
				});
			if (hasMeta) yield blockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		return this.directoryByteSize(this.basePath);
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

	// --- paths ---

	private getBlockPath(blockId: BlockId): string {
		return path.join(this.basePath, blockId);
	}

	private getMetadataPath(blockId: BlockId): string {
		return path.join(this.getBlockPath(blockId), 'meta.json');
	}

	private getRevisionPath(blockId: BlockId, rev: number): string {
		return path.join(this.getBlockPath(blockId), 'revs', `${rev}.json`);
	}

	// `encoded` controls colon handling: writes and canonical reads use the
	// percent-encoded filename (encoded = true); the legacy raw-colon fallback
	// (see readActionScopedBytes) passes encoded = false to reach pre-encode
	// POSIX files like `actions/tx:<hash>.json`.
	private getPendingActionPath(blockId: BlockId, actionId: ActionId, encoded = true): string {
		const filename = encoded ? encodeActionIdForFilename(actionId) : actionId;
		return path.join(this.getBlockPath(blockId), 'pend', `${filename}.json`);
	}

	private getActionPath(blockId: BlockId, actionId: ActionId, encoded = true): string {
		const filename = encoded ? encodeActionIdForFilename(actionId) : actionId;
		return path.join(this.getBlockPath(blockId), 'actions', `${filename}.json`);
	}

	private getMaterializedPath(blockId: BlockId, actionId: ActionId, encoded = true): string {
		const filename = encoded ? encodeActionIdForFilename(actionId) : actionId;
		return path.join(this.getBlockPath(blockId), 'blocks', `${filename}.json`);
	}

	// Best-effort removal of a pre-encode raw-colon file after the encoded delete,
	// so a deleted item cannot resurface via the read fallback in readActionScopedBytes.
	// Skipped on win32 (raw-colon files cannot exist there) and when paths are identical
	// (action id contains no colon — only one syscall needed). ENOENT is silently ignored.
	private async unlinkRawColon(encodedPath: string, rawPath: string): Promise<void> {
		if (process.platform === 'win32' || rawPath === encodedPath) return;
		await fs.unlink(rawPath).catch((err) => {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('unlinkRawColon failed for %s - %o', rawPath, err);
		});
	}

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
	// present-but-corrupt file (JSON.parse fails — most likely a torn write from a
	// crash before atomic writes existed) is treated as "missing" so recover() and
	// normal reads make progress instead of rethrowing forever. A real I/O error
	// (permissions, EIO, EISDIR, ...) still throws — it must not be masked.
	private async readBytesIfExists(filePath: string, jsonGuard: boolean): Promise<Uint8Array | undefined> {
		let bytes: Uint8Array;
		try {
			bytes = await fs.readFile(filePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
			throw err;
		}
		if (jsonGuard && !isParseableJson(bytes)) {
			log('readBytesIfExists: corrupt JSON at %s, treating as missing', filePath);
			return undefined;
		}
		return bytes;
	}
}

/**
 * Filesystem-backed {@link IRawStorage}, now a thin shell over the shared
 * {@link KvRawStorage} kernel driven by a {@link FileStoreDriver}. The public
 * name/constructor (`new FileRawStorage(basePath)`) is unchanged so existing
 * imports keep resolving; the kernel supplies the `IRawStorage` surface and the
 * driver supplies fs behavior.
 *
 * `listBlockIds`/`getApproximateBytesUsed` are re-declared here as always-present
 * (the fs driver always implements them, so the kernel constructor always wires
 * them) — the base declares them optional, but every fs consumer relies on them.
 */
export class FileRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;

	constructor(basePath: string) {
		super(new FileStoreDriver(basePath));
	}
}
