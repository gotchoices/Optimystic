description: The browser IndexedDB block store was rebuilt on the shared storage core; reviewed for behavioral parity with the other backends and no browser/structured-clone regressions — parity holds, one stale README table fixed.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-web/README.md, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
difficulty: medium
----

# Review complete: IndexedDB driver on the shared `KvRawStorage` kernel

`IndexedDBRawStorage` was rewritten from a hand-rolled `IRawStorage` into a thin
`extends KvRawStorage` shell over a new `IndexedDBStoreDriver implements RawStoreDriver`.
The kernel owns all JSON/UTF-8 serialization; the driver moves opaque `Uint8Array`
bytes over the five unchanged IndexedDB object stores. Object stores, compound keys,
and the atomic promote are unchanged; public surface (`new IndexedDBRawStorage(handle)`)
unchanged. Mirrors the fs `FileRawStorage`/`FileStoreDriver` split reviewed in
`2-st-kvkernel-driver-fs`.

## Review findings

Adversarial pass over the implement diff (`git show 16f6934`), read before the handoff
summary. Read every touched file plus the kernel (`kv-raw-storage.ts`), the driver
contract (`raw-store-driver.ts`), the codec (`raw-store-codec.ts`), and the conformance
suite. Validation re-run this session (win32 dev box):

- **db-p2p build** (dist is git-ignored → must be built so the web package can import
  the kernel + conformance suite): clean.
- **web build / typecheck** (`tsc`): clean.
- **web `yarn test`**: **43 passing, 0 failing** — conformance suite + 3 IndexedDB-only
  cases + pre-existing KV/identity specs. The `IndexedDB` conformance `listBlockIds`
  cases ran (NOT skipped), proving the driver's optional methods are wired at runtime.
- **eslint** over `indexeddb-storage.ts`, `db.ts`, `indexeddb-storage.spec.ts`: clean.

### Checked — no defect

- **Cross-backend parity.** Diffed `IndexedDBStoreDriver` method-by-method against the
  `RawStoreDriver` interface and the kernel's call sites. Every logical store maps
  correctly; `rangeRevisions` reverse handling (`reverse ? 'prev' : 'next'` over the
  `[lo,hi]` bound) matches the kernel's lo/hi/reverse computation; `promote` is the
  verbatim single `readwrite` transaction. The conformance suite (authoritative parity
  contract) passes in full, including descending `listRevisions`, sparse gaps,
  single-bound, block-scoping, promote atomicity + exact missing-pend error, and the
  `BlockStorage` open-ended-range + tombstone slice.
- **Structured-clone byte fidelity.** Driver-level test pins that a stored `Uint8Array`
  returns AS a `Uint8Array` (not `ArrayBuffer`/`DataView`), byte-for-byte — the exact
  view-drift that would break the kernel's `decodeJson`. fake-indexeddb and real-browser
  structured clone both preserve typed-array type.
- **drain-before-yield.** Both `rangeRevisions` and `listPendingActionIds` snapshot the
  cursor into an array and `await tx.done` before yielding; the conformance suite
  interleaves an unrelated `getMetadata` await between yields and both pass — a live
  cursor straddling those awaits would auto-commit under IndexedDB and fail.
- **Array-key pending scan.** The `[blockId] .. [blockId, []]` bound is driven directly
  with a `block-10` neighbour that sorts adjacent to `block-1` under string compare;
  no cross-block leak.
- **`promote` missing-pend guard.** `if (!value)` is safe: driver values are non-empty
  JSON/UTF-8 byte arrays and any `Uint8Array` object is truthy, so the branch fires only
  on a true `undefined` miss; throws the exact `Pending action <id> not found for block
  <blockId>` the conformance suite asserts.
- **`declare` re-typing of `listBlockIds`/`getApproximateBytesUsed`.** Truthful and free
  of the `useDefineForClassFields` footgun: `declare` emits no field initializer, so it
  does not reset the base-constructor-wired functions to `undefined`. The base wires them
  iff the driver provides them, and `IndexedDBStoreDriver` always does. Identical to the
  reviewed fs pattern; proven at runtime by the unskipped conformance `listBlockIds` cases.
- **No broken consumers.** Grep for `IndexedDBRawStorage`/`IndexedDBStoreDriver` across
  `packages/**/src` finds only the class itself and doc/comment references — no external
  caller depended on the old per-method names (`saveMetadata`, `getPendingTransaction`,
  etc.); those live on the kernel-provided `IRawStorage` surface, unchanged.
- **Shared handle not closed by the driver.** `IndexedDBStoreDriver` correctly omits the
  optional `close()` — the `OptimysticWebDBHandle` is shared with `IndexedDBKVStore` and
  the identity helper, so closing it from the driver would break them. Not a gap.
- **No schema/version change.** Object stores + keys are byte-identical, so `db.ts`
  keeps `DEFAULT_DB_VERSION = 1` with no upgrade hook. Correct — only the value *shape*
  changed, which IndexedDB does not version.

### Found + fixed inline (minor)

- **Stale README object-store table** (`packages/db-p2p-storage-web/README.md`). The
  "Persistence semantics" table still listed the object-store `Value` column as live
  `BlockMetadata`/`ActionId`/`Transform`/`IBlock`. After the refactor those stores hold
  kernel-encoded `Uint8Array` bytes. Rewrote the table to a `Stored value` (`Uint8Array`)
  + `Decoded (logical) type` split and added a sentence noting the kernel owns
  serialization. No other README section was stale (`listRevisions`/`promote`/
  `getApproximateBytesUsed`/identity prose all still accurate).

### Tripwires (recorded, not filed)

- **`listBlockIds` snapshots all `metadata` keys** into memory via `getAllKeys('metadata')`.
  Behaviorally identical to the pre-refactor code and fine as a startup seed; only an
  O(n) allocation concern if a browser store ever holds enormous block counts. Parked
  here in findings (not as a code `NOTE:`) because the behavior is unchanged by this diff
  — it is not a regression, and the site already carries an explanatory comment.

### Not addressed here (out of scope, documented)

- **Old-format on-disk data will not decode.** An IndexedDB database written by the *old*
  web backend stored live objects; because the stores/keys are unchanged there is no
  version bump, so a stale browser store keeps object-valued rows and the kernel's
  `decodeJson` fails at read time. This is the same uniform kernel-format migration class
  affecting all four drivers (cf. the fs review's identical out-of-scope note and
  `filestorage-posix-colon-actionid-migration` in `complete/`); pre-1.0 and out of scope
  to migrate per-driver. IndexedDB's twist is that it is **silent** (no schema version
  distinguishes old vs new value shape), but that does not change the disposition — it is
  a documented pre-1.0 boundary, not a fresh defect. If a real pre-1.0 upgrade path is
  ever wanted, it is one migration ticket spanning all four backends, not a per-driver fix.
- **Never run against a real browser.** All validation is `fake-indexeddb` under Node.
  Structured-clone typed-array fidelity, cursor auto-commit timing, and
  `navigator.storage.estimate()` are assumed browser-equivalent; a headless-browser run
  is the true check and is out of band for an agent. No code concern — a
  coverage-environment note only.
- **`db-p2p` dist rebuild.** dist is git-ignored, so the rebuild needed to run the tests
  is not committed; CI build ordering (db-p2p before web) is the only implication, already
  noted in the handoff.

### Confirmed intentional

- **`IndexedDBStoreDriver` is newly public** via the unchanged `export * from
  './indexeddb-storage.js'`. Intentional and symmetric with the exported fs
  `FileStoreDriver`; part of the package's public surface.

## Out of scope (unchanged, intentionally)

`indexeddb-kv-store.ts` (still string-valued over the `kv` store), `identity.ts`,
`logger.ts`, `index.ts`, and `openOptimysticWebDb` (schema/version unchanged). The sibling
driver tickets (`2-st-kvkernel-driver-{sqlite,leveldb}`) are independent.

## End
