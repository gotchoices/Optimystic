description: Storage backends can now report an optional short label naming what they are backed by — the folder or database behind them — so that a later change can tell when two of them are really the same thing. Nothing reads that label yet; this change only puts it in place.
files: packages/db-p2p/src/storage/store-identity.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/store-identity.spec.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts
----

# What landed

An **optional, additive** capability with **no behavior change**: a storage backend can report a
stable string naming what it is backed by. Nothing in the codebase reads it yet — the consumers
are the two follow-on tickets (`read-cache-dedupe-by-store-identity`,
`duplicate-store-identity-guard`).

- `packages/db-p2p/src/storage/store-identity.ts` — `type StoreIdentity = string` (compared for
  equality only, never parsed) and `identityForHandle(scheme, handle)`, a per-scheme
  `WeakMap<object, string>` over a process-global ordinal producing `` `${scheme}:${n}` ``. Weak,
  so tagging a handle never keeps it alive.
- Two optional interface members, feature-detected exactly as the existing `listBlockIds` /
  `approximateBytesUsed` are: `RawStoreDriver.storeIdentity?()` and
  `IRawStorage.getStoreIdentity?()`.
- Three wrappers pass identity through as constructor-time conditional assignments:
  `KvRawStorage`, `RawStorageDriverAdapter`, `CachedStoreDriver` — so
  `CachedRawStorage → CachedStoreDriver → RawStorageDriverAdapter → KvRawStorage → driver`
  reports the innermost driver's identity unchanged. A cache names the same store as the storage
  it fronts; it is not a store of its own.
- Backends: `FileStoreDriver` → `'file:' + path.resolve(basePath)` (lowercased on win32);
  `SqliteStoreDriver` / `IndexedDBStoreDriver` / `LevelDBStoreDriver` → `identityForHandle` over
  their open handle; `MemoryStoreDriver` → **none, deliberately** (two memory drivers are
  genuinely two stores).

# Review findings

Reviewed the implement diff (`60d74d70`) against the working tree before reading the handoff
summary. Verified every `implements RawStoreDriver`, `implements IRawStorage`, and
`extends KvRawStorage` site in the repo (8 production, 4 test doubles) — no implementor was
missed, and `withReadCache`, the seam the follow-on consumer ticket will edit, correctly receives
a `CachedRawStorage` that passes identity through.

## Major — none filed, and why

The one contract-level defect found (below, minor #1) resolves entirely at two interface doc
comments, so filing a ticket for a fix completed in this same pass would only pad the queue.
Nothing else rose above minor. No new `fix/`, `plan/`, or `backlog/` tickets were created.

## Minor — fixed in this pass

**1. The interface stated a `MUST` that three of four backends knowingly break.** Both
`raw-store-driver.ts` and `i-raw-storage.ts` read "Two drivers over the SAME underlying location
MUST return equal strings; two over different locations MUST NOT." The second half holds. The
first does not: every handle backend documents at its own site that two handles opened over one
database read as *two* identities, and the fs driver documents the same for unresolved directory
aliases. Left as written, a consumer author reading the literal text could write
`if (a !== b) → these are different stores`, which is false, and that inference is the one that
merges or splits wrongly. Both comments now state the achievable, one-directional contract:
**equality proves sameness** (a consumer may merge on it); **inequality proves nothing**. This was
the highest-leverage finding — it de-risks both follow-on tickets, which would otherwise be
designed against a false premise.

**2. The `FileStoreDriver` alias NOTE covered only the safe direction.** Every gap it listed
(symlinks, junctions, UNC-vs-mapped-drive, darwin case-insensitivity) fails *safe*: a missed alias
yields two identities for one directory, so a consumer declines to merge and gets today's
behavior. The NOTE missed the single **unsafe** case: Windows 10+ supports per-directory case
sensitivity (`fsutil file setCaseSensitiveInfo`), and on such a directory the unconditional win32
lowercase folds `X:\p\Foo` and `X:\p\foo` — two real directories — onto **one** identity, which a
merging consumer would act on. Not fixable synchronously (the flag is a per-directory filesystem
query, and the constructor is not async). Documented at the site as a second `NOTE:` with its
revisit condition, and the safe/unsafe split now made explicit so the distinction survives.

**3. A factually wrong comment.** The `FileStoreDriver` constructor claimed "An empty/whitespace
basePath resolves to the cwd". True for empty, false for whitespace — `path.resolve` is pure
string work, so `path.resolve(' ')` names a *child* directory called `' '`. Corrected.

**4. Both test doubles' "must not pass identity through" rules were comments with nothing
enforcing them.** The handoff flagged this and deliberately deferred it; it costs two lines, and
the failure mode is the expensive kind — once the dedupe ticket lands, a passthrough added later
makes these suites silently measure the wrong thing rather than going red. Pinned:
`CountingStoreDriver` (its call-count isolation depends on several wrappers over one inner driver
staying independent) in `store-identity.spec.ts`, and `CrashingRawStorage` (a rebuilt crash mesh
gets a fresh proxy over the same preserved inner storage) in `mid-ddl-crash.spec.ts`.

**5. The composition the interface promises by name was asserted nowhere.** `i-raw-storage.ts`
states verbatim that `new CachedRawStorage(new FileRawStorage(dir)).getStoreIdentity()` is
`'file:<resolved dir>'`. Each half was covered — fs identity in the fs package, the wrapper chain
over a synthetic driver in db-p2p — but the end-to-end join across the two packages was not. Added
three tests to `file-store-identity.spec.ts`: the promised equality, **two independent caches over
one directory report equal identities** (the exact fact the dedupe ticket keys on), and caches
over different directories differ.

**6. A correction to the handoff's own claim, now pinned by a test.** The handoff states the
feature-detection contract as "the *property* absent, not a method returning `undefined`". Under
this repo's settings the property is in fact **present with value `undefined`**: `tsconfig.base.json`
sets `target: ES2022` with no `useDefineForClassFields`, so TypeScript defaults it to `true` and
the optional members are emitted as native class fields defined before the constructor body runs.
`'getStoreIdentity' in storage` is therefore `true` even on an identity-less store. Harmless — every
doc comment specifies `typeof x === 'function'`, which is correct — and identical in shape to the
pre-existing `listBlockIds`, so this is not a defect. But an `in`-based probe would be wrong, so a
test now pins `typeof` as the sanctioned probe.

**7. Documentation.** `packages/db-p2p/docs/storage.md` Invariant 5 ("A store is owned by exactly
one process") is precisely the invariant this capability exists to serve and said nothing about it.
Added a subsection recording the capability with both caveats stated plainly — nothing reads it
yet, and it only ever under-approximates, so equality proves sameness while inequality proves
nothing. Also fixed two pre-existing doc-rot items in the same file, unrelated to identity but
found while reading it: the `FileRawStorage` line reference was stale (`file-storage.ts:411`, and
this diff moved the class further to 466), and the kernel is described twice as exposing "five
logical stores (metadata, revisions, pending, transactions, materialized)" when
`RawStoreDriver` has had **six** since the proofs store landed.

## Tripwires — none newly parked, by design

The implement pass had already parked the three genuine conditional concerns at their sites (fs
directory aliases; handle-based identity being per-handle rather than per-location; memory being
deliberately identity-less). Rather than add a fourth `NOTE:` tag, finding #2 extended the existing
fs one, and the architectural half — which has no single code site — went into `docs/storage.md`
Invariant 5 per finding #7.

## Deviations from the implement ticket — all four judged, all four kept

1. **`declare getStoreIdentity` on all four backend storage classes, not just the fs one.**
   Correct. Each of those classes already re-declares its always-present
   `listBlockIds`/`getApproximateBytesUsed` identically, and all four drivers always implement
   `storeIdentity`; redeclaring only one of four would have been the inconsistency. Type-only, no
   runtime effect.
2. **Identity assigned in the constructor body rather than as a field initializer — the hazard was
   real, not merely avoided.** The handoff asked for this to be confirmed. `tsconfig.base.json`
   sets `target: ES2022` and no explicit `useDefineForClassFields`, so TypeScript defaults it to
   `true`: native class fields initialize *before* the constructor body, where parameter
   properties like `private readonly db` are assigned. A field initializer reading `this.db`
   would have captured `undefined` and tagged the wrong object. Constructor-body assignment is
   the right call; all three handle backends correctly read the constructor *parameter*, not
   `this.db`.
3. **The alias NOTE widened past the ticket's wording to cover darwin case-insensitivity.** Right
   to widen — it is a genuine hole, it is documented, and it fails in the safe direction (a missed
   alias means the dedupe ticket declines to dedupe, i.e. the status quo of two caches; it never
   wrongly merges two distinct stores). Acceptable for both follow-on tickets. The direction that
   *would* be dangerous is covered by finding #2 above.
4. **Process-global rather than per-scheme ordinal.** Cosmetic; both satisfy the contract. Kept.

## Gaps left open, deliberately

- **Per-backend handle wiring is still covered only generically.** That two drivers over one
  handle agree, and two handles differ, is asserted for `identityForHandle` itself in
  `store-identity.spec.ts` and for each backend only by the inherited conformance clause
  (non-empty, contains `':'`, stable across calls). Closing it properly needs a real open handle
  in each of three packages to assert three identical one-liners; the logic under test is shared
  and already covered. Not worth the cross-package fixture cost.
- **The win32 case-fold branch can only ever run one arm per platform.** Verified on Windows here
  (the `strictEqual` arm); the `notStrictEqual` arm runs on Linux/macOS. Inherent to the test.
- **`identityForHandle`'s weakness is still untested** — that tagging a handle does not retain it
  is a `WeakMap` property, and asserting it needs GC hooks.
- **The "one handle per location in practice" claim in the three handle-backend NOTEs is a usage
  convention, not something the repo enforces.** No opener caches handles per location, there are
  no in-repo production call sites (they are library entry points for external consumers), and
  `db-p2p-storage-web/test/identity.spec.ts` deliberately opens one database name twice. This
  weakens the NOTEs slightly but changes nothing: it only widens the under-approximation, which is
  the safe direction, and finding #1 now states that direction correctly at the interface.

## Validation — all green, nothing skipped, disabled, or loosened

```
yarn build                                          → clean
yarn typecheck                                      → clean
yarn lint                                           → clean (eslint, exit 0, no output)
yarn workspace @optimystic/db-p2p test              → 2317 passing, 49 pending, 0 failing
yarn workspace @optimystic/db-p2p-storage-fs test   →   71 passing,  1 pending, 0 failing
yarn workspace @optimystic/db-p2p-storage-ns test   →   58 passing, 0 failing
yarn workspace @optimystic/db-p2p-storage-rn test   →   53 passing, 0 failing
yarn workspace @optimystic/db-p2p-storage-web test  →   52 passing, 0 failing
```

Counts are up by the six tests this review added (db-p2p 2314 → 2317, fs 68 → 71). Each new test
was confirmed to actually execute rather than merely be counted, by re-running its file with
`--reporter spec`: `store identity` reports 12 passing including both new cases, `FileRawStorage
store identity` reports 10 passing including all three new `through CachedRawStorage` cases, and
`the crash proxy reports no store identity` passes on its own.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
