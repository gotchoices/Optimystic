import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileRawStorage, FileKVStore } from '../src/index.js';
import { KvUnderReplicationLedger, type BlockMetadata, type UnderReplicatedEntry } from '@optimystic/db-p2p';
import type { ActionId, BlockId } from '@optimystic/db-core';

// ---------------------------------------------------------------------------
// The under-replication ledger over the filesystem store. The ledger's own rules are pinned in
// db-p2p over the in-memory store; what only this package can show is that what it records is on
// disk — readable by a fresh store and ledger over the same directory, the stand-in for a restart —
// and that it can share FileRawStorage's base path, which is how the reference peer wires it.
// ---------------------------------------------------------------------------

const entry = (blockId: string, overrides: Partial<UnderReplicatedEntry> = {}): UnderReplicatedEntry => ({
	blockId: blockId as BlockId,
	rev: 7,
	actionId: 'tx:action-7' as ActionId,
	quorum: 'majority',
	missingPeerIds: ['peer-away'],
	recordedAt: 1_000,
	attempts: 0,
	...overrides
});

describe('KvUnderReplicationLedger over FileKVStore', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-ledger-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('entries written before a restart are read back by a fresh store and ledger at the same path', async () => {
		const before = new KvUnderReplicationLedger(new FileKVStore(base));
		await before.record(entry('block-majority', { missingPeerIds: ['peer-away', 'peer-slow'], recordedAt: 1_000 }));
		await before.record(entry('block-local', { quorum: 'local', missingPeerIds: [], recordedAt: 2_000 }));
		await before.noteAttempt('block-majority' as BlockId);

		const after = new KvUnderReplicationLedger(new FileKVStore(base));

		assert.deepStrictEqual(await after.list(), [
			entry('block-majority', { missingPeerIds: ['peer-away', 'peer-slow'], recordedAt: 1_000, attempts: 1 }),
			entry('block-local', { quorum: 'local', missingPeerIds: [], recordedAt: 2_000 })
		]);
	});

	it('a reopened ledger keeps applying its rules to what it survived with', async () => {
		const before = new KvUnderReplicationLedger(new FileKVStore(base));
		await before.record(entry('block-a', { rev: 7, missingPeerIds: ['peer-1', 'peer-2'] }));
		await before.record(entry('block-b', { rev: 7 }));

		const after = new KvUnderReplicationLedger(new FileKVStore(base));
		await after.record(entry('block-a', { rev: 6 }));
		const remaining = await after.satisfy('block-a' as BlockId, ['peer-1']);
		await after.settle('block-b' as BlockId, 8);

		assert.deepStrictEqual(remaining?.missingPeerIds, ['peer-2'], 'the lower revision was skipped, then one peer satisfied');
		assert.strictEqual(await after.get('block-b' as BlockId), undefined, 'settled by a later full commit');
		const reread = new KvUnderReplicationLedger(new FileKVStore(base));
		assert.deepStrictEqual((await reread.list()).map(e => e.blockId), ['block-a']);
	});

	it('shares a base path with FileRawStorage without its directory being enumerated as a block', async () => {
		const storage = new FileRawStorage(base);
		const meta: BlockMetadata = { latest: { rev: 1, actionId: 'tx:a1' as ActionId }, ranges: [[1, 1]] };
		await storage.saveMetadata('real-block' as BlockId, meta);
		const ledger = new KvUnderReplicationLedger(new FileKVStore(base));
		await ledger.record(entry('real-block'));

		const blockIds = new Set<string>();
		for await (const id of storage.listBlockIds()) blockIds.add(id);

		assert.deepStrictEqual(blockIds, new Set(['real-block']));
		assert.ok((await fs.stat(path.join(base, 'under-replicated'))).isDirectory(), 'the ledger lives beside the block directories');
		assert.deepStrictEqual((await ledger.list()).map(e => e.blockId), ['real-block']);
	});
});
