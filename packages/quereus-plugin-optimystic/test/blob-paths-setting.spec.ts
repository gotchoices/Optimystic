/**
 * The plugin-level `blob_paths` — whether this network's blobs can be put straight from a file and
 * read straight out to one (docs/blobs.md §Putting and reading by file path, README § Plugin-Level
 * Configuration).
 *
 * Two things earn a case here. The PARSER, because a host that asked for path access and got
 * `undefined` back cannot otherwise tell a mistyped mode from a store that cannot reach files, so
 * every branch of the refusal is a promise. And that the mode actually REACHES the single-machine
 * blob service every transactor without a libp2p node gets — the plugin→db-p2p seam no type
 * settles, and the configuration (a phone on local storage, no mesh) the setting most exists for.
 *
 * The forwarding into `createLibp2pNode` is one literal field the node's own option type settles,
 * and a path put's pin rules are `put`'s own shared code (`SqlBlobService.pinnedPut`); neither is
 * tested here.
 */

import { expect } from 'chai';
import { MemoryKVStore, MemoryPieceStore, MemoryRawStorage, type NodeStorage } from '@optimystic/db-p2p';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { declaredBlobPaths } from '../src/optimystic-module.js';
import type { ParsedOptimysticTreeOptions as ParsedOptimysticOptions } from '../dist/index.js';

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
 * (`offersFiles` asks only that both calls are functions), so a spec can see a path mode become
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

describe('blob_paths reaches the single-machine blob service', function () {
	this.timeout(5000);

	function storageWithFileCapablePieces(): NodeStorage {
		return { blocks: new MemoryRawStorage(), kv: new MemoryKVStore(), pieces: new FileCapableMemoryPieceStore() };
	}

	function optionsFor(blobPaths: ParsedOptimysticOptions['blobPaths']): ParsedOptimysticOptions {
		return {
			collectionUri: 'tree://local-test/widgets',
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
			storageFactory: storageWithFileCapablePieces,
			blobPaths,
		};
	}

	function blobFactory() {
		return register(new Database(), {
			default_transactor: 'local',
			default_key_network: 'test',
			enable_cache: false,
		}).collectionFactory;
	}

	it('offers path access in the declared mode over a store that can reach files', async () => {
		const backend = await blobFactory().getBlobBackend(optionsFor('verify'));
		expect(backend.service.paths?.mode).to.equal('verify');
	});

	it('offers none when the setting is unset', async () => {
		const backend = await blobFactory().getBlobBackend(optionsFor(undefined));
		expect(backend.service.paths).to.equal(undefined);
	});
});
