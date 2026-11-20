/**
 * The `blobref` column type (docs/blobs.md §SQL): text whose value must be a well-formed blob
 * reference — the short content identifier that names a large stored file.
 *
 * What is pinned here: which values such a column accepts and refuses, and the refusals that keep
 * a process which would read the column as something else from either writing a catalog record
 * for it or opening one. Nothing here tests the registration wiring, the type's metadata flags, or
 * that an index on the column still walks — a type, the existing index-walk specs and `yarn check`
 * cover those.
 *
 * The reference below is one of the fixed vectors in `packages/db-core/test/blob-builder.spec.ts`
 * (its 1,000-byte file), so it is a reference real IPFS tools produce, not one made to fit.
 */

import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { BLOBREF_TYPE_NAME, isBlobRefColumn } from '../dist/index.js';
import type { StoredTableSchema } from '../dist/index.js';
// From source: the assertion is internal to the plugin (`doInitialize` is its only caller), and in
// a process that HAS the type registered it is unreachable through SQL — see its test below.
import { assertBlobRefTypeRegistered } from '../src/schema/blobref-type.js';
import type { StoredColumnTypeNames } from '../src/schema/blobref-type.js';
import { buildSharedLocalTransactor } from './shared-local-transactor.js';
import { captureThrown, queryAll } from './query-helpers.js';

/** A canonical reference: CIDv1, raw codec, sha2-256, lowercase base32, 59 characters. */
const REF = 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu';

const TABLE_DDL = `
	create table Attachment (Id text primary key, Content blobref null)
		using optimystic('tree://blobref/attachment')
`;

type PluginHandle = ReturnType<typeof register>;

/**
 * The hydration harness of `catalog-hydration.spec.ts`, widened to register the plugin's `types`
 * as `registerPlugin` (`@quereus/quereus/src/util/plugin-helper.ts`) does — which is what a host
 * assembling the plugin's parts by hand must also do for a `blobref` column to resolve.
 */
function openSession(transactor: ITransactor): { db: Database; plugin: PluginHandle } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	for (const type of plugin.types) db.registerType(type.name, type.definition);
	return { db, plugin };
}

interface SchemaManagerLike {
	getSchema: (schemaName: string, name: string) => Promise<StoredTableSchema | undefined>;
	storeStoredSchema: (stored: StoredTableSchema) => Promise<StoredTableSchema>;
}

/** Reach the plugin's shared SchemaManager (populated by hydrate/create), as the hydrate specs do. */
function sharedSchemaManager(plugin: PluginHandle): SchemaManagerLike {
	const optimysticModule = plugin.vtables[0]!.module as unknown as {
		schemaManagers: Map<string, SchemaManagerLike>;
	};
	const managers = [...optimysticModule.schemaManagers.values()];
	expect(managers, 'plugin should have exactly one shared SchemaManager').to.have.lengthOf(1);
	return managers[0]!;
}

/** What {@link assertBlobRefTypeRegistered} throws for `columns`, or undefined when it is quiet. */
function assertionOver(columns: readonly StoredColumnTypeNames[]): unknown {
	try {
		assertBlobRefTypeRegistered(columns, `table 'main.Attachment'`);
		return undefined;
	} catch (error) {
		return error;
	}
}

describe('blobref column type', function () {
	this.timeout(15_000);

	it('stores a well-formed reference verbatim, and NULL as nothing referenced', async () => {
		const { db } = openSession(buildSharedLocalTransactor(new MemoryRawStorage()));
		try {
			await db.exec(TABLE_DDL);
			await db.exec(`insert into Attachment (Id, Content) values (?, ?)`, ['a', REF]);
			await db.exec(`insert into Attachment (Id, Content) values (?, ?)`, ['b', null]);

			expect(await queryAll(db, `select Id, Content from Attachment order by Id`)).to.deep.equal([
				{ Id: 'a', Content: REF },
				{ Id: 'b', Content: null },
			]);
		} finally {
			db.close();
		}
	});

	it('refuses a value that is not a canonical reference', async () => {
		// Which spellings are and are not references is `isBlobRef`'s rule, pinned over the whole
		// vector set (upper case, CIDv0, other codecs, padding, whitespace, non-strings) by
		// `packages/db-core/test/blob-ref.spec.ts`. What is pinned HERE is only that the column
		// consults that rule at all, and what the engine reports when it says no: two values, one
		// per arm of `validate` — a string the grammar refuses, and a value that is not a string.
		const REFUSED: readonly { readonly what: string; readonly value: SqlValue }[] = [
			{ what: 'the upper-cased spelling of a real reference', value: REF.toUpperCase() },
			{ what: 'an integer', value: 42 },
		];

		const { db } = openSession(buildSharedLocalTransactor(new MemoryRawStorage()));
		try {
			await db.exec(TABLE_DDL);
			for (const { what, value } of REFUSED) {
				const error = await captureThrown(
					() => db.exec(`insert into Attachment (Id, Content) values (?, ?)`, ['x', value]),
				);
				expect(error, what).to.be.instanceOf(QuereusError);
				expect(error.message, what).to.include(
					`Type mismatch for column 'Content': expected ${BLOBREF_TYPE_NAME}`,
				);
				expect((error as QuereusError).code, what).to.equal(StatusCode.MISMATCH);
			}
			expect(await queryAll(db, `select count(*) as n from Attachment`)).to.deep.equal([{ n: 0 }]);
		} finally {
			db.close();
		}
	});

	it('refuses to hydrate a stored column whose rows were not written under the type', async () => {
		// Guard 1 (`hydratedColumnType` in src/schema/schema-manager.ts): a record saying "these rows
		// were written as X, declared x" where `x` no longer resolves to X in this process.
		//
		// The type cannot be un-registered to produce the disagreement honestly: Quereus's type
		// registry is process-wide with no un-register (`TypeRegistry` in
		// `@quereus/quereus/src/types/registry.ts`), so a test needing BLOBREF absent would pass
		// or fail on file ordering in a shared mocha process. So the record is tampered instead —
		// on its DECLARED side (`declaredType: 'blob'` over rows written as BLOBREF) rather than
		// its affinity side, because the affinity-side tamper is itself what the write guard below
		// refuses. Same disagreement, same place, same throw, both ways round.
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());

		const first = openSession(shared);
		try {
			await first.db.exec(TABLE_DDL);
			await first.db.exec(`insert into Attachment (Id, Content) values (?, ?)`, ['a', REF]);

			const manager = sharedSchemaManager(first.plugin);
			const stored = await manager.getSchema('main', 'Attachment');
			expect(stored!.columns.map(col => col.affinity)).to.deep.equal(['TEXT', BLOBREF_TYPE_NAME]);
			await manager.storeStoredSchema({
				...stored!,
				columns: stored!.columns.map(col => (isBlobRefColumn(col) ? { ...col, declaredType: 'blob' } : col)),
			});
		} finally {
			first.db.close();
		}

		const second = openSession(shared);
		try {
			const error = await captureThrown(() => second.plugin.hydrate(second.db));
			expect(error.message).to.include(`column 'Content' of table 'main.Attachment'`);
			expect(error.message).to.include(BLOBREF_TYPE_NAME);
			expect(error.message).to.include(`'BLOB'`);
			expect(second.db.schemaManager.findTable('Attachment', 'main'), 'nothing enters the catalog')
				.to.equal(undefined);
		} finally {
			second.db.close();
		}
	});

	it('refuses to write a catalog record declaring blobref whose rows resolve to another type', async () => {
		// Guard 2 at the seam it is held on: `SchemaManager.storeStoredSchema`, which every column a
		// record gains passes through (CREATE TABLE's declaration arm, ALTER TABLE ADD COLUMN, and
		// the record re-writes). A process missing the type would otherwise persist such a column
		// over a record whose rows were written AS blobref, and the table would then open for
		// nobody. Reached by handing the manager the record such a process builds, since in a
		// process that HAS the type no SQL produces one.
		const { db, plugin } = openSession(buildSharedLocalTransactor(new MemoryRawStorage()));
		try {
			await db.exec(TABLE_DDL);
			const manager = sharedSchemaManager(plugin);
			const stored = (await manager.getSchema('main', 'Attachment'))!;
			const error = await captureThrown(() => manager.storeStoredSchema({
				...stored,
				columns: stored.columns.map(col => (isBlobRefColumn(col) ? { ...col, affinity: 'BLOB' } : col)),
			}));
			expect(error).to.be.instanceOf(QuereusError);
			expect(error.message).to.include(`Column 'Content' of table 'main.Attachment'`);
		} finally {
			db.close();
		}
	});

	it('refuses a column declared blobref whose rows resolved to another type', () => {
		// Guard 2's rule itself: the shape `create table … (Content blobref)` produces in a process
		// that never registered the type, under `pragma strict_type_names = false`. Called directly
		// — in a process that HAS the type, no declaration reaches it (a declaration here resolves
		// to BLOBREF, and a stored record that disagrees is refused by guard 1 first), and the
		// registry is process-wide, as the test above explains.
		const error = assertionOver([
			{ name: 'Id', affinity: 'TEXT', declaredType: 'text' },
			{ name: 'Content', affinity: 'BLOB', declaredType: 'blobref' },
		]);
		expect(error).to.be.instanceOf(QuereusError);
		expect((error as QuereusError).message).to.include(`Column 'Content' of table 'main.Attachment'`);
		expect((error as QuereusError).message).to.include(BLOBREF_TYPE_NAME);
		expect((error as QuereusError).code).to.equal(StatusCode.ERROR);

		// SQL spells a declaration in any case, and the base name is what is compared.
		expect(assertionOver([{ name: 'C', affinity: 'BLOB', declaredType: 'BlobRef' }])).to.be.instanceOf(QuereusError);
		expect(assertionOver([{ name: 'C', affinity: 'BLOB', declaredType: 'blobref(2)' }])).to.be.instanceOf(QuereusError);

		// Quiet for everything that is not this disagreement: the type resolved, the column is not
		// a blobref column at all, or the record names no declared spelling (which is guard 1's).
		expect(assertionOver([{ name: 'C', affinity: BLOBREF_TYPE_NAME, declaredType: 'blobref' }])).to.equal(undefined);
		expect(assertionOver([{ name: 'C', affinity: 'BLOB', declaredType: 'blob' }])).to.equal(undefined);
		expect(assertionOver([{ name: 'C', affinity: BLOBREF_TYPE_NAME }])).to.equal(undefined);
	});
});
