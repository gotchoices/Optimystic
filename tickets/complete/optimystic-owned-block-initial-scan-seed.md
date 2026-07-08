description: A restarted node now scans its already-stored blocks at startup and tells the resilience monitors about them, so data on disk is protected immediately instead of only after each block is next touched.
prereq:
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-rn/src/leveldb-storage.ts, packages/db-p2p-storage-rn/src/keys.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts
----

# Seed the owned-block tracked set from durable storage at startup

## What shipped

A node's two resilience monitors (churn re-replication + rebalance re-homing) share one
"blocks this node owns" set, previously fed only by a live change feed. That feed never re-emits
blocks already on disk from a prior run, so a restarted node under-protected data it already held
until each block was next committed or replicated. This change enumerates the on-disk metadata store
at startup and seeds those ids into the set.

- New optional `IRawStorage.listBlockIds?(): AsyncIterable<BlockId>` (streamed, order-unspecified),
  mirroring the existing optional `getApproximateBytesUsed?()`. Absent method → nothing to seed.
- All five in-repo backends enumerate their **metadata** store (the population = blocks with a
  committed revision or persisted replica; pending-only blocks have no metadata and are excluded):
  memory (key snapshot), sqlite (`SELECT block_id FROM metadata`), leveldb (`TAG_METADATA` range
  scan via new `metadataRange()` / `blockIdFromMetadataKey()`), indexeddb (`getAllKeys('metadata')`),
  fs (**root-dir scan gated on `meta.json` existence** — see below).
- Extracted, unit-tested loop `seedOwnedBlocksFromStorage(rawStorage, ownedBlocks, isStopping,
  yieldEvery?)` in `owned-block-seed.ts` (cooperative yield every 1000 ids, cancellable).
- Startup wiring in `libp2p-node-base.ts`: gated on a monitor actually consuming the set and on
  `listBlockIds` presence; subscribe-feed-then-scan (idempotent `Set.add` covers the overlap);
  fire-and-forget with a `.catch`; a stop wrapper flips a stopping flag so the scan aborts.

## fs deviation from the plan (verified correct)

The plan prescribed a bare `fs.readdir` yielding every directory. That is **wrong**: a pending-only
block (never committed) still creates `basePath/<blockId>/pend/` via `atomicWriteFile`'s recursive
mkdir, so the block dir exists at root with no `meta.json`. A bare scan would seed pending-only
blocks, violating the pending-only-exclusion contract that the other four (metadata-keyed) backends
satisfy for free. The implementer instead gates each root dir on `meta.json` existence (`fs.access`,
existence-not-parse). Reviewer confirmed the reasoning: the divergence is load-bearing and correct.
The "corrupt/torn meta.json still counts" nuance is effectively unreachable — `atomicWriteFile`
renames atomically, so `meta.json` is never torn — but the existence gate is cheaper than a parse and
harmless, so the choice stands.

## Validation (all green at review)

- Build + typecheck: db-core, db-p2p, and the four storage backends.
- Tests: db-p2p `1260 passing` (includes `owned-block-seed.spec.ts` 6 helper cases + memory
  `listBlockIds` cases + node-wiring specs); backends fs `25`, ns `34`, rn `30`, web `27`.
- Lint: `eslint` clean on all touched files.

## Review findings

**Checked:** the full implement diff (interface, all five backend impls, `keys.ts` range/decode,
the extracted helper, the node-base wiring + stop-wrapper chain), the fs deviation reasoning, tuple
shapes / range bounds in leveldb, backend consistency (all enumerate the same metadata population),
absence of any decorator/wrapping `IRawStorage` that could silently drop the new method, docs/comment
freshness, and every backend's new tests. Ran build + full test suites + lint.

**Correctness — no defects found.**
- leveldb `metadataRange()` bounds verified: `[0x01, ...]` metadata keys sort strictly inside
  `[0x01, 0x02)`; higher-tag keys (revision/pending/…) for the same block are excluded. Encode/decode
  in `keys.ts` round-trip correctly. rn test asserts higher-tag keys are not decoded as ids.
- fs meta.json gate correctly excludes pending-only dirs; ENOENT → not-owned, other errors surface
  (matches `directoryByteSize` discrimination). No blockId encoding mismatch (dir name is the raw
  blockId, same as `getBlockPath`).
- Wiring passes the *same* shared `ownedBlocks` instance the monitors read; gate (`offOwnedBlockFeed`)
  is truthy only when a monitor subscribed; stop-wrapper chain (feed-teardown → arachnode → seed) is
  correctly nested. Fire-and-forget `.catch` uses the same `(node as any).logger?.forComponent?.(…)`
  pattern already used at the spread-init site — no cleaner `log` is in scope there.

**Minor — fixed inline this pass.**
- Stale comment in `libp2p-node-base.ts` (~line 830) still called the startup seed "a follow-on
  enhancement (optimystic-owned-block-initial-scan-seed)" — but it now IS implemented ~20 lines
  below. Rewrote it to point at `seedOwnedBlocksFromStorage` as the live seeding path.

**Major — filed as a new ticket.**
- No end-to-end test constructs a real node over a **pre-populated disk backend**, lets the
  fire-and-forget scan settle, and asserts the monitor's set contains the seeded ids. The loop, the
  gate/teardown, and each backend's `listBlockIds` are individually tested, but the integration seam
  (node construction → background task → real monitor set) is unverified. Low-risk (wiring is ~8
  gated lines, every piece tested) → filed `tickets/backlog/debt-owned-block-seed-e2e-restart-test.md`
  rather than blocking.

**Tripwires — parked in-code (not tickets), verified present:**
- `libp2p-node-base.ts:1143` `NOTE:` — concurrent rebalance-release can `untrackBlock` a
  confirmed-released id mid-scan and the scan may re-add it; benign transient (re-evaluated + released
  next tick), accepted rather than synchronized.
- `file-storage.ts:165` and `sqlite-storage.ts:57` `NOTE:` — whole-listing / whole-table enumeration
  up front; page it only if a store ever grows to millions of blocks and startup latency shows it.
- `indexeddb-storage.ts` `getAllKeys('metadata')` materializes all keys into one array despite the
  `AsyncIterable` signature — same scale tripwire, noted in the backend's Known-gaps (fine at scale).

**Docs:** no `docs/` file references this seam; the relevant knowledge lives in code comments, which
were read and (the one stale spot) corrected. No other doc updates needed.
