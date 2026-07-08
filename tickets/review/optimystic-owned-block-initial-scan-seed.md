description: A restarted node now scans its already-stored blocks at startup and tells the resilience monitors about them, so data on disk is protected immediately instead of only after each block is next touched.
prereq:
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p/test/owned-block-seed.spec.ts, packages/db-p2p/test/memory-storage.spec.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts
----

# Review: seed the owned-block tracked set from durable storage at startup

## What this solves (plain language)

The two "resilience monitors" (one re-replicates a node's blocks when peers leave; one re-homes
blocks as responsibility shifts) both act on a shared set of "blocks this node owns". That set was
fed **only** by a live feed that fires on new commits and received replicas. So after a process
restart, blocks already sitting on disk were invisible to the monitors until each one happened to be
committed or replicated again — a freshly restarted node under-protected exactly the data it already
held. This change enumerates the on-disk blocks at startup and adds them to the set.

## What was built

**1. New optional enumeration method on the storage interface.**
`IRawStorage.listBlockIds?(): AsyncIterable<BlockId>` (`i-raw-storage.ts`). Optional, mirroring the
existing optional `getApproximateBytesUsed?()` — external/test doubles (e.g. `CrashingRawStorage` in
`mid-ddl-crash.spec.ts`) need not implement it; an absent method means "nothing to seed". All five
in-repo backends implement it. The enumeration source is the **metadata** store (keyed by `blockId`
alone → distinct ids, no dedup), which holds a record precisely for blocks with a committed revision
or a persisted replica — the same population the live feed tracks. Pending-only blocks (pended, never
committed) have no metadata and are excluded.

**2. Per-backend implementations.**
- `MemoryRawStorage` — `yield*` a snapshot (`Array.from(metadata.keys())`) so a concurrent
  `saveMetadata` can't invalidate a live iterator.
- `SqliteRawStorage` — prepared `SELECT block_id FROM metadata`, drain-then-yield.
- `LevelDBRawStorage` — drained range scan over the `TAG_METADATA` keyspace. Added `metadataRange()`
  and `blockIdFromMetadataKey()` to `keys.ts`.
- `IndexedDBRawStorage` — `getAllKeys('metadata')`.
- `FileRawStorage` — **see deviation below.**

**3. Startup seed wiring** (`libp2p-node-base.ts`, after the arachnode block ~line 1150): a gated,
fire-and-forget, cancellable background scan. Gated on `offOwnedBlockFeed` (only runs when a monitor
actually consumes the set) and on `listBlockIds` being present. Ordering is subscribe-feed-then-scan
so a block committed mid-scan is still caught (`Set.add` idempotent). A stop wrapper flips
`seedStopping` so the loop breaks against a stopping backend. The loop itself is extracted into a
pure, unit-testable helper `seedOwnedBlocksFromStorage(rawStorage, ownedBlocks, isStopping, yieldEvery?)`
in `owned-block-seed.ts` (cooperative yield every 1000 ids).

## Deviation from the ticket — READ THIS (most important review item)

The ticket prescribed `FileRawStorage.listBlockIds` as "`fs.readdir(basePath)`, yield every
`entry.isDirectory()`". **That is incorrect** and I did not implement it that way. A block that was
only *pended* (never committed) still creates `basePath/<blockId>/pend/…` because `atomicWriteFile`
does a recursive `mkdir` of the parent dir — so the block directory exists at the root **even with no
`meta.json`**. A plain directory scan would therefore seed pending-only blocks, violating the
ticket's own contract ("pending-only must NOT be seeded; the seed must match the live-feed
population"). The other four backends enumerate the metadata store and exclude pending-only for free;
directory-scan would make fs the lone divergent backend.

**What I did instead:** enumerate root directories **and** gate each on `meta.json` existence
(`fs.access`, existence-not-parse, so a torn/corrupt meta.json still counts as a key — matching
key-existence semantics in the other backends). ENOENT on the per-dir access → skip; any other error
surfaces (same discrimination as the root readdir and `directoryByteSize`).

**Reviewer:** please sanity-check this reasoning and the meta.json gate. It is the one place where the
implementation intentionally diverges from the ticket text, and it is load-bearing for the
pending-only-exclusion contract. The fs test `excludes a block that has only a pending transform (no
metadata)` fails against the ticket's prescribed impl and passes against this one.

## How to validate

Build + typecheck (all green): db-core, db-p2p, then the four storage backends —
`yarn workspace @optimystic/db-p2p-storage-{fs,ns,rn,web} run build`.

Tests (all green as of handoff):
- `db-p2p`: `test/memory-storage.spec.ts` + `test/owned-block-seed.spec.ts` (10 passing) and the
  node-wiring specs `test/{unify-tracked-block-set,spread-on-churn-node-wiring,rebalance-monitor-node-wiring}.spec.ts`
  (11 passing) — confirms the seed block doesn't disturb existing ownedBlocks wiring.
- `db-p2p-storage-fs` (25), `-ns` (34), `-rn` (30), `-web` (27): `run test:verbose`.

Run all from a repo where db-p2p is built first (storage packages consume its `dist`).

Key cases now covered per backend: exact id-set after committing several blocks; pending-only
excluded; empty store → empty; fs non-existent basePath → empty + stray root file ignored; leveldb
range upper-bound guard (revision/pending/transaction/materialized keys for a block with no metadata
are NOT decoded as ids). Helper cases: all-ids added, pending-only excluded, idempotent union with a
pre-populated set, early-stop on `isStopping`, no-op when `listBlockIds` absent, small-`yieldEvery`
yield path.

## Known gaps / where to look hard (tests are a floor)

- **No full end-to-end restart test of a real libp2p node.** The seed *loop* is tested via the
  extracted helper against `MemoryRawStorage`, and the *gate/teardown* is exercised indirectly by the
  existing node-wiring specs — but no test constructs a node over a **pre-populated disk backend**,
  lets the background scan settle, and asserts `node.spreadOnChurnMonitor`'s set contains the seeded
  ids. That integration path (background `void` task + real backend) is unverified end-to-end. If you
  want belt-and-suspenders, add one such test (fs or a MemoryRawStorage-backed node).
- **Background task timing.** The scan is fire-and-forget; nothing awaits it. A test that needs to
  observe the settled set must poll/wait. The helper is deterministic (awaitable) — prefer testing
  through it, which is why it was extracted.
- **`getAllKeys('metadata')` (web) loads all keys into one array** — no streaming despite the
  AsyncIterable signature. Fine at current scale; noted as a scale tripwire only, not a defect.
- **fs meta.json gate does one extra `fs.access` per block dir.** Doubles syscalls vs a bare readdir.
  Acceptable for a fire-and-forget startup scan; flagged so it isn't a surprise.

## Tripwires recorded (not tickets — parked in-code)

- `libp2p-node-base.ts` seed site — `NOTE:` on the **concurrent rebalance-release race**: a rebalance
  release can `untrackBlock` a confirmed-released id mid-scan and the scan may re-add it. Benign
  transient (metadata still present; re-evaluated + re-released next tick); accepted rather than
  synchronized.
- `file-storage.ts` `listBlockIds` and `sqlite-storage.ts` `listBlockIds` statement — `NOTE:` on
  **extreme-scale enumeration latency** (millions of blocks): page the readdir / SELECT if it ever
  becomes a startup-latency problem.

## Review findings

- **Ticket-vs-implementation deviation (fs backend):** implemented `FileRawStorage.listBlockIds` with
  a `meta.json`-existence gate instead of the ticket's prescribed bare directory scan, because a
  pending-only block creates the block dir and a bare scan would wrongly seed it — breaking the
  ticket's own pending-only-exclusion contract. Verify the reasoning and the existence-not-parse
  choice. (Detailed above.)
- **Tripwire — rebalance-release race:** parked as a `NOTE:` at the seed site in `libp2p-node-base.ts`.
- **Tripwire — extreme-scale enumeration latency:** parked as `NOTE:`s at the fs `readdir` and sqlite
  `SELECT block_id FROM metadata` sites.
- **Gap — no end-to-end real-node restart seed test:** seed loop tested via extracted helper + the
  wiring covered by existing node-wiring specs, but no test drives a node over a pre-populated disk
  backend and asserts the settled owned set. Called out under Known gaps.
