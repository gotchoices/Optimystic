import assert from 'node:assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PieceId } from '@optimystic/db-core';
import { conformancePieceId, runPieceStoreConformance, type PieceStoreHarness } from '@optimystic/db-p2p/testing/conformance';
import { FilePieceStore, PIECE_DIRECTORY } from '../src/index.js';

/** The bytes at `file`, or undefined where there is none; the `files` harness's read. */
async function readIfPresent(file: string): Promise<Uint8Array | undefined> {
	try {
		return await fs.readFile(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

// Each case gets a fresh temp directory; the suite closes the first store before `reopen`. The
// import and export cases' own files go in that directory beside `optimystic-pieces/`, which the
// store neither lists nor touches.
runPieceStoreConformance('FilePieceStore', async (): Promise<PieceStoreHarness> => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'optimystic-fs-pieces-'));
	let named = 0;
	return {
		store: new FilePieceStore(base),
		reopen: async () => new FilePieceStore(base),
		files: {
			write: async bytes => {
				const file = path.join(base, `file-${named++}`);
				await fs.writeFile(file, bytes);
				return file;
			},
			freshPath: async () => path.join(base, `fresh-${named++}`),
			read: readIfPresent
		},
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

	it('exports a piece larger than the chunk an export copies at a time', async () => {
		// 1 MiB is the largest piece a blob may carry (`MAX_BLOB_PIECE_BYTES`), four times the 256 KiB
		// an export copies at a time; the conformance cases join 256 KiB pieces, so this is the only
		// one whose copy loop runs more than once per piece.
		const bytes = new Uint8Array(1024 * 1024);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff;
		const id = await conformancePieceId(bytes);
		const store = new FilePieceStore(base);
		await store.put(id, bytes);
		const target = path.join(base, 'joined');

		await store.exportFile([id], target);

		assert.deepStrictEqual(new Uint8Array(await fs.readFile(target)), bytes);
	});

	it('refuses an id that is not a lowercase base32 CID', async () => {
		const store = new FilePieceStore(base);
		const upper = (await conformancePieceId(Uint8Array.of(1))).toUpperCase() as PieceId;

		await assert.rejects(store.get('../x' as PieceId), RangeError);
		await assert.rejects(store.put(upper, Uint8Array.of(1)), RangeError);
		assert.deepStrictEqual(await fs.readdir(base), []);
	});
});
