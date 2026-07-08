import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRawStorage, FileKVStore } from '../src/index.js';
import { BlockStorage } from '@optimystic/db-p2p';
import type { BlockMetadata } from '@optimystic/db-p2p';
import type { BlockId, ActionId, Transform, IBlock } from '@optimystic/db-core';

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

describe('FileRawStorage round-trips', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-rt-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('saveRevision/getRevision round-trips', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-rev' as BlockId;
		const actionId = 'tx:revtest' as ActionId;

		assert.strictEqual(await storage.getRevision(blockId, 1), undefined);
		await storage.saveRevision(blockId, 1, actionId);
		assert.strictEqual(await storage.getRevision(blockId, 1), actionId);
	});

	it('saveTransaction/getTransaction round-trips', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-tx' as BlockId;
		const actionId = 'tx:txtest' as ActionId;
		const transform: Transform = { delete: true };

		assert.strictEqual(await storage.getTransaction(blockId, actionId), undefined);
		await storage.saveTransaction(blockId, actionId, transform);
		assert.deepStrictEqual(await storage.getTransaction(blockId, actionId), transform);
	});

	it('saveMaterializedBlock/getMaterializedBlock round-trips', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-mat' as BlockId;
		const actionId = 'tx:mattest' as ActionId;
		const block = { data: 'test-block-content' } as unknown as IBlock;

		assert.strictEqual(await storage.getMaterializedBlock(blockId, actionId), undefined);
		await storage.saveMaterializedBlock(blockId, actionId, block);
		assert.deepStrictEqual(await storage.getMaterializedBlock(blockId, actionId), block);
	});

	it('savePendingTransaction → promotePendingTransaction moves pend to actions', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-promote' as BlockId;
		const actionId = 'tx:promote123' as ActionId;
		const transform: Transform = { delete: true };

		await storage.savePendingTransaction(blockId, actionId, transform);

		// Must be in pending, not yet in actions
		assert.deepStrictEqual(await storage.getPendingTransaction(blockId, actionId), transform);
		assert.strictEqual(await storage.getTransaction(blockId, actionId), undefined);

		await storage.promotePendingTransaction(blockId, actionId);

		// Now in actions, no longer in pending
		assert.deepStrictEqual(await storage.getTransaction(blockId, actionId), transform);
		const remaining = await drainPendings(storage, blockId);
		assert.deepStrictEqual(remaining, []);
	});

	it('colon-bearing action id round-trips on all platforms (percent-encoded filename)', async () => {
		const storage = new FileRawStorage(base);
		const blockId = 'block-colon' as BlockId;
		const colonId = 'tx:abcd1234' as ActionId;
		const transform: Transform = { delete: true };

		await storage.saveTransaction(blockId, colonId, transform);
		assert.deepStrictEqual(await storage.getTransaction(blockId, colonId), transform);

		// Verify filename is percent-encoded on disk (no raw colon)
		const actionsDir = path.join(base, blockId, 'actions');
		const files = await fs.readdir(actionsDir);
		assert.ok(files.some(f => f.includes('%3A')), 'expected %3A encoding in filename');
		assert.ok(!files.some(f => f.includes(':') && !f.includes('%3A')), 'expected no raw colon in filename');
	});
});

describe('FileRawStorage.listBlockIds', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-listblocks-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	async function collect(storage: FileRawStorage): Promise<Set<string>> {
		const out = new Set<string>();
		for await (const id of storage.listBlockIds()) out.add(id);
		return out;
	}

	const meta = (rev: number): BlockMetadata => ({ latest: { rev, actionId: `tx:a${rev}` as ActionId }, ranges: [[1, rev]] });

	it('yields exactly the ids of blocks that have metadata', async () => {
		const storage = new FileRawStorage(base);
		await storage.saveMetadata('block-a' as BlockId, meta(1));
		await storage.saveMetadata('block-b' as BlockId, meta(2));
		await storage.saveMetadata('block-c' as BlockId, meta(3));

		assert.deepStrictEqual(await collect(storage), new Set(['block-a', 'block-b', 'block-c']));
	});

	it('excludes a block that has only a pending transform (no metadata)', async () => {
		const storage = new FileRawStorage(base);
		await storage.saveMetadata('committed' as BlockId, meta(1));
		// Pended but never committed → block dir exists (pend/ created by atomicWriteFile's
		// recursive mkdir) but no meta.json → must not be enumerated.
		await storage.savePendingTransaction('pending-only' as BlockId, 'tx:x' as ActionId, { delete: true });

		assert.deepStrictEqual(await collect(storage), new Set(['committed']));
	});

	it('yields empty for an existing-but-empty basePath', async () => {
		const storage = new FileRawStorage(base);
		assert.deepStrictEqual(await collect(storage), new Set());
	});

	it('yields empty for a non-existent basePath (ENOENT → no throw)', async () => {
		const storage = new FileRawStorage(path.join(base, 'does-not-exist'));
		assert.deepStrictEqual(await collect(storage), new Set());
	});

	it('ignores a stray non-directory file at basePath root', async () => {
		const storage = new FileRawStorage(base);
		await storage.saveMetadata('real-block' as BlockId, meta(1));
		await fs.writeFile(path.join(base, 'stray.txt'), 'not a block');

		assert.deepStrictEqual(await collect(storage), new Set(['real-block']));
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

	it('list(prefix) returns all keys under prefix recursively', async () => {
		const kv = new FileKVStore(base);
		await kv.set('ns/a', 'v1');
		await kv.set('ns/b', 'v2');
		await kv.set('ns/sub/c', 'v3');
		await kv.set('other/x', 'vx');

		const results = await kv.list('ns/');
		results.sort();
		assert.deepStrictEqual(results, ['ns/a', 'ns/b', 'ns/sub/c']);
	});

	it('list(prefix) returns empty for non-existent prefix', async () => {
		const kv = new FileKVStore(base);
		assert.deepStrictEqual(await kv.list('no-such/'), []);
	});

	it('delete removes a key; get returns undefined afterward', async () => {
		const kv = new FileKVStore(base);
		await kv.set('del/key', 'to-delete');
		assert.strictEqual(await kv.get('del/key'), 'to-delete');

		await kv.delete('del/key');
		assert.strictEqual(await kv.get('del/key'), undefined);
	});

	it('delete on non-existent key does not throw', async () => {
		const kv = new FileKVStore(base);
		await assert.doesNotReject(() => kv.delete('never/existed'));
	});
});
