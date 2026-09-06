/**
 * `db-core` raises typed read failures specifically so a caller can branch on them:
 * `BlockUnavailableError` carries `reason` (one of `unmaterializable`, `peers-unreachable`,
 * `cohort-unreachable`, `claimed-elsewhere`), and `BlockPossiblyStaleError` carries
 * `claimedRev`. Before this fix, every catch arm in `OptimysticModule` that surfaced a
 * caught error to SQL rewrapped it as a plain `new Error(message)` with no `cause`, so the
 * class and its fields were unrecoverable past the SQL boundary — a consumer reading
 * through SQL had nothing to test but the text of a sentence.
 *
 * Each case here drives a read whose transactor raises a chosen failure, catches what SQL
 * throws, and asserts the cause chain reaches the original value: a `BlockUnavailableError`
 * with its `reason`, a `BlockPossiblyStaleError` with its `claimedRev`, and a non-`Error`
 * throw (the rewrap's `String(error)` branch) reaching `cause` unwrapped.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import { BlockUnavailableError, BlockPossiblyStaleError } from '@optimystic/db-core';
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
	/** While set, a `get` whose block ids satisfy this raises instead of reading. */
	failing?: (blockIds: string[]) => boolean;
	/** What such a `get` raises. Defaults to a `BlockUnavailableError('cohort-unreachable')`. */
	raise?: (blockId: string) => unknown;
}

/** A transactor that delegates to `base` but raises `gate.raise` out of `get` while
 *  `gate.failing` matches the block ids being read — the same shape a real
 *  `NetworkTransactor` raises when a cohort read cannot determine whether a block exists. */
function gatedTransactor(base: ITransactor, gate: Gate): ITransactor {
	return {
		async get(blockGets) {
			const ids = blockGets.blockIds.map((id: unknown) => String(id));
			if (gate.failing?.(ids)) {
				const raise = gate.raise ?? ((id: string) => new BlockUnavailableError(id, 'cohort-unreachable'));
				throw raise(ids[0]!);
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

/**
 * Seed a table with a healthy transactor, then re-open it behind a transactor whose header
 * read raises `raise`, and return whatever `select *` threw. Seeding first is what makes the
 * later session take the "load persisted table" path, which reads the collection header.
 */
async function catchGatedRead(uri: string, raise?: (blockId: string) => unknown): Promise<unknown> {
	const storage = new MemoryRawStorage();
	const healthy = buildSharedLocalTransactor(storage);

	const seedDb = new Database();
	registerWithSharedTransactor(seedDb, healthy);
	try {
		await seedDb.exec(`create table t (id integer primary key, a text) using optimystic('${uri}')`);
		await seedDb.exec(`insert into t (id, a) values (1, 'aa')`);
	} finally {
		seedDb.close();
	}

	const gate: Gate = { failing: headerOf(uri), raise };
	const db = new Database();
	const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
	try {
		await plugin.hydrate(db);
		try {
			await queryAll(db, `select * from t`);
		} catch (error) {
			return error;
		}
		return undefined;
	} finally {
		db.close();
	}
}

/**
 * Walk to the value the plugin's rewrap carried as `cause`. Quereus wraps whatever the vtab
 * throws in a `QuereusError` and itself preserves `cause` (see runtime/emit/scan.ts), so the
 * chain a caller walks is:
 *   QuereusError (Quereus's own wrap) -> Error (this plugin's wrap, the fix under test)
 *   -> the original value raised by the transactor.
 * Before the fix, the middle link dropped `cause` and the chain stopped there.
 */
function originalCauseOf(thrown: unknown): unknown {
	expect(thrown, 'the gated read must fail').to.be.instanceOf(Error);
	const pluginWrap = (thrown as Error).cause;
	expect(pluginWrap, "this plugin's rewrap must survive as `cause` on Quereus's own error")
		.to.be.instanceOf(Error);
	return (pluginWrap as Error).cause;
}

describe('a read failure crossing the SQL adapter keeps its typed cause', () => {
	it('a BlockUnavailableError raised during initialization survives as `cause`, reason intact', async () => {
		const thrown = await catchGatedRead('tree://cause-passthrough/t');

		expect((thrown as Error).message).to.include('unavailable');

		const original = originalCauseOf(thrown);
		expect(original, 'the original BlockUnavailableError must survive as the next `cause`')
			.to.be.instanceOf(BlockUnavailableError);
		expect((original as BlockUnavailableError).reason).to.equal('cohort-unreachable');
	});

	it('a BlockPossiblyStaleError survives the same way, claimedRev intact', async () => {
		// Parity with the reason case: the rewrap is generic over `Error`, and this is the
		// other typed read failure db-core raises that carries a field worth branching on.
		const thrown = await catchGatedRead(
			'tree://cause-passthrough-stale/t',
			id => new BlockPossiblyStaleError(id, 42)
		);

		const original = originalCauseOf(thrown);
		expect(original, 'the original BlockPossiblyStaleError must survive as the next `cause`')
			.to.be.instanceOf(BlockPossiblyStaleError);
		expect((original as BlockPossiblyStaleError).claimedRev).to.equal(42);
	});

	it('a non-Error throw reaches `cause` unwrapped, message built from String(value)', async () => {
		// The rewrap's `String(error)` branch: a transactor that throws a bare value must still
		// produce a readable message and hand the raw value through as `cause`, not a wrapper
		// around it.
		const raw = { code: 'not-an-error' };
		const thrown = await catchGatedRead('tree://cause-passthrough-raw/t', () => raw);

		expect((thrown as Error).message).to.include(String(raw));
		expect(originalCauseOf(thrown), 'the raw thrown value must arrive as `cause` untouched')
			.to.equal(raw);
	});
});
