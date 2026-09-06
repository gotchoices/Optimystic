/**
 * `db-core` raises typed read failures specifically so a caller can branch on them:
 * `BlockUnavailableError` carries `reason` (one of `unmaterializable`, `peers-unreachable`,
 * `cohort-unreachable`, `claimed-elsewhere`), and `BlockPossiblyStaleError` carries
 * `claimedRev`. Before this fix, every catch arm in `OptimysticModule` that surfaced a
 * caught error to SQL rewrapped it as a plain `new Error(message)` with no `cause`, so the
 * class and its fields were unrecoverable past the SQL boundary — a consumer reading
 * through SQL had nothing to test but the text of a sentence
 * (tickets/fix/2-a-sql-caller-cannot-see-why-a-read-failed).
 *
 * This drives a read whose transactor raises `BlockUnavailableError` during table
 * initialization, catches what SQL throws, and asserts the cause chain reaches an error
 * with `reason === 'cohort-unreachable'`.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import { BlockUnavailableError } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { queryAll } from './query-helpers.js';

/** Build a `local`-style transactor over raw storage, same shape as
 *  init-retry-after-transient-failure.spec.ts. */
function buildSharedLocalTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_trxRefs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

interface Gate {
	/** While set, a `get` whose block ids satisfy this throws `BlockUnavailableError`
	 *  instead of reading. */
	failing?: (blockIds: string[]) => boolean;
}

/** A transactor that delegates to `base` but raises a typed `BlockUnavailableError` out of
 *  `get` while `gate.failing` matches the block ids being read — the same shape a real
 *  `NetworkTransactor` raises when a cohort read cannot determine whether a block exists. */
function gatedTransactor(base: ITransactor, gate: Gate): ITransactor {
	return {
		async get(blockGets) {
			const ids = blockGets.blockIds.map((id: unknown) => String(id));
			if (gate.failing?.(ids)) {
				throw new BlockUnavailableError(ids[0]!, 'cohort-unreachable');
			}
			return await base.get(blockGets);
		},
		async getStatus(trxRefs) { return await base.getStatus(trxRefs); },
		async pend(request) { return await base.pend(request); },
		async commit(request) { return await base.commit(request); },
		async cancel(trxRef) { return await base.cancel(trxRef); },
	} as ITransactor;
}

/** Gate predicate: fail the header read of the collection at `uri` — the first block a
 *  fresh table touches during initialization. */
function headerOf(uri: string): (blockIds: string[]) => boolean {
	const collectionId = uri.replace(/^tree:\/\//, '');
	return ids => ids.includes(collectionId);
}

function registerWithSharedTransactor(db: Database, transactor: ITransactor) {
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return plugin;
}

describe('a read failure crossing the SQL adapter keeps its typed cause', () => {
	it('a BlockUnavailableError raised during initialization survives as `cause`, reason intact', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);

		// Seed the table with a healthy transactor so a later session's touch takes the
		// "load persisted table" path, which reads the collection header.
		{
			const seedDb = new Database();
			registerWithSharedTransactor(seedDb, healthy);
			try {
				await seedDb.exec(`create table t (id integer primary key, a text) using optimystic('tree://cause-passthrough/t')`);
				await seedDb.exec(`insert into t (id, a) values (1, 'aa')`);
			} finally {
				seedDb.close();
			}
		}

		const gate: Gate = { failing: headerOf('tree://cause-passthrough/t') };
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		try {
			await plugin.hydrate(db);

			let caught: unknown;
			try {
				await queryAll(db, `select * from t`);
			} catch (error) {
				caught = error;
			}

			expect(caught, 'the gated read must fail').to.be.instanceOf(Error);
			const thrown = caught as Error;
			expect(thrown.message).to.include('unavailable');

			// Quereus wraps whatever the vtab throws in a `QuereusError` and itself preserves
			// `cause` (see runtime/emit/scan.ts). So the chain a caller walks is:
			//   QuereusError (Quereus's own wrap) -> Error (this plugin's wrap, the fix under
			//   test) -> BlockUnavailableError (the original, from db-core).
			// Before the fix, the middle link dropped `cause` and the chain stopped there.
			const pluginWrap = thrown.cause;
			expect(pluginWrap, 'this plugin`s rewrap must survive as `cause` on Quereus`s own error')
				.to.be.instanceOf(Error);

			const original = (pluginWrap as Error).cause;
			expect(original, 'the original BlockUnavailableError must survive as the next `cause`')
				.to.be.instanceOf(BlockUnavailableError);
			expect((original as BlockUnavailableError).reason).to.equal('cohort-unreachable');
		} finally {
			db.close();
		}
	});
});
