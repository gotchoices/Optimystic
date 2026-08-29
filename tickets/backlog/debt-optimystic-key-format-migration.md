description: An earlier change altered how Optimystic stores primary-key and index bytes on disk; any database saved by an older build would silently return wrong or missing rows after upgrading, and there is no upgrade path yet. Decide whether one is needed.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-encoding.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
severity: corruption
likelihood: unusual
repro: static
tradeoffs: The package is pre-1.0, where callers are normally expected to recreate data, so the honest answer may be "no migration, stamp a format version and move on" — building a real reindex path could be work nobody needs.
----

## Background

The `optimystic-injective-key-encoding` change (landed, reviewed) replaced the way a
row's primary key and each secondary-index key are turned into the string used as the
tree key. The old scheme joined column values with a raw `\x00` byte; the new scheme
frames each value with an order-preserving, injective encoding (see
`src/schema/key-encoding.ts`). This fixed real collision/mis-sort bugs.

The catch: **the on-disk bytes of every primary-key and index tree key changed.** A
collection that was persisted by an *earlier* build (via the `local` /
`FileRawStorage` transactor, or any durable network storage) holds old-format keys.
After upgrading to a build with the new encoding:

- point lookups build a new-format key that will not match the stored old-format key,
- range/index scans and ordering become inconsistent,

with the practical effect that rows can silently disappear or duplicate — no error is
raised. There is currently **no migration or reindex step** and no schema/format
version stamped on a collection.

## The decision a human needs to make

The package is pre-1.0 (v0.14.1), where format churn is normally acceptable and callers
are expected to re-create data. So the real question is a product one:

> Does any persisted Optimystic data created before the injective-key-encoding change
> need to survive an in-place upgrade?

- **If no** (only fresh deployments / disposable local test data exist): close this
  ticket — nothing to build. Consider stamping a format version now so the *next*
  breaking key change can be detected.
- **If yes**: a migration/reindex capability is needed — e.g. detect old-format
  collections (a format-version marker, or a heuristic), read every row via the old
  key scheme, and rewrite primary-key and all index tree keys under the new framing.
  This is real work and should be split into its own implement ticket once the
  decision is made.

## Drift detection now exists (added by the `debt-nominal-key-tuple-vs-row-types` review)

`test/key-encoding.spec.ts` now has an `on-disk format (literal bytes)` block asserting the
exact framed strings (`encodeKeyElement(null) === '\x00'`, the `\x00\xff` escape, the empty
tuple, `KEY_PREFIX_END`). Before that, every assertion in the file was either relational
(distinct / correctly ordered) or a round-trip through the same module, so a coordinated
change to both the encoder and the decoder would have kept the suite green while making every
persisted database unreadable.

That does not answer the decision above — it only means the *next* accidental format change
fails a test instead of shipping silently. A deliberate change still needs whatever migration
answer this ticket settles on.

## Why this is backlog, not blocking

The current change is correct and complete for new data; this only concerns backward
compatibility with data from before the change. It does not block any active work.
Recorded so the format-change risk is not lost — the reviewer flagged it rather than
silently accepting it.

## Two more on-disk changes to cover (added by `bug-persisted-index-outlives-the-columns-it-points-at`)

Whatever migration answer this ticket settles on must cover two further format changes
that landed with that fix, both in `packages/quereus-plugin-optimystic`:

- **The schema catalog record's index columns changed shape.** Each entry in the
  plugin-global catalog (`tree://optimystic/schema`) used to store an index column as
  `{ index: <position> }`; it now stores `{ name: <column name> }`
  (`PersistedIndexColumn` in `src/schema/schema-manager.ts`). A catalog written by an
  older build has no `name` on any index column, so reading it fails loudly on the first
  table with an index (`Persisted catalog record for table '…' is unresolvable`). There is
  deliberately no read-side fallback for the positional form — it was the ambiguous state
  the fix removes. A migration would rewrite each record's index columns from positions
  to names using that record's own `columns` list (they agree in any record the old build
  wrote without a column-reordering re-declare).

- **The synthesized UNIQUE-enforcement trees moved to new URIs.** A column-level or
  table-level UNIQUE with no declared index is enforced through a tree at
  `<collectionUri>/index/_uniq_<…>`. The suffix was the sorted column positions
  (`_uniq_1`, `_uniq_1_2`); it is now the sorted, lowercased, length-prefixed column
  names (`_uniq_5.stamp`, `_uniq_1.a_1.b`) — `uniqueEnforcementTreeName` in
  `src/schema/schema-manager.ts`. This one self-heals: the vtab's one-time backfill
  (`ensureUniquePopulated`) rebuilds an empty enforcement tree from the table on first
  probe, so no data is lost. The old `_uniq_<positions>` trees are simply never read
  again and stay in storage as unreferenced collections; a migration or a cleanup pass
  could delete them.
