description: Text values containing certain control characters can corrupt multi-column key and index encoding, so rows collide, mis-sort, or become unreachable — replace the raw-delimiter join with an order-preserving, injective encoding that survives any string.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/test/index-serialize-value.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
difficulty: medium
----

## Problem (confirmed)

The key encoding is not injective. Three legal-data cases break it, all reachable
with ordinary user strings — no adversary or exotic input:

1. **Separator collision.** Composite PK parts are joined with a raw `\x00`
   (`row-codec.ts:100-102, 121, 149`); index key parts likewise
   (`index-manager.ts:139`); and the index tree key is `indexKey\x00primaryKey`
   (`index-manager.ts:169, 191, 217`). A TEXT value that itself contains `\x00`
   shifts part boundaries, so two distinct tuples encode to the same string (or one
   decodes with the wrong arity). Confirmed by `row-codec.spec.ts:239-256`
   (`('foo\x00bar','baz')` collides with `('foo','bar')`).

2. **Index prefix-range corruption.** Index lookups scan `[indexKey\x00,
   indexKey\x01)` (`index-manager.ts:267-268`, and the same bracket in
   `scanIndexRange` at `305-310`). An index value containing `\x00` (or `\x01`)
   breaks the range invariant, so a prefix scan over- or under-matches.

3. **NULL-marker collision.** SQL NULL is the literal sentinel `'\x01NULL\x01'`
   in PKs (`row-codec.ts:157`) and `'\x01'` in index values
   (`index-manager.ts:45`). A real TEXT value equal to that sentinel is
   indistinguishable from SQL NULL. Confirmed by `row-codec.spec.ts:358-367`.

## Root cause

`serializeKeyPart` (`row-codec.ts:155-184`) and `serializeIndexValue`
(`index-manager.ts:43-64`) emit a per-value string, then callers concatenate those
strings with a raw `\x00` and reserve `\x00`/`\x01` as structural bytes — but
nothing prevents those bytes from appearing *inside* a value. There is no framing
layer separating "value payload" from "structure".

## The hard constraint that shapes the fix

**Both data trees and index trees are ordered by a plain lexicographic string
comparator** — `collection-factory.ts:46`:

```js
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
```

`RowCodec.createPrimaryKeyComparator` (`row-codec.ts:243-292`) exists but is **dead
code** — it is never passed to `Tree.createOrOpen` (that wiring is sq-2's job;
see *Coordination*). So today, tree order == raw UTF-16 code-unit order of the key
string, and the index range brackets `[…\x00, …\x01)` rely on that ordering.

Therefore the new encoding must be **injective AND lexicographic-order-preserving**
so it drops in under the *current* comparator without first requiring sq-2 to land.

**This is why the review's "just reuse `encodeFields`" suggestion does not drop
in.** `encodeFields` (`packages/quereus-plugin-crypto/src/crypto.ts:276`) is
injective, but it is a *length-prefixed binary framing* (`version ‖ tag ‖
varint(len) ‖ payload`) producing a `Uint8Array`. Length-prefix framing is **not**
lexicographically order-preserving (a short value sorts before a long one
regardless of content), and it is bytes, not a `string`. Using it as a tree key
would silently corrupt both PK ordering and the index prefix-range scans. Reuse its
*idea* (self-delimiting, NULL-distinct, delimiter-safe) but not its byte layout.
Numbers already lean on order-preservation too: `serializeIndexValue` deliberately
uses `toExponential(15)` (`index-manager.ts:53-57`) so REAL range bounds sort
correctly — do not regress that.

## Chosen direction: order-preserving tuple framing (in string space)

Introduce a small shared module (suggest
`packages/quereus-plugin-optimystic/src/schema/key-encoding.ts`) with the framing,
and route both `row-codec` and `index-manager` through it. Per-element scheme
(FoundationDB-tuple style, adapted to UTF-16 code units):

```
NULL element      -> "\x00"                                  (bare tag; sorts first)
non-null element  -> "\x02" + escape(payload) + "\x00"       (present tag, payload, terminator)
  where escape replaces every  "\x00"  ->  "\x00\xFF"
```

A key tuple is the concatenation of its framed elements (no extra separator — the
terminator delimits). Properties, all needed here:

- **Injective / delimiter-safe.** A real `\x00` in payload becomes `\x00\xFF`, so a
  bare `\x00` only ever means "end of element". Distinct tuples never collide.
- **Order-preserving.** NULL (`\x00`) < any present value (`\x02…`) — matches SQL
  NULL-sorts-first (`compareValues` returns `-1` for null). For two present values,
  the terminator `\x00` of a shorter string sorts before the escaped-null's second
  unit `\xFF`, so prefix ordering is preserved.
- **NULL distinct from empty string and from any literal.** NULL is `"\x00"`; empty
  string is `"\x02\x00"`; a literal `"\x01NULL\x01"` frames to its own escaped
  bytes — no collision. Fixes case 3.

Notes / gotchas for the implementer:
- `payload` is the *existing* per-value serialization (string verbatim; number via
  `toString`/`toExponential`; blob via base64; bool `'1'`/`'0'`). Keep those payload
  forms unchanged so number range-ordering (`toExponential`) is preserved — the
  framing wraps them, it does not replace them.
- Type-distinguishing (INTEGER `42` vs TEXT `'42'`) is intentionally **out of scope**
  here — a PK/index column's type is fixed by schema, so that ambiguity is not
  reachable within one column. It belongs to sq-2's `deserializeKeyPart` type-sniff
  fix. All present values share the one `\x02` tag; do not add per-type tags in this
  ticket (that would collide with sq-2's design and expand scope).
- We only escape `\x00`. `\x01` no longer carries any structural meaning once NULL
  stops being `\x01…`, so plain `\x01` in data is fine.

### Index tree key + prefix range (index-manager)

Rebuild `indexKey\x00primaryKey` composition and the `[…\x00, …\x01)` brackets on
top of the framing. Compose the tree key as `frame(index cols) ‖ frame(pk)` (frame
the pk as trailing element(s) with the same scheme). For a point index lookup on a
fully-specified `indexKey` P (= the framed index columns, which ends in a `\x00`
terminator):

- **start** = `P` (inclusive).
- **end** = `P` with its final `\x00` replaced by `\x01` (exclusive).

This is the standard prefix-successor: every tree key that begins with the framed
`P` is `P + <pk frame>` and sorts in `[P, P-with-last-\x00→\x01)`, and no key with a
*different* index tuple falls in that span (a different tuple differs inside the
framed region, before the terminator). Verify this reasoning against the actual
`KeyRange` semantics in db-core before relying on it. `scanIndexRange`
(`index-manager.ts:291-324`) needs the same bracket rebuild for its start/end.

## Coordination with sibling tickets

- **sq-2** = `optimystic-tree-comparator-lexicographic-missort` — wires a real
  comparator into `Tree.createOrOpen` and fixes numeric ordering / collations /
  DESC + `deserializeKeyPart` type-sniffing. This encoding is designed to remain
  correct under either the current lexicographic comparator *or* a future structural
  comparator (the framed tuple is uniquely decodable). If sq-2 lands after this,
  its comparator must split on the framing (walk elements) instead of the naive
  `a.split('\x00')` at `row-codec.ts:275-276` — flag this in the sq-2 handoff. This
  ticket should land **before** sq-2; they touch `row-codec.ts` together, so expect
  a rebase whichever lands second.
- **sq-3** (shared index-value serialization) — `serializeIndexValue` was already
  consolidated to one shared encoder (`index-serialize-value.spec.ts` header). The
  new framing module is the natural shared home; keep the per-value payload logic
  (the `toExponential` etc.) intact and wrap it.
- Distinct from completed `cascade-pairkey-nul-byte-normalization` (unrelated
  db-p2p cosmetic fix) and `optimystic-composite-pk-point-lookup-key-assembly`
  (which fixed *which* columns seed the seek, not part escaping).

## Test updates

Two existing "known bug" tests assert the *broken* behavior and must be flipped to
assert correctness (they are the regression guard for this fix):

- `row-codec.spec.ts:239-256` `'should collide when key contains \x00 separator'`
  — after the fix `cmp(pk1, pk2)` must **not** equal 0. Rename away from "known bug".
- `row-codec.spec.ts:358-367` `'should collide \x01NULL\x01 literal with actual
  null'` — after the fix `nullPk` must **not** equal `literalPk`. Rename.

Leave the sq-2-owned type-sniffing "known bug" tests (`:258-273` numeric-looking
TEXT, `:348-356` whitespace→0, `:369-377` `1e2`→100) alone — they flip under sq-2,
not here. BUT: changing the encode output changes the raw strings those tests feed
to the comparator, and the comparator's `split('\x00')`/`deserializeKeyPart` path
must stay internally consistent with the new framing. If wiring the framing forces
touching the comparator's decode side, keep those sq-2 tests green (adjust the
comparator's *split*, not its type logic) or, if that is not cleanly separable,
note the coupling in the review handoff so sq-2 picks it up.

Also update the NULL-marker assertions that encode the old sentinel as an exact
string:
- `row-codec.spec.ts:152-158` expects PK NULL == `'\x01NULL\x01'`.
- `index-serialize-value.spec.ts:38-41` expects index NULL == `'\x01'`.
These pin the *old* representation; update them to the new NULL framing (or assert
the injective property — NULL ≠ any literal — rather than an exact byte string).

## TODO

- [ ] Add `src/schema/key-encoding.ts`: `encodeKeyElement(value)` /
  `decodeKeyElement`, plus `encodeKeyTuple(values[])` and a framing-aware
  `splitKeyTuple(encoded)`. Order-preserving + injective per the scheme above.
  Include the escape (`\x00`→`\x00\xFF`) and the NULL bare-tag.
- [ ] Route `RowCodec.extractPrimaryKey` / `createPrimaryKey` / `serializeKeyPart`
  through the framing (payload logic unchanged; framing added). Ensure single-column
  keys are framed too (today `row-codec.ts:96-98, 117-119` short-circuit a lone part
  to the raw value — that raw value is still un-framed and can contain `\x00`).
- [ ] Update `createPrimaryKeyComparator` decode side (`row-codec.ts:275-281,
  297-310`) to split on the framing instead of `a.split('\x00')`, keeping the
  existing per-part compare/collation logic. Do not change type-sniffing (sq-2).
- [ ] Route `IndexManager.createIndexKey` and the `indexKey\x00pk` composition
  (`index-manager.ts:139, 169, 191, 217`) through the framing.
- [ ] Rebuild the prefix-range brackets in `findByIndexIn` (`267-268`) and
  `scanIndexRange` (`305-310`) for the framed layout (prefix-successor: final
  `\x00`→`\x01`). Verify against db-core `KeyRange` inclusivity semantics.
- [ ] Frame `serializeIndexValue`'s NULL (`index-manager.ts:44-46`) via the shared
  NULL tag; keep number/blob payloads (`toExponential`, base64) intact.
- [ ] Flip the two "known bug" collision tests to assert injectivity; update the
  NULL-representation assertions in both spec files.
- [ ] Add edge-case tests: value with embedded `\x00`; value with embedded `\x01`
  and `\xFF`; value exactly `'\x01NULL\x01'` vs real NULL; composite PK whose middle
  part contains the separator; index prefix scan where an index value contains the
  separator (integration-level, exercises the range brackets).
- [ ] Build the plugin (`yarn workspace @quereus/quereus-plugin-optimystic build`)
  — note `row-codec.spec.ts` imports from `../dist/index.js`, so the build must run
  before the spec — and run the plugin test suite, streaming output with `tee`.
  If any failure is plainly outside this diff, follow the pre-existing-error rule.
