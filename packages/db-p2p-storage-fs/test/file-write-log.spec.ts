import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { crc32 } from 'zlib';
import { StoreFailedError } from '@optimystic/db-p2p';
import type { BlockId, ActionId } from '@optimystic/db-core';
import {
	FileWriteLog, StoreLockedError, WRITE_LOG_FILENAME, STORE_LOCK_FILENAME, WRITE_LOG_HEADER,
	encodeWriteLogRecord, decodeWriteLog, type WriteLogEntry,
} from '../src/index.js';
import { trackedStores } from './support/tracked-stores.js';
import { interceptHandleSync, withFailingWriteFile } from './support/fs-injection.js';

// ---------------------------------------------------------------------------
// The write-ahead log on its own: what a strict replay applies from a damaged log, what a commit
// leaves behind when it fails at each of its two steps, and the lock. Logs are hand-built from the
// exported codec so a replay can be given records the store never applied — the shape a crash
// between the sync and the apply leaves — without a real crash.
// ---------------------------------------------------------------------------

const put = (relative: string, text: string): WriteLogEntry => ({ kind: 'put', path: relative, value: Buffer.from(text) });
const del = (relative: string): WriteLogEntry => ({ kind: 'delete', path: relative });

async function readText(base: string, relative: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.join(base, relative), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

async function writeLogFile(base: string, ...parts: Uint8Array[]): Promise<void> {
	await fs.writeFile(path.join(base, WRITE_LOG_FILENAME), Buffer.concat(parts.map(p => Buffer.from(p))));
}

async function logFileBytes(base: string): Promise<Buffer> {
	return fs.readFile(path.join(base, WRITE_LOG_FILENAME));
}

async function lockExists(base: string): Promise<boolean> {
	return fs.access(path.join(base, STORE_LOCK_FILENAME)).then(() => true, () => false);
}

/** Open the directory's log, run `fn` over it, and release it — the last release closes the handle and removes the lock. */
async function withLog(base: string, fn: (log: FileWriteLog) => Promise<void>): Promise<void> {
	const log = FileWriteLog.acquire(base);
	try {
		await fn(log);
	} finally {
		await log.release();
	}
}

describe('FileWriteLog record codec', () => {
	it('round-trips a batch of puts and deletes through one record', () => {
		const batch = [put('b/meta.json', '{"a":1}'), del('b/pend/x.json'), put('b/revs/1.json', 'tx:é')];
		const decoded = decodeWriteLog(Buffer.concat([Buffer.from(WRITE_LOG_HEADER), Buffer.from(encodeWriteLogRecord(batch))]));
		assert.strictEqual(decoded.stoppedBy, undefined);
		assert.strictEqual(decoded.batches.length, 1);
		assert.deepStrictEqual(decoded.batches[0]!.map(e => [e.kind, e.path, e.kind === 'put' ? Buffer.from(e.value).toString('utf8') : undefined]),
			[['put', 'b/meta.json', '{"a":1}'], ['delete', 'b/pend/x.json', undefined], ['put', 'b/revs/1.json', 'tx:é']]);
	});
});

describe('FileWriteLog replay', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-wal-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('applies every intact record in order, then truncates the log to its header', async () => {
		await writeLogFile(base, WRITE_LOG_HEADER,
			encodeWriteLogRecord([put('blk/meta.json', 'one'), put('blk/pend/a.json', 'pending')]),
			encodeWriteLogRecord([put('blk/meta.json', 'two'), del('blk/pend/a.json'), put('blk/actions/a.json', 'promoted')]));

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'two', 'the later record wins');
			assert.strictEqual(await readText(base, 'blk/pend/a.json'), undefined, 'the delete in the later record applied');
			assert.strictEqual(await readText(base, 'blk/actions/a.json'), 'promoted');
			assert.ok((await logFileBytes(base)).equals(Buffer.from(WRITE_LOG_HEADER)), 'log holds only its header after replay');
		});
	});

	it('stops at a torn final record and applies what precedes it', async () => {
		const second = Buffer.from(encodeWriteLogRecord([put('blk/meta.json', 'two')]));
		await writeLogFile(base, WRITE_LOG_HEADER, encodeWriteLogRecord([put('blk/meta.json', 'one')]), second.subarray(0, second.length - 1));

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'one');
			assert.ok((await logFileBytes(base)).equals(Buffer.from(WRITE_LOG_HEADER)));
		});
	});

	it('a CRC mismatch in the middle is treated like a torn end: stop there, apply what precedes', async () => {
		const second = Buffer.from(encodeWriteLogRecord([put('blk/meta.json', 'two')]));
		second[second.length - 1] = second[second.length - 1]! ^ 0xff;
		await writeLogFile(base, WRITE_LOG_HEADER,
			encodeWriteLogRecord([put('blk/meta.json', 'one')]), second, encodeWriteLogRecord([put('blk/revs/3.json', 'three')]));

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'one', 'the record before the mismatch applied');
			assert.strictEqual(await readText(base, 'blk/revs/3.json'), undefined, 'the intact record after it is discarded');
		});
	});

	it('a record whose length runs past the end of the file is torn', async () => {
		const overlong = Buffer.alloc(12);
		overlong.writeUInt32LE(1 << 30, 0);
		overlong.writeUInt32LE(crc32(Buffer.alloc(0)), 4);
		await writeLogFile(base, WRITE_LOG_HEADER, encodeWriteLogRecord([put('blk/meta.json', 'one')]), overlong);

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'one');
		});
	});

	it('a file that is not a write-ahead log replays nothing and is replaced by a fresh header', async () => {
		await writeLogFile(base, Buffer.from('not a log at all'));

		await withLog(base, async log => {
			await log.open();
			assert.ok((await logFileBytes(base)).equals(Buffer.from(WRITE_LOG_HEADER)));
		});
	});

	it('a store written by a build before the log has none and opens over its tree unchanged', async () => {
		await fs.mkdir(path.join(base, 'blk'), { recursive: true });
		await fs.writeFile(path.join(base, 'blk', 'meta.json'), 'older build');

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'older build');
			assert.ok((await logFileBytes(base)).equals(Buffer.from(WRITE_LOG_HEADER)), 'a header-only log was created');
		});
	});
});

describe('FileWriteLog commit failures', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-wal-fail-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('a batch whose tree write fails after its record is durable is rebuilt by the next open', async () => {
		await withLog(base, async log => {
			await log.commit([put('blk/meta.json', 'one')]);
			await withFailingWriteFile(async () => {
				await assert.rejects(() => log.commit([put('blk/meta.json', 'two'), put('blk/revs/2.json', 'tx:2')]), StoreFailedError);
			});
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'one', 'the tree still holds the prior content');
			assert.strictEqual(await readText(base, 'blk/revs/2.json'), undefined);
			assert.ok(log.failed);
			await assert.rejects(() => log.commit([put('blk/meta.json', 'three')]), StoreFailedError, 'latched: later commits are refused');
		});

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(await readText(base, 'blk/meta.json'), 'two', 'replay wrote the durable record into the tree');
			assert.strictEqual(await readText(base, 'blk/revs/2.json'), 'tx:2');
		});
	});

	it('a batch whose record never reached the log leaves nothing in the tree and latches the log', async () => {
		let failSync = false;
		const restore = interceptHandleSync(() => { if (failSync) throw new Error('injected sync failure'); });
		try {
			await withLog(base, async log => {
				await log.open();
				failSync = true;
				await assert.rejects(() => log.commit([put('blk/meta.json', 'lost')]), StoreFailedError);
				assert.strictEqual(await readText(base, 'blk/meta.json'), undefined, 'nothing was applied');
				assert.ok(log.failed);
				failSync = false;
				await assert.rejects(() => log.commit([put('blk/meta.json', 'after')]), StoreFailedError, 'a retried sync is never trusted');
				assert.strictEqual(await readText(base, 'blk/meta.json'), undefined);
			});
		} finally {
			restore();
		}
	});
});

describe('FileWriteLog lock', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-lock-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	const writeLock = (holder: { pid: number; hostname: string }) =>
		fs.writeFile(path.join(base, STORE_LOCK_FILENAME), JSON.stringify(holder));

	it('refuses a directory held by a live process on this machine, from every operation', async () => {
		await writeLock({ pid: process.pid, hostname: os.hostname() });

		await withLog(base, async log => {
			await assert.rejects(() => log.open(), StoreLockedError);
		});
		const storage = stores.open(base);
		await assert.rejects(() => storage.getMetadata('b' as BlockId), StoreLockedError);
		await storage.saveRevision('b' as BlockId, 1, 'tx:1' as ActionId);
		await assert.rejects(() => storage.flush(), (err: StoreFailedError) => err instanceof StoreFailedError && err.cause instanceof StoreLockedError);
		assert.strictEqual(JSON.parse(await fs.readFile(path.join(base, STORE_LOCK_FILENAME), 'utf8')).pid, process.pid, 'the holder keeps its lock');
	});

	it('replaces a lock left by another machine', async () => {
		await writeLock({ pid: process.pid, hostname: 'another-machine' });

		await withLog(base, async log => {
			await log.open();
			assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(base, STORE_LOCK_FILENAME), 'utf8')), { pid: process.pid, hostname: os.hostname() });
		});
	});

	it('replaces a lock left by a process that has exited', async () => {
		const exited = spawnSync(process.execPath, ['-e', '']);
		assert.ok(exited.pid > 0, 'spawned a short-lived process to take a pid from');
		await writeLock({ pid: exited.pid, hostname: os.hostname() });

		await withLog(base, async log => {
			await log.open();
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(base, STORE_LOCK_FILENAME), 'utf8')).pid, process.pid);
		});
	});

	it('two stores over one directory in one process share one log and one lock, released by the last close', async () => {
		const first = stores.open(base);
		const second = stores.open(base);
		assert.strictEqual(first.getStoreIdentity(), second.getStoreIdentity());

		await first.saveMetadata('shared' as BlockId, { ranges: [[1]], latest: { rev: 1, actionId: 'tx:1' as ActionId } });
		await first.flush();
		assert.deepStrictEqual(await second.getMetadata('shared' as BlockId), { ranges: [[1]], latest: { rev: 1, actionId: 'tx:1' } }, 'the second store reads the tree the first wrote through the shared log');
		const rootFiles = (await fs.readdir(base)).filter(name => name === STORE_LOCK_FILENAME || name === WRITE_LOG_FILENAME).sort();
		assert.deepStrictEqual(rootFiles, [STORE_LOCK_FILENAME, WRITE_LOG_FILENAME], 'one lock and one log');

		await first.close();
		assert.ok(await lockExists(base), 'the lock outlives the first close');
		await second.close();
		assert.ok(!(await lockExists(base)), 'the last close removes the lock');
	});

	it('a log acquired while the previous one over the directory is still closing opens after it', async () => {
		const first = stores.open(base);
		await first.saveRevision('b' as BlockId, 1, 'tx:1' as ActionId);
		await first.flush();
		const closing = first.close();
		const second = stores.open(base);
		const read = second.getRevision('b' as BlockId, 1);
		await closing;
		assert.strictEqual(await read, 'tx:1');
	});
});
