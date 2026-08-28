description: Saving or reading a single row causes the same few tiny files to be read from disk hundreds of times over. On a machine where disk reads are slow this makes a handful of tests take so long they are killed for running over time. A ready-built caching layer already exists in the codebase but was never plugged in; plug it in.
files: packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, docs/repository.md, tickets/.pre-existing-known.md
difficulty: hard
repro: verified
----

# Wire the write-through raw-storage cache into the storage composition seams

## What is wrong

`BlockStorage` re-reads block metadata from the raw store on essentially every operation — ten
separate `await this.storage.getMetadata(this.blockId)` sites in
`packages/db-p2p/src/storage/block-storage.ts`, with no memoization at any layer beneath them —
and `StorageRepo` builds a fresh `BlockStorage` per block id per call, so nothing survives between
operations either. On `MemoryRawStorage` this is free. On `FileRawStorage` every one of those calls
is a real `fs.readFile` of a file that was just read.

The fix layer already exists, is unit-tested (`packages/db-p2p/test/cached-raw-storage.spec.ts`),
and has **no production call site**. This ticket wires it in.

## Measured, at HEAD (`65373ba0`), after `yarn build`

Workload: one `create table … using optimystic('tree://pkmove/free')`, one `insert`, one PK-move
`update`, one `select`; then `db.close()`, a fresh `Database` over the **same** directory,
`plugin.hydrate`, one more `select`. That is the third test of
`test/update-pk-move-uniqueness.spec.ts`, reduced to a script. Counters wrap `fs.promises` (the
same singleton `file-storage.ts` and `atomic-write.ts` import) and the `IRawStorage` instance.

| counter | baseline (`FileRawStorage`) | with cache | ratio |
|---|---|---|---|
| `fs.readFile` | **314** | **32** | 9.8× |
| `fs.readdir` | 53 | 12 | 4.4× |
| `fs.open` | 76 | 76 | — |
| `fs.rename` | 46 | 46 | — |
| `fs.mkdir` | 46 | 46 | — |
| `IRawStorage.getMetadata` | 181 | 181 | — |
| wall clock (3 runs each) | 878 / 424 / 358 ms | 157 / 165 / 170 ms | ~2.4× |

Two things to read off that table:

- **181 `getMetadata` calls for a two-statement workload** is the defect, restated in one number.
- **The `IRawStorage`-level counts do not change.** The cache sits *below* that seam. A regression
  guard that counts `IRawStorage` calls would measure nothing at all — see the TODO.

Write-side counts are unchanged, as expected: the cache is write-through, so every save still
reaches disk.

## Decisions already made — do not re-derive these

### Use the wrapper form (`CachedRawStorage`), not the driver-direct form

`CachedStoreDriver`'s own class doc prefers wrapping a backend's `RawStoreDriver` directly
(`new KvRawStorage(new CachedStoreDriver(driver))`) because the wrapper form pays an extra
encode/decode on each cold miss. **Both forms were measured on the workload above and produced
identical filesystem counts (32 `readFile`, 12 `readdir`); the wall-clock difference was inside
run-to-run noise.** The double codec pass does not show up at this scale.

The wrapper wins on everything else:

- The composition seams hand out an `IRawStorage`, not a driver. `KvRawStorage.driver` is
  `private`, so driver-direct wiring would need a new public accessor on the kernel.
- Caching *inside* `FileRawStorage` would change behaviour for every existing consumer, including
  `packages/db-p2p-storage-fs/test/file-storage.spec.ts`, which deliberately writes files behind
  the storage object's back (a truncated `meta.json` at line 94, `not json at all` at line 105, a
  legacy raw-colon pending file at line 262) and then reads through it. Those tests pass today only
  because they mutate before the first read; a cache would make them silently order-dependent.
  Leave `FileRawStorage` uncached.

### Cache lifecycle: reopen coldness is already free; dispose is hygiene, not correctness

This was the ticket's biggest open question. Answer, verified by the reopen assertion in the
measurement above (a reopened `Database` read the correct post-update value through the cache):

`register(db, config)` (`packages/quereus-plugin-optimystic/src/plugin.ts:28`) constructs a **new**
`CollectionFactory` every call. Its `transactors` map, the `rawStorageFactory()` call, and therefore
the cache instance and its `SharedCachePool` store handle are all per-`register()`. A spec that
closes its `Database` and re-opens the same directory calls `register` again and gets a cold cache.
Nothing needs to be done to make reopen correct.

What is *not* free: nothing calls `unregisterStore`. `SharedCachePool.registerStore` hands out a
fresh id per call and never reuses one, so a 650-test process accumulates one dead
`CacheStoreHandle` per `Database`. Entries belonging to dead stores stay charged against the shared
budget until 2Q evicts them as cold. This is bounded (the pool has a byte budget and always evicts,
never refuses) and small, so it is **hygiene, not a correctness bug** — but wire it anyway, because
a long-lived provider node deserves honest occupancy numbers.

There is no `Database`-close hook that reaches the `CollectionFactory`: the vtab module's
`disconnect()` is per-statement and its `destroy()` is `DROP TABLE`. So dispose must be explicit —
a method on `CollectionFactory`, surfaced on the object `register()` returns. Do **not** rewrite the
18 existing spec files to call it; document it and let the bounded leak stand where hosts don't.

### Cross-directory aliasing is not a hazard — verified, don't re-check

`SharedCachePool.keyFor` (`shared-cache-pool.ts:225`) prefixes every key with the per-store handle
id, and `registerStore` (`:190`) increments a counter that is never reused. Two temp directories
holding the same deterministic block id (`tree://pkmove/collide` appears in several specs, in
different directories) cannot collide.

## Design

One helper, applied at both composition seams, with the `MemoryRawStorage` exclusion stated once:

```ts
/**
 * Wrap a raw storage in the write-through read cache, unless it is already in memory
 * (wrapping MemoryRawStorage adds bookkeeping with nothing to save — see CachedStoreDriver's
 * class doc). Returns the storage unchanged when caching would not pay.
 *
 * Precondition: one process owns this storage's backing store. FileStoreDriver takes no
 * cross-process lock (the proper-lockfile TODO at file-storage.ts:57) and is last-writer-wins;
 * a second writing process bypasses this cache and makes its values stale.
 */
export function withReadCache(storage: IRawStorage, label?: string): IRawStorage
```

The two seams:

- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:292` —
  `createLocalTransactor`. This is the one that fixes the failing specs.
- `packages/db-p2p/src/libp2p-node-base.ts:398` — `resolveStorage(options.storage)`, the single
  place the network node resolves its raw storage.

Both currently read `provider?.() ?? new MemoryRawStorage()`, so the helper drops in at one line
each and the memory case falls through untouched.

### The network seam carries one extra consideration

The review of `tickets/complete/coherent-raw-storage-cache.md` flagged that proven-absence negatives
are cached by design, and `StorageRepo.get` is reachable from a remote peer with an arbitrary
block-id list (`repo/service.ts:273`) — so a remote peer can drive negative-entry growth. That
review concluded the bound is exactly what the shared pool provides, and the pool has since landed
(`tickets/complete/shared-bounded-cache-pool-with-2q-admission.md`): one-off scans die in A1in
probation rather than displacing hot entries, and the pool always evicts and never refuses. That is
the accepted answer; wire the seam.

**Drop this arm and file separately if** implement finds any configuration where two nodes are
pointed at one `basePath`. Caching is sound only under the single-process-owner precondition, and
that precondition is not enforced in code. Grep the mesh harnesses and integration specs before
wiring this seam; `mesh-harness.ts:322` takes a per-node-index factory, which is the right shape,
but confirm the integration specs actually give each node its own directory.

## Secondary: skip the directory fsync on win32

`atomicWriteFile` calls `fsyncDir(dir)` after every write. On win32 the `fs.open(dir, 'r')`
**succeeds** and the subsequent `handle.sync()` fails with `EPERM`, which is swallowed — so the
work is guaranteed to be wasted, and it is exactly half of all `fs.open` calls (76 opens for 38
writes in the measurement above). Skip it when `process.platform === 'win32'`.

**Magnitude, corrected.** The fix ticket cited 6.95 ms/op for this. Re-measured on the same host in
a fast filesystem window it is **0.10 ms/op** (`readFile` was 0.59 ms/op in that same window versus
the 0.9–18 ms/op range the fix ticket measured). The cost is proportional to whatever the host's
current filesystem latency is; it is not a fixed 7 ms. It is correct and free either way — land it,
but do not expect it to carry the fix. This changes durability *timing* on win32 only, where the
call never succeeded, so no on-disk format or determinism concern.

## About reproducing the original timeouts

Do not expect to reproduce the 11 Mocha timeouts on demand. This host swings between roughly
0.6 ms and 18 ms for a small `readFile`, and the specs fail only in the slow state — the fix
ticket saw 6s and 41s runs of the same spec file minutes apart. Throughout the investigation for
this ticket the host was in its fast state and the plugin suite would very likely have passed.

**The operation counts above are the reproduction**, and they are host-independent. Pin the fix
with those, not with wall clock.

## Cross-cutting obligations — checked, none triggered

- **Determinism edition bump**: not required. Nothing consensus-visible changes; this is local read
  acceleration.
- **On-disk byte format**: unchanged. The `basePath/<blockId>/` layout is untouched, so no new
  format vector and no golden-fixture or migration work.

If implementation instead changes what `BlockStorage` *persists* rather than what it re-reads,
stop — that is a different ticket, and all three of the above need re-evaluating.

## Documentation

`cached-store-driver.ts:142`, `:153` and `cached-raw-storage.ts:157` all cite **`docs/storage.md`**
for the soundness invariants (numbered 1–5) and the single-process-owner precondition. **That file
does not exist.** The invariants the cache's correctness argument rests on are written down nowhere.

Per AGENTS.md ("Don't create summary documents; update existing documentation"), add the section to
`docs/repository.md` — which already owns "Block Storage Repository" (L159), "Implementation Notes"
(L209) and "Invariant P" (L132) — and repoint those three references at it. State the numbered
invariants explicitly (every write funnels through `IRawStorage` in-process; every `meta.latest`
writer holds the per-block commit latch and each cache update is synchronous with its inner write;
committed revisions and materializations are append-only; the cache is always clean; one process
owns the store) plus the wiring guidance and the `MemoryRawStorage` exclusion.

## TODO

### Regression guard (do this first — it is what pins the fix)

- [ ] Add a spec that drives a fixed workload through a counting `RawStoreDriver` and asserts an
      upper bound on reads. **Count at the `RawStoreDriver` seam, not `IRawStorage`** — the
      measurement above shows `IRawStorage` counts are identical (397) cached and uncached, so an
      `IRawStorage`-level counter would assert nothing.
- [ ] Make the assertion an operation count, never wall clock. Wall clock on this workload varied
      2.5× between runs on one host in one session.
- [ ] Assert the reopen arm too: close, reconstruct over the same backing store, and confirm the
      post-write value is observed. That is the coherence property the failing specs actually turn
      on.

### Wiring

- [ ] Add `withReadCache(storage, label?)` in `packages/db-p2p/src/storage/`, exported from the
      package index, with the `MemoryRawStorage` exclusion and the single-writer precondition in
      its doc comment.
- [ ] Wire it at `collection-factory.ts:292`.
- [ ] Confirm no mesh/integration configuration shares a `basePath` between nodes, then wire it at
      `libp2p-node-base.ts:398` (`resolveStorage`). If any shared-basePath configuration exists,
      skip this seam and file it.
- [ ] Add `dispose()` to `CollectionFactory` (calling `CachedRawStorage.dispose()` on each storage
      it created, which reaches `SharedCachePool.unregisterStore`), surface it on the object
      `register()` returns, and release it from the libp2p node's stop path for the network seam.
- [ ] Add one spec proving dispose actually unregisters — `SharedCachePool.stats()` store count
      drops — so the leak-hygiene claim is pinned rather than asserted.

### Secondary

- [ ] Skip `fsyncDir` on `process.platform === 'win32'` in
      `packages/db-p2p-storage-fs/src/atomic-write.ts`.

### Documentation

- [ ] Write the storage-cache invariants section into `docs/repository.md` and repoint the three
      dangling `docs/storage.md` references at it.

### Validation

- [ ] `yarn build`, then the full `@optimystic/quereus-plugin-optimystic` suite several times,
      confirming 0 failures across runs. Note in the handoff which filesystem state the host was in
      — a green run in a fast window is weak evidence on its own.
- [ ] `@optimystic/db-p2p` (2254 passing at HEAD) — it owns the cache layer's own tests and is
      where a coherence regression surfaces first.
- [ ] `@optimystic/db-p2p-storage-fs` — the shared conformance suite runs against `FileRawStorage`,
      and the out-of-band-mutation tests listed above are the ones a caching mistake would break.
- [ ] `yarn typecheck` (after build).
- [ ] Re-measure the read counts and report them in the handoff next to the baselines in the table
      above.
- [ ] Remove the seven `filestorage-read-amplification-times-out-plugin-specs` entries from
      `tickets/.pre-existing-known.md`.

## Noticed while investigating — not in scope, do not chase

- `atomicWriteFile` calls `fs.mkdir(dir, { recursive: true })` on **every** write (46 in the
  measured workload), even for a directory it created microseconds earlier. Measured at 0.10 ms/op
  in a fast window on this host. Cheap to memoize a known-created-directories set, but it is a
  separate site with its own crash-safety argument. If it is still visible after the cache lands,
  record it as a `NOTE:` at the site rather than filing it.
- `file-storage.ts:32` already carries a `NOTE:` that every guarded read parses the JSON twice (once
  to validate, once in the kernel's `decodeJson`). The cache removes most of those reads entirely,
  which makes that note *less* pressing, not more. Leave it.
