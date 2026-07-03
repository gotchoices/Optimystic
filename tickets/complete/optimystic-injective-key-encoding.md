description: Multi-column primary-key and index-key encoding was not injective — text values containing certain control bytes could collide, mis-sort, or hide rows. This replaced the raw-delimiter join with an order-preserving, injective framing that survives any string.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-encoding.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/key-encoding.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/test/index-serialize-value.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
----

## What shipped

A shared framing module (`src/schema/key-encoding.ts`) encodes a tuple of column
payloads into one string that is **injective** (distinct tuples never collide) and
**order-preserving** under plain lexicographic (raw UTF-16 code-unit) comparison — the
comparator the trees actually use (`collection-factory.ts:46`,
`a < b ? -1 : a > b ? 1 : 0`). Per-element scheme (FoundationDB-tuple style):

```
NULL element      -> "\x00"                              (bare tag; sorts first)
present element   -> "\x02" + escape(payload) + "\x00"   (escape: "\x00" -> "\x00\xff")
```

Both the primary-key encoder (`row-codec.ts`) and the secondary-index encoder
(`index-manager.ts`) route through it; per-value payload logic is unchanged (number
`toExponential(15)` range-ordering and PK `toString`/base64 forms preserved). The
module seek/unique builders (`optimystic-module.ts`) use the same framing. Prefix-range
brackets for index lookups use the framed-prefix successor `[P, P + '\x03')`
(`KEY_PREFIX_END`), not the ticket's originally-suggested `final \x00 -> \x01` (which
would re-introduce the collision). Full rationale is in the implement handoff and the
module docstring.

## Review findings

Reviewed the full implement diff (commit 3216221) with fresh eyes before the handoff,
then re-derived the core arguments independently and probed for what it overlooked.

**Correctness — the injective framing and prefix brackets: CONFIRMED correct.**
- Re-derived the `[P, P + '\x03')` prefix-successor argument from scratch. It holds for
  all inputs: every legitimate child key continues after `P` with a framing tag
  (`\x00`/`\x02`, both `< \x03`); the only way a *different* value's frame can have `P`
  as a prefix is a value `= P-value + '\x00' + …`, whose escape places `\xff` (`> \x03`)
  immediately after `P`, so it is excluded. Tried to construct a leak with values
  differing only by trailing `\x00`, and with payloads containing `\x02`/`\x03`/`\xff`
  — none leak, because those bytes only ever appear *inside* an element (after a
  `\x02` tag), never at the boundary position right after `P`.
- Verified the escape's order-preservation (`\x00 -> \x00\xff`) against adversarial
  pairs (`'a\x00'` vs `'a\xff'`, `'\x02'` vs `'\x02\x00'`, embedded `\x00\xff`
  look-alikes) — all preserve raw payload ordering.
- Verified `extractPrimaryKey`/`createPrimaryKey` are byte-identical (both call
  `encodeKeyTuple(map(serializeKeyPart))`); a test now asserts this parity explicitly.
- Confirmed **both** the data tree and every index tree are opened with the *same*
  lexicographic comparator (index trees are created via the same
  `collectionFactory.createOrGetCollection`), so the framing's order-preservation
  assumption holds on both — the scheme is not silently relying on a comparator that
  only the primary-key tree uses.
- `uniqueKeyFor` (in-memory batch dup detection) uses the same `encodeKeyTuple`, so it
  agrees with how the index would key the row.

**Missed call sites: none.** Grepped the whole package `src` for `.join('\x00')` and
the old `\x01`/`\x01NULL\x01` sentinels — no remaining raw-join or sentinel key
construction. All producers route through the shared framing.

**Docs out of date (minor — fixed inline this pass).** Three comments/docs still
described the old `\x00`-join format and are now wrong:
- `src/types.ts:79` (RowData doc) — updated to reference the framed encoding.
- `src/optimystic-module.ts` UPDATE-OR-REPLACE index-maintenance comment (`<idx>\x00…`
  notation) — updated to `frame(idx)‖frame(pk)` notation.
- `README.md` Data Model section ("composite keys are joined with `\x00`") — updated.

**Tests: adequate as a floor; ran green.** `build`, `typecheck` (tsc --noEmit), and the
full suite all pass — **284 passing, 11 pending, 0 failing** (~2m). The new
`key-encoding.spec.ts` covers round-trip, injectivity, order-preservation across
mixed NULL/present tuples, framed prefix-range isolation, and split robustness; the
three original collision-class regression tests are correctly flipped from
"known bug" to "fixed"; an end-to-end prefix-isolation integration test exercises the
real SQL path. The implementer's noted gap — embedded-`\x00` injectivity is proven at
unit level but not driven through real SQL (a bound-parameter NUL insert) — stands; it
is a strengthening, not a hole, since the unit proofs are deterministic. No new tests
were required to close a defect.

**Tripwires (parked, not tickets):**
- `scanIndexRange` (`index-manager.ts`) has no production caller and no direct test; its
  framed brackets were updated for consistency only. Parked as an inline `NOTE:` at the
  method — add range coverage if it becomes live.
- The dead-code comparator's raw/un-framed fallback (`row-codec.ts`
  `decodeKeyForCompare`) is a compatibility shim kept alive only by low-level unit
  tests while `createPrimaryKeyComparator` is unused. Already carries an inline `NOTE:`;
  sq-2 (`optimystic-tree-comparator-lexicographic-missort`) removes it when it wires the
  comparator into the tree.

**Major finding → new backlog ticket:** the change alters the **on-disk bytes** of every
primary-key and index tree key with **no migration/reindex path**. Data persisted by an
earlier build would silently return wrong/missing rows after upgrade. Pre-1.0 (v0.14.1)
this may be acceptable, but whether any persisted data must survive an upgrade is a
product decision. Filed as `tickets/backlog/debt-optimystic-key-format-migration.md`
(the implementer flagged it; the reviewer dispositioned it rather than accepting
silently).

## Sibling coordination (carried forward from the implement handoff)

- **sq-2** inherits framing-aware key decode (`splitKeyTuple`) in `row-codec.ts` and
  should, when it wires up `createPrimaryKeyComparator`, drop the raw fallback and
  re-point its raw-string comparator tests at framed keys.
- **sq-3** — `serializeIndexValue` remains the single shared per-value index encoder;
  only its NULL return changed (`'\x01'` → `null`), framing moved to the composition
  layer.

## Validation performed (this review pass)

- `yarn build` — success (DTS type-check passes).
- `yarn typecheck` — clean.
- `yarn test` — 284 passing, 11 pending, 0 failing.
- Post-review edits were **doc/comment-only** (types.ts comment, module comment,
  README, two inline NOTE comments) — no compiled logic changed, so the green run above
  remains representative.
