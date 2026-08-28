description: When two parts of a program open the same storage folder separately, each quietly gets its own private copy of recently-read data, so neither ever sees what the other saved — with no error to tell anyone it happened.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts
severity: wrong-result
likelihood: unusual
tradeoffs: The configuration is already documented as unsupported (a store is meant to have one owner), so a maintainer could reasonably say the doc note added alongside this ticket is enough and decline to spend type-system or runtime-guard work on preventing it.
----

# Two read caches over one backing store never converge, silently

## What happens

A write-through read cache now sits in front of file-backed storage (`withReadCache`, added by
`filestorage-read-amplification-times-out-plugin-specs`). Cache identity is **per JavaScript
object**. Nothing in the system knows that two storage objects point at the same directory, so
two objects over one directory get two independent caches. Each serves its own stale view
forever. There is no error, no warning, and no divergence signal — reads simply never observe
the other writer.

Measured, on a create/insert workload over one temp directory (throwaway A/B, only the wrap
decision changed between arms):

| wiring | peer A's row count after peer B commits 3 rows |
| --- | --- |
| no cache (behavior before the cache landed) | 3 — correct |
| two `FileRawStorage(dir)` instances, one cache each | **1 — wrong** |
| one unwrapped instance passed to `withReadCache` twice | **1 — wrong** |
| one `CachedRawStorage` object shared by both consumers | 3 — correct |

Row 3 is the sharp edge: sharing the *inner* storage object is not enough, because each
`withReadCache` call wraps it again. Only sharing the *wrapper* works.

This was found because it broke a real test —
`read-pull-mechanism.spec.ts` "cross-writer convergence", which used two `Database`s over one
directory as a cheap stand-in for two network peers. That test now shares one pre-wrapped
`CachedRawStorage`, and a doc note was added at `withReadCache` and in
`packages/db-p2p/docs/storage.md` § 6. Those are notes, not guards — hence this ticket.

## Why a note is not sufficient

The plugin seam (`CollectionFactory.createLocalTransactor`) calls the host's
`rawStorageFactory` once per transactor, and the factory is built fresh per `register()`. So
**one cache per `Database` is produced by construction**, and a host that opens two `Database`s
over one directory gets the broken configuration without doing anything unusual or writing any
cache-related code. The host has no way to say "these two share a store" and no way to say
"don't cache this one" — the only correct wiring is for the host to know to construct a
`CachedRawStorage` itself and hand the same object to both, which nothing in the API surface
suggests.

Note this configuration was *already* imperfect before the cache: two file-storage instances
over one directory take no lock and are last-writer-wins. The cache changes the failure from
"occasionally races" to "deterministically never converges", which is worse in the sense that
it cannot be observed as flakiness and better in the sense that it is reproducible.

## What would actually fix it

Preferred, in order — the point is that the bad wiring should be impossible or loudly caught,
not documented:

1. **Give a backing store an identity, and key the cache on it.** If `IRawStorage` (or the
   driver beneath it) could report a stable identifier for what it is backed by — a resolved
   directory path for file storage, a database name for IndexedDB, a fixed sentinel for
   in-memory — then `withReadCache` could return the *same* wrapper for the same identity and
   the bad state stops being representable. Backends that cannot identify themselves opt out by
   returning nothing, and keep today's per-object behavior.
2. **Detect and refuse at the seam.** Failing identity, have the shared cache pool notice that
   two live cache stores claim the same identity and throw (or log loudly) rather than silently
   diverging. Cheaper than (1) and catches the case at the moment it is created.
3. **Give hosts a supported opt-out**, e.g. a plugin config flag that skips the wrap, so a host
   that genuinely wants several independent consumers on one directory can say so. On its own
   this is the weakest option — it only helps a host that already knows about the hazard.

## Expected behavior

Wiring two consumers onto one backing store either works correctly (they share one cache) or
fails loudly at construction. It never silently produces two views that diverge.

## How to confirm any fix

Reproduce the table above: two `Database`s over one temp directory via the plugin's
`rawStorageFactory`, peer B inserts, peer A re-reads. Peer A must see peer B's rows, or the
program must have refused the wiring outright.
