/**
 * The plugin-level `blob_paths` — whether this network's blobs can be put straight from a file and
 * read straight out to one (docs/blobs.md §Putting and reading by file path, README § Plugin-Level
 * Configuration).
 *
 * Two things earn a case here. The PARSER, because a host that asked for path access and got
 * `undefined` back cannot otherwise tell a mistyped mode from a store that cannot reach files, so
 * every branch of the refusal is a promise. And the WHOLE chain a host actually registers through —
 * `register(db, { blob_paths })` to `plugin.blobs.pathAccess()` — because every link in it carries
 * the mode in an OPTIONAL field (`ParsedOptimysticOptions.blobPaths`), so a link that stopped
 * carrying it would still compile; that, and not the single-machine service's own handling of
 * `paths`, is what no type settles.
 *
 * The forwarding into `createLibp2pNode` is one literal field the node's own option type settles,
 * and a path put's pin rules are `put`'s own shared code (`SqlBlobService.pinnedPut`); neither is
 * tested here.
 */

import { expect } from 'chai';
import { MemoryKVStore, MemoryPieceStore, MemoryRawStorage, type NodeStorage } from '@optimystic/db-p2p';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { declaredBlobPaths } from '../src/optimystic-module.js';

type Plugin = ReturnType<typeof register>;

describe('declaredBlobPaths: the path mode the plugin hands its blob services', () => {
	it('declares nothing when the setting is unset, null, or the empty string a settings form sends', () => {
		expect(declaredBlobPaths({})).to.equal(undefined);
		expect(declaredBlobPaths({ blob_paths: null })).to.equal(undefined);
		expect(declaredBlobPaths({ blob_paths: '' })).to.equal(undefined);
	});

	it('passes each of the three modes through', () => {
		expect(declaredBlobPaths({ blob_paths: 'off' })).to.equal('off');
		expect(declaredBlobPaths({ blob_paths: 'verify' })).to.equal('verify');
		expect(declaredBlobPaths({ blob_paths: 'trust' })).to.equal('trust');
	});

	it('refuses anything else, naming the setting and all three modes', () => {
		for (const declared of ['Verify', 'on', 3]) {
			expect(() => declaredBlobPaths({ blob_paths: declared }), String(declared))
				.to.throw(/blob_paths must be one of 'off', 'verify' and 'trust'/);
		}
	});
});

/**
 * A piece store that can reach files, as far as the blob service's duck-type check cares
 * (`offersFiles` asks only that both calls are functions), so a spec can see a registration become
 * path access without a filesystem.
 */
class FileCapableMemoryPieceStore extends MemoryPieceStore {
	async importFile(): Promise<never> {
		throw new Error('not reached: this spec only asks whether path access exists');
	}

	async exportFile(): Promise<never> {
		throw new Error('not reached: this spec only asks whether path access exists');
	}
}

describe('blob_paths registered turns on path access in SQL', function () {
	this.timeout(5000);

	const open: { db: Database; plugin: Plugin }[] = [];

	afterEach(async () => {
		for (const { db, plugin } of open.splice(0)) {
			db.close();
			await plugin.dispose();
		}
	});

	function storageWithFileCapablePieces(): NodeStorage {
		return { blocks: new MemoryRawStorage(), kv: new MemoryKVStore(), pieces: new FileCapableMemoryPieceStore() };
	}

	/**
	 * A plugin registered as a host registers one — on a `local` transactor, so its blobs go through
	 * the single-machine service rather than a node, over a piece store that can reach files.
	 * `blob_paths` is left out of the config entirely when `blobPaths` is undefined, which is the
	 * unset case as a host writes it.
	 */
	function pluginWith(blobPaths?: string): Plugin {
		const db = new Database();
		const plugin = register(db, {
			default_transactor: 'local',
			default_key_network: 'test',
			enable_cache: false,
			storageFactory: storageWithFileCapablePieces,
			...(blobPaths === undefined ? {} : { blob_paths: blobPaths }),
		} as unknown as Record<string, SqlValue>);
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		open.push({ db, plugin });
		return plugin;
	}

	it('offers path access in the declared mode over a store that can reach files', async () => {
		const paths = await pluginWith('verify').blobs.pathAccess();
		expect(paths?.mode).to.equal('verify');
	});

	it('offers none when the setting is unset', async () => {
		expect(await pluginWith().blobs.pathAccess()).to.equal(undefined);
	});
});
