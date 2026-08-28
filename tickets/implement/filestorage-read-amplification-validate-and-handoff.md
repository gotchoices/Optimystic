description: The read cache has been wired in front of file-backed storage at both places it is created, with cleanup hooks and regression specs written; what remains is to build, run the test suites, calibrate the new spec's read-count bounds from a real measurement, and finish the documentation update.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/db-p2p/docs/storage.md, docs/repository.md, tickets/.pre-existing-known.md
difficulty: medium
----

# Finish: wire the write-through raw-storage cache (validation + docs + handoff)

Continuation of `filestorage-read-amplification-times-out-plugin-specs` (implement stage). The
prior run hit its token budget after landing all code edits and **before running any build or
test**. Nothing below has been compiled or executed yet — treat every claim in "What landed" as
"written, unverified".

## What landed (uncommitted, in the working tree)

- **`packages/db-p2p/src/storage/with-read-cache.ts`** (new, exported from the package index):
  `withReadCache(storage, label?, pool?)`. Returns the storage unchanged when it is a
  `MemoryRawStorage` or already a `CachedRawStorage`; otherwise wraps it in `CachedRawStorage`.
  Doc comment carries the single-process-owner precondition and the "wrap once, at the seam that
  owns the instance" rule.
- **Plugin seam** — `collection-factory.ts` `createLocalTransactor` now calls
  `withReadCache(options.rawStorageFactory?.() ?? new MemoryRawStorage(), 'quereus:local')` and
  records each resulting `CachedRawStorage` in a new `readCaches` list. New
  `CollectionFactory.dispose()` releases those caches (→ `SharedCachePool.unregisterStore`) and
  clears the transactor map (a later statement rebuilds a fresh, cold transactor — coherent).
  `shutdown()` now calls `dispose()` last. `plugin.ts` surfaces `dispose` on the object
  `register()` returns.
- **Network seam** — `libp2p-node-base.ts` `resolveStorage(provider, networkName)` wraps a
  supplied instance or factory result via `withReadCache(storage, \`node:${networkName}\`)`; the
  no-provider default stays a bare `MemoryRawStorage`. A stop wrapper installed immediately after
  `liveNode = node` (before `start()`, so it runs last in the wrapper chain) calls
  `rawStorage.dispose()` in a `finally` after `previousStop()`. The `RawStorageProvider` type doc
  now states the ownership rule (one instance → one running node; sequential restart reuse is
  fine).
  - Shared-basePath check done: the only shared-instance configuration is
    `test/owned-block-seed-node-wiring.spec.ts` (one `MemoryRawStorage`, two *sequential* nodes
    — excluded from wrapping anyway; its doc comment was updated). `mesh-harness.ts` uses a
    per-node-index factory; the plugin mesh harness is memory-only; `reference-peer` builds one
    `FileRawStorage` per process. No concurrent sharing found.
- **win32 fsync skip** — `atomic-write.ts` `fsyncDir` returns immediately on
  `process.platform === 'win32'`; doc comments updated.
- **Doc-path fix** — the three source references to `docs/storage.md` now say
  `packages/db-p2p/docs/storage.md`. **Correction to the source ticket:** that file EXISTS and
  already carries the numbered Invariants 1–5 and a §6 "Write-through raw-storage cache" with the
  same list. The source ticket looked for a root-level `docs/storage.md`. Do not move the section
  to `docs/repository.md`; update the existing one (see TODO).
- **Specs written (not yet run)**:
  - `packages/db-p2p/test/with-read-cache.spec.ts` — identity for memory / already-cached; wrapped
    storage cuts `READ_METHODS` at the `RawStoreDriver` seam to < ¼ of the uncached baseline on
    `runColdStartWorkload`; dispose-then-rewrap over one driver observes the last write cold;
    dispose retires the pool store (idempotent).
  - `packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts` — SQL workload
    (create table / insert / PK-move update / select) through `register()` with
    `rawStorageFactory: () => new KvRawStorage(countingProxy(MemoryStoreDriver))`; asserts
    `getMetadata` ≤ 20 and total reads ≤ 60 at the driver seam; `plugin.dispose()` drops
    `defaultCachePool().stats().stores.length` by one; reopen over the same driver sees the
    post-update value; second test covers dispose idempotence + statement-after-dispose.
    **The bounds (20 / 60) and the comment claiming "measured 6 getMetadata / 16 total" are
    PLACEHOLDERS — no measurement was taken. Replace both with real numbers (see TODO).**
- `tickets/.pre-existing-known.md` — the seven entries for this slug removed (file is now header
  only).

## TODO

### Build + calibrate

- [ ] `yarn build` (root). The plugin spec imports `../dist/plugin.js`, so nothing runs before this.
- [ ] `yarn typecheck`. Watch for: `RawStoreDriver` being exported from `@optimystic/db-p2p` as a
      type (the plugin spec imports it with `type`); the Proxy-based counting driver's
      `Reflect.get` typing.
- [ ] Run `local-transactor-read-cache.spec.ts` once, read the printed counts from the assertion
      messages (or add a temporary `console.log`), then set the bounds to roughly 3× the measured
      values and rewrite the "Measured through this seam" comment with the real figures. If the
      measured `getMetadata` count is NOT far below 181, the seam is not wired — stop and check
      `createLocalTransactor`.
- [ ] Re-measure filesystem counts against the table in the source ticket's history (baseline 314
      `readFile` / 53 `readdir` / 76 `open`; expected ≈32 / 12 / 38 after cache + win32 fsync skip)
      and report them in the handoff. A throwaway script wrapping `fs.promises` is enough; do not
      commit it.

### Documentation

- [ ] `packages/db-p2p/docs/storage.md` §6 "**Wiring:**" bullets (≈ line 340): add `withReadCache`
      as the production entry point, name the two seams (`CollectionFactory.createLocalTransactor`,
      `libp2p-node-base.ts` `resolveStorage`), the `MemoryRawStorage` pass-through, and the dispose
      obligations (`plugin.dispose()` / `CollectionFactory.dispose()`; node stop releases
      automatically). Keep the existing driver-direct and wrapper-form bullets.
- [ ] `docs/repository.md` "Implementation Notes" (≈ L209): one bullet pointing at
      `packages/db-p2p/docs/storage.md` § Invariants / §6 for the cache's soundness argument, so a
      reader starting from the root docs finds it.

### Validation

- [ ] `yarn workspace @optimystic/db-p2p test` (2254 passing at HEAD + the new spec).
- [ ] `yarn workspace @optimystic/db-p2p-storage-fs test` — the out-of-band-mutation tests in
      `file-storage.spec.ts` (truncated `meta.json`, `not json at all`, legacy raw-colon pending
      file) must still pass; `FileRawStorage` itself is deliberately uncached.
- [ ] `yarn workspace @optimystic/quereus-plugin-optimystic test` — run it **several times**; note
      in the handoff whether the host was in its fast (~0.6 ms `readFile`) or slow (~18 ms) state,
      since a green run in a fast window is weak evidence. Also run
      `owned-block-seed-node-wiring.spec.ts` in db-p2p explicitly (the stop-wrapper change touches
      its path).
- [ ] If anything fails that is plainly unrelated, follow the pre-existing-failure procedure; do
      not skip tests.

### Handoff

- [ ] Write `tickets/review/filestorage-read-amplification-times-out-plugin-specs.md` with: the
      measured before/after table, the docs correction above, the network-seam shared-instance
      audit, and known gaps — in particular that no spec exercises the **node** seam end-to-end
      (spinning a libp2p node just to assert `instanceof CachedRawStorage` was judged not worth
      40 s; say so and let review decide), and that `plugin.dispose()` is opt-in for hosts (the 18
      existing spec files were deliberately not rewritten to call it — bounded leak accepted).
