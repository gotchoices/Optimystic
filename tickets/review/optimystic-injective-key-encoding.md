description: Multi-column primary-key and index-key encoding was not injective — text values containing certain control bytes could collide, mis-sort, or hide rows. This replaces the raw-delimiter join with an order-preserving, injective framing that survives any string. Ready for an adversarial review pass.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-encoding.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/key-encoding.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/test/index-serialize-value.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
difficulty: medium
----

## What was built

A shared framing module, `src/schema/key-encoding.ts`, that encodes a tuple of column
payloads into a single string that is **injective** (distinct tuples never collide) and
**order-preserving** under plain lexicographic (raw UTF-16 code-unit) comparison — so it
drops in under the *current* tree comparator (`collection-factory.ts` `compare`) with no
dependency on sq-2's structural comparator.

Per-element scheme (FoundationDB-tuple style, UTF-16 code units):

```
NULL element      -> "\x00"                              (bare tag; sorts first)
present element   -> "\x02" + escape(payload) + "\x00"   (tag, escaped payload, terminator)
  where escape replaces every "\x00" -> "\x00\xff".
```

A tuple is the concatenation of framed elements (no separator — each self-delimits).

Both encoders were routed through it, keeping their **per-value payload logic unchanged**
(so number range-ordering via `toExponential(15)` and PK `toString`/base64 forms are
preserved — the framing only wraps them):

- **Primary keys** (`row-codec.ts`): `serializeKeyPart` now returns `string | null`
  (null signals SQL NULL instead of the old in-band `'\x01NULL\x01'` sentinel);
  `extractPrimaryKey`/`createPrimaryKey` call `encodeKeyTuple`. **Single-column keys are
  framed too** (the old raw short-circuit is gone).
- **Secondary indexes** (`index-manager.ts`): `serializeIndexValue` now returns
  `string | null` (null instead of the old `'\x01'` marker); `createIndexKey` calls
  `encodeKeyTuple`. Composite tree key is `indexKey + primaryKey` (both framed → plain
  concatenation, no `\x00` separator).
- **Module seek/unique builders** (`optimystic-module.ts`): `executeIndexScan`'s seek key
  and `uniqueKeyFor` route through `encodeKeyTuple`.
- Framing primitives are exported from the package index for tests/consumers.

## The three original collision classes — how each is now closed

1. **Separator collision** — a payload `\x00` is escaped to `\x00\xff`, so a bare `\x00`
   only ever means "element boundary". `('foo\x00bar','baz')` and `('foo','bar')` now
   frame to distinct keys. (Regression test flipped from "known bug".)
2. **NULL-marker collision** — NULL is a bare tag distinct from every present value,
   including a literal equal to the old sentinel and the empty string. (Regression test
   flipped.)
3. **Index prefix-range corruption** — the point-lookup / range brackets were rebuilt on
   the framed layout (see the important correction below).

## IMPORTANT — deviation from the ticket's suggested prefix-range bracket (review this)

The ticket proposed the prefix successor "replace the final `\x00` with `\x01`". **That is
wrong for this framing** and I did **not** use it. It re-introduces exactly the collision
class we are fixing: for a lookup on value `'b'`, the framed prefix `P = '\x02b\x00'` ends
in `\x00`; a *different* value `'b\x00'` frames to `'\x02b\x00\xff\x00…'`, which has `P` as
a prefix. `[P, P-with-final-\x00→\x01)` would wrongly admit the `'b\x00'` entries.

Correct successor (used here): append `KEY_PREFIX_END = '\x03'`, i.e. range `[P, P+'\x03')`.
Reasoning: every legitimate child key is `P` followed by a further framed element whose
first unit is a tag (`\x00` or `\x02`, both `< \x03`); the only way a *different* value's
frame can have `P` as a prefix is value `= P-value + '\x00' + …`, whose escape puts `\xff`
(`> \x03`) immediately after `P`. So `\x03` includes all real children and excludes the
leak-ins. This is proven at the unit level in `key-encoding.spec.ts` ("framed prefix-range
isolation") and exercised end-to-end in `index-support.spec.ts` ("isolates an index value
from another that has it as a prefix"). **Please sanity-check this argument** — it is the
subtlest part of the change and the brackets are applied in `findByIndexIn` and
`scanIndexRange`.

## Known gaps / risks — treat the tests as a floor

- **On-disk/tree key FORMAT CHANGE — no migration.** This changes the bytes of every
  primary-key and index tree key. Any collection persisted by an *earlier* build (network
  or `local`/`FileRawStorage`) would have old-format keys: point lookups build new-format
  keys that won't match, and ordering/index scans would be inconsistent. The package is
  v0.14.1 (pre-1.0) and the ticket scoped no migration, so I did not add one. If any
  persisted optimystic data must survive an upgrade, a migration/reindex is a **separate
  ticket** the human should decide on. Flagging, not resolving.
- **Embedded-`\x00` coverage is unit-level, not SQL-integration-level.** I could not inject
  a raw NUL byte into a stored value through `Database.exec` SQL text (bound parameters go
  through the engine/statement API, not `db.eval`, and a literal NUL in SQL text is
  parser-risky). The `\x00`-in-payload injectivity and the `'b'`-vs-`'b\x00'` prefix
  isolation are proven deterministically in `key-encoding.spec.ts`; the SQL integration
  test uses ordinary prefix-sharing strings (`'a'`/`'aa'`/`'ab'`). If a reviewer can drive
  a bound-parameter INSERT with a NUL, an end-to-end test of case 1 through real SQL would
  strengthen the floor.
- **`scanIndexRange` appears unused by production paths** (only defined + updated for
  consistency). I updated its brackets to the framed layout but there is no test that
  exercises its start/end directly. If it is or becomes live, add coverage.

## Coordination with sibling tickets

- **sq-2 (`optimystic-tree-comparator-lexicographic-missort`) — coupling, please carry
  forward.** `RowCodec.createPrimaryKeyComparator` is still dead code (never passed to
  `Tree.createOrOpen`). I updated its **decode side** to walk the framing via
  `splitKeyTuple` (replacing the naive `a.split('\x00')`) and removed the `'\x01NULL\x01'`
  null sentinel (NULL is now carried by the framing's `isNull`). I **did not** touch its
  numeric type-sniffing (`deserializeKeyPart`) — that is sq-2's. To keep sq-2's
  type-sniffing "known bug" tests (which feed *raw*, un-framed strings to the comparator)
  green **without editing them**, the comparator's decode has a small documented
  **legacy/raw fallback** (`decodeKeyForCompare`): a key not beginning with a structural
  tag is treated as one raw present element. When sq-2 wires this comparator into the tree
  and fully owns the decode, it should **update those raw-string comparator tests to feed
  framed keys and drop the fallback**. sq-2 also inherits the framing-aware split for free.
- **sq-3 (shared index-value serialization).** `serializeIndexValue` stays the single
  shared per-value encoder; its present-value payloads are unchanged. Only its NULL return
  changed (`'\x01'` → JS `null`), with framing moved to the composition layer.
- Unrelated to `cascade-pairkey-nul-byte-normalization` and to the already-landed
  `optimystic-composite-pk-point-lookup-key-assembly` (that fixed *which* columns seed the
  seek; this fixes *how* parts are escaped).

## Tripwires (parked, not tickets)

- **Comparator raw fallback** — `row-codec.ts` `decodeKeyForCompare` carries a documented
  compatibility shim for un-framed keys, live only via low-level unit tests while the
  comparator is dead code. Parked as an inline note + the sq-2 coupling above; sq-2 removes
  it. (Indexed here per the tripwire rule; the analysis lives at the code site and in the
  sq-2 coordination note above.)

## Validation performed

- `yarn workspace @optimystic/quereus-plugin-optimystic build` — success (DTS type-check
  passes).
- `… typecheck` (`tsc --noEmit`) — clean.
- `… test` — **284 passing, 11 pending, 0 failing** (~2m). Includes the new
  `key-encoding.spec.ts` (round-trip, injectivity, order-preservation, framed prefix-range
  isolation, split robustness) and the new prefix-isolation integration test. No
  pre-existing failures surfaced.

## Suggested review focus (use cases to probe)

- Re-derive the prefix-successor argument; try to construct a value pair that leaks across
  the `[P, P+'\x03')` bracket (e.g. values differing only by trailing `\x00`s, or a payload
  containing `\x02`/`\x03`/`\xff`).
- Confirm `extractPrimaryKey` and `createPrimaryKey` stay byte-identical for every SQL type
  (insert vs point-lookup parity) — a divergence silently hides rows.
- Order-preservation across mixed NULL/present composite keys, and that REAL range bounds
  (`toExponential(15)`) still sort correctly *after* framing.
- The format-change/migration risk above: decide whether a reindex ticket is warranted.
