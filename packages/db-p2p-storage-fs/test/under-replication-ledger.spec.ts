import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KvUnderReplicationLedger, type BlockMetadata, type UnderReplicatedEntry } from '@optimystic/db-p2p';
import type { ActionId, BlockId } from '@optimystic/db-core';
import { trackedStores } from './support/tracked-stores.js';

// ---------------------------------------------------------------------------
// The under-replication ledger over the filesystem store. The ledger's own rules are pinned in
// db-p2p over the in-memory store; what only this package can show is that what it records is on
// disk — readable by a fresh store and ledger over the same directory once the first is closed, the
// stand-in for a restart — and that it can share FileRawStorage's base path and write-ahead log,
// which is how the reference peer wires it.
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
	const stores = trackedStores();

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-ledger-'));
	});

	afterEach(async () => {
		await stores.closeAll();
		await fs.rm(base, { recursive: true, force: true });
	});

	/** A ledger over a fresh store at `base`, with the store returned so a test can close it as a stop would. */
	const openLedger = () => {
		const kv = stores.openKv(base);
		return { kv, ledger: new KvUnderReplicationLedger(kv) };
	};

	it('entries written before a restart are read back by a fresh store and ledger at the same path', async () => {
		const before = openLedger();
		await before.ledger.record(entry('block-majority', { missingPeerIds: ['peer-away', 'peer-slow'], recordedAt: 1_000 }));
		await before.ledger.record(entry('block-local', { quorum: 'local', missingPeerIds: [], recordedAt: 2_000 }));
		await before.ledger.noteAttempt('block-majority' as BlockId);
		await before.kv.close();

		const after = openLedger();

		assert.deepStrictEqual(await after.ledger.list(), [
			entry('block-majority', { missingPeerIds: ['peer-away', 'peer-slow'], recordedAt: 1_000, attempts: 1 }),
			entry('block-local', { quorum: 'local', missingPeerIds: [], recordedAt: 2_000 })
		]);
	});

	it('a reopened ledger keeps applying its rules to what it survived with', async () => {
		const before = openLedger();
		await before.ledger.record(entry('block-a', { rev: 7, missingPeerIds: ['peer-1', 'peer-2'] }));
		await before.ledger.record(entry('block-b', { rev: 7 }));
		await before.kv.close();

		const after = openLedger();
		await after.ledger.record(entry('block-a', { rev: 6 }));
		const outcome = await after.ledger.satisfy('block-a' as BlockId, ['peer-1']);
		await after.ledger.settle('block-b' as BlockId, 8);
		await after.kv.close();

		assert.deepStrictEqual(outcome.status === 'owed' ? outcome.entry.missingPeerIds : outcome.status, ['peer-2'],
			'the lower revision was skipped, then one peer satisfied');
		const reread = openLedger();
		assert.strictEqual(await reread.ledger.get('block-b' as BlockId), undefined, 'settled by a later full commit');
		assert.deepStrictEqual((await reread.ledger.list()).map(e => e.blockId), ['block-a']);
	});

	it('shares a base path with FileRawStorage without its directory being enumerated as a block', async () => {
		const storage = stores.open(base);
		const meta: BlockMetadata = { latest: { rev: 1, actionId: 'tx:a1' as ActionId }, ranges: [[1, 1]] };
		await storage.saveMetadata('real-block' as BlockId, meta);
		await storage.flush();
		const { ledger } = openLedger();
		await ledger.record(entry('real-block'));

		const blockIds = new Set<string>();
		for await (const id of storage.listBlockIds()) blockIds.add(id);

		assert.deepStrictEqual(blockIds, new Set(['real-block']));
		assert.ok((await fs.stat(path.join(base, 'under-replicated'))).isDirectory(), 'the ledger lives beside the block directories');
		assert.deepStrictEqual((await ledger.list()).map(e => e.blockId), ['real-block']);
	});
});
