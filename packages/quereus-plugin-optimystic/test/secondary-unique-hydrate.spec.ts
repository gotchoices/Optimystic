/**
 * Hydrate-path coverage for secondary UNIQUE enforcement
 * (see ticket `bug-optimystic-hydrate-unique-not-enforced`).
 *
 * The documented warm-restart flow is `plugin.hydrate(db)` followed by DDL that
 * no-ops against the hydrated catalog — so on that path NO `CREATE TABLE` /
 * `CREATE UNIQUE INDEX` ever re-runs, and the vtab's uniqueness metadata must
 * come entirely from the persisted schema. These tests open persisted tables
 * through hydrate ONLY (no re-declared DDL) and assert duplicates are rejected
 * exactly as on the fresh-CREATE path, for every constraint shape: plain
 * secondary UNIQUE, CREATE UNIQUE INDEX, composite, partial (stays excluded),
 * and nullable. They also pin the schemasEqual stabilization contract: a
 * modern-format schema takes the no-write short-circuit on reopen, and a
 * pre-upgrade schema (no `uniqueConstraints` key) re-stabilizes after exactly
 * one write once re-declared.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { ConflictResolution } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import type { StoredTableSchema } from '../dist/index.js';

/** Build a `local`-style transactor over the supplied raw storage, shared
 * across plugin instances so Trees opened by either side see the other's
 * writes (same harness as catalog-hydration.spec.ts). */
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

type PluginHandle = ReturnType<typeof registerWithSharedTransactor>;

interface SchemaManagerLike {
	getSchema: (name: string) => Promise<StoredTableSchema | undefined>;
	storeStoredSchema: (stored: StoredTableSchema) => Promise<void>;
	storeSchema: (...args: unknown[]) => Promise<void>;
}

/** Reach the plugin's shared SchemaManager (populated by hydrate/create). */
function sharedSchemaManager(plugin: PluginHandle): SchemaManagerLike {
	const optimysticModule = plugin.vtables[0]!.module as unknown as {
		schemaManagers: Map<string, SchemaManagerLike>;
	};
	const managers = [...optimysticModule.schemaManagers.values()];
	expect(managers, 'plugin should have exactly one shared SchemaManager').to.have.lengthOf(1);
	return managers[0]!;
}

async function scalar(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { v: number }).v);
	}
	throw new Error('scalar query returned no rows');
}

async function expectThrows(fn: () => Promise<unknown>, match?: RegExp): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (match) {
			const message = e instanceof Error ? e.message : String(e);
			expect(message).to.match(match);
		}
		return;
	}
	throw new Error('expected operation to throw, but it resolved');
}

describe('Secondary UNIQUE enforcement across the hydrate warm-restart path', function () {
	this.timeout(20000);

	it('hydrate-only open enforces a plain secondary UNIQUE (no re-declared DDL)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		// Session 1: declare + populate.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniqhydrate/plain')
			`);
			await dbA.exec(`insert into T (Id, Stamp) values (1, 'a')`);
		} finally {
			dbA.close();
		}

		// Session 2: hydrate ONLY — no CREATE TABLE re-runs, so enforcement must
		// come entirely from the persisted schema.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			const result = await pluginB.hydrate(dbB);
			expect(result.tables).to.equal(1);

			// The hydrated catalog entry carries the constraint...
			const hydrated = dbB.schemaManager.findTable('T', 'main');
			expect(hydrated?.uniqueConstraints, 'hydrated schema must carry the UNIQUE constraint')
				.to.have.lengthOf(1);
			expect([...hydrated!.uniqueConstraints![0]!.columns]).to.deep.equal([1]);

			// ...and hydrate stays idempotent without doubling constraints.
			const second = await pluginB.hydrate(dbB);
			expect(second.tables).to.equal(0);
			expect(dbB.schemaManager.findTable('T', 'main')!.uniqueConstraints).to.have.lengthOf(1);

			// Different PK, same Stamp → only the secondary UNIQUE can reject it.
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			// A distinct value inserts fine; the rejected row never landed.
			await dbB.exec(`insert into T (Id, Stamp) values (3, 'b')`);
			expect(await scalar(dbB, `select count(*) as v from T`)).to.equal(2);
			expect(await scalar(dbB, `select count(*) as v from T where Stamp = 'a'`)).to.equal(1);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open enforces a UNIQUE derived from CREATE UNIQUE INDEX', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		const pluginA = registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table T (Id integer primary key, Stamp text not null)
					using optimystic('tree://uniqhydrate/createindex')
			`);
			await dbA.exec(`create unique index ux_stamp on T (Stamp)`);
			await dbA.exec(`insert into T (Id, Stamp) values (1, 'a')`);

			// The persisted index must carry its uniqueness so a later hydrate can
			// reconstruct the derived constraint.
			const stored = await sharedSchemaManager(pluginA).getSchema('T');
			expect(stored?.indexes.map(idx => ({ name: idx.name, unique: idx.unique })))
				.to.deep.equal([{ name: 'ux_stamp', unique: true }]);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);

			// Duplicate of a session-1 value → rejected through the declared index tree.
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			// Fresh value inserts, then ITS duplicate is rejected too.
			await dbB.exec(`insert into T (Id, Stamp) values (3, 'b')`);
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (4, 'b')`),
				/UNIQUE constraint failed/,
			);
			expect(await scalar(dbB, `select count(*) as v from T`)).to.equal(2);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open enforces a composite UNIQUE with declared column order preserved', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		const pluginA = registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table C (Id integer primary key, A text, B text, unique (A, B))
					using optimystic('tree://uniqhydrate/composite')
			`);
			await dbA.exec(`insert into C (Id, A, B) values (1, 'x', 'y')`);

			// Declared column order must round-trip — it feeds the synthesized
			// `_uniq_` tree's key derivation, which must stay stable across restarts.
			const stored = await sharedSchemaManager(pluginA).getSchema('C');
			expect(stored?.uniqueConstraints?.map(uc => uc.columns)).to.deep.equal([[1, 2]]);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);

			// Same (A,B) pair as a session-1 row → rejected.
			await expectThrows(
				() => dbB.exec(`insert into C (Id, A, B) values (2, 'x', 'y')`),
				/UNIQUE constraint failed/,
			);
			// Partial overlap (same A, different B) → allowed.
			await dbB.exec(`insert into C (Id, A, B) values (3, 'x', 'z')`);
			expect(await scalar(dbB, `select count(*) as v from C`)).to.equal(2);
		} finally {
			dbB.close();
		}
	});

	it('a partial UNIQUE index stays excluded from enforcement after hydrate (predicate presence survives)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		const pluginA = registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table P (Id integer primary key, Val text not null, Flag integer not null)
					using optimystic('tree://uniqhydrate/partial')
			`);
			await dbA.exec(`create unique index ux_val on P (Val) where Flag = 1`);
			await dbA.exec(`insert into P (Id, Val, Flag) values (1, 'v', 0)`);

			// The persisted index must record BOTH the unique flag and the predicate;
			// losing the predicate would silently promote it to a full constraint.
			const stored = await sharedSchemaManager(pluginA).getSchema('P');
			const idx = stored?.indexes.find(candidate => candidate.name === 'ux_val');
			expect(idx?.unique, 'persisted partial index must be marked unique').to.equal(true);
			expect(idx?.predicate, 'persisted partial index must keep its predicate').to.not.equal(undefined);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);

			// Duplicate Val OUTSIDE the predicate scope (Flag = 0 rows) is legitimate.
			// If the predicate had been dropped in the round-trip, the constraint
			// would have become a full UNIQUE and wrongly rejected this insert.
			await dbB.exec(`insert into P (Id, Val, Flag) values (2, 'v', 0)`);
			expect(await scalar(dbB, `select count(*) as v from P`)).to.equal(2);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open keeps nullable-UNIQUE semantics (multiple NULLs, duplicate non-null rejected)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			// Mirrors the control schema's nullable Strand.MemberPrivateKey shape.
			await dbA.exec(`
				create table N (Id integer primary key, Tag text null unique)
					using optimystic('tree://uniqhydrate/nullable')
			`);
			await dbA.exec(`insert into N (Id, Tag) values (1, null)`);
			await dbA.exec(`insert into N (Id, Tag) values (2, 'x')`);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);

			// NULLs stay exempt — a second NULL row coexists with session 1's.
			await dbB.exec(`insert into N (Id, Tag) values (3, null)`);
			// A duplicate NON-null value is still rejected.
			await expectThrows(
				() => dbB.exec(`insert into N (Id, Tag) values (4, 'x')`),
				/UNIQUE constraint failed/,
			);
			expect(await scalar(dbB, `select count(*) as v from N`)).to.equal(3);
		} finally {
			dbB.close();
		}
	});

	it('reopen of a modern-format schema with UNIQUE constraints takes the no-write short-circuit', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table W (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniqhydrate/shortcircuit')
			`);
			await dbA.exec(`insert into W (Id, Stamp) values (1, 'a')`);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);
			const manager = sharedSchemaManager(pluginB);
			let writes = 0;
			const originalStore = manager.storeSchema.bind(manager);
			const originalStoreStored = manager.storeStoredSchema.bind(manager);
			manager.storeSchema = async (...args: unknown[]) => { writes++; return originalStore(...args); };
			manager.storeStoredSchema = async (stored: StoredTableSchema) => { writes++; return originalStoreStored(stored); };

			// First touch runs doInitialize against the hydrated schema; the
			// candidate (with its uniqueConstraints) must match the persisted
			// bytes, so nothing is re-written — while enforcement is still live.
			await expectThrows(
				() => dbB.exec(`insert into W (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			await dbB.exec(`insert into W (Id, Stamp) values (3, 'b')`);
			expect(writes, 'reopen of a modern schema must not re-write it').to.equal(0);
		} finally {
			dbB.close();
		}
	});

	it('pre-upgrade schema (no uniqueConstraints key) re-stabilizes after exactly one write once re-declared', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const ddl = `
			create table T (Id integer primary key, Stamp text not null unique)
				using optimystic('tree://uniqhydrate/preupgrade')
		`;

		// Session 1: modern create + data.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(ddl);
			await dbA.exec(`insert into T (Id, Stamp) values (1, 'a')`);
		} finally {
			dbA.close();
		}

		// Tamper: strip the persisted uniqueConstraints key to simulate a schema
		// written by a build that predates uniqueness persistence.
		const dbT = new Database();
		const pluginT = registerWithSharedTransactor(dbT, shared);
		try {
			await pluginT.hydrate(dbT);
			const manager = sharedSchemaManager(pluginT);
			const stored = await manager.getSchema('T');
			expect(stored?.uniqueConstraints, 'sanity: modern schema has the key').to.not.equal(undefined);
			const { uniqueConstraints: _dropped, ...preUpgrade } = stored!;
			await manager.storeStoredSchema(preUpgrade as StoredTableSchema);
		} finally {
			dbT.close();
		}

		// Session 2: re-declare (no hydrate — the differ sees an empty catalog and
		// the CREATE TABLE actually executes). Count schema-tree writes: the
		// candidate now carries uniqueConstraints, the persisted side does not, so
		// exactly ONE re-write persists them — and enforcement is live immediately.
		const countSchemaTreeWrites = (plugin: PluginHandle): { count: () => number } => {
			let writes = 0;
			const factory = plugin.collectionFactory as unknown as {
				createOrGetCollection: (options: { collectionUri?: string }, txnState?: unknown) => Promise<{ replace: (...args: unknown[]) => Promise<unknown> }>;
			};
			const original = factory.createOrGetCollection.bind(factory);
			factory.createOrGetCollection = async (options, txnState) => {
				const tree = await original(options, txnState);
				if (options?.collectionUri === 'tree://optimystic/schema') {
					const originalReplace = tree.replace.bind(tree);
					tree.replace = async (...args: unknown[]) => { writes++; return originalReplace(...args); };
				}
				return tree;
			};
			return { count: () => writes };
		};

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			const writesB = countSchemaTreeWrites(pluginB);
			await dbB.exec(ddl);
			expect(writesB.count(), 're-declare over a pre-upgrade schema writes exactly once').to.equal(1);
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
		} finally {
			dbB.close();
		}

		// Session 3: identical re-declare — the persisted schema now carries the
		// constraints, so the short-circuit holds and nothing is written.
		const dbC = new Database();
		const pluginC = registerWithSharedTransactor(dbC, shared);
		try {
			const writesC = countSchemaTreeWrites(pluginC);
			await dbC.exec(ddl);
			expect(writesC.count(), 'second post-upgrade open must write nothing').to.equal(0);
			await expectThrows(
				() => dbC.exec(`insert into T (Id, Stamp) values (3, 'a')`),
				/UNIQUE constraint failed/,
			);
		} finally {
			dbC.close();
		}
	});

	it('re-declared CREATE UNIQUE INDEX over a pre-upgrade schema enforces immediately and persists the flag', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const tableDdl = `
			create table T (Id integer primary key, Stamp text not null)
				using optimystic('tree://uniqhydrate/idxupgrade')
		`;

		// Session 1: modern create + unique index + data.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(tableDdl);
			await dbA.exec(`create unique index ux_stamp on T (Stamp)`);
			await dbA.exec(`insert into T (Id, Stamp) values (1, 'a')`);
		} finally {
			dbA.close();
		}

		// Tamper: strip the persisted index's uniqueness metadata to simulate a
		// schema written by a build that predates it.
		const dbT = new Database();
		const pluginT = registerWithSharedTransactor(dbT, shared);
		try {
			await pluginT.hydrate(dbT);
			const manager = sharedSchemaManager(pluginT);
			const stored = await manager.getSchema('T');
			await manager.storeStoredSchema({
				...stored!,
				indexes: stored!.indexes.map(idx => ({ name: idx.name, columns: idx.columns })),
			});
		} finally {
			dbT.close();
		}

		// Session 2: re-declare table AND index (no hydrate). The index name dedupe
		// hits — but the derived constraint must still mirror into the live vtab
		// (enforcement immediately), and the missing `unique` flag must persist.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await dbB.exec(tableDdl);
			await dbB.exec(`create unique index if not exists ux_stamp on T (Stamp)`);
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			const stored = await sharedSchemaManager(pluginB).getSchema('T');
			expect(
				stored?.indexes.find(idx => idx.name === 'ux_stamp')?.unique,
				're-declare must persist the missing unique flag',
			).to.equal(true);
		} finally {
			dbB.close();
		}

		// Session 3: hydrate-only — the upgraded flag now carries enforcement.
		const dbC = new Database();
		const pluginC = registerWithSharedTransactor(dbC, shared);
		try {
			await pluginC.hydrate(dbC);
			await expectThrows(
				() => dbC.exec(`insert into T (Id, Stamp) values (3, 'a')`),
				/UNIQUE constraint failed/,
			);
			await dbC.exec(`insert into T (Id, Stamp) values (4, 'b')`);
			expect(await scalar(dbC, `select count(*) as v from T`)).to.equal(2);
		} finally {
			dbC.close();
		}
	});

	it('a partial unique index does not mask a full one over the same columns after hydrate', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		const tableDdl = `
			create table T (Id integer primary key, Stamp text not null, Flag integer not null)
				using optimystic('tree://uniqhydrate/partialmask')
		`;

		// Session 1: the PARTIAL unique index is declared FIRST, so it lands first in
		// the persisted index list. The full one that follows is the constraint that
		// actually enforces.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(tableDdl);
			await dbA.exec(`create unique index ux_partial on T (Stamp) where Flag = 1`);
			await dbA.exec(`create unique index ux_full on T (Stamp)`);
			await dbA.exec(`insert into T (Id, Stamp, Flag) values (1, 'a', 0)`);
			// Baseline: on the fresh-DDL path the full index enforces.
			await expectThrows(
				() => dbA.exec(`insert into T (Id, Stamp, Flag) values (2, 'a', 0)`),
				/UNIQUE constraint failed/,
			);
		} finally {
			dbA.close();
		}

		// Session 2: hydrate only. Reconstruction must not let the partial index's
		// derived constraint dedupe away the full one — that would drop enforcement
		// entirely on the warm-restart path.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp, Flag) values (3, 'a', 0)`),
				/UNIQUE constraint failed/,
			);
			await dbB.exec(`insert into T (Id, Stamp, Flag) values (4, 'b', 0)`);
			expect(await scalar(dbB, `select count(*) as v from T`)).to.equal(2);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open enforces every UNIQUE constraint when a table declares several', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table M (Id integer primary key, Email text not null unique, Handle text not null unique)
					using optimystic('tree://uniqhydrate/multi')
			`);
			await dbA.exec(`insert into M (Id, Email, Handle) values (1, 'e1', 'h1')`);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);
			expect(dbB.schemaManager.findTable('M', 'main')?.uniqueConstraints).to.have.lengthOf(2);

			// Each constraint must reject independently — a shared-key collision in the
			// synthesized-tree naming would let one of them silently win.
			await expectThrows(
				() => dbB.exec(`insert into M (Id, Email, Handle) values (2, 'e1', 'h2')`),
				/UNIQUE constraint failed/,
			);
			await expectThrows(
				() => dbB.exec(`insert into M (Id, Email, Handle) values (3, 'e2', 'h1')`),
				/UNIQUE constraint failed/,
			);
			await dbB.exec(`insert into M (Id, Email, Handle) values (4, 'e2', 'h2')`);
			expect(await scalar(dbB, `select count(*) as v from M`)).to.equal(2);
		} finally {
			dbB.close();
		}
	});

	it("round-trips a constraint-level 'on conflict' action through persistence and hydrate", async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);
		let declared: ConflictResolution | undefined;

		const dbA = new Database();
		const pluginA = registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table I (Id integer primary key, Stamp text not null unique on conflict ignore)
					using optimystic('tree://uniqhydrate/onconflict')
			`);
			declared = dbA.schemaManager.findTable('I', 'main')?.uniqueConstraints?.[0]?.defaultConflict;
			expect(declared, 'sanity: the parsed schema carries the declared action').to.not.equal(undefined);

			const stored = await sharedSchemaManager(pluginA).getSchema('I');
			expect(stored?.uniqueConstraints?.[0]?.defaultConflict, 'action must be persisted')
				.to.equal(declared);
		} finally {
			dbA.close();
		}

		// NOTE: the vtab does not yet ACT on a constraint-level `on conflict` for a
		// secondary UNIQUE (it honours only the statement-level `insert or ...`) —
		// a pre-existing gap on every path, tracked by
		// `bug-optimystic-constraint-level-on-conflict-ignored`. This pins the
		// persistence round-trip so the fix has correct metadata to act on.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);
			expect(dbB.schemaManager.findTable('I', 'main')?.uniqueConstraints?.[0]?.defaultConflict)
				.to.equal(declared);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open enforces UNIQUE on UPDATE (and lets a row keep its own value)', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table U (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniqhydrate/update')
			`);
			await dbA.exec(`insert into U (Id, Stamp) values (1, 'a')`);
			await dbA.exec(`insert into U (Id, Stamp) values (2, 'b')`);
		} finally {
			dbA.close();
		}

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);

			// Moving row 2 onto row 1's value collides.
			await expectThrows(
				() => dbB.exec(`update U set Stamp = 'a' where Id = 2`),
				/UNIQUE constraint failed/,
			);
			// A no-op self-update must NOT collide with the row's own index entry.
			await dbB.exec(`update U set Stamp = 'b' where Id = 2`);
			// A move to a free value succeeds and frees the old one for reuse.
			await dbB.exec(`update U set Stamp = 'c' where Id = 2`);
			await dbB.exec(`insert into U (Id, Stamp) values (3, 'b')`);
			expect(await scalar(dbB, `select count(*) as v from U`)).to.equal(3);
			expect(await scalar(dbB, `select count(*) as v from U where Stamp = 'c'`)).to.equal(1);
		} finally {
			dbB.close();
		}
	});

	it('hydrate-only open backfills an empty unique tree over already-populated rows', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		// Session 1: NO unique constraint — rows land with no `_uniq_` tree ever
		// created (the "older build" state of secondary-unique-migration.spec.ts).
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`
				create table T (Id integer primary key, Stamp text not null)
					using optimystic('tree://uniqhydrate/backfill')
			`);
			await dbA.exec(`insert into T (Id, Stamp) values (1, 'a')`);
			await dbA.exec(`insert into T (Id, Stamp) values (2, 'b')`);
			await dbA.exec(`insert into T (Id, Stamp) values (3, 'c')`);
		} finally {
			dbA.close();
		}

		// Tamper: add the constraint to the persisted schema WITHOUT any re-declare
		// having run the backfill — as if another node upgraded the schema but this
		// node's synthesized tree is still empty over a populated table.
		const dbT = new Database();
		const pluginT = registerWithSharedTransactor(dbT, shared);
		try {
			await pluginT.hydrate(dbT);
			const manager = sharedSchemaManager(pluginT);
			const stored = await manager.getSchema('T');
			await manager.storeStoredSchema({ ...stored!, uniqueConstraints: [{ columns: [1] }] });
		} finally {
			dbT.close();
		}

		// Session 2: hydrate-only. The one-time backfill must populate the empty
		// `_uniq_1` tree from the existing rows before the first probe trusts it.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		try {
			await pluginB.hydrate(dbB);
			await expectThrows(
				() => dbB.exec(`insert into T (Id, Stamp) values (4, 'a')`),
				/UNIQUE constraint failed/,
			);
			await dbB.exec(`insert into T (Id, Stamp) values (5, 'd')`);
			expect(await scalar(dbB, `select count(*) as v from T`)).to.equal(4);
			expect(await scalar(dbB, `select count(*) as v from T where Stamp = 'a'`)).to.equal(1);
		} finally {
			dbB.close();
		}
	});
});
