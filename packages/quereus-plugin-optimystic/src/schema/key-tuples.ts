/**
 * key-tuples — nominal (branded) types that keep the two differently-addressed value
 * lists apart at compile time.
 *
 * Three shapes reach the key-building machinery, and they are NOT interchangeable:
 *
 *   - a FULL ROW (`Row` = `SqlValue[]` from quereus) — one cell per table column,
 *     addressed by COLUMN POSITION: `row[pkDef[i].index]`, `row[indexCol.index]`.
 *   - a PRIMARY KEY TUPLE — one cell per `primaryKeyDefinition` entry, in key order,
 *     addressed POSITIONALLY: `tuple[i]`. This is what `UpdateArgs.oldKeyValues`
 *     carries and what a primary-key point lookup's seek args are.
 *   - an INDEX COLUMN TUPLE — one cell per index column, in index order (possibly a
 *     leading prefix), also addressed positionally.
 *
 * Before these types existed all three were plain `SqlValue[]`, so handing one method
 * the other's input compiled, ran, and produced a WRONG-but-valid tree key — silent
 * corruption discoverable only from downstream symptoms (a composite-PK point lookup
 * returning nothing; a same-key UPDATE reported as colliding with itself; a DELETE
 * removing nothing). Two shipped bugs came from exactly that substitution.
 *
 * Why this works, in two halves:
 *
 *   1. The tuples are `readonly`. `Row` is quereus's own MUTABLE `SqlValue[]`, and a
 *      `readonly` array is not assignable to a mutable one — so a tuple can never
 *      reach a `Row` parameter (e.g. `extractPrimaryKey`). `Row` itself is deliberately
 *      NOT branded: it crosses the vtab boundary in both directions and branding it
 *      would demand a cast at every engine call site for no extra safety.
 *   2. The tuples carry a phantom brand property. That blocks the other direction (a
 *      full row, or a bare array literal, reaching a tuple parameter) and keeps the two
 *      tuple kinds distinct from each other.
 *
 * The brand exists only in the type system — there is no runtime property, and every
 * ordinary array operation (`.length`, indexing, `.map`, iteration) still works.
 *
 * A value of either tuple type can only be obtained from its CHECKED CONSTRUCTOR, which
 * is where the arity is validated:
 *
 *   PrimaryKeyTuple  <- RowCodec.asPrimaryKeyTuple
 *   IndexColumnTuple <- IndexManager.asIndexColumnTuple
 *
 * Those constructors are the single audited site for each shape. The arity checks alone
 * are not sufficient — they are blind when the two shapes happen to be the same length
 * (e.g. `create table R (a text, b text, primary key (b, a))`, where a full row and a
 * key tuple are both length 2 but ordered differently) — which is precisely why the
 * compile-time guard is needed on top of them. The constructors also refuse an input
 * that is ALREADY branded (see {@link UnbrandedValues}), so neither tuple kind can be
 * laundered into the other by passing it back through the audit point.
 */

import type { SqlValue } from '@quereus/quereus';

/**
 * One cell per `primaryKeyDefinition` entry, in key order.
 *
 * NOT a row: addressed positionally (`tuple[i]` for PK column `i`), never by column
 * position (`row[pkDef[i].index]`). Construct only via {@link RowCodec.asPrimaryKeyTuple},
 * which checks the arity. An empty tuple is legal — a singleton table has an empty
 * primary key definition.
 */
export type PrimaryKeyTuple = readonly SqlValue[] & { readonly __tupleBrand: 'PrimaryKeyTuple' };

/**
 * One cell per index column, in index order; may be a leading PREFIX of the index's
 * columns (a partial seek key, which brackets a range rather than a point).
 *
 * NOT a row: addressed positionally, never by column position. Construct only via
 * {@link IndexManager.asIndexColumnTuple}, which checks the arity. Unlike a primary-key
 * tuple, an EMPTY index tuple is rejected there — a zero-column prefix would range over
 * the entire index, which is a decision a caller must make explicitly rather than
 * stumble into.
 */
export type IndexColumnTuple = readonly SqlValue[] & { readonly __tupleBrand: 'IndexColumnTuple' };

/**
 * The input type both checked constructors accept: a positional value list that is NOT
 * already branded as a tuple of either kind.
 *
 * Without this, a constructor taking a plain `readonly SqlValue[]` would happily accept
 * the OTHER tuple kind, laundering an index-ordered tuple into a primary-key one (or
 * vice versa) through the very site that is supposed to be the audit point. The arity
 * check catches that in most schemas but not when the two happen to be the same width.
 *
 * `__tupleBrand?: never` reads as "must not carry a brand": a `Row`, a bare array
 * literal, and an unbranded `readonly SqlValue[]` all satisfy it (the property is
 * optional and absent), while either branded tuple fails on the property's type.
 */
export type UnbrandedValues = readonly SqlValue[] & { readonly __tupleBrand?: never };
