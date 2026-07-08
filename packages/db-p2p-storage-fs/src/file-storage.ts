import { promises as fs } from 'fs';
import * as path from 'path';
import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockMetadata, IRawStorage } from "@optimystic/db-p2p";
import { createLogger } from './logger.js';
import { atomicWriteFile } from './atomic-write.js';

const log = createLogger('storage:file');

// Colons are illegal in Windows filenames; encode them so action ids like
// `tx:<hash>` and `stamp:<hash>` round-trip safely on all platforms.
function encodeActionIdForFilename(actionId: ActionId): string {
	return actionId.replace(/:/g, '%3A');
}

function decodeFilenameToActionId(filename: string): ActionId {
	return filename.replace(/%3A/g, ':') as ActionId;
}

export class FileRawStorage implements IRawStorage {
	constructor(private readonly basePath: string) {
		// TODO: use https://www.npmjs.com/package/proper-lockfile to take a lock on the basePath, also introduce explicit dispose pattern
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.readIfExists<BlockMetadata>(this.getMetadataPath(blockId));
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.ensureAndWriteFile(
			this.getMetadataPath(blockId),
			JSON.stringify(metadata)
		);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.readIfExists<ActionId>(this.getRevisionPath(blockId, rev));
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.ensureAndWriteFile(
			this.getRevisionPath(blockId, rev),
			JSON.stringify(actionId)
		);
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.readActionScopedFile<Transform>(
			this.getPendingActionPath(blockId, actionId),
			this.getPendingActionPath(blockId, actionId, false)
		);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.ensureAndWriteFile(
			this.getPendingActionPath(blockId, actionId),
			JSON.stringify(transform)
		);
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingPath = this.getPendingActionPath(blockId, actionId);
		await fs.unlink(pendingPath)
			.catch((err) => {
				if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('deletePendingTransaction unlink failed for %s/%s - %o', blockId, actionId, err);
			});
		await this.unlinkRawColon(pendingPath, this.getPendingActionPath(blockId, actionId, false));
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		// Only a genuinely-absent directory (ENOENT) maps to "no pendings". Any other error
		// (EACCES, EIO, ENOTDIR, ...) must surface — swallowing it here would make
		// listPendingTransactions silently report an empty directory, so pend's conflict
		// detection would be skipped. Mirrors directoryByteSize's ENOENT-vs-other discrimination.
		const files = await fs.readdir(pendingPath).catch((err) => {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [] as string[];
			log('listPendingTransactions readdir failed for %s - %o', blockId, err);
			throw err;
		});
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const actionId = decodeFilenameToActionId(file.slice(0, -5));
			// Accept legacy UUID format and consensus tx:/stamp: format. The
			// consensus hash is base64url-encoded SHA-256 (see db-core hashString),
			// so its alphabet is [A-Za-z0-9_-] — NOT lowercase hex.
			if (!/^(?:[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+|(?:tx|stamp):[A-Za-z0-9_-]+)$/.test(actionId)) {
				// Leave a breadcrumb rather than silently dropping: a future id scheme that
				// doesn't match legacy-UUID or tx:/stamp: shape would otherwise vanish from
				// the listing with no signal. The .json + decode guard still excludes stray files.
				log('listPendingTransactions skipping unrecognized action-id file %s for %s', file, blockId);
				continue;
			}
			yield actionId;
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.readActionScopedFile<Transform>(
			this.getActionPath(blockId, actionId),
			this.getActionPath(blockId, actionId, false)
		);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		for (let rev = startRev; startRev <= endRev ? rev <= endRev : rev >= endRev; startRev <= endRev ? ++rev : --rev) {
			const actionId = await this.getRevision(blockId, rev);
			if (actionId) {
				yield { actionId, rev };
			}
		}
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.ensureAndWriteFile(
			this.getActionPath(blockId, actionId),
			JSON.stringify(transform)
		);
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return this.readActionScopedFile<IBlock>(
			this.getMaterializedPath(blockId, actionId),
			this.getMaterializedPath(blockId, actionId, false)
		);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		if (block) {
			await this.ensureAndWriteFile(
				this.getMaterializedPath(blockId, actionId),
				JSON.stringify(block)
			);
		} else {
			await fs.unlink(this.getMaterializedPath(blockId, actionId))
				.catch((err) => {
					if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('saveMaterializedBlock unlink failed for %s/%s - %o', blockId, actionId, err);
				});
			await this.unlinkRawColon(this.getMaterializedPath(blockId, actionId), this.getMaterializedPath(blockId, actionId, false));
		}
	}

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

	async getApproximateBytesUsed(): Promise<number> {
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

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingPath = this.getPendingActionPath(blockId, actionId);
		const actionPath = this.getActionPath(blockId, actionId);

		await fs.mkdir(path.dirname(actionPath), { recursive: true });

		return fs.rename(pendingPath, actionPath)
			.catch(err => {
				if (err.code === 'ENOENT') {
					throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
				}
				log('promotePendingTransaction rename failed for %s/%s - %o', blockId, actionId, err);
				throw err;
			});
	}

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
	// (see readActionScopedFile) passes encoded = false to reach pre-encode
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
	// so a deleted item cannot resurface via the read fallback in readActionScopedFile.
	// Skipped on win32 (raw-colon files cannot exist there) and when paths are identical
	// (action id contains no colon — only one syscall needed). ENOENT is silently ignored.
	private async unlinkRawColon(encodedPath: string, rawPath: string): Promise<void> {
		if (process.platform === 'win32' || rawPath === encodedPath) return;
		await fs.unlink(rawPath).catch((err) => {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('unlinkRawColon failed for %s - %o', rawPath, err);
		});
	}

	// Reads an action-id-keyed file by its canonical (percent-encoded) path,
	// falling back on a miss to the legacy raw-colon path written by pre-encode
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
	private async readActionScopedFile<T>(encodedPath: string, rawPath: string): Promise<T | undefined> {
		const hit = await this.readIfExists<T>(encodedPath);
		if (hit !== undefined) return hit;
		if (process.platform === 'win32' || rawPath === encodedPath) return undefined;
		return fs.readFile(rawPath, 'utf-8')
			.then(content => JSON.parse(content) as T)
			.catch(() => undefined);
	}

	private async readIfExists<T>(filePath: string): Promise<T | undefined> {
		return fs.readFile(filePath, 'utf-8')
			.then(content => JSON.parse(content) as T)
			.catch(err => {
				if (err?.code === 'ENOENT') return undefined;
				// A JSON parse failure (SyntaxError, which carries no `code`) means the
				// file is present but corrupt — most likely a torn write from a crash
				// before atomic writes existed. Treat it as "missing" so recover() and
				// normal reads make progress instead of rethrowing forever. A real I/O
				// error (permissions, EIO, ...) still throws — it must not be masked.
				if (err instanceof SyntaxError) {
					log('readIfExists: corrupt JSON at %s, treating as missing - %o', filePath, err);
					return undefined;
				}
				throw err;
			});
	}

	private async ensureAndWriteFile(filePath: string, content: string): Promise<void> {
		await atomicWriteFile(filePath, content);
	}
}
