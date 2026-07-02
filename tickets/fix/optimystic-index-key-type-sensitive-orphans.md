description: Secondary-index bookkeeping keys are built from raw values whose data type differs between insert and later update/delete, so index entries are orphaned and stale rows resurface in query results.
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
----

## Bug

Index keys are serialized directly from raw incoming values, whose JavaScript
type varies across the row's lifecycle:

- On INSERT, the index key is built from the raw Quereus row where an integer
  arrives as a `bigint` (`5n` → `"5"`).
- The stored row is normalized to a JS `number` (`5`).
- A later UPDATE/DELETE recomputes the *old* index key from the normalized row,
  producing `"5.000000000000000e+0"` — which does not equal the stored `"5"`.

The delete-of-old-key misses, leaving a **stale index entry**; index scans then
resurrect the deleted/old row. The same type mismatch makes index seeks with
differently-typed arguments miss valid rows.

Locations (verify current lines): `index-manager.ts:285-306` +
`row-codec.ts:189-197`. The serializer is also **duplicated byte-for-byte** in
`optimystic-module.ts:662-679`, with comments admitting the two copies must agree
exactly — a second place the mismatch can creep in.

## Relationship to prior work

A completed ticket, `optimystic-index-orphan-on-update-delete`, fixed a
*different* orphan cause (old indexed-column values read at the wrong schema
position, yielding a NULL-marker key). That fix fetches the real old row before
staging. This finding is a **distinct, still-live** root cause: even with the
correct old row, the value's JS type (bigint vs number) makes the recomputed key
differ from the stored key. The earlier fix does not address type canonicalization,
so this is a gap, not a regression of that ticket.

## Expected behavior

Index keys for the same logical value are byte-identical regardless of whether
the value arrived as `bigint` or `number`, on insert, seek, update, and delete.

Suggested direction (from review): canonicalize values (the same
`normalizeValue` / decode transform used for stored rows) **before** serializing
index keys everywhere; export one shared `serializeIndexValue()` and delete the
duplicate copy in `optimystic-module.ts`. Add a bigint round-trip index test
(insert `5n`, update/delete, assert no stale index entry survives).
