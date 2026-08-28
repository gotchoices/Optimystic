description: A caching layer was added so that reading from disk-backed storage stops re-reading the same small files hundreds of times per query; this pass built it, measured the improvement, and fixed a real bug the cache introduced where two parts of one program stopped seeing each other's saved data.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/db-p2p/docs/storage.md, docs/repository.md
difficulty: medium
----

# Review: write-through read cache in front of file-backed raw storage

Two commits' worth of work. `119ef173` landed the code (unbuilt, untested). **This pass** built
it, measured it, calibrated the regression bounds from real numbers, wrote the docs, and — the
part most worth your attention — **found and fixed a correctness regression the cache
introduced**, then filed the underlying design gap as
`backlog/debt-two-caches-over-one-store-never-converge`.

## What the change does

`BlockStorage` re-reads block metadata on essentially every operation and `StorageRepo` builds a
fresh `BlockStorage` per block per call, so nothing above the raw-storage boundary memoizes. Over
a filesystem backend that is hundreds of reads of the same tiny files per statement.
`withReadCache(storage, label?, pool?)` is now the single seam that puts `CachedRawStorage` in
front of a persistent backend. It returns the storage unchanged for `MemoryRawStorage` (nothing
to save) and for an already-wrapped `CachedRawStorage` (no double-wrap). Two call sites:
`CollectionFactory.createLocalTransactor` and `libp2p-node-base.ts` `resolveStorage`.

## Measured results (this pass, not inherited)

Throwaway A/B script, both arms in one process on the identical create/insert/PK-move-update/
select workload, with **only the wrap decision** changed between arms. (The uncached arm used a
`getPrototypeOf` Proxy to report as `MemoryRawStorage` so `withReadCache` skipped it —
`withReadCache` is the only `instanceof MemoryRawStorage` site in the tree, verified by grep, so
nothing else in the system branched on it.) Script deleted; the numbers below are the whole
artifact.

Driver seam (`RawStoreDriver`, below the cache):

| | uncached | cached |
| --- | --- | --- |
| `getMetadata` | 113 | **6** |
| total reads (7 read methods) | 207 | **14** |

Filesystem syscalls over `FileRawStorage`, same workload:

| | uncached | cached |
| --- | --- | --- |
| `readFile` | 184 | **9** |
| `readdir` | 29 | **6** |
| `open` | 38 | 38 |
| `rename` / `mkdir` | 46 / 46 | 46 / 46 |
| wall clock | 789 ms | 165 ms |

**Read the `open` row carefully.** It did not improve because the win32 `fsyncDir` skip (also part
of this work) was already active in *both* arms — that change is orthogonal to the cache, so this
A/B does not measure it. The source ticket predicted `open` 76 to 38; 46 renames each previously
opened their containing directory to fsync it, and 38 + 46 = 84, close to that 76 baseline, which
is consistent — but **I did not measure the pre-fsync-skip state directly.** Treat the fsync-skip
magnitude as inferred, not measured. Wall clock is a single sample on a noisy host; the operation
counts are the real evidence.

An unrelated pre-existing db-p2p spec independently prints `809 -> 33` reads (95.9% cut) on its own
workload, which corroborates the direction.

The source ticket's baseline figures (181 `getMetadata`, 314 `readFile`, 53 `readdir`) came from a
different workload and **do not reproduce** on the one the regression spec runs. Everything above
supersedes them.

## The correctness regression, and the fix

`read-pull-mechanism.spec.ts` "count(*) observes a second writer's committed appends" **failed on
all three of my first three plugin-suite runs** — peer A saw 1 row where 3 were expected. This was
caused by this change, not pre-existing. A/B, same script:

| wiring | peer A's count after peer B commits 3 |
| --- | --- |
| no cache (pre-change behavior) | 3 — correct |
| two `FileRawStorage(dir)`, one cache each (what the test did) | **1 — wrong** |
| one *unwrapped* instance passed to `withReadCache` twice | **1 — wrong** |
| one `CachedRawStorage` object shared by both peers | 3 — correct |

Cache identity is per-object; nothing knows two storage objects share a directory. The test used
two `Database`s over one directory as a cheap stand-in for two network peers, so it got two caches
that never converge.

**Fix applied:** the cross-writer test now constructs one `CachedRawStorage` and hands the same
object to both peers. **No assertion was weakened, nothing was skipped** — it still expects 3 rows
and still asserts the read path issued a pull (`treeUpdate > 0`), which is what that test is
actually for. Row 3 of the table is the subtle part and is now documented at both sites: sharing
the *inner* storage is not enough, because each `withReadCache` call re-wraps it.

**This is the finding to push hardest on.** My reasoning for fixing the test rather than the cache
was: real peers are separate processes with separate directories converging over the network
(covered by the mesh harness), and one-owner-per-store is documented as Invariant 5. But the
counter-argument is real and I want it weighed: a host that opens two `Database`s over one
directory now gets deterministic non-convergence, having written no cache-related code, with no
error. Before this change that configuration was merely racy (no lock, last-writer-wins); now it
is reliably wrong. I filed `backlog/debt-two-caches-over-one-store-never-converge` proposing
store-identity-keyed cache lookup (make the bad state unrepresentable) or a loud refusal at the
pool, because a doc note is not a guard. **If you think that should block rather than be deferred,
say so** — I judged the shape settled enough for backlog, but it is a legitimate "should we cache
at this seam at all" question.

## Validation actually run

All green, all foreground, on this pass after the final rebuild:

- `yarn build`, `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2269 passing**, 44 pending, 0 failing.
- `yarn workspace @optimystic/db-p2p-storage-fs test` — **60 passing**, 1 pending. The out-of-band
  mutation cases (truncated `meta.json`, `not json at all`, legacy raw-colon pending file) pass;
  `FileRawStorage` itself remains deliberately uncached.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **658 passing**, 13 pending, 0
  failing, run **three consecutive times** (168 s / 169 s / 192 s), plus a fourth run checked for
  exit code 0 (that script also runs `test:smoke`).
- `owned-block-seed-node-wiring.spec.ts` run explicitly (the node stop-wrapper touches its path) —
  2 passing.

**Host speed context**, since the source ticket asked: this host measured **4.4 ms average
`readFile`** over 300 reads of a small file — between the "fast" (~0.6 ms) and "slow" (~18 ms)
states the earlier ticket described. So the green plugin runs are moderate evidence, not the weak
evidence a fast-window run would be. No pre-existing failures surfaced;
`tickets/.pre-existing-known.md` is header-only and I added nothing to it.

## Regression bounds: calibrated, not guessed

The bounds in `local-transactor-read-cache.spec.ts` were placeholders (20 / 60) with a fabricated
"measured 6 / 16" comment. I pinned the assertions to exact equality, confirmed the spec's own
counters read **exactly 6 `getMetadata` / 14 total**, then set the shipped bounds to **20 / 45**
(~3x headroom for schema-catalog growth). The comment now states the real figures and the real
uncached baseline (113 / 207). The header doc block was rewritten for the same reason.

## Known gaps — please treat these as the starting point

- **The node seam has no end-to-end test.** Nothing asserts that a libp2p node's storage is
  actually a `CachedRawStorage`, or that node stop disposes it. The prior run judged a ~40 s node
  spin-up not worth it and I did not overturn that, but it means `resolveStorage`'s wrapping and
  the stop-wrapper's `finally` dispose are **verified only by reading the code**. This is the
  largest untested surface in the change. The seed-node wiring spec exercises the stop path but
  asserts nothing about the cache.
- **`plugin.dispose()` is opt-in and almost nothing calls it.** The 18 existing plugin spec files
  were deliberately not rewritten. A host that never disposes leaks cold pool entries the pool
  evicts under pressure — hygiene, not correctness — but it does mean the dispose path is covered
  only by the one new spec.
- **No fresh concurrent-node sharing audit.** The prior run checked every `RawStorageProvider` call
  site and found no concurrent sharing (`mesh-harness.ts` uses a per-node-index factory, the plugin
  mesh harness is memory-only, `reference-peer` builds one `FileRawStorage` per process, and
  `owned-block-seed-node-wiring.spec.ts` shares one `MemoryRawStorage` across two *sequential*
  nodes — excluded from wrapping anyway). I re-verified the `MemoryRawStorage` claim by grep but
  did not independently re-walk every provider site.
- **The win32 `fsyncDir` skip is not directly tested**, and its magnitude is inferred (see above).
  It also means a power-loss window exists on win32 that does not exist on POSIX; that tradeoff was
  made by the prior run and I did not re-litigate it.
- The uncached A/B arm used a Proxy trick. It is sound for measurement (grep-verified single
  `instanceof` site) but it is not the same as measuring the actual pre-change commit.

## Doc correction carried forward

The source ticket said to add a cache section to a root-level `docs/storage.md`. **That file does
not exist**; the real one is `packages/db-p2p/docs/storage.md`, and it already carried Invariants
1-5 and a section 6 "Write-through raw-storage cache". I extended that section's **Wiring** list
rather than duplicating it, and added a pointer bullet in `docs/repository.md` "Implementation
Notes" so a reader starting from the root docs finds the soundness argument. Both files also now
carry the sharpened coherence rule from the regression above.
