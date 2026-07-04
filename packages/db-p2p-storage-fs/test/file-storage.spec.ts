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
