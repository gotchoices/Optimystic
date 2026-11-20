/**
 * The `blobref` column type: text whose value must be a well-formed blob reference —
 * the short content identifier that names a large stored file (docs/blobs.md §SQL).
 *
 * `isBlobRef` in `packages/db-core/src/blob/blob-ref.ts` is the one rule for what is and is
 * not a reference, so the type adds no grammar of its own. It also holds the refusal that
 * keeps such a column from being written to, or opened from, a catalog record in a process that
 * has not registered the type ({@link assertBlobRefTypeRegistered}) — the type's name contains
 * "BLOB", so with `pragma strict_type_names = false` Quereus's SQLite affinity rules would
 * otherwise make the column a BLOB column, whose row codec base64-DECODES every stored string.
 */

import { BINARY_COLLATION, PhysicalType, QuereusError, StatusCode } from '@quereus/quereus';
import type { LogicalType, SqlValue } from '@quereus/quereus';
import { isBlobRef } from '@optimystic/db-core';

/** The name the type is registered under, and the `affinity` a catalog record stores for its columns. */
export const BLOBREF_TYPE_NAME = 'BLOBREF';

/**
 * How a missing logical type is made to reach this process — the remedy every refusal in this
 * module and in `packages/quereus-plugin-optimystic/src/schema/schema-manager.ts` names.
 *
 * Type-neutral on purpose: the hydrate refusals it is quoted in fire for ANY type a record names
 * and this process cannot resolve, the host's own custom types included, so it must not send a
 * reader after the Optimystic plugin for a type the plugin never owned.
 */
export const REGISTER_TYPES_REMEDY =
	'register the type with db.registerType before opening the table — the plugin\'s own types '
	+ '(`blobref`) come with registerPlugin, or register `plugin.types` by hand when assembling '
	+ 'its parts';

/**
 * A reference has exactly ONE accepted spelling, so there is nothing for a `parse` to
 * canonicalize: anything `isBlobRef` refuses fails Quereus's `validateValue` at
 * `StatusCode.MISMATCH`, and a `parse` would only move the same refusal to a "Type conversion
 * failed" message.
 *
 * `supportedCollations: []` — the empty list, as JSON and the temporal types carry, not
 * `['BINARY']`: {@link LogicalType.compare} below is collation-blind (it never applies the
 * function it is handed), so a declared non-BINARY collation would be silently ignored. The
 * empty list makes `validateCollationForType` (`@quereus/quereus/src/schema/table.ts`) refuse
 * `collate nocase` on such a column outright, and makes `resolveDefaultCollation` fall it back
 * to BINARY under a non-BINARY session `default_collation`.
 *
 * `collationAware` and `semanticOrdering` are both left unset. Unset `collationAware` keys a
 * `blobref` primary key under BINARY (`pkKeyCollationName` in
 * `@quereus/quereus/src/planner/analysis/comparison-collation.ts`), which is the order
 * `compare` actually imposes, so key bytes and comparator agree. Unset `semanticOrdering`
 * leaves the column comparing as the text it is stored as, which is what lets
 * `bytesOrderAsValues` in `packages/quereus-plugin-optimystic/src/schema/index-walk.ts` admit an
 * index on it as an ordinary text index.
 */
export const BLOBREF_TYPE: LogicalType = {
	name: BLOBREF_TYPE_NAME,
	physicalType: PhysicalType.TEXT,
	isTextual: true,
	supportedCollations: [],
	validate: (v: SqlValue) => v === null || isBlobRef(v),
	compare: (a, b) => {
		// Quereus's own `compareNulls` preamble, inlined: it is not exported from the package
		// entry, and this is the whole of it.
		if (a === null) return b === null ? 0 : -1;
		if (b === null) return 1;
		return BINARY_COLLATION(a as string, b as string);
	},
};

/**
 * A column as the blobref guards read it: either shape it comes in — the engine's
 * (`logicalType`) or a catalog record's (`affinity`) — carries one of the two names.
 */
export interface BlobRefColumnShape {
	readonly logicalType?: { readonly name: string };
	readonly affinity?: string;
}

/** Whether a column, in either shape, is a blobref column. */
export function isBlobRefColumn(column: BlobRefColumnShape): boolean {
	return column.logicalType?.name === BLOBREF_TYPE_NAME || column.affinity === BLOBREF_TYPE_NAME;
}

/** The fields {@link assertBlobRefTypeRegistered} needs of a stored column record. */
export interface StoredColumnTypeNames {
	readonly name: string;
	readonly affinity: string;
	readonly declaredType?: string;
}

/**
 * Refuse a column declared `blobref` whose rows are NOT stored under the type — the shape a
 * process that never registered the type produces: with `strict_type_names` off, `inferType`
 * falls `blobref` through to the affinity rules, the name contains "BLOB", and the column is
 * built as a BLOB column whose record then says `affinity: 'BLOB'` consistently, so nothing
 * downstream ever notices. Decided in the ticket that added the type: refused loudly, never
 * opened as something else.
 *
 * The declared spelling is compared on its base name (the text before any `(…)` parameter
 * list, the rule `declaredTypeBase` in `@quereus/quereus/src/types/registry.ts` applies) and
 * case-insensitively, as SQL spells a declaration in any case.
 *
 * A record carrying `affinity: 'BLOBREF'` is none of this guard's business, whether or not it
 * also carries a declared spelling: a process that cannot resolve `BLOBREF` is refused by the
 * hydrate guard in `schema-manager.ts` instead, which covers every stored record rather than
 * only this type's.
 *
 * @param columns The table's stored columns
 * @param subject What they belong to, for the message — e.g. `table 'main.Attachment'`
 */
export function assertBlobRefTypeRegistered(
	columns: readonly StoredColumnTypeNames[],
	subject: string,
): void {
	for (const column of columns) {
		if (!declaresBlobRef(column.declaredType) || isBlobRefColumn(column)) continue;
		throw new QuereusError(
			`Column '${column.name}' of ${subject} is declared '${column.declaredType}', but the `
			+ `${BLOBREF_TYPE_NAME} type is not registered in this process, so the column resolved to `
			+ `'${column.affinity}' instead — its rows would be read as '${column.affinity}' values. To fix: `
			+ REGISTER_TYPES_REMEDY,
			StatusCode.ERROR,
		);
	}
}

/**
 * Whether a declared type spelling names this type, by its base name, in any case.
 *
 * NOTE: this reimplements `declaredTypeBase` in `@quereus/quereus/src/types/registry.ts`, which is
 * not exported. The two agree today (the text before the first `(`, trimmed); if Quereus ever
 * changes how it splits a declared name from its parameter list, this guard stops matching what
 * the engine resolved and must follow.
 */
function declaresBlobRef(declaredType: string | undefined): boolean {
	if (declaredType === undefined) return false;
	const paren = declaredType.indexOf('(');
	const base = paren < 0 ? declaredType : declaredType.slice(0, paren);
	return base.trim().toUpperCase() === BLOBREF_TYPE_NAME;
}
