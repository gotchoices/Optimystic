/**
 * Verifies that `CollectionFactory.createLocalTransactor` honours the
 * `rawStorageFactory` field on `ParsedOptimysticOptions`. This is the
 * bootstrap-mode hook that lets a host (e.g. RN/MMKV) plug in persistent
 * storage instead of the default in-process `MemoryRawStorage`.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ParsedOptimysticTreeOptions as ParsedOptimysticOptions } from '../dist/index.js';

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

describe('local transactor honours rawStorageFactory', function () {
	this.timeout(5000);

	it('routes pend + commit through host-supplied IRawStorage', async () => {
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
			rawStorageFactory: () => {
				factoryCalls++;
				return storage;
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
});
