/**
 * Two dirty trees that are DIFFERENT `Tree` instances over ONE collection id — the shape two
 * tables declared over the same URI in one Database produce — must both land in a legacy commit.
 *
 * The multi-tree legacy commit hands its coordinator a map keyed by collection id
 * (`TransactionBridge.commitBatchLegacy`). Two instances under one id would collapse to one
 * entry there, and the dropped instance's staged rows would be skipped by a commit that reports
 * success. `legacyBatch` therefore sends such a pair to the per-tree fallback sweep, where the
 * second instance's `sync()` refreshes onto the first's commit and replays its own rows there.
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { Tree } from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { register, type ParsedOptimysticTreeOptions as ParsedOptimysticOptions } from '../dist/index.js';

type Entry = { key: number; name: string };
const COLLECTION_ID = 'shared/dup';

describe('Legacy commit: two dirty tree instances over one collection id', function () {
	this.timeout(20_000);

	it('both instances\' staged rows are committed (the pair takes the per-tree sweep, not the batch)', async () => {
		const db = new Database();
		const config = {
			default_transactor: 'local',
			default_key_network: 'test',
			enable_cache: false,
		} as unknown as Record<string, SqlValue>;
		const plugin = register(db, config);
		const transactor = new TestTransactor();
		// Pre-registered under the key the factory computes for (transactor='local',
		// keyNetwork='test'), so beginTransaction resolves this instance.
		plugin.collectionFactory.registerTransactor('local:test', transactor);
		const options: ParsedOptimysticOptions = {
			collectionUri: `tree://${COLLECTION_ID}`,
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {} as ParsedOptimysticOptions['libp2pOptions'],
			cache: false,
			encoding: 'json',
		};

		try {
			// Commit the collection first, so both instances below OPEN one committed header
			// rather than each inventing its own.
			const seed = await Tree.createOrOpen<number, Entry>(transactor, COLLECTION_ID, e => e.key);
			await seed.stage([[0, { key: 0, name: 'seed' }]]);
			await seed.sync();

			const first = await Tree.createOrOpen<number, Entry>(transactor, COLLECTION_ID, e => e.key);
			const second = await Tree.createOrOpen<number, Entry>(transactor, COLLECTION_ID, e => e.key);
			expect(first.getCollection().id).to.equal(second.getCollection().id);
			expect(first.getCollection()).to.not.equal(second.getCollection());

			const bridge = plugin.txnBridge;
			await bridge.beginTransaction(options);
			bridge.markDirty(first);
			bridge.markDirty(second);
			await first.stage([[1, { key: 1, name: 'first' }]]);
			await second.stage([[2, { key: 2, name: 'second' }]]);
			await bridge.commitTransaction();

			expect(bridge.isDegraded(), 'a clean commit').to.equal(false);
			const fresh = await Tree.createOrOpen<number, Entry>(transactor, COLLECTION_ID, e => e.key);
			expect(await fresh.get(1), 'the first instance\'s row is durable').to.deep.equal({ key: 1, name: 'first' });
			expect(await fresh.get(2), 'the second instance\'s row is durable').to.deep.equal({ key: 2, name: 'second' });
			expect(await fresh.get(0)).to.deep.equal({ key: 0, name: 'seed' });
		} finally {
			db.close();
		}
	});
});
