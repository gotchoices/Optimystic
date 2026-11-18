import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PieceId } from '@optimystic/db-core';
import { conformancePieceId, runPieceStoreConformance, type PieceStoreHarness } from '@optimystic/db-p2p/testing/conformance';
import { FilePieceStore, PIECE_DIRECTORY } from '../src/index.js';

// Each case gets a fresh temp directory; the suite closes the first store before `reopen`.
runPieceStoreConformance('FilePieceStore', async (): Promise<PieceStoreHarness> => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-pieces-'));
	return {
		store: new FilePieceStore(base),
		reopen: async () => new FilePieceStore(base),
		cleanup: () => fs.rm(base, { recursive: true, force: true })
	};
}, { persistent: true });

describe('FilePieceStore on disk', () => {
	let base: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-pieces-'));
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it('a leftover temp is never served and is removed on open', async () => {
		const bytes = Uint8Array.of(1, 2, 3);
		const id = await conformancePieceId(bytes);
		const first = new FilePieceStore(base);
		await first.put(id, bytes);
		await first.close();
		const temp = path.join(base, PIECE_DIRECTORY, 'incoming', '0123456789abcdef.tmp');
		await fs.writeFile(temp, Uint8Array.of(9, 9));

		const reopened = new FilePieceStore(base);
		const listed: PieceId[] = [];
		for await (const listedId of reopened.list()) listed.push(listedId);

		assert.deepStrictEqual(listed, [id]);
		await assert.rejects(fs.access(temp), { code: 'ENOENT' });
	});

	it('refuses an id that is not a lowercase base32 CID', async () => {
		const store = new FilePieceStore(base);
		const upper = (await conformancePieceId(Uint8Array.of(1))).toUpperCase() as PieceId;

		await assert.rejects(store.get('../x' as PieceId), RangeError);
		await assert.rejects(store.put(upper, Uint8Array.of(1)), RangeError);
		assert.deepStrictEqual(await fs.readdir(base), []);
	});
});
