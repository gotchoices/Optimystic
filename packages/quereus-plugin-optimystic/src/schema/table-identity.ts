/**
 * table-identity — the two persistent names a table has: WHERE its rows live (the default
 * collection URI) and WHAT the schema catalog files its record under (the catalog key).
 *
 * Both are derived from the table's engine schema AND its name. A table's name alone is not
 * an identity: one database can hold `strand.Member` and `app.Member`, and when either name
 * left the schema out the two tables opened one collection and shared one catalog record —
 * rows mixed, one table's inserts read back through the other, and a warm restart could not
 * tell the two definitions apart. Every site that derives either name goes through this file
 * so the rule cannot drift between copies again.
 *
 * Names are used exactly as Quereus's `TableSchema` carries them: `schemaName` is canonical
 * (lowercase — see Quereus `SchemaManager.canonicalSchemaName`) and the table name keeps its
 * declared casing.
 *
 * NOTE: because the table name keeps its casing, `Member` and `member` in one schema name two
 * locations and two records even though SQL resolves them to one table (the same was true of the
 * earlier bare-name rule). Harmless while every declaration of a table spells it the same way;
 * if hosts ever declare one table with varying case (say, across devices), fold the table name here.
 */

import { encodeKeyTuple, splitKeyTuple } from './key-encoding.js';

/** A table addressed by its engine schema and its name. */
export interface QualifiedTableName {
	schemaName: string;
	tableName: string;
}

/**
 * The collection URI of a table declared without an explicit `using optimystic('<uri>')`:
 * `tree://default/<schema>/<table>`. `main` is qualified like any other schema. The table's
 * secondary indexes live under it unchanged (`<uri>/index/<name>`), and the segment counts keep
 * the two apart: a table is `default/<schema>/<table>`, its index `default/<schema>/<table>/index/<name>`.
 *
 * NOTE: the segments are not escaped, so a schema or table name containing `/` can spell
 * another table's (or index's) location — `a/b`.`c` and `a`.`b/c` both default to
 * `tree://default/a/b/c`. No SQL identifier in use contains `/`; if one ever must, escape the
 * segments here (and only here) rather than at a call site. The catalog key below is framed and
 * has no such hole, so the storage-adoption guard still sees each table's own record.
 */
export function defaultCollectionUri(schemaName: string, tableName: string): string {
	return `tree://default/${schemaName}/${tableName}`;
}

/**
 * The key a table's record (live or gravestone) is filed under in the schema catalog. Framed with
 * the injective tuple encoding the data trees use ({@link encodeKeyTuple}), so no pair of
 * identifiers can spell another pair's key — a plain `schema.table` join would let `a.b`.`c`
 * and `a`.`b.c` share one record.
 */
export function catalogKey(schemaName: string, tableName: string): string {
	return encodeKeyTuple([schemaName, tableName]);
}

/**
 * The (schema, table) a catalog key names, or undefined when the key is not a two-element
 * framed tuple — which is what a record filed by a build that keyed the catalog by bare table
 * name looks like. Such a record is not readable under any (schema, table) this build asks for.
 */
export function namesOfCatalogKey(key: string): QualifiedTableName | undefined {
	const elements = splitKeyTuple(key);
	if (elements.length !== 2 || elements.some(element => element.isNull)) {
		return undefined;
	}
	if (catalogKey(elements[0]!.payload, elements[1]!.payload) !== key) {
		return undefined;
	}
	return { schemaName: elements[0]!.payload, tableName: elements[1]!.payload };
}
