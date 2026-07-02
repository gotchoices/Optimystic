description: Text values containing certain control characters can corrupt multi-column key and index encoding, so rows collide, mis-sort, or become unreachable — reachable with ordinary user-supplied strings.
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## Bug

The key encoding is not injective — different logical tuples can map to the same
byte string, and legal user data can break structural invariants:

- Composite primary keys join their parts with a `\x00` separator
  (`row-codec.ts:100-102, 155-158`). A TEXT column value that itself contains
  `\x00` shifts the part boundaries, so two distinct tuples encode identically
  (or one decodes wrong).
- Index entry keys are `indexKey\x00pk`, and index prefix ranges are
  `[key\x00, key\x01)` (`index-manager.ts:88, 118, 216-217`). A value containing
  `\x00` breaks the range invariant, so prefix scans over- or under-match.
- SQL NULL is represented by the literal marker `'\x01NULL\x01'` / `'\x01'`. A
  real TEXT value equal to that marker collides with SQL NULL.

All of these are reachable with ordinary strings — no adversary or exotic input
required.

## Relationship to prior work

Distinct from the completed `cascade-pairkey-nul-byte-normalization` (a git
text/binary cosmetic fix in db-p2p, unrelated file) and from
`optimystic-composite-pk-point-lookup-key-assembly` (which fixed using *all* PK
columns for the seek, not the escaping of the parts). This is a fresh encoding
correctness bug.

## Expected behavior

Encoding is injective: any TEXT value, including one containing `\x00` or
matching a NULL marker, round-trips without changing tuple identity, sort
boundaries, or index range membership.

Suggested direction (from review): length-prefix or escape each key part rather
than using raw delimiters. The crypto package's `encodeFields` already solves
this exact injective-framing problem and can be reused. Coordinate with sq-2
(any encoding change must stay order-consistent with the comparator) and sq-3
(shared index-value serialization).

## Edge cases

- Value containing embedded `\x00`; value containing `\x01`.
- Value exactly equal to the NULL marker vs actual SQL NULL.
- Composite PK where a middle part contains the separator.
- Index prefix scan where an index value contains the separator.
