description: An earlier change altered how Optimystic stores primary-key and index bytes on disk; any database saved by an older build would silently return wrong or missing rows after upgrading, and there is no upgrade path yet. Decide whether one is needed.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-encoding.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
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

## Why this is backlog, not blocking

The current change is correct and complete for new data; this only concerns backward
compatibility with data from before the change. It does not block any active work.
Recorded so the format-change risk is not lost — the reviewer flagged it rather than
silently accepting it.
