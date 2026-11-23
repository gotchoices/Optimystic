/**
 * Verifies that `CollectionFactory` honours the `storageFactory` field on
 * `ParsedOptimysticOptions` — the one value a host supplies for everything a network persists to on
 * this machine. This is the bootstrap-mode hook that lets a host (e.g. RN/MMKV) plug in persistent
 * storage instead of the default in-process memory stores.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ParsedOptimysticTreeOptions as ParsedOptimysticOptions } from '../dist/index.js';
import { blocksOnly } from './storage-helpers.js';

/**
 * MemoryRawStorage subclass that counts how often its mutating operations
 * fire, so the test can assert the supplied storage actually observed writes
 * without depending on internal block IDs.
 */
class CountingRawStorage extends MemoryRawStorage {
	public saves = 0;

	override async savePendingTransaction(
		...args: Parameters<MemoryRawStorage['savePendingTransaction']>
	): Promise<void> {
		this.saves++;
		return super.savePendingTransaction(...args);
	}

	override async saveTransaction(
		...args: Parameters<MemoryRawStorage['saveTransaction']>
	): Promise<void> {
		this.saves++;
		return super.saveTransaction(...args);
	}

	override async saveRevision(
		...args: Parameters<MemoryRawStorage['saveRevision']>
	): Promise<void> {
		this.saves++;
		return super.saveRevision(...args);
	}

	override async saveMetadata(
		...args: Parameters<MemoryRawStorage['saveMetadata']>
	): Promise<void> {
		this.saves++;
		return super.saveMetadata(...args);
	}
}

function createPlugin() {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	return plugin;
}

describe('local transactor honours storageFactory', function () {
	this.timeout(5000);

	it('routes pend + commit through the host-supplied block store', async () => {
		const plugin = createPlugin();
		const factory = plugin.collectionFactory;

		const storage = new CountingRawStorage();
		let factoryCalls = 0;

		const options: ParsedOptimysticOptions = {
			collectionUri: 'tree://local-test/widgets',
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
			storageFactory: () => {
				factoryCalls++;
				return blocksOnly(storage);
			},
		};

		const collection = await factory.createOrGetCollection(options);

		// Drive a write through the local transactor: this triggers pend +
		// commit via StorageRepo, which must land on `storage`.
		await collection.replace([['k1', ['k1', '"v1"']]]);

		expect(factoryCalls).to.be.greaterThan(0);
		expect(storage.saves).to.be.greaterThan(0);
	});

	it('still works when no factory is supplied (default in-memory storage)', async () => {
		const plugin = createPlugin();
		const factory = plugin.collectionFactory;

		const options: ParsedOptimysticOptions = {
			collectionUri: 'tree://local-test/no-factory',
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
		};

		const collection = await factory.createOrGetCollection(options);

		// Smoke test: a write must succeed (and round-trip via the default
		// MemoryRawStorage). We deliberately don't assert anything about the
		// default storage instance — that's an internal detail.
		await collection.replace([['k1', ['k1', '"v1"']]]);
	});

	// A host's factory may CONSTRUCT its storage rather than return one it holds, and one location
	// must only ever be opened once per process (`fileNodeStorage` counts holders over a directory,
	// and two sets over one would double-count its pieces and break its piece store). So the plugin
	// has to ask once per network however many tables, catalogs and blob services resolve on it —
	// which is what this pins. The consumers below are deliberately the three different ones: the
	// block store (a tree), the blob pieces and records (a blob service) and a second tree's catalog.
	it('asks the factory once per transactor key, however many consumers resolve on it', async () => {
		const factory = createPlugin().collectionFactory;
		let factoryCalls = 0;
		const options = (collectionUri: string): ParsedOptimysticOptions => ({
			collectionUri,
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
			storageFactory: () => {
				factoryCalls++;
				return blocksOnly(new MemoryRawStorage());
			},
		});

		const first = await factory.createOrGetCollection(options('tree://local-test/one'));
		await first.replace([['k1', ['k1', '"v1"']]]);
		await factory.createOrGetCollection(options('tree://local-test/two'));
		const blobs = await factory.getBlobBackend(options('tree://local-test/one'));
		await factory.getBlobBackend(options('tree://local-test/two'));

		expect(blobs.key, 'both tables resolve on the one transactor key').to.equal('local:test');
		expect(factoryCalls).to.equal(1);
	});

	// A table's first initialization opens its collection and reads the catalog together, and the
	// two resolve the same transactor. Built once per caller, they would land on two stores, neither
	// of which sees the other's writes.
	it('builds one transactor, over one store, for concurrent first callers', async () => {
		const factory = createPlugin().collectionFactory;
		let factoryCalls = 0;
		const options = (collectionUri: string): ParsedOptimysticOptions => ({
			collectionUri,
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
			storageFactory: () => {
				factoryCalls++;
				return blocksOnly(new MemoryRawStorage());
			},
		});

		const [table, catalog] = await Promise.all([
			factory.getOrCreateTransactor(options('tree://local-test/table')),
			factory.getOrCreateTransactor(options('tree://optimystic/schema')),
		]);

		expect(catalog).to.equal(table);
		expect(factoryCalls).to.equal(1);
	});
});
