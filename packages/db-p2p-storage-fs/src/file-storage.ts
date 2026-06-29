import { promises as fs } from 'fs';
import * as path from 'path';
import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockMetadata, IRawStorage } from "@optimystic/db-p2p";
import { createLogger } from './logger.js';

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
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		const files = await fs.readdir(pendingPath).catch((err) => { log('listPendingTransactions readdir failed for %s - %o', blockId, err); return [] as string[]; });
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const actionId = decodeFilenameToActionId(file.slice(0, -5));
			// Accept legacy UUID format and consensus tx:/stamp: format. The
			// consensus hash is base64url-encoded SHA-256 (see db-core hashString),
			// so its alphabet is [A-Za-z0-9_-] — NOT lowercase hex.
			if (!/^(?:[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+|(?:tx|stamp):[A-Za-z0-9_-]+)$/.test(actionId)) continue;
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
				if (err.code === 'ENOENT') return undefined;
				throw err;
			});
	}

	private async ensureAndWriteFile(filePath: string, content: string): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
	}
}
