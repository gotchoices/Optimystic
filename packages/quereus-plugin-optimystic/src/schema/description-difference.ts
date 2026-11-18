/**
 * Whether a table instance's description and the table's catalog record agree on everything a write
 * must honour — the comparison behind the commit-time refusal of a write made under a description
 * another machine replaced (`TransactionBridge.commitTransaction`, docs/internals.md §A first touch
 * writes only what the table owes).
 *
 * Compared: the columns (names in order, type, nullability, default, collation, generation, conflict
 * action), the primary key, the indexes (name, columns, unique, predicate), the UNIQUE constraints,
 * the CHECKs and the foreign keys. Not compared: tags (a tag change never refuses a write; the
 * module's `table_modified` listener saves them), the type's spelling and whether a collation was
 * written out (the stored type and collation are what a row is written under), `with context`
 * variables, `orphanedIndexes`, the vtab module and its arguments, and anything about a gravestone.
 *
 * Both sides are compared in the record's name-keyed form with names folded to lower case, as
 * Quereus compares names, and with every list that carries no order — indexes and constraints — as
 * a set, so a record written out of canonical order, or a list built in another order, compares
 * equal to the same description. A description built from a record therefore always compares equal
 * to that record, which is what keeps a machine that has just followed the record from being
 * refused again.
 */

import { canonicalJson } from '@optimystic/db-core';
import { toPersistedSchema } from './schema-manager.js';
import type { PersistedIndexSchema, PersistedTableSchema, StoredTableSchema } from './schema-manager.js';

/**
 * The first part of `instance` that differs from `record`, named for an error message (`index
 * 't_a'`, `the columns`), or undefined when they agree on everything a write must honour.
 */
export function descriptionDifference(instance: StoredTableSchema, record: StoredTableSchema): string | undefined {
	const mine = toPersistedSchema(instance);
	const theirs = toPersistedSchema(record);
	return columnsDifference(mine, theirs)
		?? (sameValue(primaryKeyOf(mine), primaryKeyOf(theirs)) ? undefined : 'the primary key')
		?? namedDifference('index', indexesOf(mine), indexesOf(theirs))
		?? namedDifference('CHECK', checksOf(mine), checksOf(theirs))
		?? (sameSet(uniqueConstraintsOf(mine), uniqueConstraintsOf(theirs)) ? undefined : 'the UNIQUE constraints')
		?? (sameSet(foreignKeysOf(mine), foreignKeysOf(theirs)) ? undefined : 'the foreign keys');
}

/** A part of a description reduced to what is compared, keyed by its lower-cased name. */
type Comparable = Record<string, unknown> & { readonly name?: string };

function columnsDifference(mine: PersistedTableSchema, theirs: PersistedTableSchema): string | undefined {
	const names = (record: PersistedTableSchema) => record.columns.map(col => col.name.toLowerCase());
	if (!sameValue(names(mine), names(theirs))) {
		return `the columns (${names(mine).join(', ')} here, ${names(theirs).join(', ')} in the record)`;
	}
	const differing = mine.columns.findIndex((col, i) => !sameValue(columnOf(col), columnOf(theirs.columns[i]!)));
	return differing < 0 ? undefined : `column '${mine.columns[differing]!.name}'`;
}

function columnOf({ tags: _tags, declaredType: _spelling, collationExplicit: _explicit, name, ...rest }: PersistedTableSchema['columns'][number]): Comparable {
	return { ...rest, name: name.toLowerCase() };
}

function primaryKeyOf(record: PersistedTableSchema): unknown {
	return { definition: record.primaryKeyDefinition, conflict: record.primaryKeyDefaultConflict };
}

function indexesOf(record: PersistedTableSchema): Comparable[] {
	// `toPersistedSchema` carries each index's tags over, though `PersistedIndexSchema` does not name them.
	return record.indexes.map(index => {
		const { tags: _tags, name, columns, ...rest } = index as PersistedIndexSchema & { readonly tags?: unknown };
		return { ...rest, name: name.toLowerCase(), columns: columns.map(col => ({ ...col, name: col.name.toLowerCase() })) };
	});
}

function checksOf(record: PersistedTableSchema): Comparable[] {
	return (record.checkConstraints ?? []).map(untaggedLowerName);
}

function uniqueConstraintsOf(record: PersistedTableSchema): Comparable[] {
	return (record.uniqueConstraints ?? []).map(untaggedLowerName);
}

function foreignKeysOf(record: PersistedTableSchema): Comparable[] {
	return (record.foreignKeys ?? []).map(untaggedLowerName);
}

function untaggedLowerName<T extends { readonly name?: string; readonly tags?: unknown }>({ tags: _tags, name, ...rest }: T): Comparable {
	return { ...rest, name: name?.toLowerCase() };
}

/**
 * The first named object of `mine` or `theirs` that the other lacks or holds differently, as
 * `<kind> '<name>'`; for unnamed objects (an unnamed CHECK), `the <kind>s`.
 */
function namedDifference(kind: string, mine: readonly Comparable[], theirs: readonly Comparable[]): string | undefined {
	if (sameSet(mine, theirs)) {
		return undefined;
	}
	const onlyIn = (items: readonly Comparable[], other: readonly Comparable[]) => {
		const encoded = new Set(other.map(canonicalJson));
		return items.filter(item => !encoded.has(canonicalJson(item)));
	};
	const named = [...onlyIn(mine, theirs), ...onlyIn(theirs, mine)].find(item => item.name !== undefined);
	return named === undefined ? `the ${kind}s` : `${kind} '${named.name}'`;
}

function sameValue(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/** Whether two lists hold the same items, whatever their order. */
function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
	const encode = (items: readonly unknown[]) => items.map(canonicalJson).sort();
	return sameValue(encode(a), encode(b));
}
