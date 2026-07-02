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

/**
 * Legacy raw-colon read fallback (ticket
 * `filestorage-posix-colon-actionid-migration`).
 *
 * Pre-encode nodes wrote action-id-keyed files with the raw colon verbatim
 * (`actions/tx:<hash>.json`). On POSIX the colon is a legal filename char, so
 * those durable files exist on disk; after the Windows-compat encode fix the
 * read helpers compute the encoded path (`actions/tx%3A<hash>.json`) and would
 * miss them. `FileRawStorage` now falls back to the raw-colon path on an
 * encoded-path miss.
 *
 * A raw-colon filename cannot be created on win32 (the colon is an NTFS ADS
 * separator), so the fallback only matters — and is only tested — on POSIX.
 * These tests would FAIL before the fallback landed (encoded miss → undefined).
 */
describe('FileRawStorage legacy raw-colon read fallback (POSIX-only)', function () {
	this.timeout(20000);

	before(function () {
		if (process.platform === 'win32') this.skip();
	});

	let dir: string;
	let storage: FileRawStorage;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-fs-actionid-legacy', randomUUID());
		await fs.mkdir(dir, { recursive: true });
		storage = new FileRawStorage(dir);
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	// Writes a file at the pre-encode raw-colon path, bypassing the API entirely
	// (the API only ever writes the encoded name now).
	async function writeRawColonFile(scope: string, actionId: string, value: unknown): Promise<string> {
		const scopeDir = path.join(dir, BLOCK_ID, scope);
		await fs.mkdir(scopeDir, { recursive: true });
		const filePath = path.join(scopeDir, `${actionId}.json`);
		await fs.writeFile(filePath, JSON.stringify(value));
		return filePath;
	}

	it('getTransaction reads a legacy raw-colon actions/tx:<hash>.json file', async () => {
		const transform = makeTransform('legacy-tx');
		await writeRawColonFile('actions', TX_ACTION_ID, transform);

		expect(await storage.getTransaction(BLOCK_ID, TX_ACTION_ID)).to.deep.equal(transform);
	});

	it('getMaterializedBlock reads a legacy raw-colon blocks/stamp:<hash>.json file', async () => {
		const block: IBlock = { header: { id: 'legacy-mat' as BlockId, type: 'TST', collectionId: BLOCK_ID } };
		await writeRawColonFile('blocks', STAMP_ACTION_ID, block);

		expect(await storage.getMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID)).to.deep.equal(block);
	});

	it('getPendingTransaction reads a legacy raw-colon pend/tx:<hash>.json file', async () => {
		const transform = makeTransform('legacy-pend');
		await writeRawColonFile('pend', TX_ACTION_ID, transform);

		expect(await storage.getPendingTransaction(BLOCK_ID, TX_ACTION_ID)).to.deep.equal(transform);
	});

	it('returns undefined for a genuinely-absent id (fallback must not invent data)', async () => {
		const absent = 'tx:ZZZ_absent-0000000000000000000000000000000000' as ActionId;
		expect(await storage.getTransaction(BLOCK_ID, absent)).to.equal(undefined);
		expect(await storage.getMaterializedBlock(BLOCK_ID, absent)).to.equal(undefined);
		expect(await storage.getPendingTransaction(BLOCK_ID, absent)).to.equal(undefined);
	});

	it('prefers the encoded file when both encoded and raw-colon files exist', async () => {
		// Canonical (encoded) write via the API, plus a stale raw-colon file on disk.
		const encoded = makeTransform('encoded-wins');
		await storage.saveTransaction(BLOCK_ID, TX_ACTION_ID, encoded);
		await writeRawColonFile('actions', TX_ACTION_ID, makeTransform('stale-raw'));

		expect(await storage.getTransaction(BLOCK_ID, TX_ACTION_ID)).to.deep.equal(encoded);
	});

	it('deletePendingTransaction removes legacy raw-colon pend file', async () => {
		const transform = makeTransform('delete-pend-legacy');
		await writeRawColonFile('pend', TX_ACTION_ID, transform);

		// No encoded file exists; the encoded unlink silently gets ENOENT, then
		// unlinkRawColon removes the raw-colon file.
		await storage.deletePendingTransaction(BLOCK_ID, TX_ACTION_ID);

		expect(await storage.getPendingTransaction(BLOCK_ID, TX_ACTION_ID)).to.equal(undefined);
	});

	it('saveMaterializedBlock tombstone removes legacy raw-colon blocks file', async () => {
		const block: IBlock = { header: { id: 'tombstone-mat' as BlockId, type: 'TST', collectionId: BLOCK_ID } };
		await writeRawColonFile('blocks', STAMP_ACTION_ID, block);

		// Tombstone call (undefined block): encoded unlink gets ENOENT, then
		// unlinkRawColon removes the raw-colon file.
		await storage.saveMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID, undefined);

		expect(await storage.getMaterializedBlock(BLOCK_ID, STAMP_ACTION_ID)).to.equal(undefined);
	});
});
