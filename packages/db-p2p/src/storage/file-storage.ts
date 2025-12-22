import { promises as fs } from 'fs';
import * as path from 'path';
import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { createLogger } from '../logger.js'

const log = createLogger('storage:file')

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
			actionId
		);
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.readIfExists<Transform>(this.getPendingActionPath(blockId, actionId));
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
				// Ignore if file doesn't exist
				if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('deletePendingTransaction unlink failed for %s/%s - %o', blockId, actionId, err)
			});
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		const files = await fs.readdir(pendingPath).catch((err) => { log('listPendingTransactions readdir failed for %s - %o', blockId, err); return [] as string[] });
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const rawActionId = file.slice(0, -5);
			if (!/^[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+$/.test(rawActionId)) continue;
			yield rawActionId as ActionId;
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.readIfExists<Transform>(this.getActionPath(blockId, actionId));
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		// TODO: Optimize this for sparse revs
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
		return this.readIfExists<IBlock>(this.getMaterializedPath(blockId, actionId));
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
					// Ignore if file doesn't exist
					if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log('saveMaterializedBlock unlink failed for %s/%s - %o', blockId, actionId, err)
				});
		}
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingPath = this.getPendingActionPath(blockId, actionId);
		const actionPath = this.getActionPath(blockId, actionId);

		// Ensure target directory exists
		await fs.mkdir(path.dirname(actionPath), { recursive: true });

		return fs.rename(pendingPath, actionPath)
			.catch(err => {
				if (err.code === 'ENOENT') {
					throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
				}
				log('promotePendingTransaction rename failed for %s/%s - %o', blockId, actionId, err)
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

	private getPendingActionPath(blockId: BlockId, actionId: ActionId): string {
		return path.join(this.getBlockPath(blockId), 'pend', `${actionId}.json`);
	}

	private getActionPath(blockId: BlockId, actionId: ActionId): string {
		return path.join(this.getBlockPath(blockId), 'actions', `${actionId}.json`);
	}

	private getMaterializedPath(blockId: BlockId, actionId: ActionId): string {
		return path.join(this.getBlockPath(blockId), 'blocks', `${actionId}.json`);
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
