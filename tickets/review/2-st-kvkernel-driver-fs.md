description: The filesystem block store was rewritten to run on the new shared storage core while keeping its human-readable directory layout, crash-safe file writes, and atomic promote — verify it behaves identically to the other backends and that no crash-safety or Windows/legacy handling regressed.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts
difficulty: hard
----

# Review: fs driver reimplemented as `FileStoreDriver implements RawStoreDriver`

`FileRawStorage` (Node.js filesystem block store) was rewritten to plug into the shared
`KvRawStorage` kernel instead of implementing `IRawStorage` by hand. The kernel now owns all
JSON serialization; the fs code became a `FileStoreDriver` that reads/writes raw `Uint8Array`
bytes and keeps every fs-specific behavior. On-disk directory layout is unchanged.

## What changed

- **`src/file-storage.ts`** — rewritten:
  - `FileStoreDriver implements RawStoreDriver` — the five logical stores map to the five
    subdirectories (`meta.json`, `revs/`, `pend/`, `actions/`, `blocks/`). Values are bytes; the
    driver no longer does `JSON.stringify/parse`.
  - `FileRawStorage` is now `extends KvRawStorage` (same public constructor
    `new FileRawStorage(basePath)`), matching the `MemoryRawStorage` precedent. `listBlockIds` /
    `getApproximateBytesUsed` are re-`declare`d as always-present (the fs driver always implements
    them, so the kernel constructor always wires them).
  - Preserved verbatim: atomic (temp+rename) writes for every value; the corrupt-content→missing
    read guard (now byte-level, JSON-validate-then-return-raw-bytes); colon `%3A` filename encoding
    + legacy raw-colon read fallback + best-effort raw-colon unlink + win32 skips; `promote` as a
    single `rename` (the atomic move, no WAL); `listBlockIds` `meta.json` existence gate;
    `listPendingActionIds` ENOENT-vs-other `readdir` discrimination; `approximateBytesUsed`
    recursive dir walk.
- **`src/atomic-write.ts`** — `atomicWriteFile` signature widened `string` → `string | Uint8Array`
  (only change). `FileHandle.writeFile` writes a `Uint8Array` byte-for-byte, so non-ASCII JSON
  round-trips exactly. `FileKVStore` still passes strings.
- **`test/file-storage.spec.ts`** — added `runRawStorageConformance('FileSystem', …)` over a
  temp-dir factory (mkdtemp + `rm -rf` cleanup); kept the fs-only tests the shared suite can't cover.
- **`README.md`** — Tests section updated to describe the two-layer suite.
- **`packages/db-p2p/dist`** — rebuilt (was stale: it predated the `st-kvkernel-core` source, so it
  lacked `kv-raw-storage.js` / the conformance suite). Rebuild was required for the fs package to
  import `@optimystic/db-p2p/testing` at all.

## How to validate

From `packages/db-p2p-storage-fs`:

```bash
npx tsc --noEmit -p tsconfig.json      # typecheck
yarn test                              # 52 passing, 1 pending (win32 skip)
yarn build                             # dist
```

Downstream regression guard (a completed-ticket spec that drives `FileRawStorage` directly),
from `packages/quereus-plugin-optimystic`:

```bash
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/file-raw-storage-actionid.spec.ts" --reporter spec --exit   # 4 passing, 8 pending (POSIX-only)
```

**Note:** `packages/db-p2p` must be built first (`yarn build` in that package) — downstream
packages import its `dist`, and the conformance suite lives there.

### Results this session (win32 dev box)

- fs typecheck: clean. fs `yarn test`: **52 passing, 1 pending**. fs `yarn build`: clean.
- eslint over the three changed files: clean.
- quereus actionid regression: **4 passing, 8 pending** (POSIX-only legacy raw-colon tests skip on
  win32).

## Use cases / behaviors to confirm

- **Cross-backend parity** — the conformance suite is the point: fs must behave identically to
  memory/leveldb/sqlite/indexeddb. Round-trips, `listRevisions` asc/desc/sparse/scoped, promote +
  exact missing-pend message, clone-on-store/read, drain-before-yield, BlockStorage pend→commit
  range seeding + tombstone read-back.
- **Crash safety** — every value write is temp+rename; a failed rename leaves the prior complete
  file (never torn); a torn meta.json reads as missing so `recover()` progresses; a real I/O error
  (EISDIR/EACCES) still propagates.
- **Promote atomicity** — the single `rename(pend→actions)` is the whole atomic move. A crash leaves
  exactly one of pending/committed.
- **Windows + legacy compat** — colon ids `%3A`-encoded on disk; POSIX legacy raw-colon files still
  read and delete-through; win32 skips the raw-colon fallback (NTFS ADS separator).
- **Non-ASCII fidelity** — emoji/CJK JSON payloads round-trip byte-exact (a lossy text coercion
  would corrupt them; there's a direct fs-only test plus the conformance round-trip/clone cases).

## Known gaps / things to scrutinize (treat this as a floor)

1. **Deviation from the ticket: the pending-id filter was widened.** The ticket said keep the
   filter to "accept legacy-UUID and `tx:`/`stamp:` ids, log-and-skip others." But the shared
   conformance suite (the authoritative parity contract) stores pending ids like `a1`/`a2`, and the
   old regex rejected them → two conformance tests failed. The memory reference driver applies **no**
   filter at all. Resolution: I widened the accept-regex to
   `^(?:tx:|stamp:)?[A-Za-z0-9_-]+$` — every realistic id (UUID, base64url `tx:`/`stamp:`, bare
   alphanumeric) passes; only decoded names with other punctuation (a dot, a space) are
   logged-and-skipped. This still honors the windows-ticket guarantee (real consensus ids are
   listed) and no longer drops valid ids. **Reviewer: confirm this is the right call, or decide the
   filter should be dropped entirely to match the memory reference.** (`file-storage.ts`,
   `listPendingActionIds`.)

2. **Revision value on-disk format changed** (`revs/<rev>.json`): was `JSON.stringify(actionId)`
   (`"tx:a7"`), now `encodeActionId(actionId)` (bare `tx:a7`). This is the kernel's byte format and
   is the SAME change all four drivers make — but a store written by the *old* fs backend and read
   by the *new* one mis-reads revisions (reads the literal quoted string as the ActionId). This is
   the known kernel-migration class (cf. `filestorage-posix-colon-actionid-migration` in
   `complete/`); pre-1.0, out of scope to migrate here. Flagging so it isn't mistaken for a fresh
   defect.

3. **Corrupt-guard is now per-store.** JSON stores (metadata/pending/transactions/materialized) keep
   the torn-read→missing guard; the revisions store does NOT (its value is a bare string, not JSON,
   so there's nothing to validate). Recorded as a `NOTE:` at `getRevision` — atomic writes make a
   new torn rev impossible and `recover()` re-derives revisions, so this is a tripwire, not a
   defect.

4. **Legacy raw-colon path not exercised at runtime this session** — this is a win32 dev box, and
   both the fs-package legacy test and the quereus POSIX legacy tests are win32-gated (the
   production `readActionScopedBytes`/`unlinkRawColon` short-circuit on win32). The code is a
   faithful port of the reviewed original, but a POSIX CI run is the real check. If reviewing on
   POSIX, run the suites there to actually cover the fallback.

5. **`db-p2p` dist rebuild is a side effect.** No `db-p2p` source changed, but its dist was stale
   and had to be rebuilt so the fs package could import the kernel/conformance suite. If the runner
   commits dist, this is expected; if dist is git-ignored, the build ordering (db-p2p before fs)
   matters for CI.

## Out of scope (unchanged, intentionally)

`file-kv-store.ts` (still string-valued over `atomicWriteFile`), `logger.ts`, `index.ts`, the
proper-lockfile / dispose TODO, and fs peer-identity — all untouched. The sibling driver tickets
(`2-st-kvkernel-driver-{sqlite,leveldb,indexeddb}`) are independent and still in `implement/`.
