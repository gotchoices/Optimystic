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

import type { SqlValue } from '@quereus/quereus';
import { encodeKeyTuple, splitKeyTuple } from './key-encoding.js';

/**
 * The `using optimystic(…)` arguments that say how THIS PROCESS reaches storage, not what the
 * table is: the transactor and key network it goes through, the network's name and port, and
 * whether to cache. They are never written to the catalog record. Two reasons: the record must
 * be the same bytes on every machine that runs one declaration (a host compares catalogs across
 * machines), and a table hydrated by a later session must open storage the way THAT session
 * does — the writer's transactor and network name are how the previous era reached it. Hydrate
 * fills them the way a fresh `create table` would: from the session's `default_vtab_args` when
 * this module is the session's default module, then from the plugin's registration config
 * (`resolveBinding` in `optimystic-module.ts` reads exactly these names).
 *
 * Everything else in the clause is identity and stays in the record — above all the collection
 * URI (`'0'`), and the row `encoding`, which describes the bytes already in storage.
 */
export const SESSION_BINDING_VTAB_ARGS: ReadonlySet<string> = new Set(['transactor', 'keyNetwork', 'port', 'networkName', 'cache']);

/**
 * `args` without its session-binding entries ({@link SESSION_BINDING_VTAB_ARGS}) — the part of
 * a table's `using` clause that is the table's identity. Undefined when nothing is left, so a
 * record whose declaration named nothing identity-bearing carries no `vtabArgs` key at all.
 */
export function identityVtabArgs(args: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> | undefined {
	const identity = pickVtabArgs(args, key => !SESSION_BINDING_VTAB_ARGS.has(key));
	return Object.keys(identity).length > 0 ? identity : undefined;
}

/**
 * ONLY the session-binding entries of `args` — what a hydrated table may take from the current
 * session's `default_vtab_args`. Anything else there (a default `encoding`, say) describes tables
 * that session CREATES, not the bytes a hydrated table already has in storage; the record alone
 * says those, and an overlaid `encoding` would be written back into the record on first open.
 */
export function sessionBindingVtabArgs(args: Readonly<Record<string, SqlValue>> | undefined): Record<string, SqlValue> {
	return pickVtabArgs(args, key => SESSION_BINDING_VTAB_ARGS.has(key));
}

function pickVtabArgs(args: Readonly<Record<string, SqlValue>> | undefined, keep: (key: string) => boolean): Record<string, SqlValue> {
	const picked: Record<string, SqlValue> = {};
	for (const [key, value] of Object.entries(args ?? {})) {
		if (keep(key)) picked[key] = value;
	}
	return picked;
}

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
