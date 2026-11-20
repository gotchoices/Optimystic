/**
 * blob-reference-maintainer — a table's reference tree kept in step with its rows.
 *
 * The counterpart of `IndexManager` (`./index-manager.ts`) for blob references: where that one
 * stages an index entry per indexed column of every row written, this one stages a
 * reference-tree entry per `blobref` column of every row written, into the same transaction
 * (docs/blobs.md §Registering references). The vtab calls it immediately beside the index call
 * it mirrors, so a row and the references it holds commit or roll back together.
 *
 * Pure, and that is load-bearing. What is staged is a function of `(rows, keys, columns)` alone —
 * no read of the tree, no clock, no blob service — so a validating member re-executing the
 * transaction's statements through `QuereusEngine`
 * (`packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts`) derives the same
 * operations (docs/blobs.md §Registering references, *Under transaction validation*). A remove is
 * staged blind, as an index delete is (`IndexManager.deleteIndexEntries` explains why that is
 * sound), and an add is an upsert of a key fixed by the reference and the referrer whose value is
 * fixed by the key. Neither carries a guard: the row the referrer names carries the `unchanged`
 * guard that decides a race, and rolling that transaction back takes its reference entries with it
 * (docs/internals.md §Blob reference trees and the scope registry carry no guards).
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import type { Row, SqlValue } from '@quereus/quereus';
import { BlobRefError, parseBlobRef } from '@optimystic/db-core';
import type { BlobRef, BlobReferenceChange, BlobReferenceTree, BlobScope } from '@optimystic/db-core';
import { isBlobRefColumn } from './blobref-type.js';
import type { BlobRefColumnShape } from './blobref-type.js';
import { encodeKeyElement } from './key-encoding.js';
import type { PrimaryKey } from './index-manager.js';

/** A staged change to the reference tree, as the pin lifecycle consumes it (`SqlBlobPins` in
 *  `../optimystic-adapter/blob-pins.ts`, through the transaction's `BlobReferenceLedger`). */
export interface ReferenceChange {
	readonly op: 'add' | 'remove';
	readonly ref: BlobRef;
	readonly referrer: string;
	readonly scope: BlobScope;
}

/** One `blobref` column of a table: where the engine positions it, and the name it is stored under. */
export interface BlobRefColumn {
	readonly position: number;
	readonly name: string;
}

/**
 * A column as {@link BlobReferenceMaintainer.columnsOf} reads it: either shape the blobref guards
 * take (`isBlobRefColumn`), plus the name the referrer is framed around. Both the engine's
 * `ColumnSchema` and a record's `StoredColumnSchema` satisfy it.
 */
export type NamedBlobRefColumn = BlobRefColumnShape & { readonly name: string };

/**
 * The referrer of one row's one column: the table's framed primary key, then the column name
 * framed as one more element.
 *
 * `primaryKey` is already the self-delimiting framed tuple the main tree is keyed by
 * (`RowCodec.createPrimaryKey` over `encodeKeyTuple`), and each framed element self-delimits, so
 * the concatenation is injective and `splitKeyTuple(referrer)` gives the key's elements followed
 * by the column name. A referrer therefore contains U+0000 framing characters, which is fine:
 * `blobReferenceKey` (`packages/db-core/src/blob/reference-key.ts`) splits at the FIRST one, and a
 * reference, being lowercase base32, contains none.
 *
 * The column NAME rather than its position, because a position moves: a catalog-only DROP COLUMN
 * of another column renumbers the ones after it, which would re-point every committed entry. The
 * name is stable — RENAME COLUMN is refused on every table of this module, and a `blobref` column
 * can be neither dropped nor re-declared away (`columnDropBlockers` in `./catalog-only-change.ts`,
 * `SchemaManager.mergeForWrite` in `./schema-manager.ts`).
 */
export function blobReferrer(primaryKey: PrimaryKey, column: string): string {
	return primaryKey + encodeKeyElement(column);
}

/**
 * One table's `blobref` columns and its reference tree, staging the tree's entries for every row
 * the table writes.
 *
 * `onStaged`, when given, is called with exactly what was staged, in the order it was staged, and
 * is not called when nothing was staged. It is here because the maintainer is the one place that
 * knows both. `OptimysticVirtualTable.buildBlobReferences` sets it, to record each change on the
 * transaction so the COMMIT knows which references to pin and announce (docs/blobs.md §Committing
 * a reference) — and it is the vtab rather than this class that asks whether the statements are a
 * validating member's replay, since only the vtab holds the `Database` they run on.
 */
export class BlobReferenceMaintainer {
	/**
	 * @param table The qualified table name, for the one refusal below.
	 * @param columns The table's `blobref` columns, in declaration order ({@link columnsOf}).
	 * @param tree The table's reference tree, opened through the collection factory.
	 * @param scope The tree's collection id — what the scope registry lists and what a later
	 *   announcement names.
	 */
	constructor(
		private readonly table: string,
		private readonly columns: readonly BlobRefColumn[],
		private readonly referenceTree: BlobReferenceTree,
		readonly scope: BlobScope,
		private readonly onStaged?: (changes: readonly ReferenceChange[]) => void,
	) {}

	/** The `blobref` columns of `columns`, in declaration order. Takes either column shape. */
	static columnsOf(columns: readonly NamedBlobRefColumn[]): BlobRefColumn[] {
		return columns.flatMap((column, position) => isBlobRefColumn(column) ? [{ position, name: column.name }] : []);
	}

	/** The underlying db-core tree, for the vtab to mark dirty and register. */
	get tree(): BlobReferenceTree {
		return this.referenceTree;
	}

	/** This maintainer over a new column list, everything else kept
	 *  (`OptimysticVirtualTable.republishColumnLayout`). */
	withColumns(columns: readonly BlobRefColumn[]): BlobReferenceMaintainer {
		return new BlobReferenceMaintainer(this.table, columns, this.referenceTree, this.scope, this.onStaged);
	}

	/** Every reference the new row holds becomes an entry under its key. */
	async stageInsert(row: Row, primaryKey: PrimaryKey): Promise<void> {
		await this.apply(this.columns.flatMap(column => this.add(row, primaryKey, column)));
	}

	/** Every reference the removed row held leaves. */
	async stageDelete(row: Row, primaryKey: PrimaryKey): Promise<void> {
		await this.apply(this.columns.flatMap(column => this.remove(row, primaryKey, column)));
	}

	/**
	 * At the SAME key, per column: a changed value removes the old reference and adds the new one,
	 * and an unchanged one (both NULL included) stages nothing. At a CHANGED key the row's entries
	 * move wholesale — every old reference leaves the old key and every new one lands under the new
	 * key — whether or not the value changed.
	 *
	 * Removes are staged before adds, in one tree action, so a remove and an add of one key within
	 * a call cannot invert: when a displaced row and the row replacing it hold the same reference in
	 * the same column they stage the identical key, and remove-then-add leaves it present.
	 */
	async stageUpdate(oldRow: Row, newRow: Row, oldPrimaryKey: PrimaryKey, newPrimaryKey: PrimaryKey): Promise<void> {
		const moved = oldPrimaryKey !== newPrimaryKey;
		const changed = this.columns.filter(column => moved || cellOf(oldRow, column) !== cellOf(newRow, column));
		await this.apply([
			...changed.flatMap(column => this.remove(oldRow, oldPrimaryKey, column)),
			...changed.flatMap(column => this.add(newRow, newPrimaryKey, column)),
		]);
	}

	/** Stage `changes` as one action, then report exactly what was staged. An empty list does nothing. */
	private async apply(changes: readonly ReferenceChange[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		await this.referenceTree.stage(changes.map(treeChange));
		this.onStaged?.(changes);
	}

	private add(row: Row, primaryKey: PrimaryKey, column: BlobRefColumn): ReferenceChange[] {
		return this.changeFor('add', row, primaryKey, column);
	}

	private remove(row: Row, primaryKey: PrimaryKey, column: BlobRefColumn): ReferenceChange[] {
		return this.changeFor('remove', row, primaryKey, column);
	}

	/** The one change `column` of `row` implies, or none when the cell is NULL. */
	private changeFor(op: 'add' | 'remove', row: Row, primaryKey: PrimaryKey, column: BlobRefColumn): ReferenceChange[] {
		const cell = cellOf(row, column);
		if (cell === null) {
			return [];
		}
		return [{ op, ref: this.referenceOf(cell, column), referrer: blobReferrer(primaryKey, column.name), scope: this.scope }];
	}

	/**
	 * The cell as a reference. The engine validates every written value through the type
	 * (`BLOBREF_TYPE` in `./blobref-type.ts`), so this is unreachable through SQL; it is what keeps a
	 * malformed value out of the tree whatever path delivered the row.
	 */
	private referenceOf(cell: SqlValue, column: BlobRefColumn): BlobRef {
		try {
			// Typed `string`, but a value of any other type reaches the same refusal rather than a
			// TypeError: the parse rule judges its input's type first (`judgeCanonical` in
			// `packages/db-core/src/blob/blob-ref.ts`).
			return parseBlobRef(cell as string);
		} catch (error) {
			if (!(error instanceof BlobRefError)) throw error;
			throw new QuereusError(
				`Column '${column.name}' of table '${this.table}' holds a value that is not a blob reference, `
				+ `so the row's blob reference cannot be registered: ${error.message}`,
				StatusCode.MISMATCH,
				error,
			);
		}
	}
}

/** One row's value for `column`, with absent and SQL NULL alike reading as NULL. */
function cellOf(row: Row, column: BlobRefColumn): SqlValue | null {
	return row[column.position] ?? null;
}

/** A {@link ReferenceChange} as db-core's reference tree takes it; the scope is the tree's own. */
function treeChange(change: ReferenceChange): BlobReferenceChange {
	return { kind: change.op, ref: change.ref, referrer: change.referrer };
}
