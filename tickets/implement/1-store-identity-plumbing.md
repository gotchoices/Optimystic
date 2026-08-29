description: Storage backends currently cannot say what they are backed by, so nothing can tell that two of them are pointed at the same folder or database. This adds an optional self-identifier that each backend reports; nothing consumes it yet.
files: packages/db-p2p/src/storage/store-identity.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p/test/store-identity.spec.ts, packages/db-p2p/test/entry-parity.spec.ts
difficulty: medium
----

# A backing store can name itself

## Why this exists

`withReadCache` puts a write-through read cache in front of a storage object, and cache
identity is **per JavaScript object**. Two `FileRawStorage` objects constructed over one
directory therefore get two independent caches that never observe each other's writes — no
error, no warning, reads simply never converge (measured: peer A still reads 1 row after peer
B commits 3). The root cause is that nothing in the system can tell the two objects apart from
two storages over genuinely different directories.

This ticket adds the missing fact and nothing else: **a backend can report a stable string
naming what it is backed by.** No behavior changes here. The two follow-on tickets consume it —
`read-cache-dedupe-by-store-identity` returns one shared cache per identity, and
`duplicate-store-identity-guard` makes a second cache over one identity throw.

## Interface

New module `packages/db-p2p/src/storage/store-identity.ts`:

```ts
/**
 * A stable, process-scoped name for what a store is backed by. Compared for equality only —
 * never parsed, never used as a cache key for values.
 */
export type StoreIdentity = string;

/**
 * A stable identity for a backend reachable only as an already-open handle object (a SQLite
 * db, an IndexedDB handle, a LevelDB instance). Returns the same string for the same object
 * for the life of the process, and a different one for every other object.
 */
export function identityForHandle(scheme: string, handle: object): StoreIdentity;
```

`identityForHandle` is a module-level `WeakMap<object, string>` plus a monotonic counter, e.g.
`` `${scheme}:${n}` ``. Weak, so tagging a handle never keeps it alive.

Two optional members, feature-detected exactly the way `listBlockIds` /
`approximateBytesUsed` already are:

```ts
// RawStoreDriver
storeIdentity?(): StoreIdentity;

// IRawStorage  (name mirrors the existing driver→storage rename, cf. getApproximateBytesUsed)
getStoreIdentity?(): StoreIdentity;
```

Contract to write into both doc comments:

- Two objects over the **same** underlying location MUST return equal strings; two over
  different locations MUST NOT.
- Every string is **scheme-prefixed** so backends cannot collide: `file:`, `sqlite-handle:`,
  `idb-handle:`, `leveldb-handle:`.
- Stable for the object's whole life.
- **Optional by design.** A backend that cannot honour the contract omits the method entirely,
  and callers fall back to per-object behavior. Never install a stub that returns `undefined` —
  feature-detection above must see the backend's true capability (the trap `KvRawStorage`'s
  class doc already calls out for `listBlockIds`).
- It identifies the *store*, not its contents.

## Passthrough: wrappers report what they ultimately wrap

Wire in each constructor, only when the wrapped thing has it:

| wrapper | reads | exposes |
| --- | --- | --- |
| `KvRawStorage` | `driver.storeIdentity` | `getStoreIdentity` |
| `RawStorageDriverAdapter` (in `cached-raw-storage.ts`) | `inner.getStoreIdentity` | `storeIdentity` |
| `CachedStoreDriver` | `inner.storeIdentity` | `storeIdentity` |

The consequence the next two tickets rely on:
`new CachedRawStorage(new FileRawStorage(dir)).getStoreIdentity()` is
`'file:<resolved dir>'` — a cache and the storage it fronts name the same store.

## Backends

- **`FileStoreDriver`** — `'file:' + path.resolve(basePath)`, computed once in the constructor,
  lowercased on `win32` (Windows paths are case-insensitive, so `C:\Foo` and `C:\foo` are one
  directory and must produce one identity).
- **`SqliteStoreDriver`** — `identityForHandle('sqlite-handle', db)`.
- **`IndexedDBStoreDriver`** — `identityForHandle('idb-handle', db)`.
- **`LevelDBStoreDriver`** — `identityForHandle('leveldb-handle', db)`.
- **`MemoryStoreDriver`** — none, deliberately. Two memory drivers are genuinely two stores,
  and the one object shared between two wrappers is covered by object identity in the next
  ticket.

Those three handle-based backends take an already-open handle rather than a path or name, so
the handle object *is* the best available identity. Record as a `NOTE:` at each site: two
handles opened over the same SQLite file / IndexedDB name / LevelDB path read as two
identities; the package openers (`ns-opener.ts`, `rn-opener.ts`, `db.ts`) hand out one handle
per location in practice, so this is the reachable case, not the complete one.

Record as a `NOTE:` in `FileStoreDriver`: symlinks, junctions, and UNC-versus-mapped-drive
aliases of one directory read as two identities. `fs.realpath` would resolve them but needs an
async constructor and a directory that already exists; revisit if an alias ever bites.

## Edge cases & interactions

- **Entry parity.** `entry-parity.spec.ts` pins that `index.ts` and `rn.ts` export the same
  set. Export `store-identity.js` from **both** or that spec fails.
- **Feature detection, not stubs.** Assign in the constructor under an `if`; never declare a
  method body that returns `undefined`. A stub silently defeats every consumer downstream.
- **`FileRawStorage`** already re-declares its always-present passthroughs
  (`declare listBlockIds: …`). Do the same for `getStoreIdentity` — the fs driver always has it.
- **Test doubles must stay opaque.** `CountingStoreDriver` (`test/support/cache-test-helpers.ts`)
  and the storage proxy in `mid-ddl-crash.spec.ts` wrap a driver/storage. They must NOT pass
  identity through unless deliberately intended — if they did, wrappers meant to be independent
  would start deduping once the next ticket lands. Check each and leave them identity-less;
  say so in a comment where it is load-bearing.
- **Relative `basePath`.** `path.resolve` is cwd-dependent and captured at construction. Two
  storages built from the same relative path under different cwds legitimately name different
  directories, so this is correct — but state it.
- **Empty / whitespace `basePath`** resolves to the cwd; no special-casing, just don't crash.
- **A driver that gains identity later** is not a case — identity is fixed at construction.

## Tests

`packages/db-p2p/test/store-identity.spec.ts`:

- `identityForHandle` returns the same string for the same object across calls, different
  strings for different objects, and different strings for the same object under two schemes.
- Two `KvRawStorage` over ONE driver that has identity report equal identities.
- The wrapper chain passes through: a `CachedRawStorage` over a `KvRawStorage` over a driver
  with identity reports the driver's identity.
- A driver WITHOUT identity leaves `getStoreIdentity` **undefined on the storage object**
  (`expect(storage.getStoreIdentity).to.equal(undefined)`) — pins the feature-detect contract,
  not just a undefined return.

`packages/db-p2p-storage-fs/test/file-storage.spec.ts` (or a new sibling spec):

- `new FileRawStorage(dir)` and `new FileRawStorage(path.join(dir, 'sub', '..'))` report equal
  identity; a different directory differs.
- On win32 only, a case-differing spelling of the same directory reports equal identity.

`packages/db-p2p/src/testing/raw-storage-conformance.ts`:

- One clause every backend suite inherits: **if** `getStoreIdentity` is present, it returns a
  non-empty string containing `':'` and returns the same value on two consecutive calls.

## TODO

- Add `packages/db-p2p/src/storage/store-identity.ts` with `StoreIdentity` and
  `identityForHandle`; export from `src/index.ts` and `src/rn.ts`.
- Add `storeIdentity?()` to `RawStoreDriver` and `getStoreIdentity?()` to `IRawStorage`, with
  the contract doc above on both.
- Wire the three passthroughs (`KvRawStorage`, `RawStorageDriverAdapter`, `CachedStoreDriver`)
  as constructor-time conditional assignments.
- Implement identity in `FileStoreDriver` (resolved path, win32-lowercased) with its `NOTE:`
  about aliases; re-declare it as always-present on `FileRawStorage`.
- Implement identity in `SqliteStoreDriver`, `IndexedDBStoreDriver`, `LevelDBStoreDriver` via
  `identityForHandle`, each with its `NOTE:` about two handles over one location.
- Leave `MemoryStoreDriver` identity-less with a one-line comment saying why.
- Audit `CountingStoreDriver` and the `mid-ddl-crash.spec.ts` proxy; keep them identity-less.
- Add the conformance clause and the specs above.
- Run: `yarn workspace @optimystic/db-p2p test`,
  `yarn workspace @optimystic/db-p2p-storage-fs test`,
  `yarn workspace @optimystic/db-p2p-storage-ns test`,
  `yarn workspace @optimystic/db-p2p-storage-rn test`,
  `yarn workspace @optimystic/db-p2p-storage-web test`, then `yarn build && yarn typecheck`.
