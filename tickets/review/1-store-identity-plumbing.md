description: Storage backends can now report an optional string naming what they are backed by, so a later change can tell that two of them point at the same folder or database. Nothing reads that string yet.
files: packages/db-p2p/src/storage/store-identity.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/store-identity.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts
difficulty: medium
----

# Review: a backing store can name itself

## What landed

An **optional, additive** capability: a storage backend can report a stable string naming what
it is backed by. **No behavior changed.** Nothing in the codebase reads the string yet — the two
follow-on tickets (`read-cache-dedupe-by-store-identity`, `duplicate-store-identity-guard`) are
the consumers.

New module `packages/db-p2p/src/storage/store-identity.ts`:

- `type StoreIdentity = string` — compared for equality only, never parsed.
- `identityForHandle(scheme, handle)` — a per-scheme `WeakMap<object, string>` plus a
  **process-global** monotonic ordinal, producing `` `${scheme}:${n}` ``. Weak, so tagging never
  keeps a handle alive.

Two optional interface members, feature-detected the way `listBlockIds` /
`approximateBytesUsed` already are — `RawStoreDriver.storeIdentity?()` and
`IRawStorage.getStoreIdentity?()` — each carrying the full contract in its doc comment
(same location ⇒ equal; different location ⇒ unequal; scheme-prefixed; stable for the object's
life; **omit the method entirely** rather than stub it; names the store, not its contents).

Three wrappers pass identity through as constructor-time conditional assignments:
`KvRawStorage` (from `driver.storeIdentity`), `RawStorageDriverAdapter` (from
`inner.getStoreIdentity`), `CachedStoreDriver` (from `inner.storeIdentity`).

Backends:

| backend | identity |
| --- | --- |
| `FileStoreDriver` | `'file:' + path.resolve(basePath)`, lowercased on win32, computed once in the constructor |
| `SqliteStoreDriver` | `identityForHandle('sqlite-handle', db)` |
| `IndexedDBStoreDriver` | `identityForHandle('idb-handle', db)` |
| `LevelDBStoreDriver` | `identityForHandle('leveldb-handle', db)` |
| `MemoryStoreDriver` | **none, deliberately** — commented at the site |

## Deviations from the implement ticket — please check these first

**1. `declare getStoreIdentity` added to all four backend storage classes, not just
`FileRawStorage`.** The ticket named only the fs one. `SqliteRawStorage`,
`IndexedDBRawStorage`, and `LevelDBRawStorage` already re-declare their always-present
`listBlockIds`/`getApproximateBytesUsed` the same way, and their drivers always implement
`storeIdentity` too, so leaving three of four un-redeclared would have been an inconsistency.
Strictly a typing change; no runtime effect. Revert if you disagree.

**2. Identity is assigned in the constructor BODY on all three handle backends, not as a field
initializer.** A field initializer reading `this.db` (a parameter property) is order-dependent
under `useDefineForClassFields`, where native class fields run before the constructor body and
`this.db` would still be `undefined`. Constructor-body assignment sidesteps the question
entirely. Worth confirming the repo's effective `useDefineForClassFields` setting if you want to
know whether the hazard was real or merely avoided.

**3. The `FileStoreDriver` alias NOTE was widened beyond the ticket's wording.** The ticket asked
for symlinks / junctions / UNC-vs-mapped-drive. Implementation also covers **case-differing
spellings on a case-insensitive non-Windows volume — the default on macOS.** Only `win32` is
lowercased, so on a default macOS volume `/x/Foo` and `/x/foo` are one directory that gets two
identities. Platform is the only signal available synchronously, and case-folding every darwin
path would be wrong on a case-sensitive volume; `fs.realpath` resolves it but is async and needs
the directory to exist. This is a genuine, documented hole in the "same location ⇒ equal
identity" half of the contract, on darwin only. **Judge whether that is acceptable for the
follow-on tickets' purposes** — a missed alias means the dedupe ticket fails to dedupe (two
caches, the status quo), not that it wrongly merges two different stores. The unequal ⇒ different
direction, which is the one a guard would throw on, is not affected.

**4. `identityForHandle`'s ordinal is process-global, shared across schemes** (`sqlite-handle:0`,
`idb-handle:1`, …) rather than per-scheme. Either satisfies the contract; global also makes the
same object under two schemes differ in the suffix as well as the prefix. Cosmetic.

## Known gaps — treat the tests as a floor

- **The test doubles are identity-less by comment, not by assertion.** `CountingStoreDriver`
  (`test/support/cache-test-helpers.ts`) and `CrashingRawStorage` (`test/mid-ddl-crash.spec.ts`)
  were audited and each carries a comment saying it must NOT pass identity through, and why
  (several `CountingStoreDriver`s over one inner driver are meant to stay independent; a rebuilt
  crash mesh gets a fresh proxy over the same inner storage). **Nothing fails if someone adds a
  passthrough later.** The consequence only appears once the dedupe ticket lands, and it appears
  as tests silently measuring the wrong thing rather than as a red run. A one-line assertion in
  each file would pin it; deliberately not added, since the theme belongs with the ticket that
  makes identity load-bearing.
- **No cross-package test that two `CachedRawStorage` over one `FileRawStorage` directory report
  equal identity.** The two halves are each covered (fs identity spec; wrapper-chain spec in
  db-p2p over a synthetic identified driver), but the end-to-end composition the next ticket
  actually relies on — `new CachedRawStorage(new FileRawStorage(dir)).getStoreIdentity() ===
  'file:<resolved dir>'` — is asserted nowhere. That composition is the whole point of the
  passthrough chain.
- **The three handle backends' identity is exercised only by the inherited conformance clause**
  (non-empty, contains `':'`, stable across two calls). Nothing asserts that two drivers over one
  handle agree, or that two handles differ. The `WeakMap` logic is covered generically in
  `store-identity.spec.ts`; the per-backend wiring is not.
- **The win32 case-folding branch only ever runs one way per platform.** On the CI/dev machine
  this was run on (Windows) the `assert.strictEqual` arm executed; the `assert.notStrictEqual`
  arm has not been observed. Inverse on Linux/macOS.
- **`identityForHandle`'s weakness is asserted nowhere** — that tagging a handle does not keep it
  alive is a `WeakMap` property taken on faith, not tested (testing it needs GC hooks).

## Use cases to validate

- **Feature detection is the contract, not the return value.** `new
  KvRawStorage(new MemoryStoreDriver()).getStoreIdentity` must be `undefined` — the *property*
  absent, not a method returning `undefined`. A stub would silently defeat every consumer
  downstream. Pinned in `store-identity.spec.ts`; check the same holds through
  `CachedRawStorage` over an identity-less inner (also pinned).
- **Passthrough depth.** A `CachedRawStorage` over a `KvRawStorage` over an identified driver
  reports the driver's identity, unchanged — a cache and the storage it fronts name the SAME
  store, and a cache is not a store of its own.
- **Two wrappers over one driver agree.** Two `KvRawStorage` built over a single identified
  driver report equal identities. This is the fact the dedupe ticket keys on.
- **Directory spelling normalization.** `new FileRawStorage(dir)` and `new
  FileRawStorage(path.join(dir, 'sub', '..'))` agree; a different directory disagrees; an empty
  `basePath` resolves to the cwd without crashing; a relative `basePath` resolves against the cwd
  **at construction time** (deliberate — two storages built from one relative path under
  different cwds address different directories and must not compare equal).
- **Entry parity.** `store-identity.js` is exported from BOTH `src/index.ts` and `src/rn.ts`;
  `entry-parity.spec.ts` fails otherwise. It passes.

## Validation run — all green, nothing skipped or loosened

```
yarn workspace @optimystic/db-p2p test              → 2314 passing, 49 pending, 0 failing
yarn workspace @optimystic/db-p2p-storage-fs test   →   68 passing,  1 pending, 0 failing
yarn workspace @optimystic/db-p2p-storage-ns test   →   58 passing, 0 failing
yarn workspace @optimystic/db-p2p-storage-rn test   →   53 passing, 0 failing
yarn workspace @optimystic/db-p2p-storage-web test  →   52 passing, 0 failing
yarn build                                          → clean
yarn typecheck                                      → clean
```

New specs confirmed to actually execute (run individually with `--reporter spec`, not merely
counted): `store-identity.spec.ts` 9 passing, `file-store-identity.spec.ts` 7 passing. The new
conformance clause was confirmed **running rather than skipping** on a real handle backend
(`sqlite-storage.spec.ts` → `✔ getStoreIdentity is a stable, scheme-prefixed, non-empty
string`). It correctly skips on memory-backed suites, which have no identity by design.

No pre-existing failures surfaced. No test was skipped, disabled, or had assertions loosened.

## Tripwires parked in code

- `FileStoreDriver` constructor — directory aliases (symlinks, junctions, UNC-vs-mapped-drive,
  darwin case-insensitivity) read as two identities; `fs.realpath` would fix it but is async and
  requires the directory to exist. Revisit if an alias ever bites.
- `SqliteStoreDriver` / `IndexedDBStoreDriver` / `LevelDBStoreDriver` — identity is the HANDLE
  object, so two handles opened over one file / database name / path read as two identities. The
  package openers (`ns-opener.ts`, `db.ts`, `rn-opener.ts`) hand out one handle per location in
  practice, so this is the reachable case, not the complete one.
- `MemoryStoreDriver` — deliberately identity-less; two memory drivers are genuinely two stores,
  and one driver shared by two wrappers is already covered by object identity.
