description: Four storage backends are near-identical copies of the same ~150 lines, differing only in the low-level key-value primitive underneath. Design a single shared core so each backend keeps only its thin driver, and fold the duplicated replica/deletion save logic into one helper.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p-storage-rn/src/leveldb-like.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts
difficulty: hard
----

# Extract a shared ordered-KV storage kernel; the four adapters are ~150-line near-clones

The four raw-storage adapters — LevelDB/React-Native, filesystem, NativeScript SQLite, and
IndexedDB/web — are ~150-line near-duplicates. They share the same JSON (de)serialization, the
same key scheme, the same drain-before-yield iteration, and the same promote semantics,
differing **only** in the underlying key-value primitive (get / put / delete / range-scan /
atomic-batch).

The `LevelDBLike` interface (`db-p2p-storage-rn/src/leveldb-like.ts`) is already almost exactly
the needed kernel surface — an ordered KV with atomic batch. Additionally, the
`saveReplica` / `saveDeletion` bodies in `block-storage.ts:126-223` are ~90% duplicated and
should collapse into one helper.

This is a design/refactor task (routed to plan). The goal: ship a `KvRawStorage` in `db-p2p`
implemented once over a minimal ordered-KV + atomic-batch interface, so each adapter package
keeps only its ~100-line driver (the primitive binding) and inherits all the shared logic.

## Edge cases & interactions

- **Minimal interface surface.** The shared interface must be small enough that every backend
  can implement it honestly. Confirm each of the four primitives (LevelDB, fs, SQLite,
  IndexedDB) can provide: point get/put/delete, ordered range-scan, and a truly atomic batch.
  The fs adapter's "batch" is the weakest link — its atomicity ties directly to
  `st-filestorage-non-atomic-write-corruption` (temp-file+rename); the kernel must not assume an
  atomicity the fs driver cannot deliver, or must define how the driver provides it.
- **Iteration semantics.** The drain-before-yield iteration pattern must be preserved exactly —
  document why it exists (avoiding holding a cursor open across yields) so the shared kernel does
  not silently change concurrency behavior any adapter relied on.
- **Promote semantics & crash windows.** The pend→promote→setLatest sequence and its crash
  windows (see `st-recoverblock-no-production-caller`) live in the shared logic once extracted;
  the refactor must preserve the exact ordering and recovery behavior, not just the happy path.
- **Per-adapter transaction/mutex differences.** NativeScript SQLite needs serialized
  transactions (`st-nativescript-sqlite-transaction-mutex`); the kernel's atomic-batch contract
  must accommodate a driver that serializes internally without the kernel assuming lock-free
  concurrency.
- **`meta.ranges` / clone invariants.** The shared `saveReplica`/`saveDeletion` helper must
  preserve the honest closed-range seeding (`[]` + merge) that the correct paths already do — do
  not carry forward the `ranges: [[0]]` pend defect (`st-pend-seeds-open-ended-ranges`) — and the
  memory store's clone-on-store invariant (`st-storage-assorted-cleanliness-bugs`).
- **Capacity-estimate hook.** If the sweep/estimate work (`st-storage-sweep-archival-and-capacity-estimate`)
  introduces an incremental byte counter, the kernel is the natural place to maintain it; design
  the interface so that counter can hang off the shared write path rather than each driver.
- **Behavior parity testing.** A shared conformance test suite run against all four drivers is
  the way to prove the extraction changed no observable behavior; name it in the resulting
  implement ticket(s).

Resolve the exact kernel interface (whether `LevelDBLike` is adopted as-is or refined) and the
fs-atomicity contract before emitting implement tickets. Sequence sensibly with the adapter-floor
bug fixes so the refactor extracts *fixed* behavior, not the current defects.
