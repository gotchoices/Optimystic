description: Two different kinds of value list — a whole table row, and a short list holding just the key columns — are both plain arrays, so passing one where the other is expected compiles cleanly and silently computes the wrong storage key. Two separate bugs have been caused by exactly this mix-up; a type that tells them apart would make it impossible.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
severity: corruption
likelihood: unusual
tradeoffs: A branded type ripples through every producer and consumer of these arrays and buys nothing at runtime — a maintainer may reasonably decide that two length assertions plus the existing comments already carry the contract, and that the churn is not worth it.
----

## The confusion

Optimystic turns column values into the byte string it uses as a tree key. There are two different
inputs that can arrive, and they need different handling:

- a **full row** — one cell per table column, addressed by column position, and
- a **key tuple** — one cell per primary-key column, in key order, nothing else.

`RowCodec` has one method for each:

```ts
extractPrimaryKey(row: Row): PrimaryKeyValue        // reads row[pkDef[i].index]
createPrimaryKey(values: SqlValue[]): PrimaryKeyValue  // reads values[i]
```

Both parameters are plain arrays of SQL values. Nothing in the type system distinguishes them, so
handing either method the other's input compiles, runs, and returns a key — a *wrong* key. The two
agree only when the primary-key columns happen to be the table's leading columns in key order, which
is the common case and therefore hides the mistake in most tests.

## Why file it

Two shipped bugs have already been caused by this exact confusion:

- **Point lookups on a composite key returned nothing.** The seek path built a key from only the
  first seek argument. Fixed by routing all args through `createPrimaryKey` — see
  `test/composite-pk-point-lookup.spec.ts`.
- **An UPDATE that changed no key column was rejected as a duplicate of itself, a DELETE silently
  removed nothing, and a key-moving UPDATE left the original row behind.** The DML path ran the
  engine's compact key tuple through `extractPrimaryKey` (full-row addressing). Fixed; see
  `test/oldkeyvalues-compact-shape.spec.ts` and the `NOTE`-bearing comments at the two sites in
  `optimystic-module.ts`.

Both were found only from downstream symptoms — a rejected statement in a consuming repo, a query
returning no rows — because the wrong key is a perfectly valid key. Neither was caught by a type
error or an assertion.

The proposed guard: give the key tuple a nominal (branded) type so the two cannot substitute for
each other, e.g.

```ts
/** One cell per primaryKeyDefinition entry, in key order. Not a row. */
export type KeyTuple = readonly SqlValue[] & { readonly __keyTuple: unique symbol };
```

with a single checked constructor that validates arity, and `extractPrimaryKey` narrowed so it can
only accept a full row. Producers are the handful of places that build key lists — the engine's
`UpdateArgs.oldKeyValues` at the vtab boundary, seek args in the filter path, and index-manager
callers.

Scope to settle while doing it: whether `Row` itself should also become nominal (it is quereus's own
exported type, so probably not), and whether the index-key builders in `index-manager.ts` carry the
same ambiguity between an index-column tuple and a row.

A cheaper floor already covered elsewhere: `createPrimaryKey` validates its input length, and an
implement ticket (`oldkeyvalues-compact-tuple-hardening`) adds the mirror check to
`extractPrimaryKey`. Those two assertions turn a silent wrong key into a loud error at the first
mis-call, which may be enough — that is the argument for declining this ticket.
