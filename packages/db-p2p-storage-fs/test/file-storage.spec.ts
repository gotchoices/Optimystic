import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRawStorage, WRITE_LOG_FILENAME, WRITE_LOG_HEADER, STORE_LOCK_FILENAME, decodeWriteLog } from '../src/index.js';
import { BlockStorage, StoreFailedError, withBlockWriteLatch } from '@optimystic/db-p2p';
import type { BlockMetadata } from '@optimystic/db-p2p';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing/conformance';
import type { BlockId, ActionId, Transform, IBlock } from '@optimystic/db-core';
import { trackedStores } from './support/tracked-stores.js';
import { withFailingWriteFile } from './support/fs-injection.js';

// ---------------------------------------------------------------------------
// Shared parity suite. Proves FileRawStorage (KvRawStorage over WriteGroupDriver over
// FileBatchBackend) behaves identically to every other backend — round-trips, listRevisions
// ordering, promote atomicity + missing-pend error, clone-on-store/read (now structural via the
// byte boundary), drain-before-yield, the BlockStorage parity slice, and the persistent reopen
// case. Each case gets a fresh temp dir; the suite closes the first store before `reopen` (the
// second would otherwise share the first's log and read the first's memory), and cleanup closes
// whatever is still open before it rm -rf's the directory.
// ---------------------------------------------------------------------------
runRawStorageConformance('FileSystem', async (): Promise<ConformanceHarness> => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-conformance-'));
	const stores = trackedStores();
	return {
		storage: stores.open(base),
		reopen: async () => stores.open(base),
		cleanup: async () => {
			await stores.closeAll();
			await fs.rm(base, { recursive: true, force: true });
		}
	};
}, { persistent: true });

// ---------------------------------------------------------------------------
// fs-only tests the shared suite cannot cover: what the write-ahead log leaves in the tree,
// torn-file corruption tolerance, colon-encoded filenames + legacy raw-colon fallback, readdir
// error discrimination, and the directory-based listBlockIds meta-gate.
// ---------------------------------------------------------------------------

// Injects a readdir failure with a specific errno code (e.g. EACCES), so a caller can assert
// how the storage layer discriminates readdir errors. file-batch-backend.ts holds the same
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

describe('FileRawStorage tree writes + corruption tolerance', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-storage-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	it('getMetadata returns undefined (not throws) for a truncated/corrupt meta.json', async () => {
		const storage = stores.open(base);
		const blockId = 'block-corrupt' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		// A torn write: valid-prefix JSON cut off mid-token — JSON.parse throws SyntaxError.
		await fs.writeFile(metaPath, '{"latest":{"rev":1,"actionId":"tx:ab');

		const meta = await storage.getMetadata(blockId);
		assert.strictEqual(meta, undefined);
	});

	it('recover() over a block with corrupt meta.json does not throw (treats it as missing)', async () => {
		const storage = stores.open(base);
		const blockId = 'block-corrupt-recover' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		await fs.writeFile(metaPath, 'not json at all');

		const blockStorage = new BlockStorage(blockId, storage);
		const result = await withBlockWriteLatch(blockId, l => blockStorage.recover(l));
		assert.deepStrictEqual(result, { reconciled: false });
	});

	it('a real I/O error (not a parse error) still propagates from a read', async () => {
		const storage = stores.open(base);
		const blockId = 'block-eio' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');
		await fs.mkdir(path.dirname(metaPath), { recursive: true });
		// Make the metadata path a directory: readFile on it fails with EISDIR — a
		// genuine I/O error that must NOT be masked as "missing".
		await fs.mkdir(metaPath, { recursive: true });

		await assert.rejects(() => storage.getMetadata(blockId), (err: NodeJS.ErrnoException) => err.code !== 'ENOENT');
	});

	it('saveMetadata round-trips, and a flush puts it at its canonical path with nothing beside it', async () => {
		const storage = stores.open(base);
		const blockId = 'block-roundtrip' as BlockId;
		const meta: BlockMetadata = { latest: { rev: 3, actionId: 'tx:abc' as ActionId }, ranges: [[1, 4]] };
		await storage.saveMetadata(blockId, meta);
		assert.deepStrictEqual(await storage.getMetadata(blockId), meta, 'served from memory before the flush');

		await storage.flush();
		assert.deepStrictEqual(await fs.readdir(path.join(base, blockId)), ['meta.json'], 'the tree holds the file, no temp sibling');
		assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(base, blockId, 'meta.json'), 'utf8')), meta);
		assert.deepStrictEqual((await fs.readdir(base)).filter(name => !name.startsWith('block-')).sort(), [STORE_LOCK_FILENAME, WRITE_LOG_FILENAME]);
	});

	it('a second write replaces the prior value in the tree', async () => {
		const storage = stores.open(base);
		const blockId = 'block-replace' as BlockId;

		const valueA: BlockMetadata = { latest: { rev: 1, actionId: 'tx:aaa' as ActionId }, ranges: [[1, 2]] };
		const valueB: BlockMetadata = { latest: { rev: 2, actionId: 'tx:bbb' as ActionId }, ranges: [[1, 3]] };
		await storage.saveMetadata(blockId, valueA);
		await storage.saveMetadata(blockId, valueB);
		await storage.flush();

		assert.deepStrictEqual(await storage.getMetadata(blockId), valueB);
		assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(base, blockId, 'meta.json'), 'utf8')), valueB);
	});

	it('a group whose tree write fails after its record is durable is served from memory, latches the store, and is replayed on reopen', async () => {
		const storage = stores.open(base);
		const blockId = 'block-replay' as BlockId;
		const metaPath = path.join(base, blockId, 'meta.json');

		const valueA: BlockMetadata = { latest: { rev: 1, actionId: 'tx:aaa' as ActionId }, ranges: [[1, 2]] };
		const valueB: BlockMetadata = { latest: { rev: 2, actionId: 'tx:bbb' as ActionId }, ranges: [[1, 3]] };
		await storage.saveMetadata(blockId, valueA);
		await storage.flush();

		await withFailingWriteFile(async () => {
			await storage.saveMetadata(blockId, valueB);
			await assert.rejects(() => storage.flush(), StoreFailedError);
		});
		// The tree still holds the complete OLD value — the failed apply never touched it — while
		// in-process readers keep being served the write that resolved.
		assert.deepStrictEqual(JSON.parse(await fs.readFile(metaPath, 'utf8')), valueA);
		assert.deepStrictEqual(await storage.getMetadata(blockId), valueB);
		await assert.rejects(() => storage.saveMetadata(blockId, valueA), StoreFailedError, 'latched: every later write is refused');
		await assert.rejects(() => storage.close(), StoreFailedError);

		// The record was durable before the apply, so the next open rebuilds the tree from it.
		const reopened = stores.open(base);
		assert.deepStrictEqual(await reopened.getMetadata(blockId), valueB);
		assert.deepStrictEqual(JSON.parse(await fs.readFile(metaPath, 'utf8')), valueB);
	});

	it('non-ASCII JSON bytes round-trip exactly (lossless byte write, not a lossy text coercion)', async () => {
		const storage = stores.open(base);
		const blockId = 'block-unicode' as BlockId;
		// A materialized block carrying multi-byte UTF-8 payloads (emoji, CJK, combining marks).
		const block = { header: { id: blockId, type: 'test', collectionId: 'c1' as BlockId }, note: '🌐 日本語 café' } as unknown as IBlock;
		await storage.saveMaterializedBlock(blockId, 'tx:unicode' as ActionId, block);
		await storage.flush();
		assert.deepStrictEqual(await storage.getMaterializedBlock(blockId, 'tx:unicode' as ActionId), block);
		assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(base, blockId, 'blocks', 'tx%3Aunicode.json'), 'utf8')), block);
	});
});

describe('FileRawStorage.listPendingTransactions readdir error discrimination', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-pend-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	it('yields empty for a genuinely-absent pend directory (ENOENT)', async () => {
		const storage = stores.open(base);
		// No block dir written at all → the pend dir does not exist → ENOENT → empty listing.
		const out = await drainPendings(storage, 'no-such-block' as BlockId);
		assert.deepStrictEqual(out, []);
	});

	it('rejects (does not silently yield "no pendings") when readdir fails with a non-ENOENT error', async () => {
		const storage = stores.open(base);
		// A swallowed EACCES/EIO would make listPendingTransactions report an empty directory,
		// so pend's conflict detection would be skipped — a correctness hazard, not just noise.
		await withFailingReaddir('EACCES', async () => {
			await assert.rejects(
				() => drainPendings(storage, 'block-eacces' as BlockId),
				(err: NodeJS.ErrnoException) => err.code === 'EACCES'
			);
		});
	});

	it('lists a flushed pending action id from the tree, and an unflushed one from memory', async () => {
		const storage = stores.open(base);
		const blockId = 'block-with-pendings' as BlockId;
		await storage.savePendingTransaction(blockId, 'tx:abc123' as ActionId, { delete: true });
		await storage.flush();
		await storage.savePendingTransaction(blockId, 'tx:def456' as ActionId, { delete: true });

		const out = await drainPendings(storage, blockId);
		assert.deepStrictEqual(out.sort(), ['tx:abc123', 'tx:def456']);
	});
});

describe('FileRawStorage colon-encoded action-id filenames', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-colon-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	it('colon-bearing action id round-trips on all platforms (percent-encoded filename)', async () => {
		const storage = stores.open(base);
		const blockId = 'block-colon' as BlockId;
		const colonId = 'tx:abcd1234' as ActionId;
		const transform: Transform = { delete: true };

		await storage.saveTransaction(blockId, colonId, transform);
		await storage.flush();
		assert.deepStrictEqual(await storage.getTransaction(blockId, colonId), transform);

		// Verify filename is percent-encoded on disk (no raw colon)
		const actionsDir = path.join(base, blockId, 'actions');
		const files = await fs.readdir(actionsDir);
		assert.ok(files.some(f => f.includes('%3A')), 'expected %3A encoding in filename');
		assert.ok(!files.some(f => f.includes(':') && !f.includes('%3A')), 'expected no raw colon in filename');
	});

	// POSIX-only: pre-encode nodes wrote raw-colon files (`pend/tx:<hash>.json`). The read
	// fallback must still find them, and a delete must remove them so they can't resurrect via
	// the fallback. win32 cannot create a raw-colon file (NTFS ADS separator), so skip there.
	it('reads a legacy raw-colon pend file and deletePendingTransaction removes it (POSIX)', async function () {
		if (process.platform === 'win32') { this.skip(); return; }
		const storage = stores.open(base);
		const blockId = 'block-legacy-colon' as BlockId;
		const colonId = 'tx:legacy99' as ActionId;

		// Simulate a pre-encode node: write the value under the raw-colon filename by hand,
		// as JSON bytes (the kernel's on-disk value form).
		const pendDir = path.join(base, blockId, 'pend');
		await fs.mkdir(pendDir, { recursive: true });
		const rawColonPath = path.join(pendDir, `${colonId}.json`);
		await fs.writeFile(rawColonPath, JSON.stringify({ delete: true } as Transform));

		// The read fallback finds it despite no encoded file existing.
		assert.deepStrictEqual(await storage.getPendingTransaction(blockId, colonId), { delete: true });

		// Delete must reach the raw-colon file too — otherwise the fallback resurrects it. The
		// sibling's unlink is a second entry of the delete's log record, applied at the flush.
		await storage.deletePendingTransaction(blockId, colonId);
		assert.strictEqual(await storage.getPendingTransaction(blockId, colonId), undefined, 'hidden from memory before the flush');
		await storage.flush();
		await assert.rejects(() => fs.access(rawColonPath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
	});
});

describe('FileRawStorage.listBlockIds', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-listblocks-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	async function collect(storage: FileRawStorage): Promise<Set<string>> {
		const out = new Set<string>();
		for await (const id of storage.listBlockIds()) out.add(id);
		return out;
	}

	const meta = (rev: number): BlockMetadata => ({ latest: { rev, actionId: `tx:a${rev}` as ActionId }, ranges: [[1, rev]] });

	it('yields exactly the ids of blocks that have metadata, flushed or not', async () => {
		const storage = stores.open(base);
		await storage.saveMetadata('block-a' as BlockId, meta(1));
		await storage.saveMetadata('block-b' as BlockId, meta(2));
		await storage.flush();
		await storage.saveMetadata('block-c' as BlockId, meta(3));

		assert.deepStrictEqual(await collect(storage), new Set(['block-a', 'block-b', 'block-c']));
	});

	it('excludes a block that has only a pending transform (no metadata)', async () => {
		const storage = stores.open(base);
		await storage.saveMetadata('committed' as BlockId, meta(1));
		// RAW-DRIVER LAYER: pending straight through the store creates the block dir (pend/ via the
		// apply's recursive mkdir) but no meta.json, so the meta-gate excludes it. This is what proves
		// the gate is meta.json and not directory-existence — it is NOT the node's behavior: a pend
		// through `BlockStorage` seeds metadata first and IS enumerated (pinned for every backend by
		// the shared conformance suite's `listBlockIds` parity case).
		await storage.savePendingTransaction('pending-only' as BlockId, 'tx:x' as ActionId, { delete: true });
		await storage.flush();

		assert.deepStrictEqual(await collect(storage), new Set(['committed']));
	});

	it('yields empty for an existing-but-empty basePath', async () => {
		const storage = stores.open(base);
		assert.deepStrictEqual(await collect(storage), new Set());
	});

	it('yields empty for a basePath that did not exist (the open creates it)', async () => {
		const storage = stores.open(path.join(base, 'does-not-exist'));
		assert.deepStrictEqual(await collect(storage), new Set());
	});

	it('ignores stray non-directory files at basePath root — the log and lock among them', async () => {
		const storage = stores.open(base);
		await storage.saveMetadata('real-block' as BlockId, meta(1));
		await storage.flush();
		await fs.writeFile(path.join(base, 'stray.txt'), 'not a block');

		assert.deepStrictEqual(await collect(storage), new Set(['real-block']));
	});

	it('does not list a shared KV store key whose last segment is `meta`', async () => {
		const storage = stores.open(base);
		const kv = stores.openKv(base);
		await storage.saveMetadata('default/app/Ledger' as BlockId, meta(1));
		// The under-replication ledger key for a block id ending in `/meta`: stored as `.../meta.json`.
		await kv.set('under-replicated/default/app/meta', '{}');
		await storage.flush();
		await kv.flush();

		assert.deepStrictEqual(await collect(storage), new Set(['default/app/Ledger']));
	});
});

describe('FileKVStore over the write-ahead log', () => {
	let base: string;
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-kv-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	it('list(prefix) merges the tree with writes not yet flushed: unflushed puts appear, unflushed deletes do not', async () => {
		const kv = stores.openKv(base);
		await kv.set('ns/a', 'v1');
		await kv.set('ns/sub/b', 'v2');
		await kv.set('other/x', 'vx');
		await kv.flush();
		await kv.set('ns/c', 'v3');
		await kv.delete('ns/a');

		assert.deepStrictEqual((await kv.list('ns/')).sort(), ['ns/c', 'ns/sub/b']);
		assert.strictEqual(await kv.get('ns/a'), undefined, 'the unflushed delete hides the tree file');
		assert.strictEqual(await readFileIfPresent(path.join(base, 'ns', 'a.json')), 'v1', 'the tree still holds it until the flush');
		await kv.flush();
		assert.strictEqual(await readFileIfPresent(path.join(base, 'ns', 'a.json')), undefined);
		assert.strictEqual(await readFileIfPresent(path.join(base, 'ns', 'c.json')), 'v3');
	});

	it('list(prefix) returns empty for a prefix nothing was written under', async () => {
		const kv = stores.openKv(base);
		assert.deepStrictEqual(await kv.list('no-such/'), []);
	});

	it('a flushed delete of a key that never existed does not throw', async () => {
		const kv = stores.openKv(base);
		await kv.delete('never/existed');
		await assert.doesNotReject(() => kv.flush());
	});

	for (const order of [['raw', 'kv'], ['kv', 'raw']] as const) {
		it(`shares one log and one lock with a FileRawStorage over the same directory (${order[0]} opened and closed first)`, async () => {
			const raw = stores.open(base);
			const kv = stores.openKv(base);
			const meta: BlockMetadata = { latest: { rev: 1, actionId: 'tx:a1' as ActionId }, ranges: [[1, 1]] };
			const writeAndFlush = {
				raw: async () => { await raw.saveMetadata('blk' as BlockId, meta); await raw.flush(); },
				kv: async () => { await kv.set('under-replicated/blk', 'entry'); await kv.flush(); },
			};
			await writeAndFlush[order[0]]();
			await writeAndFlush[order[1]]();
			const records = decodeWriteLog(await fs.readFile(path.join(base, WRITE_LOG_FILENAME))).batches;
			assert.deepStrictEqual(records.map(batch => batch.map(entry => entry.path)),
				order.map(store => store === 'raw' ? ['blk/meta.json'] : ['under-replicated/blk.json']), 'both stores append to one log, in flush order');

			const closers = { raw: () => raw.close(), kv: () => kv.close() };
			await closers[order[0]]();
			assert.ok(await exists(path.join(base, STORE_LOCK_FILENAME)), 'the lock outlives the first close');
			await closers[order[1]]();
			assert.ok(!(await exists(path.join(base, STORE_LOCK_FILENAME))), 'the last close removes the lock');
			assert.ok((await fs.readFile(path.join(base, WRITE_LOG_FILENAME))).equals(Buffer.from(WRITE_LOG_HEADER)), 'and checkpoints the log empty');

			const reopenedRaw = stores.open(base);
			const reopenedKv = stores.openKv(base);
			assert.deepStrictEqual(await reopenedRaw.getMetadata('blk' as BlockId), meta);
			assert.strictEqual(await reopenedKv.get('under-replicated/blk'), 'entry');
		});
	}
});

async function readFileIfPresent(filePath: string): Promise<string | undefined> {
	return fs.readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
		if (err.code === 'ENOENT') return undefined;
		throw err;
	});
}

async function exists(filePath: string): Promise<boolean> {
	return fs.access(filePath).then(() => true, () => false);
}
