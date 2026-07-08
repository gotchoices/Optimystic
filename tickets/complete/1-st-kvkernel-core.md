description: A shared storage core (KvRawStorage) now backs the in-memory block store, with one reusable test suite that any storage backend can run to prove it behaves identically. Reviewed and accepted; four disk/db backends adopt it next.
prereq:
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/kv-raw-storage.spec.ts, packages/db-p2p/docs/storage.md, docs/internals.md
----

# Complete: shared ordered-KV storage kernel (`KvRawStorage` + `RawStoreDriver` + conformance suite)

## What shipped

A typed multi-store driver kernel that hoists the genuinely-shared storage logic
(value serialization + call orchestration) above the storage primitive, leaving each
backend's key/topology layer alone.

- **`raw-store-driver.ts`** — `RawStoreDriver` interface: bytes-valued, per-logical-store surface
  (metadata / revisions / pending / transactions / materialized) plus optional
  `listBlockIds`/`approximateBytesUsed`/`close`. Documents the two contracts the kernel relies on:
  drain-before-yield iteration and promote atomicity.
- **`raw-store-codec.ts`** — `encodeJson`/`decodeJson` + `encodeActionId`/`decodeActionId`.
- **`kv-raw-storage.ts`** — `KvRawStorage implements IRawStorage` over a driver; owns codec calls,
  `listRevisions` bound computation, `saveMaterializedBlock` put-or-delete, `promote`, and the
  optional passthroughs (wired only when the driver provides them). Carries the `// NOTE:` marking
  the write-path seam for a future incremental byte counter (not built here, by scope).
- **`memory-store-driver.ts`** — in-memory `RawStoreDriver` (five `Map`s of `Uint8Array`).
- **`memory-storage.ts`** — `MemoryRawStorage` is now a thin `extends KvRawStorage` over the memory
  driver; `structuredClone` discipline deleted (now structural via the byte boundary).
- **`raw-storage-conformance.ts`** — `runRawStorageConformance(name, makeStorage)`, 30 tests,
  exported from the `./testing` entry.
- **`kv-raw-storage.spec.ts`** — runs the suite against the in-memory driver.

Exports added to `index.ts`/`rn.ts`; `docs/internals.md` and `packages/db-p2p/docs/storage.md`
updated to record the kernel and the now-structural clone invariant.

## Review findings

Reviewed the implement-stage diff (`3f903ae`) with fresh eyes, then verified against the
surrounding codebase. Disposition below; nothing blocking, no major findings.

### Checked — correctness

- **JSON codec vs the old `structuredClone` (potential fidelity regression) — CLEARED.** The four
  persistent backends already serialize every value with `JSON.stringify` (confirmed in
  `file-storage.ts` — metadata/revision/pending/transaction/materialized all `JSON.stringify`;
  the `.json` on-disk layout). So the kernel's JSON codec is *exact parity* with production
  persistence, and binary-in-blocks was never supported by any persistent backend. Switching the
  in-memory backend from `structuredClone` to JSON does not lose fidelity — it makes memory and
  disk *agree* on edge cases they previously could diverge on (e.g. an open-ended `RevisionRange`
  encoded as the one-element tuple `[E]`; `RevisionRange` is `[startRev, endRev?]` with open-ended
  = one element, so `[5]`→`"[5]"`→`[5]` round-trips byte-exact — verified against `struct.ts`). The
  conformance suite pins this.
- **`promote` behavior change (missing-pend now throws instead of silent no-op) — SAFE.** Both
  production callers guard pending presence before promoting: `internalCommit`
  (`storage-repo.ts:633` checks `getPendingTransaction` and throws its own consistency error first,
  promotes at :658) and the retry-commit path (`storage-repo.ts:480-501`, which routes genuine
  missing-pends into its own error before the commit loop and skips recovered blocks). No legitimate
  path reaches the new throw. The throw message matches all four backends exactly.
- **Deleted `test/memory-storage.spec.ts` — no coverage lost.** Its three tests (saveTransaction
  clone-on-store, `listBlockIds` exactness incl. pending-only exclusion, empty store) are a strict
  subset of the conformance suite now running against `MemoryRawStorage` (which adds a committed-
  transaction clone assertion + read-independence + the BlockStorage parity slice). Confirmed
  superset by reading both.
- **Optional `listBlockIds`/`getApproximateBytesUsed` on `KvRawStorage` — no caller breakage.** All
  consumers feature-detect: `owned-block-seed.ts:33` (`typeof … !== 'function'`),
  `libp2p-node-base.ts:1156` (`typeof … === 'function'`), `storage-monitor.ts:49`
  (`?.()`). The remaining direct calls are backend-specific tests typed against the concrete
  `FileRawStorage`/`SqliteStorage`/`LevelDbStorage`/`IndexedDbStorage`, which still declare these as
  required methods. The one concrete-`MemoryRawStorage` static caller was the deleted test. A
  repo-wide grep found no other.
- **`./testing` entry is a real published subpath** (`package.json` exports → `dist/src/testing/…`),
  so the four backend packages can import `runRawStorageConformance` — the "one suite guards four
  backends" design is wired, not just intended. (`chai`/`StorageRepo`/`BlockStorage` pulled in at
  test time only, consistent with the pre-existing `mesh-harness` export.)

### Checked — docs

- `docs/internals.md` "Storage Returns References" was updated by the implementer — accurate.
- **`packages/db-p2p/docs/storage.md` was STALE — FIXED inline this pass.** Its architecture diagram
  showed only `IRawStorage → FileRawStorage` (no kernel), and a "Structured Cloning: Uses efficient
  deep cloning for immutability" performance bullet that is now false for the in-memory backend.
  Added a "Shared KV Kernel" component section + corrected the diagram and the clone bullet to the
  snapshot-on-store/read reality, keeping migration status honest (memory adopted; disk backends
  pending).
- `packages/db-p2p/README.md` left as-is — it describes the pluggable `IRawStorage` interface at an
  abstraction level the kernel doesn't invalidate; not stale.

### Checked — tests / lint

- `npx tsc --noEmit -p tsconfig.json` (db-p2p) → clean.
- Conformance spec → **30 passing**.
- Full db-p2p unit suite (excluding `*.integration.spec.ts`) → **1292 passing, 11 pending, 0
  failing**.
- `eslint` over all changed files → clean.

### Minor — fixed in this pass

- `packages/db-p2p/docs/storage.md` staleness (above).

### Major — new tickets

- None filed. The one known-major follow-up (migrate the four persistent backends onto
  `RawStoreDriver` + wire the conformance suite) is **already queued**: `tickets/implement/`
  holds `2-st-kvkernel-driver-{fs,sqlite,leveldb,indexeddb}.md`. No duplication needed.

### Conditional / tripwires

- **Drain-before-yield is only trivially exercised** by the memory driver (no live cursor), as the
  implementer flagged. This is not a defect — the contract is doc-only until a real driver adopts
  it, and the interleaved-await conformance test becomes load-bearing then (each of the four
  migration tickets inherits it automatically). Recorded here, not as a code comment: the site that
  will meet it is each backend's `rangeRevisions`/`listPendingActionIds`, which don't exist yet.
- **JSON drops `undefined` object properties** (vs `structuredClone` preserving the key). Considered
  and dismissed: all decoded-value access in the codebase is optional-chaining (`meta.latest?.rev`),
  never key-presence introspection (`'latest' in meta`), and every persistent backend already has
  this exact JSON behavior — so it is universal reality, not kernel-introduced. No comment added; a
  `NOTE:` would just restate standard JSON semantics.
- Memory driver `rangeRevisions` walks `lo..hi` one rev at a time — same as the old memory impl and
  the fs backend; not new, and real backends use native cursors. Not recorded (pre-existing, not
  kernel-introduced).

### Blocked

- None. No decisions require a human.

## Known gaps carried forward (not defects — deferred by design)

- The four persistent drivers are not migrated; the copied `test/*-storage.spec.ts` files remain in
  place. Follow-up tickets exist (above). "one suite replaces four specs" and "fs is a first-class
  driver via `rename`" are proven only against the in-memory driver so far.
- Incremental byte counter not built — only the `// NOTE:` seam, per ticket scope
  (`st-storage-sweep-archival-and-capacity-estimate`).
- `getApproximateBytesUsed` stays per-driver (backend-specific), by design.

## End
