import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('store-lock');

export const STORE_LOCK_FILENAME = 'store.lock';

/** What the lock file records about the process that took it. */
export interface StoreLockHolder {
	readonly pid: number;
	readonly hostname: string;
}

/**
 * Thrown by every operation of a store whose directory another live process on this machine has
 * open. Invariant 5 in `packages/db-p2p/docs/storage.md`: a store is owned by exactly one process,
 * and the write-ahead log makes two writers in one file a corruption rather than a stale cache.
 */
export class StoreLockedError extends Error {
	constructor(readonly lockPath: string, readonly holder: StoreLockHolder) {
		super(`store at ${path.dirname(lockPath)} is open in process ${holder.pid} on ${holder.hostname}; a store is owned by one process at a time`);
		this.name = 'StoreLockedError';
	}
}

export interface StoreLock {
	readonly path: string;
	/** Remove the lock file. Idempotent. */
	release(): Promise<void>;
}

/** How many stale locks one open will replace before giving up on a directory whose lock keeps reappearing. */
const REPLACE_ATTEMPTS = 3;

/**
 * Take `<basePath>/store.lock` for this process. The file is created exclusively (`wx`) and holds
 * `{ pid, hostname }`. An existing lock naming this machine and a live pid refuses the open with
 * {@link StoreLockedError}; any other existing lock — another machine's, a dead pid's, or one whose
 * content cannot be read — is stale and replaced. The liveness test is `process.kill(pid, 0)`, so
 * only one machine is protected, which is the one case ever supported (two machines over one
 * network share never were; Invariant 5).
 *
 * NOTE: the content is written in the same call that creates the file, but a second process that
 * opens the directory in the microseconds between the create and the write reads an empty file,
 * judges the lock stale and replaces it. Two processes starting over one directory at the same
 * instant is already the violation the lock exists to refuse; if that race is ever seen, judge an
 * unreadable lock by its age instead of replacing it at once.
 */
export async function acquireStoreLock(basePath: string): Promise<StoreLock> {
	const lockPath = path.join(basePath, STORE_LOCK_FILENAME);
	const self: StoreLockHolder = { pid: process.pid, hostname: os.hostname() };
	for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
		if (await tryCreate(lockPath, self)) {
			return { path: lockPath, release: () => removeLock(lockPath) };
		}
		const holder = await readHolder(lockPath);
		if (holder && holder.hostname === self.hostname && processExists(holder.pid)) {
			throw new StoreLockedError(lockPath, holder);
		}
		log('replacing stale lock %s held by %o', lockPath, holder);
		await removeLock(lockPath);
	}
	throw new Error(`could not take ${lockPath}: it was replaced ${REPLACE_ATTEMPTS} times by another opener`);
}

async function tryCreate(lockPath: string, holder: StoreLockHolder): Promise<boolean> {
	try {
		await fs.writeFile(lockPath, JSON.stringify(holder), { flag: 'wx' });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw err;
	}
}

/** The holder a lock file names, or `undefined` for a missing, unreadable or malformed one. */
async function readHolder(lockPath: string): Promise<StoreLockHolder | undefined> {
	let text: string;
	try {
		text = await fs.readFile(lockPath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isHolder(parsed) ? parsed : undefined;
	} catch (err) {
		if (err instanceof SyntaxError) return undefined;
		throw err;
	}
}

function isHolder(value: unknown): value is StoreLockHolder {
	if (typeof value !== 'object' || value === null) return false;
	const { pid, hostname } = value as Record<string, unknown>;
	return Number.isInteger(pid) && (pid as number) > 0 && typeof hostname === 'string';
}

/** Signal 0 tests for existence without sending anything; EPERM means the process exists but is not ours. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function removeLock(lockPath: string): Promise<void> {
	try {
		await fs.unlink(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}
