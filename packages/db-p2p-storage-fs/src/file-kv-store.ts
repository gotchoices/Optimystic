import { promises as fs } from 'fs';
import * as path from 'path';
import type { IKVStore } from '@optimystic/db-p2p';

/** Filesystem-backed IKVStore. Keys may contain `/` separators which become subdirectories. */
export class FileKVStore implements IKVStore {
	constructor(private readonly basePath: string) {}

	async get(key: string): Promise<string | undefined> {
		try {
			return await fs.readFile(this.keyToPath(key), 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
			throw err;
		}
	}

	async set(key: string, value: string): Promise<void> {
		const filePath = this.keyToPath(key);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, value);
	}

	async delete(key: string): Promise<void> {
		try {
			await fs.unlink(this.keyToPath(key));
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
		}
	}

	async list(prefix: string): Promise<string[]> {
		// prefix like "coordinator/" → scan basePath/coordinator/ directory
		const parts = prefix.split('/').filter(Boolean);
		const dirPath = path.join(this.basePath, ...parts);
		const results: string[] = [];
		await this.listRecursive(dirPath, prefix, results);
		return results;
	}

	private async listRecursive(dirPath: string, prefix: string, results: string[]): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const subPrefix = prefix + entry.name + '/';
				await this.listRecursive(path.join(dirPath, entry.name), subPrefix, results);
			} else if (entry.isFile() && entry.name.endsWith('.json')) {
				results.push(prefix + entry.name.slice(0, -5));
			}
		}
	}

	private keyToPath(key: string): string {
		return path.join(this.basePath, ...key.split('/')) + '.json';
	}
}
