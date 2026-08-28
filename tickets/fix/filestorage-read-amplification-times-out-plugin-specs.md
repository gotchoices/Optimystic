description: The FileRawStorage-backed quereus-plugin specs re-read the same tiny files hundreds of times per test (one block's `meta.json` alone is read ~270× per test), so a run costs ~1,500 filesystem reads to verify two rows. On any host where a small read costs milliseconds, those specs run 6–40s against 15–20s Mocha budgets and time out non-deterministically — 11 failures in a workspace-alone run at HEAD. A ready-built cache layer (`CachedStoreDriver`/`CachedRawStorage`) exists, is unit-tested, and has no production call site.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/atomic-write.ts
difficulty: high
----

# FileRawStorage read amplification makes the plugin specs time out

## Reproduce

```
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter spec --exit
```

At HEAD (`b43368c4`), with all sibling portal dists confirmed fresh, this gives:

```
645 passing (13m)
13 pending
11 failing
```

The prior triage report claimed the workspace-alone run was green (`656 passing (3m), 0 failing`).
That was a lucky run, not a refutation — see *Why the timings swing* below. The failure is real and
reproduces at HEAD.

### The 11 failures

All are Mocha timeouts (no assertion ever fails), and every one of them is a spec that drives a real
`FileRawStorage` directory:

| # | Spec | Test | Budget |
|---|---|---|---|
| 1, 2 | `committed-read-isolation.spec.ts` | degraded-latch pair | 30000ms |
| 3 | `composite-pk-point-lookup.spec.ts` | two-column PK point lookup | 15000ms |
| 4, 5, 6 | `deferred-constraint-rollback.spec.ts` | three rollback cases | 15000ms |
| 7 | `distributed-transaction-validation.spec.ts` | sequential txns from multiple nodes | 120000ms |
| 8, 9 | `oldkeyvalues-compact-shape.spec.ts` | composite-PK UPDATE / DELETE | 15000ms |
| 10 | `update-pk-move-uniqueness.spec.ts` | PK-move aborted inside a txn | 15000ms |
| 11 | `update-pk-move-uniqueness.spec.ts` | the `afterEach` hook for #10 | — |

Representative error:

```
Error: Timeout of 15000ms exceeded. For async tests and hooks, ensure "done()" is called;
if returning a Promise, ensure it resolves.
 (C:\projects\optimystic\packages\quereus-plugin-optimystic\test\update-pk-move-uniqueness.spec.ts)
    at listOnTimeout (node:internal/timers:608:17)
    at process.processTimers (node:internal/timers:543:7)
```

Failure #11 is a **cascade of #10, not an independent bug**: when Mocha kills the test mid-write, the
spec's `afterEach` `fs.rm` races the still-in-flight `atomicWriteFile`, so the rmdir sees a directory
that is being repopulated:

```
Error: ENOTEMPTY: directory not empty, rmdir
'C:\Users\n8ers\AppData\Local\Temp\optimystic-update-pk-move\<uuid>\<blockId>\revs'
```

Fixing the timeout removes this one too. Do not chase it separately.

## Root cause

`BlockStorage` re-reads block metadata from the raw store on essentially every operation — there are
ten separate `await this.storage.getMetadata(this.blockId)` sites in
`packages/db-p2p/src/storage/block-storage.ts` (lines 33, 38, 118, 145, 173, 199, 298, 385, 461), with
no memoization at any layer beneath them. `StorageRepo` constructs a fresh `BlockStorage` per block id
per call (`new BlockStorage(blockId, rawStorage)` in `createLocalTransactor`), so nothing survives
between operations either.

Instrumenting `fs.promises` for a single run of `update-pk-move-uniqueness.spec.ts` (3 tests, tables
of **two rows**):

```
counts {"open":228,"rename":138,"readFile":1496,"mkdir":141,"readdir":249,"rm":3}
ms     {"open":574,"rename":445,"readFile":26989,"mkdir":512,"readdir":688,"rm":162}
total  29369 ms
```

`readFile` is 92% of the wall clock. Broken down by path (a faster run of the same spec, so the ms
are lower — the *counts* are the point):

```
n=382 C:/…/<TMP>/<ID>/meta.json
n=115 C:/…/<TMP>/pkmove/txn/meta.json
n=115 C:/…/<TMP>/pkmove/collide/meta.json
n=113 C:/…/<TMP>/optimystic/schema/meta.json
n=111 C:/…/<TMP>/<ID>/revs/1.json
n= 92 C:/…/<TMP>/pkmove/free/meta.json
n= 63 C:/…/<TMP>/<ID>/revs/2.json
…
```

~817 of the 1,496 reads are `meta.json` — the same handful of files, re-read from disk hundreds of
times inside a single test. That is the defect. It is invisible on `MemoryRawStorage` (which is what
almost every other spec uses) because a map lookup is free; it is the entire cost on
`FileRawStorage`.

### Why the timings swing

Measured on this host, a `readFile` of a small, just-written file costs **0.9–18 ms** depending on
machine state, and a full `atomicWriteFile` costs ~44 ms:

```
write+fsync+rename+fsyncDir (current): 43.58 ms/op
write+rename, no fsync:                19.60 ms/op
fsyncDir only:                          6.95 ms/op
```

This is host-level filesystem latency (Windows + real-time AV), **not** temp-directory size — a
benchmark against a repo-local directory was equally slow (4.37 vs 4.69 ms/readFile), so the 30k
entries in `%TEMP%` are a red herring; don't spend time there.

Multiply: 1,500 reads × 0.9 ms = 1.4s (spec passes, looks fine) versus 1,500 reads × 18 ms = 27s
(spec blows a 15s budget). The identical command on the identical tree produced **6s and 41s** runs
of the same spec file minutes apart. The specs are not flaky in their logic; they are sitting on a
workload whose cost is ~1,500× the per-read latency, with no headroom. Any host slower than the
fastest case fails, and this host fails often.

Corollary: the suite ordering is irrelevant. Bisecting the preceding spec files changed nothing;
`deferred-constraint-rollback.spec.ts` run *entirely alone* took 53s (8 tests, 3.2–10.3s each) on one
run and <6s on another. Do not go looking for a leak in an earlier spec — there isn't one.

## The fix direction

`packages/db-p2p/src/storage/` already contains the remedy, fully built and unit-tested
(`packages/db-p2p/test/cached-raw-storage.spec.ts`):

- `CachedStoreDriver` — byte-layer cache over a `RawStoreDriver`, write-through, with a
  proven-absence (`null`) vs unknown (`undefined`) distinction and revision-range coverage tracking.
- `CachedRawStorage` — the same thing composed over an `IRawStorage` that does not expose its driver.
- `SharedCachePool` — a process-wide 2Q pool with a byte budget shared across stores.

**Neither has a single production call site.** Grepping `CachedStoreDriver|CachedRawStorage` across
`packages/*/src` returns only their own definitions and their own tests. The obvious shape of the fix
is to wire one of them into the storage composition — most directly at
`collection-factory.ts:292`:

```ts
const rawStorage = options.rawStorageFactory?.() ?? new MemoryRawStorage();
```

Do not assume that one line is the whole job — see the constraints below.

## Design constraints

- **Cache coherence is the whole risk.** The specs that fail are precisely the ones that assert
  cross-instance visibility: `committed-read-isolation`, `session-mode-commit` reopen durability,
  `schema-catalog-index-durability`, and every `(in-session + reopen)` case. Each closes its
  `Database` and reopens the *same* directory expecting to observe what was written. A cache that
  outlives the reopen, or that serves a stale `meta.latest`, converts these from timeouts into
  wrong-answer failures — strictly worse. Any wiring must guarantee a reopened store starts cold.
- **Pool keys are already store-scoped, so cross-directory aliasing is not a hazard.**
  `SharedCachePool.keyFor` prefixes every key with the per-store handle id
  (`shared-cache-pool.ts:225`), and `registerStore` never reuses an id. Two temp directories holding
  the same deterministic block id (e.g. `tree://pkmove/collide`, which several specs create in
  different dirs) will not collide. This is load-bearing evidence that the wiring is viable — verify
  it still holds rather than re-deriving it.
- **There is no dispose path, and the cache needs one.** `FileStoreDriver`'s constructor carries a
  standing `TODO: … also introduce explicit dispose pattern`, and `createLocalTransactor` never tears
  its storage down. `SharedCachePool.unregisterStore` exists and must actually be called, or every
  `Database` in a 650-test process leaks a registered store handle plus its resident entries. Decide
  the lifecycle before the wiring.
- **Multi-writer basePath.** `FileStoreDriver` takes no lock (the `proper-lockfile` TODO at
  `file-storage.ts:57`) and is documented as last-writer-wins. Caching is only sound while a
  basePath has one writing process. The local transactor satisfies that; state the assumption
  explicitly at the wiring site rather than leaving it implicit, and confirm the libp2p-backed specs
  do not share a directory between nodes.
- **Do not "fix" this by raising the Mocha budgets.** The budgets are not the defect; 1,500 reads to
  check two rows is. Raising them hides the regression signal and leaves production doing the same
  amplification over a network. (Skipping, loosening, or deleting these tests is likewise not on the
  table — they are the only coverage for PK-move uniqueness, deferred-constraint rollback, and the
  committed-read latch.)

## Secondary (in scope, but not the fix)

`atomicWriteFile` calls `fsyncDir` after **every** write. On win32 that is guaranteed to fail — the
function's own doc says directory fsync "is unsupported on win32 and its error is swallowed" — yet it
still pays an `fs.open` on the directory each time, measured at **6.95 ms/op** here (~1s per spec at
138 renames). Skip it on `process.platform === 'win32'` instead of opening-and-failing. This is
correct and free, but it is roughly 4% of the problem: land it with the fix, not instead of it.

## Cross-cutting obligations

Checked; none of the usual ones are triggered by the fix direction above:

- **Determinism edition bump** — not required. No consensus-visible behaviour changes; caching is
  local read acceleration.
- **On-disk byte format** — unchanged. No new format vector needed. (The `fsyncDir` change alters
  durability *timing* on win32 only, where the call never succeeded anyway.)
- **Golden fixtures / migration** — none. The directory layout under `basePath/<blockId>/` is
  untouched.

If the implementation instead changes what `BlockStorage` persists (rather than what it re-reads),
re-evaluate all three — that would be a different ticket.

## Suspect files

- `packages/db-p2p/src/storage/block-storage.ts` — the ten unmemoized `getMetadata` sites.
- `packages/db-p2p/src/storage/storage-repo.ts` — constructs a fresh `BlockStorage` per call.
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:288-292` —
  `createLocalTransactor`, the composition point that skips the cache.
- `packages/db-p2p/src/storage/cached-store-driver.ts`,
  `packages/db-p2p/src/storage/cached-raw-storage.ts`,
  `packages/db-p2p/src/storage/shared-cache-pool.ts` — the unwired remedy.
- `packages/db-p2p-storage-fs/src/file-storage.ts`,
  `packages/db-p2p-storage-fs/src/atomic-write.ts` — the fs driver and the win32 `fsyncDir` waste.

## TODO

- [ ] Add a regression guard that counts raw-store reads for a fixed workload (e.g. a two-row
      INSERT + UPDATE against a counting `RawStoreDriver`) and asserts an upper bound. A wall-clock
      assertion would be as host-dependent as the bug; an operation-count assertion is not. This is
      the test that actually pins the fix.
- [ ] Decide the cache lifecycle: who registers the store, who calls `unregisterStore`, and how a
      `Database` close guarantees the next open over the same basePath starts cold.
- [ ] Wire the chosen cache layer into `createLocalTransactor` (and audit whether the network/repo
      composition wants the same treatment — likely yes, but confirm before widening scope).
- [ ] Skip `fsyncDir` on win32 in `atomicWriteFile`.
- [ ] Re-run the full `@optimystic/quereus-plugin-optimystic` suite several times and confirm 0
      failures across runs, plus the per-spec read counts dropped by the expected order of magnitude.
- [ ] Re-run `@optimystic/db-p2p` (2254 passing at HEAD) — it owns the cache layer's own tests and is
      where a coherence regression would first surface.
- [ ] On landing, remove the `filestorage-read-amplification-times-out-plugin-specs` entries from
      `tickets/.pre-existing-known.md`.
