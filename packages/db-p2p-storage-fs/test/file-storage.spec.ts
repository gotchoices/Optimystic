import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRawStorage, FileKVStore } from '../src/index.js';
import { BlockStorage } from '@optimystic/db-p2p';
import type { BlockMetadata } from '@optimystic/db-p2p';
import type { BlockId, ActionId } from '@optimystic/db-core';

// Injects a "crash" between the atomic writer's temp write and its rename by
// making fs.rename throw. atomic-write.ts holds the same `fs.promises` singleton,
// so overriding `rename` on it aborts the write exactly at the rename step. Always
// restore in a finally so one test's injection never leaks into another.
async function withFailingRename(fn: () => Promise<void>): Promise<void> {
	const original = fs.rename;
	(fs as { rename: typeof fs.rename }).rename = async () => { throw new Error('injected crash before rename'); };
	try {
		await fn();
	} finally {
		(fs as { rename: typeof fs.rename }).rename = original;
	}
}

async function hasTempSibling(dir: string): Promise<boolean> {
	const entries = await fs.readdir(dir);
	return entries.some(e => e.endsWith('.tmp'));
}

// Injects a readdir failure with a specific errno code (e.g. EACCES), so a caller can assert
// how the storage layer discriminates readdir errors. file-storage.ts holds the same
// `fs.promises` singleton, so overriding `readdir` on it intercepts its calls. Always restore
// in a finally so one test's injection never leaks into another.
async function withFailingReaddir(code: string, fn: () => Promise<void>): Promise<void> {
	const original = fs.readdir;
	(fs as { readdir: typeof fs.readdir }).readdir = (async () => {
		const err = new Error(`injected ${code}`) as NodeJS.ErrnoException;
		err.code = code;
		throw err;
	}) as typeof fs.readdir;
	try {
		await fn();
	} finally {
		(fs as { readdir: typeof fs.readdir }).readdir = original;
	}
}

async function drainPendings(storage: FileRawStorage, blockId: BlockId): Promise<ActionId[]> {
	const out: ActionId[] = [];
	for await (const id of storage.listPendingTransactions(blockId)) {
		out.push(id);
	}
	return out;
}

describe('FileRawStorage atomic writes + corruption tolerance', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-storage-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('getMetadata returns undefined (not throws) for a truncated/corrupt meta.json', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-corrupt' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		// A torn write: valid-prefix JSON cut off mid-token — JSON.parse throws SyntaxError.
		await fs.writeFile(metaPath, '{"latest":{"rev":1,"actionId":"tx:ab');

		const meta = await storage.getMetadata(blockId);
		assert.strictEqual(meta, undefined);
	});

	it('recover() over a block with corrupt meta.json does not throw (treats it as missing)', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-corrupt-recover' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		await fs.writeFile(metaPath, 'not json at all');

		const blockStorage = new BlockStorage(blockId, storage);
		const result = await blockStorage.recover();
		assert.deepStrictEqual(result, { reconciled: false });
	});

	it('a real I/O error (not a parse error) still propagates from a read', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-eio' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		// Make the metadata path a directory: readFile on it fails with EISDIR — a
		// genuine I/O error that must NOT be masked as "missing".
		await fs.mkdir(metaPath, { recursive: true });

		await assert.rejects(() => storage.getMetadata(blockId), (err: NodeJS.ErrnoException) => err.code !== 'ENOENT');
	});

	it('saveMetadata round-trips and leaves no .tmp sibling behind', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-roundtrip' as BlockId;
		const meta: BlockMetadata = { latest: { rev: 3, actionId: 'tx:abc' as ActionId }, ranges: [[1, 4]] };
		await storage.saveMetadata(blockId, meta);

		assert.deepStrictEqual(await storage.getMetadata(blockId), meta);
		assert.ok(!(await hasTempSibling(path.join(base, blockId))), 'expected no leftover *.tmp files');
	});

	it('a successful second write replaces the prior value (rename-over-existing works on this platform)', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-replace' as BlockId;

		const valueA: BlockMetadata = { latest: { rev: 1, actionId: 'tx:aaa' as ActionId }, ranges: [[1, 2]] };
		const valueB: BlockMetadata = { latest: { rev: 2, actionId: 'tx:bbb' as ActionId }, ranges: [[1, 3]] };
		await storage.saveMetadata(blockId, valueA);
		await storage.saveMetadata(blockId, valueB);

		assert.deepStrictEqual(await storage.getMetadata(blockId), valueB);
		assert.ok(!(await hasTempSibling(path.join(base, blockId))), 'expected no leftover *.tmp files');
	});

	it('a failed rename leaves the canonical file at the prior complete value (never torn)', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-atomic' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');

		const valueA: BlockMetadata = { latest: { rev: 1, actionId: 'tx:aaa' as ActionId }, ranges: [[1, 2]] };
		await storage.saveMetadata(blockId, valueA);

		let threw = false;
		await withFailingRename(async () => {
			const valueB: BlockMetadata = { latest: { rev: 2, actionId: 'tx:bbb' as ActionId }, ranges: [[1, 3]] };
			await storage.saveMetadata(blockId, valueB).catch(() => { threw = true; });
		});
		assert.ok(threw, 'saveMetadata should reject when the rename fails');

		// Canonical path still holds the complete OLD value — never a partial/torn file.
		assert.deepStrictEqual(await storage.getMetadata(blockId), valueA);
		const raw = await fs.readFile(metaPath, 'utf-8');
		assert.doesNotThrow(() => JSON.parse(raw), 'canonical file must parse cleanly');

		// Temp file was cleaned up on the failed write.
		assert.ok(!(await hasTempSibling(path.join(base, blockId))), 'expected no orphaned *.tmp files');
	});
});

describe('FileRawStorage.listPendingTransactions readdir error discrimination', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-pend-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('yields empty for a genuinely-absent pend directory (ENOENT)', async () => {
		const storage = new FileRawStorage(base);
		// No block dir written at all → the pend dir does not exist → ENOENT → empty listing.
		const out = await drainPendings(storage, 'no-such-block' as BlockId);
		assert.deepStrictEqual(out, []);
	});

	it('rejects (does not silently yield "no pendings") when readdir fails with a non-ENOENT error', async () => {
		const storage = new FileRawStorage(base);
		// A swallowed EACCES/EIO would make listPendingTransactions report an empty directory,
		// so pend's conflict detection would be skipped — a correctness hazard, not just noise.
		await withFailingReaddir('EACCES', async () => {
			await assert.rejects(
				() => drainPendings(storage, 'block-eacces' as BlockId),
				(err: NodeJS.ErrnoException) => err.code === 'EACCES'
			);
		});
	});

	it('still lists recognized pending action ids after the ENOENT/other discrimination change', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-with-pendings' as BlockId;
		await storage.savePendingTransaction(blockId, 'tx:abc123' as ActionId, { delete: true });

		const out = await drainPendings(storage, blockId);
		assert.deepStrictEqual(out, ['tx:abc123']);
	});
});

describe('FileKVStore atomic writes', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-kv-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('set round-trips and leaves no .tmp sibling', async () => {
		const kv = new FileKVStore(base);
		await kv.set('coordinator/key1', 'value-1');

		assert.strictEqual(await kv.get('coordinator/key1'), 'value-1');
		assert.ok(!(await hasTempSibling(path.join(base, 'coordinator'))), 'expected no leftover *.tmp files');
	});

	it('a failed rename leaves the prior value intact (never torn)', async () => {
		const kv = new FileKVStore(base);
		await kv.set('coordinator/key1', 'value-A');

		let threw = false;
		await withFailingRename(async () => {
			await kv.set('coordinator/key1', 'value-B').catch(() => { threw = true; });
		});
		assert.ok(threw, 'set should reject when the rename fails');

		assert.strictEqual(await kv.get('coordinator/key1'), 'value-A');
		assert.ok(!(await hasTempSibling(path.join(base, 'coordinator'))), 'expected no orphaned *.tmp files');
	});
});
