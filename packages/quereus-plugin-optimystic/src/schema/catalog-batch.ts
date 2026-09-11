/**
 * CatalogBatch — the plugin's catalog writes for ONE `APPLY SCHEMA`, held in memory.
 *
 * Quereus drives `apply schema` as a loop of ordinary DDL statements and brackets the loop
 * with `beginSchemaBatch` / `endSchemaBatch` (`@quereus/quereus/src/vtab/module.ts`). Without
 * a batch every `CREATE TABLE` / `CREATE INDEX` / `DROP TABLE` in that loop commits the
 * catalog tree on its own and re-opens (and re-reads) the growing catalog for each lookup,
 * so a schema of N objects costs N catalog commits and quadratic catalog reads. Inside a
 * batch every catalog write lands in {@link CatalogBatch.pending} instead, every catalog
 * read is answered from `pending` first and otherwise from ONE committed catalog tree opened
 * (and refreshed) once for the whole apply, and {@link CatalogBatch.commit} merges the
 * overlay against the LATEST committed catalog and flushes it in one commit.
 *
 * The batch is a WRITE-COALESCING BUFFER, NOT A TRANSACTION. It is committed on both success
 * and failure of the apply (see `OptimysticModule.endSchemaBatch`); the per-statement
 * {@link CatalogBatch.checkpoint} / {@link CatalogBatch.restore} pair is what gives a failed
 * statement the same "leaves no catalog trace" outcome it had when it committed on its own.
 *
 * Owned by one `SchemaManager`, which does every conversion between the persisted and the
 * resolved schema shapes and hands this class only persisted records — this file never
 * resolves a record, so the catalog's shape boundary stays in `schema-manager.ts`.
 */

import type { ITransactor, Tree } from '@optimystic/db-core';
import type { PersistedTableSchema } from './schema-manager.js';

/**
 * What the catalog tree stores under a table's name: `[name, record]` for a live record or a
 * gravestone, `[name, undefined]` for a bare tombstone (builds before gravestones existed, or
 * `deleteSchema`'s degraded fallback). The tree's key extractor reads `entry[0]`.
 */
export type CatalogEntry = [string, PersistedTableSchema | undefined];

/** The catalog tree as the `SchemaManager` opens it (entries are untyped at the tree level). */
export type CatalogTree = Tree<string, any>;

/**
 * Opens the catalog tree. `create` falsy opens an EXISTING catalog and resolves `undefined` when
 * none has ever been committed; `true` brings it into existence — the same contract as the
 * `SchemaManager` constructor's `getSchemaTree`.
 */
export type OpenCatalogTree = (transactor?: ITransactor, create?: boolean) => Promise<CatalogTree | undefined>;

/**
 * Re-merges a pending LIVE record with the latest committed live record for the same name at
 * commit time (`mergePersistedSchemas`), so an index a sibling node added while the batch was
 * open is unioned in rather than overwritten — the same write-time guarantee the unbatched
 * `storeStoredSchema` gives, with its window narrowed to the one end-of-batch commit.
 */
export type MergeLatest = (
	pending: PersistedTableSchema,
	latestCommitted: PersistedTableSchema | undefined,
) => PersistedTableSchema;

/**
 * The pending writes as they stood when the checkpoint was taken. Opaque to callers: take it
 * before a statement's catalog work and hand it back to {@link CatalogBatch.restore} if the
 * statement throws.
 */
export interface CatalogBatchCheckpoint {
	readonly pending: ReadonlyMap<string, CatalogEntry | undefined>;
}

/**
 * The record inside a catalog entry whether live OR gravestone, or undefined for a bare
 * tombstone or an absent entry. The one place the tuple shape is unpacked; `SchemaManager`'s
 * live/gravestone filters build on it.
 */
export function recordOfEntry(entry: unknown): PersistedTableSchema | undefined {
	const tuple = entry as CatalogEntry | undefined;
	return tuple && tuple.length >= 2 && tuple[1] ? tuple[1] : undefined;
}

/**
 * The collection URI a catalog record describes: its first `USING optimystic(...)` argument,
 * defaulted the way `parseTableSchema` defaults it (`tree://default/<name>`) so tables declared
 * without an explicit URI still match. Shared by the batched and unbatched URI lookups so the
 * two cannot drift.
 */
export function recordUriOf(record: PersistedTableSchema): string {
	return (record.vtabArgs?.['0'] as string | undefined) || `tree://default/${record.name}`;
}

/** Catalog changes held for one APPLY SCHEMA. Owned by one `SchemaManager`. */
export class CatalogBatch {
	/**
	 * The committed catalog tree, opened lazily ONCE and refreshed once at open: `undefined`
	 * until first needed, `null` when the catalog was absent at open (a cold database).
	 * Deliberately not refreshed again during the batch — a sibling's write lands stale for
	 * the length of the apply, which matches the cached-read contract of
	 * `SchemaManager.getSchema`; the end-of-batch re-merge is what protects the sibling's
	 * indexes.
	 */
	private tree: CatalogTree | null | undefined;
	/** The transactor the first caller supplied; reused by every later open, including the commit's. */
	private transactor?: ITransactor;
	/**
	 * name → the entry this batch will write. Insertion-ordered; a `has` hit with an
	 * `undefined` value is a pending bare tombstone, distinct from "not pending".
	 */
	private pending = new Map<string, CatalogEntry | undefined>();
	/**
	 * Every committed record (live or gravestone) by name, built by ONE walk of the committed
	 * catalog the first time a URI lookup needs it. Bare tombstones are skipped: they describe
	 * nothing. Unaffected by `pending`, so a checkpoint restore never invalidates it.
	 */
	private committedRecords?: Map<string, PersistedTableSchema>;

	constructor(
		private readonly openTree: OpenCatalogTree,
		private readonly mergeLatest: MergeLatest,
	) {}

	/** Whether a catalog has been committed (opens the tree lazily; no I/O beyond that open). */
	async catalogExists(transactor?: ITransactor): Promise<boolean> {
		return (await this.committedTree(transactor)) !== null;
	}

	/** Whether this batch holds a write for `name` — a live record, a gravestone, or a tombstone. */
	hasPending(name: string): boolean {
		return this.pending.has(name);
	}

	/**
	 * The entry under `name` as this batch sees it: the pending write when there is one,
	 * otherwise the committed catalog's entry (undefined when absent, or when there is no
	 * catalog at all).
	 */
	async readEntry(name: string, transactor?: ITransactor): Promise<CatalogEntry | undefined> {
		if (this.pending.has(name)) {
			return this.pending.get(name);
		}
		const tree = await this.committedTree(transactor);
		if (!tree) {
			return undefined;
		}
		const path = await tree.find(name);
		return tree.isValid(path) ? (tree.at(path) as CatalogEntry | undefined) : undefined;
	}

	/** Stage the entry to write under `name` (replacing any earlier pending write). No I/O. */
	write(name: string, entry: CatalogEntry | undefined): void {
		this.pending.set(name, entry);
	}

	/**
	 * The record — live OR gravestone — describing the storage at `collectionUri`, as this
	 * batch sees it: the committed records with the pending entries overlaid BY NAME (a
	 * pending gravestone replaces the committed live record of the same table; a pending
	 * tombstone removes it), then the same rule as the unbatched `findRecordForUri` — a live
	 * record wins over a gravestone, and the first in catalog order otherwise.
	 *
	 * NOTE: the overlay is re-derived on every call rather than cached and invalidated on
	 * `write`/`restore`. Each DDL statement calls this at most once and the walk is in
	 * memory (the committed side is built once), so the O(catalog) per call is CPU only; if
	 * it ever shows in a profile, cache the derived map and clear it in `write` and `restore`.
	 */
	async recordForUri(collectionUri: string, transactor?: ITransactor): Promise<PersistedTableSchema | undefined> {
		const effective = new Map(await this.committed(transactor));
		for (const [name, entry] of this.pending) {
			const record = recordOfEntry(entry);
			if (record) {
				effective.set(name, record);
			} else {
				effective.delete(name);
			}
		}
		let dropped: PersistedTableSchema | undefined;
		for (const record of effective.values()) {
			if (recordUriOf(record) !== collectionUri) {
				continue;
			}
			if (!record.droppedAt) {
				return record;
			}
			dropped = dropped ?? record;
		}
		return dropped;
	}

	/** Snapshot the pending writes. Cheap: one map entry per table this batch has touched. */
	checkpoint(): CatalogBatchCheckpoint {
		return { pending: new Map(this.pending) };
	}

	/** Drop every write staged since `checkpoint` was taken. */
	restore(checkpoint: CatalogBatchCheckpoint): void {
		this.pending = new Map(checkpoint.pending);
	}

	/**
	 * Flush every pending write in ONE catalog commit and return what was written, by name.
	 *
	 * Does zero I/O when nothing is pending: an apply that touched no optimystic table must
	 * not open — let alone create — the catalog. Otherwise the committed tree is refreshed
	 * once, each pending LIVE record is re-merged with the latest committed live record for
	 * its name ({@link MergeLatest}), gravestones and tombstones are written as-is, and the
	 * whole set is staged and synced together. The catalog is created (`create = true`) only
	 * here, and only because something is pending — the same open-only rule
	 * `SchemaManager.deleteSchema` documents.
	 *
	 * Not reusable after this call, successful or not: the owner discards the batch.
	 */
	async commit(): Promise<Map<string, CatalogEntry | undefined>> {
		const written = new Map<string, CatalogEntry | undefined>();
		if (this.pending.size === 0) {
			return written;
		}
		const tree = await this.writableTree();
		await tree.update();
		for (const [name, entry] of this.pending) {
			const record = recordOfEntry(entry);
			if (record && !record.droppedAt) {
				const path = await tree.find(name);
				const latest = tree.isValid(path) ? recordOfEntry(tree.at(path)) : undefined;
				const latestLive = latest && !latest.droppedAt ? latest : undefined;
				written.set(name, [name, this.mergeLatest(record, latestLive)]);
			} else {
				written.set(name, entry);
			}
		}
		await tree.stage([...written.entries()]);
		await tree.sync();
		return written;
	}

	/** The committed catalog tree, opened and refreshed once; `null` when there is none. */
	private async committedTree(transactor?: ITransactor): Promise<CatalogTree | null> {
		if (this.tree === undefined) {
			this.transactor = this.transactor ?? transactor;
			const tree = await this.openTree(this.transactor, false);
			if (tree) {
				await tree.update();
			}
			this.tree = tree ?? null;
		}
		return this.tree;
	}

	/** The catalog tree for the commit: the one already open, else created now. */
	private async writableTree(): Promise<CatalogTree> {
		const existing = await this.committedTree();
		if (existing) {
			return existing;
		}
		const created = await this.openTree(this.transactor, true);
		if (!created) {
			throw new Error('Schema catalog tree unavailable: create-on-missing resolved to nothing');
		}
		this.tree = created;
		return created;
	}

	/** Every committed record by name — ONE walk, on first use. */
	private async committed(transactor?: ITransactor): Promise<Map<string, PersistedTableSchema>> {
		if (!this.committedRecords) {
			const records = new Map<string, PersistedTableSchema>();
			const tree = await this.committedTree(transactor);
			if (tree) {
				for await (const path of tree.range({ isAscending: true } as any)) {
					if (!tree.isValid(path)) {
						continue;
					}
					const entry = tree.at(path) as CatalogEntry | undefined;
					const record = recordOfEntry(entry);
					if (entry && record) {
						records.set(entry[0], record);
					}
				}
			}
			this.committedRecords = records;
		}
		return this.committedRecords;
	}
}
