/**
 * Direct regression coverage for `FileRawStorage` action-id-as-filename handling
 * (ticket `optimystic-filestorage-colon-actionid-windows`).
 *
 * Two properties are pinned here that the higher-level session-mode reopen test
 * does NOT exercise (after a clean commit no pending files remain on disk, so
 * `listPendingTransactions` is never asked to recognise a real consensus id):
 *
 *  1. Colon round-trip — consensus ids are `tx:<hash>` / `stamp:<hash>`; the
 *     colon is illegal in a Windows filename, so it is percent-encoded on write
 *     and decoded on read. pend → actions promotion (a rename) must survive it.
 *  2. `listPendingTransactions` recognition — the hash is base64url-encoded
 *     SHA-256 (alphabet `[A-Za-z0-9_-]`, NOT lowercase hex), so the filter that
 *     skips non-action files in the pend dir must accept mixed-case / `_` / `-`.
 */

import { expect } from 'chai';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import type { ActionId, BlockId, Transform, IBlock } from '@optimystic/db-core';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// A realistic consensus action id: `tx:` + base64url SHA-256 (mixed case, `_`, `-`).
const TX_ACTION_ID = 'tx:Ab3_xZ9-QkLmNoPqRsTuVwXyZ0123456789-_abcDEF' as ActionId;
const STAMP_ACTION_ID = 'stamp:Zz9_Yx8-WvUtSrQpOnMlKjIhGfEdCbA9876543210_-x' as ActionId;
const BLOCK_ID = 'block-under-test' as BlockId;

function makeTransform(marker: string): Transform {
	const block: IBlock = { header: { id: marker as BlockId, type: 'TST', collectionId: BLOCK_ID } };
	return { insert: block };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of it) out.push(v);
	return out;
}

describe('FileRawStorage action-id filename encoding (colon / base64url consensus ids)', function () {
	this.timeout(20000);

	let dir: string;
	let storage: FileRawStorage;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-fs-actionid', randomUUID());
		await fs.mkdir(dir, { recursive: true });
		storage = new FileRawStorage(dir);
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('round-trips a pending transaction with a colon-bearing tx: id (save/get/list)', async () => {
		const transform = makeTransform('pend-1');
		await storage.savePendingTransaction(BLOCK_ID, TX_ACTION_ID, transform);

		// Read back through the encoded path.
		expect(await storage.getPendingTransaction(BLOCK_ID, TX_ACTION_ID)).to.deep.equal(transform);

		// Enumeration must recognise the base64url-hash consensus id (the regex bug
		// that hex-only `[0-9a-f]+` would silently drop it).
		expect(await collect(storage.listPendingTransactions(BLOCK_ID))).to.deep.equal([TX_ACTION_ID]);
	});

	it('promotes a pending tx: id to actions (the pend→actions rename that failed on Windows)', async () => {
		const transform = makeTransform('promote-1');
		await storage.savePendingTransaction(BLOCK_ID, TX_ACTION_ID, transform);

		// This rename is the original EINVAL site on win32 when the colon was raw.
		await storage.promotePendingTransaction(BLOCK_ID, TX_ACTION_ID);

		expect(await storage.getTransaction(BLOCK_ID, TX_ACTION_ID)).to.deep.equal(transform);
		// No longer pending once promoted.
		expect(await collect(storage.listPendingTransactions(BLOCK_ID))).to.deep.equal([]);
	});

	it('lists multiple consensus ids and honours delete (tx: and stamp:)', async () => {
		await storage.savePendingTransaction(BLOCK_ID, TX_ACTION_ID, makeTransform('a'));
		await storage.savePendingTransaction(BLOCK_ID, STAMP_ACTION_ID, makeTransform('b'));

		expect((await collect(storage.listPendingTransactions(BLOCK_ID))).sort())
			.to.deep.equal([STAMP_ACTION_ID, TX_ACTION_ID].sort());

		await storage.deletePendingTransaction(BLOCK_ID, TX_ACTION_ID);
		expect(await collect(storage.listPendingTransactions(BLOCK_ID))).to.deep.equal([STAMP_ACTION_ID]);
	});

	it('round-trips a materialized block under a stamp: id', async () => {
		const block: IBlock = { header: { id: 'mat-1' as BlockId, type: 'TST', collectionId: BLOCK_ID } };
		await storage.saveMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID, block);
		expect(await storage.getMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID)).to.deep.equal(block);
	});
});
