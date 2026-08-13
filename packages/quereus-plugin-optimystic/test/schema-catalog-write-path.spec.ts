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
import { SchemaManager } from '../src/schema/schema-manager.js';
import type { StoredTableSchema } from '../src/schema/schema-manager.js';
import type { Tree } from '@optimystic/db-core';

type CatalogEntry = [string, StoredTableSchema | undefined];

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

	/** The schema last written under `name`, or undefined if it was tombstoned. */
	stored(name: string): StoredTableSchema | undefined {
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
			tree.entries.set('t', ['t', makeStored('t', ['idx_persisted'])]);
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
			tree.entries.set('t', ['t', makeStored('t', ['idx_persisted'])]);
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

	describe('getSchemaFresh', () => {
		it('prefers the catalog over a stale cached copy', async () => {
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', makeStored('t', [])]);
			const { manager } = managerOver(tree);
			expect((await manager.getSchema('t'))!.indexes).to.deep.equal([]);

			// A sibling instance persists an index behind this manager's back.
			tree.entries.set('t', ['t', makeStored('t', ['idx_sibling'])]);

			expect((await manager.getSchema('t'))!.indexes, 'the cached read must stay stale by design').to.deep.equal([]);
			const fresh = await manager.getSchemaFresh('t');
			expect(fresh!.indexes.map(i => i.name)).to.deep.equal(['idx_sibling']);
		});

		it('falls back to the cache when the catalog read yields nothing', async () => {
			// "Nothing" can still mean an undetectably unreadable catalog; a cached
			// entry is proof the schema existed, so reporting the table gone would be
			// inventing certainty.
			const tree = new FakeCatalogTree();
			tree.entries.set('t', ['t', makeStored('t', ['idx_a'])]);
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
			tree.entries.set('t', ['t', makeStored('t', ['idx_a'])]);
			const { manager } = managerOver(tree);
			await manager.getSchema('t');

			await manager.deleteSchema('t');

			expect(tree.stored('t'), 'the entry must read as absent after the drop').to.equal(undefined);
			expect(await manager.getSchemaFresh('t'), 'the cached copy must go with it').to.equal(undefined);
		});
	});
});
