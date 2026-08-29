/**
 * SchemaManager's write path against a stand-in catalog tree.
 *
 * The end-to-end durability guarantees live in schema-catalog-index-durability.spec.ts;
 * this file pins the contracts that spec can only reach indirectly, by driving
 * SchemaManager over a fake tree whose state and failures are dictated per case:
 *
 * - storeStoredSchema unions `indexes` with what the catalog holds AT WRITE TIME,
 *   even for a caller that never read the catalog at all;
 * - a tombstoned entry is "absent", not an index list to merge with;
 * - the per-instance cache is updated only after the write actually lands;
 * - getSchemaFresh prefers the catalog and falls back to the cache;
 * - deleteSchema opens the catalog OPEN-ONLY and no-ops when there is none —
 *   dropping one table must never bring a locally-invented empty catalog into
 *   existence over a real one.
 */

import { expect } from 'chai';
import { SchemaManager, toPersistedSchema } from '../src/schema/schema-manager.js';
import type { PersistedTableSchema, StoredTableSchema } from '../src/schema/schema-manager.js';
import type { Tree } from '@optimystic/db-core';

/** The catalog holds the PERSISTED shape (index columns by name), never the resolved one. */
type CatalogEntry = [string, PersistedTableSchema | undefined];

/** Minimal stand-in for the catalog tree: just the surface SchemaManager touches. */
class FakeCatalogTree {
	readonly entries = new Map<string, CatalogEntry>();
	readonly writes: CatalogEntry[][] = [];
	updateCount = 0;
	failNextReplace = false;

	async update(): Promise<void> {
		this.updateCount++;
	}

	async find(key: string): Promise<unknown> {
		return { key };
	}

	isValid(path: unknown): boolean {
		return this.entries.has((path as { key: string }).key);
	}

	at(path: unknown): CatalogEntry | undefined {
		return this.entries.get((path as { key: string }).key);
	}

	async replace(data: [string, CatalogEntry | undefined][]): Promise<void> {
		if (this.failNextReplace) {
			this.failNextReplace = false;
			throw new Error('replace failed');
		}
		this.writes.push(data.map(([, entry]) => entry ?? ([] as unknown as CatalogEntry)));
		for (const [key, entry] of data) {
			// A delete arrives as a bare `undefined` value; the read paths must treat
			// the resulting entry as absent rather than as a live schema.
			this.entries.set(key, entry ?? [key, undefined]);
		}
	}

	/** The record last written under `name`, or undefined if it was tombstoned. */
	stored(name: string): PersistedTableSchema | undefined {
		return this.entries.get(name)?.[1];
	}
}

function makeStored(name: string, indexNames: string[]): StoredTableSchema {
	return {
		name,
		schemaName: 'main',
		columns: [{
			name: 'id', affinity: 'INTEGER', notNull: true, primaryKey: true,
			pkOrder: 0, collation: 'BINARY', generated: false,
		}],
		primaryKeyDefinition: [{ index: 0 }],
		indexes: indexNames.map(idxName => ({ name: idxName, columns: [{ index: 0 }] })),
		vtabModuleName: 'optimystic',
	};
}

/**
 * A resolved schema over `columnNames` (first column is the PK) with one single-column
 * index per `[indexName, columnName]` pair, positions resolved against THIS column list.
 */
function makeStoredWide(
	name: string,
	columnNames: string[],
	indexes: [indexName: string, columnName: string][],
	uniqueColumns?: number[],
): StoredTableSchema {
	return {
		name,
		schemaName: 'main',
		columns: columnNames.map((colName, i) => ({
			name: colName, affinity: i === 0 ? 'INTEGER' : 'TEXT', notNull: i === 0, primaryKey: i === 0,
			pkOrder: i === 0 ? 0 : -1, collation: 'BINARY', generated: false,
		})),
		primaryKeyDefinition: [{ index: 0 }],
		indexes: indexes.map(([idxName, colName]) => ({
			name: idxName,
			columns: [{ index: columnNames.indexOf(colName) }],
		})),
		vtabModuleName: 'optimystic',
		uniqueConstraints: uniqueColumns ? [{ columns: uniqueColumns }] : undefined,
	};
}

/** What the catalog would hold for `stored`: seed helper for the fake tree. */
const persistedOf = (stored: StoredTableSchema): PersistedTableSchema => toPersistedSchema(stored);

/** A SchemaManager over `tree`, plus the (transactor, create) calls it made. */
function managerOver(tree: FakeCatalogTree | undefined) {
	const opens: { create: boolean }[] = [];
	const manager = new SchemaManager(async (_transactor, create) => {
		opens.push({ create: create === true });
		return tree as unknown as Tree<string, any> | undefined;
	});
	return { manager, opens };
}

describe('SchemaManager write path', () => {
	describe('storeStoredSchema', () => {
		it('unions the incoming index list with the catalog entry at write time', async () => {
			// The caller never read the catalog — the guard is the write path's own
			// re-read, which is what makes an index-free candidate non-destructive.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStored('t', ['idx_persisted']))]);
			const { manager } = managerOver(tree);

			const written = await manager.storeStoredSchema(makeStored('t', []));

			expect(written.indexes.map(i => i.name)).to.deep.equal(['idx_persisted']);
			expect(tree.stored('t')!.indexes.map(i => i.name)).to.deep.equal(['idx_persisted']);
		});

		it('writes the [name, schema] tuple the catalog keyExtractor expects', async () => {
			const tree = new FakeCatalogTree();
			const { manager } = managerOver(tree);

			await manager.storeStoredSchema(makeStored('t', ['idx_a']));

			expect(tree.writes).to.have.lengthOf(1);
			const entry = tree.writes[0]![0]!;
			expect(entry[0], 'entry[0] must be the table name the tree keys on').to.equal('t');
			expect(entry[1]!.indexes.map(i => i.name)).to.deep.equal(['idx_a']);
		});

		it('treats a tombstoned entry as absent rather than as an index list to merge', async () => {
			// A dropped table's entry surfaces with an undefined payload. Merging with
			// it would resurrect the dead schema's indexes into a re-created table.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', undefined]);
			const { manager } = managerOver(tree);

			const written = await manager.storeStoredSchema(makeStored('t', ['idx_new']));

			expect(written.indexes.map(i => i.name)).to.deep.equal(['idx_new']);
		});

		it('leaves the cache untouched when the write fails', async () => {
			// Caching before the replace would let a later read report a value that
			// never reached storage.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStored('t', ['idx_persisted']))]);
			const { manager } = managerOver(tree);
			tree.failNextReplace = true;

			let thrown: unknown;
			try {
				await manager.storeStoredSchema(makeStored('t', ['idx_new']));
			} catch (error) {
				thrown = error;
			}
			expect((thrown as Error | undefined)?.message).to.equal('replace failed');

			const seen = await manager.getSchema('t');
			expect(seen!.indexes.map(i => i.name)).to.deep.equal(['idx_persisted']);
		});

		it('brings the catalog into existence (create-on-missing) — it is a write path', async () => {
			const tree = new FakeCatalogTree();
			const { manager, opens } = managerOver(tree);

			await manager.storeStoredSchema(makeStored('t', []));

			expect(opens.map(o => o.create)).to.deep.equal([true]);
		});
	});

	describe('column identity across the catalog boundary', () => {
		// The catalog record identifies an index's columns by NAME; the runtime schema by
		// POSITION. The two are converted only here, each against the record's own column
		// list — so a persisted index can never point at "whatever now sits in slot 2".

		it('writes index columns by name and reads them back resolved against the record', async () => {
			const tree = new FakeCatalogTree();
			const { manager } = managerOver(tree);

			await manager.storeStoredSchema(makeStoredWide('t', ['id', 'a', 'b'], [['idx_b', 'b']]));

			expect(tree.stored('t')!.indexes[0]!.columns, 'on disk: a name, no position').to.deep.equal([{ name: 'b' }]);

			manager.clearCache();
			const read = await manager.getSchema('t');
			expect(read!.indexes[0]!.columns, 'in memory: a position, no name').to.deep.equal([{ index: 2 }]);
		});

		it('re-points a persisted index at its column when a re-declare reorders the columns', async () => {
			// The pre-fix defect: `idx_b` persisted as position 2; a re-declare with `a`
			// and `b` swapped kept "position 2", which is now `a`.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStoredWide('t', ['id', 'a', 'b'], [['idx_b', 'b']]))]);
			const { manager } = managerOver(tree);

			const written = await manager.storeStoredSchema(makeStoredWide('t', ['id', 'b', 'a'], []));

			expect(written.indexes.map(i => [i.name, i.columns[0]!.index])).to.deep.equal([['idx_b', 1]]);
			expect(tree.stored('t')!.indexes[0]!.columns).to.deep.equal([{ name: 'b' }]);
		});

		it('matches persisted column names case-insensitively, as the SQL layer does', async () => {
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStoredWide('t', ['id', 'Stamp'], [['idx_stamp', 'Stamp']]))]);
			const { manager } = managerOver(tree);

			const written = await manager.storeStoredSchema(makeStoredWide('t', ['id', 'stamp'], []));

			expect(written.indexes.map(i => [i.name, i.columns[0]!.index])).to.deep.equal([['idx_stamp', 1]]);
		});

		it('refuses a re-declare that drops a column a persisted index covers', async () => {
			// Pre-fix this wrote through silently and every later row was indexed under
			// the NULL key (`row[2]` on a two-column row is undefined).
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStoredWide('t', ['id', 'a', 'b'], [['idx_b', 'b']]))]);
			const { manager } = managerOver(tree);

			let thrown: Error | undefined;
			try {
				await manager.storeStoredSchema(makeStoredWide('t', ['id', 'a'], []));
			} catch (error) {
				thrown = error as Error;
			}
			expect(thrown?.message).to.equal(
				"Cannot re-declare table 't' without column 'b': persisted index 'idx_b' covers it. " +
				'Drop the index or the table first.',
			);
			expect(tree.writes, 'nothing may reach the catalog').to.have.lengthOf(0);
		});

		it('mergeWithPersisted previews exactly what the write would land, including its refusal', () => {
			const { manager } = managerOver(new FakeCatalogTree());
			const persisted = makeStoredWide('t', ['id', 'a', 'b'], [['idx_b', 'b']]);

			const merged = manager.mergeWithPersisted(makeStoredWide('t', ['id', 'b', 'a'], []), persisted);
			expect(merged.indexes.map(i => [i.name, i.columns[0]!.index])).to.deep.equal([['idx_b', 1]]);

			expect(() => manager.mergeWithPersisted(makeStoredWide('t', ['id', 'a'], []), persisted))
				.to.throw(/without column 'b': persisted index 'idx_b' covers it/);
		});

		it('fails loudly on read when a persisted record names a column it does not have', async () => {
			// Cannot be produced by the write path any more; pins the read-side half of
			// the invariant against a hand-corrupted (or future-format) record.
			const tree = new FakeCatalogTree();
			const corrupt = persistedOf(makeStoredWide('t', ['id', 'a', 'b'], [['idx_b', 'b']]));
			tree.entries.set('t', ['t', { ...corrupt, columns: corrupt.columns.slice(0, 2) }]);
			const { manager } = managerOver(tree);

			let thrown: Error | undefined;
			try {
				await manager.getSchema('t');
			} catch (error) {
				thrown = error as Error;
			}
			expect(thrown?.message).to.equal(
				"Persisted catalog record for table 't' is unresolvable: index 'idx_b' names column 'b', " +
				'which is absent from its column list [id, a]',
			);
		});

		it('refuses to write a primary key or unique constraint position outside the column list', async () => {
			// These stay positional on disk because every write re-derives them alongside
			// the column list; this is the check that makes that an enforced invariant.
			const { manager } = managerOver(new FakeCatalogTree());

			const badPk: StoredTableSchema = { ...makeStoredWide('t', ['id', 'a'], []), primaryKeyDefinition: [{ index: 2 }] };
			let thrown: Error | undefined;
			try {
				await manager.storeStoredSchema(badPk);
			} catch (error) {
				thrown = error as Error;
			}
			expect(thrown?.message).to.equal(
				"Cannot persist table 't': primary key position 2 is out of range for its column list [id, a]",
			);

			thrown = undefined;
			try {
				await manager.storeStoredSchema(makeStoredWide('t', ['id', 'a'], [], [5]));
			} catch (error) {
				thrown = error as Error;
			}
			expect(thrown?.message).to.equal(
				"Cannot persist table 't': unique constraint column position 5 is out of range for its column list [id, a]",
			);
		});
	});

	describe('getSchemaFresh', () => {
		it('prefers the catalog over a stale cached copy', async () => {
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStored('t', []))]);
			const { manager } = managerOver(tree);
			expect((await manager.getSchema('t'))!.indexes).to.deep.equal([]);

			// A sibling instance persists an index behind this manager's back.
			tree.entries.set('t', ['t', persistedOf(makeStored('t', ['idx_sibling']))]);

			expect((await manager.getSchema('t'))!.indexes, 'the cached read must stay stale by design').to.deep.equal([]);
			const fresh = await manager.getSchemaFresh('t');
			expect(fresh!.indexes.map(i => i.name)).to.deep.equal(['idx_sibling']);
		});

		it('falls back to the cache when the catalog read yields nothing', async () => {
			// "Nothing" can still mean an undetectably unreadable catalog; a cached
			// entry is proof the schema existed, so reporting the table gone would be
			// inventing certainty.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStored('t', ['idx_a']))]);
			const { manager } = managerOver(tree);
			await manager.getSchema('t');

			tree.entries.delete('t');

			const fresh = await manager.getSchemaFresh('t');
			expect(fresh!.indexes.map(i => i.name)).to.deep.equal(['idx_a']);
		});
	});

	describe('deleteSchema', () => {
		it('no-ops on an absent catalog instead of inventing one', async () => {
			// Create-on-missing here would commit a locally-invented EMPTY catalog —
			// on a node whose read of a real catalog came back empty, that erases
			// every other table's entry.
			const { manager, opens } = managerOver(undefined);

			await manager.deleteSchema('t');

			expect(opens.map(o => o.create), 'the drop must open the catalog read-only').to.deep.equal([false]);
		});

		it('tombstones the entry when the catalog exists', async () => {
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', persistedOf(makeStored('t', ['idx_a']))]);
			const { manager } = managerOver(tree);
			await manager.getSchema('t');

			await manager.deleteSchema('t');

			expect(tree.stored('t'), 'the entry must read as absent after the drop').to.equal(undefined);
			expect(await manager.getSchemaFresh('t'), 'the cached copy must go with it').to.equal(undefined);
		});
	});
});
