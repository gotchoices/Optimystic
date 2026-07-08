description: The filesystem block store now runs on the shared storage core while keeping its human-readable directory layout, crash-safe writes, and atomic promote; reviewed for behavioral parity with the other backends and no crash-safety or Windows/legacy regressions.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
difficulty: hard
----

# Complete: fs driver reimplemented as `FileStoreDriver implements RawStoreDriver`

`FileRawStorage` (Node.js filesystem block store) was rewritten to plug into the shared
`KvRawStorage` kernel instead of implementing `IRawStorage` by hand. The kernel owns all JSON
serialization; the fs code became a `FileStoreDriver` that reads/writes raw `Uint8Array` bytes and
keeps every fs-specific behavior. On-disk directory layout is unchanged. Public surface
(`new FileRawStorage(basePath)`) unchanged.

See the implement commit `98459c4` for the full diff.

## Review findings

Adversarial pass over the implement diff, read before the handoff summary. Validation re-run this
session (win32 dev box):

- **db-p2p build** (dist is git-ignored → must be built so the fs package can import the kernel +
  conformance suite): clean.
- **fs typecheck** (`tsc --noEmit`): clean.
- **fs `yarn test`**: **52 passing, 1 pending** (the win32-gated POSIX legacy raw-colon test).
- **eslint** over `file-storage.ts`, `atomic-write.ts`, `file-storage.spec.ts`: clean.
- **Downstream regression** (`quereus-plugin-optimystic/test/file-raw-storage-actionid.spec.ts`,
  drives `FileRawStorage` directly): **4 passing, 8 pending** (8 POSIX-only legacy tests skip on
  win32).

### Checked — no defect

- **Cross-backend parity.** Diffed `FileStoreDriver` method-by-method against the `RawStoreDriver`
  interface and the `MemoryStoreDriver` reference. Every store maps correctly; `rangeRevisions`
  drain-before-yield and reverse handling match the memory driver; the kernel's `listRevisions`
  lo/hi/reverse computation drives both identically. The conformance suite (the authoritative parity
  contract) passes in full.
- **Crash safety / atomic writes.** Every value write funnels through `atomicWriteFile` (temp +
  fsync + rename). The `string → string | Uint8Array` widening is the only `atomic-write.ts` change;
  `FileHandle.writeFile` writes bytes byte-for-byte (non-ASCII round-trips exactly — direct test +
  conformance clone cases). Failed-rename-leaves-prior-value, torn-read-as-missing, and
  real-I/O-error-propagates (EISDIR) are all tested and pass.
- **Promote atomicity.** The single `rename(pend→actions)` is the whole atomic move; ENOENT maps to
  the exact `Pending action <id> not found for block <blockId>` message the conformance suite and
  downstream spec assert.
- **Windows + legacy compat.** Colon `%3A` encoding, POSIX legacy raw-colon read fallback +
  best-effort delete-through, and the win32 skips are a faithful port of the reviewed original
  (verified line-by-line against the pre-refactor source).
- **`declare` re-typing of `listBlockIds`/`getApproximateBytesUsed`** on `FileRawStorage` is
  truthful: the base `KvRawStorage` constructor wires them iff the driver provides them, and
  `FileStoreDriver` always does — so the non-optional subclass declaration matches runtime.
- **Docs.** README on-disk layout / atomic-writes / tests sections are accurate. `docs/internals.md`
  has no fs-internal references; `transactions.md` / `review.html` fs mentions are historical
  design-log / review-snapshot artifacts, not live API docs, and stay correct.

### Found + fixed inline (minor)

- **Stale line reference in README** — the `proper-lockfile` TODO moved from `file-storage.ts:22` to
  `:52` when `FileStoreDriver` was inserted above `FileRawStorage`. Corrected to `:52`.

### Decision confirmed

- **Pending-id filter widening (implement gap #1).** The accept-regex was widened to
  `^(?:tx:|stamp:)?[A-Za-z0-9_-]+$`. Confirmed the **right call**: every realistic id (legacy UUID,
  base64url `tx:`/`stamp:`, and the bare-alphanumeric ids the conformance suite uses) passes, and
  no id the memory/db reference drivers would list is dropped — base64url and UUID alphabets contain
  no dots/spaces, so only genuine junk files (decoded names with other punctuation) are
  logged-and-skipped. This both fixes the conformance failures and honors the original
  windows-ticket intent (real consensus ids are never silently dropped). Dropping the filter
  entirely would also be defensible but gains nothing and loses the breadcrumb for unexpected files.

### Tripwires (recorded at site, not filed as tickets)

- **Double JSON parse on the guarded read path** — `isParseableJson` parses the bytes to validate
  and discards, then the kernel's `decodeJson` parses the same bytes again to build the value: 2×
  parse per get (the old hand-rolled backend parsed once). The guard is intrinsic to the driver's
  "corrupt→missing" contract, which the kernel can't express, so it can't simply be dropped. Fine at
  current read volumes. Recorded as a `NOTE:` at `isParseableJson` in `file-storage.ts` — if a read
  path ever shows up hot, parse once and thread the parsed value through the driver.
- **Revisions store has no corrupt-read guard** (implement gap #3) — already a `NOTE:` at
  `getRevision`; its value is a bare string, atomic writes make a new torn rev impossible, and
  `recover()` re-derives revisions. Left as-is.

### Not addressed here (out of scope, documented)

- **Old-format on-disk migration (implement gap #2).** A store written by the *old* fs backend
  mis-reads revisions under the new kernel byte format (`"tx:a7"` → `tx:a7`). This is the known
  kernel-migration class affecting all four drivers uniformly (cf.
  `filestorage-posix-colon-actionid-migration` in `complete/`), pre-1.0 and out of scope to migrate
  per-driver. Not a fresh defect.
- **POSIX legacy raw-colon fallback not exercised at runtime this session** (implement gap #4) —
  win32 dev box; the fallback short-circuits on win32, so both the fs-package legacy test and the 8
  quereus POSIX legacy tests skip here. The code is a faithful port; a POSIX CI run is the real
  check. No code concern — a coverage-environment note only.
- **`db-p2p` dist rebuild** (implement gap #5) — dist is git-ignored (confirmed via
  `git check-ignore`), so the rebuild is not committed; CI build ordering (db-p2p before fs) is the
  only implication, which the README/handoff already note.

## Out of scope (unchanged, intentionally)

`file-kv-store.ts` (still string-valued over `atomicWriteFile`), `logger.ts`, `index.ts`, the
proper-lockfile / dispose TODO, and fs peer-identity — all untouched. The sibling driver tickets
(`2-st-kvkernel-driver-{sqlite,leveldb,indexeddb}`) are independent.
