----
description: Storing a small amount of data used to re-read the same handful of records dozens of times, making startup slow on a phone or busy disk. Those records are now kept in memory and updated as they are written, cutting repeat reads by about 96% on the measured workload.
files: packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/docs/storage.md, docs/internals.md, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
----

# Write-through coherent cache at the raw-storage seam

## What shipped

A write-through coherent cache at the byte layer of the storage stack, plus a wrapper form
for backends that only expose the higher-level interface. **No production call site wires
it** — adoption is the consumer's choice per the docs wiring guidance, and all existing
behavior is unchanged unless someone opts in.

- `packages/db-p2p/src/storage/cached-store-driver.ts` — `CachedStoreDriver implements
  RawStoreDriver`. Wraps any inner driver; wire as
  `new KvRawStorage(new CachedStoreDriver(innerDriver))`. All cache semantics live here.
- `packages/db-p2p/src/storage/cached-raw-storage.ts` — `RawStorageDriverAdapter` (presents
  a plain `IRawStorage` as a `RawStoreDriver`) and `CachedRawStorage extends KvRawStorage`
  (kernel → cache → adapter → inner storage), exposing `clearCache()`.
- Both modules exported from `src/index.ts` and `src/rn.ts`.
- `packages/db-p2p/docs/storage.md` §6 "Write-through raw-storage cache"; `docs/internals.md`
  clone-discipline section notes the cache sits inside the byte boundary.
- `packages/db-p2p/test/cached-raw-storage.spec.ts` — full backend-parity conformance over
  both compositions, twelve cache-specific coherence tests, and a measured cold-start
  workload.

### Semantics

- **Write-through, never invalidate, never write-behind.** Every save stores the encoded
  bytes into the cache synchronously after the inner write resolves — no `await` between.
  Commit-path crash-recovery write ordering is untouched.
- **Cached value type is `Uint8Array | null`**, where `null` = *proven* absence (confirmed
  inner miss or funnelled delete) and a map miss = unknown. A cached negative can never mean
  "could not confirm".
- **Read-miss fills are doubly guarded** — value guard (still unknown) and state-identity
  guard (the block's cache state object is still the live one), so neither a newer funnelled
  write nor a `clear()` landing mid-read can be undone by a stale snapshot.
- **Promote**: inner atomic move first, then one synchronous cache mutation — pending →
  proven-absent, pending-list id dropped, committed entry set from the cached pending bytes
  if present, otherwise **invalidated** (never synthesized). On throw, all three entries drop
  to unknown.
- **List completeness**: pending-id sets are served only after one full enumeration seeds a
  `complete` flag stored inside the same entry as the set; revision knowledge tracks covered
  inclusive rev intervals (adjacency-merged). Both enumerations snapshot a generation counter
  before draining and decline the completeness claim if a write or `clear()` landed mid-drain.
- **Errors**: a failed inner write drops the affected entries to unknown and rethrows.
- **Unbounded for now, deliberately** — bounding is `shared-bounded-cache-pool-with-2q-admission`.

### Measured result

Workload ≈ the profiled cold start (memory-backed, synthetic): `StorageRepo` over
`BlockStorage`, 6 blocks, 22 sequential pend→commit rounds, `repo.get` of every known block
each round. Counting driver under vs without the cache:

| driver method | uncached | cached |
|---|---|---|
| getMetadata | 360 | 6 |
| rangeRevisions | 133 | 21 |
| getPending | 44 | 0 |
| listPendingActionIds | 139 | 6 |
| getMaterialized | 133 | 0 |
| **reads total** | **809** | **33 (95.9% cut)** |
| **writes total (per-method identical)** | **126** | **126** |

The test asserts reads cut ≥70% and every write-method count unchanged. The workload is
synthetic — the ticket's real downstream consumer (React Native control DB) has not been
re-profiled with the cache.

## Review findings

### Checked

Read the implement diff (`102d735`, `c84a9a7`) against the `RawStoreDriver` contract,
`KvRawStorage`, `IRawStorage`, and the five storage invariants, before reading the handoff.
Traced every read/write/promote path for interleavings with concurrent writes, with `clear()`,
and with in-flight enumerations. Checked interval math (`coversRange`/`addCovered`) for
sortedness, disjointness and adjacency merging; optional-passthrough wiring
(`listBlockIds`/`approximateBytesUsed`/`close`) against the kernel's feature-detection rule;
byte-aliasing against the clone-on-read/write discipline; the adapter's mapping of every
`IRawStorage` method; source size (475 lines, one class per file, no function over ~30 lines);
and every doc the change touches or should have touched.

### Major — none filed

No finding rose to a new ticket. The one correctness defect found was a three-line fix at a
single site and was fixed in this pass (below); the one growth concern belongs to an already
open ticket and was appended there as an arm rather than re-filed.

### Fixed in this pass

- **Stale value reinstated past `clear()` (real defect, `cached-store-driver.ts`).** The
  read-miss fill for metadata, pending, transactions and materialized re-fetched the block's
  cache state *after* the inner await and filled whatever it found unknown. If a newer write
  landed during the read and a `clear()` then discarded the state object carrying it, the
  resumed read installed its older snapshot into the fresh state — and served that stale value
  for the rest of the process. Verified by re-applying the original code and watching the new
  test fail (`expected 2, actual 1`). The revision and pending-list paths already made the
  state-identity check; the four point-read paths did not. Fixed by a shared `fillMiss` helper
  carrying both guards (value + identity), with metadata spelling the same pair out inline
  because it is a property rather than a map entry. This also retires the handoff's
  "clear() racing an in-flight enumeration … not explicitly unit-tested" gap for the case that
  actually mattered. The identity check uses `blocks.get`, not `state()`, so a declined fill
  does not resurrect the block entry.
- **Test gaps.** Added two regression tests: the `clear()`-mid-read case above (deterministic,
  via a gated driver — no timing sleeps), and the write-error path (a failing inner
  `putMetadata` must leave the entry *unknown*, holding neither the attempted value nor the
  stale prior one, forcing a fall-through). The write-error recovery shape appears on every
  write path and had no coverage at all. Refactored the existing single-purpose gate in the
  spec into a reusable `Gate` so both tests share one rendezvous mechanism.
- **Broken doc citation.** Both `cached-store-driver.ts` and `docs/storage.md` cited "Invariant
  P" as living in `docs/repository.md`, a file that does not exist; it is documented on
  `IBlockStorage.promotePendingTransaction` (`src/storage/i-block-storage.ts`). Corrected in
  both. This is an instance of the class already tracked by
  `backlog/debt-doc-code-citations-rot-silently` — evidence, not a new ticket.
- **Docs.** `docs/storage.md`'s "always clean, never dirty" bullet claimed `clear()` is correct
  at any instant; that was only true after the fix above, so the bullet now states *why*
  (in-flight fills check state identity). `docs/internals.md`'s clone-discipline section did
  not mention the new layer — added a sentence that the cache holds encoded bytes, never
  decoded objects, so it needs no cache-side cloning.

### Appended to an existing ticket (not re-filed)

- **Negative/empty entries are a remote-driven growth vector.** `state()` allocates a per-block
  cache state for *every* block id touched, including ones that do not exist — proven-absent
  negatives are cached by design, and `StorageRepo.get` is reachable from a remote peer with an
  arbitrary block-id list (`repo/service.ts:273`). Unreachable today (nothing wires the cache)
  and the bound is exactly what `implement/shared-bounded-cache-pool-with-2q-admission` exists
  for, so it was appended there as an arm plus a `NOTE:` at the `state()` site.
- **That ticket's premise was stale.** It asserted the prereq would hook the `KvRawStorage`
  kernel ("this is why the prereq hooks there") and listed `kv-raw-storage.ts` in `files:`. The
  implementation hooks one layer below, at the driver. Corrected the `files:` list and added a
  boxed correction note, so the next agent is not sent to the wrong seam.

### Tripwires (recorded at the site, not filed)

- `rangeRevisions`' cache-hit path walks every integer in `[lo, hi]` rather than the present
  revs. Fine while revisions are dense (one per commit) and callers bound `hi` by a real
  `latest.rev` (`storage-repo.ts:445`, `:596`; `block-storage.ts:386`); if a sparse or very
  wide range ever appears, iterate sorted `byRev` keys instead. `NOTE:` at the site.
- The implementer's `JSON.parse`-per-hit tripwire (decode still paid on every cache hit) was
  reviewed and left as-is: correctly conditional, already a `NOTE:` in the class doc.

### Considered and declined re-opening

The handoff's four documented declines were re-weighed and left standing: the metadata-birth
completeness shortcut (pending-sans-metadata really is reachable at the raw layer — the
conformance suite writes it), the filesystem advisory lock (out of file scope; Invariant 5 is
documented with an embedder note), the un-guarded memory-backend wrapping (documented, harmless,
and tests depend on wrapping it), and the unlatched same-actionId pend-during-promote race
(pre-existing at every layer; the cache's promote mutation is synchronous, so it neither widens
nor closes the window). `RawStorageDriverAdapter` not forwarding `close` is also correct, not an
omission: `IRawStorage` has no `close`, and the kernel deliberately never wires the driver's
optional one (`db-p2p-storage-rn/src/leveldb-storage.ts:177`).

### Not covered — stated plainly

- **No persistent-backend run.** The cache is still exercised over the memory driver only.
  Running conformance over `FileRawStorage`/LevelDB/SQLite/IndexedDB with the cache interposed
  is a one-line addition to each backend package's existing conformance spec, but those
  packages are outside this ticket's file scope and none of them changed.
- **The op-count workload remains synthetic**, as the implementer stated; the downstream React
  Native control DB has not been re-profiled.

## Validation

- `yarn workspace @optimystic/db-p2p run build` — clean; root `yarn build` across all
  workspaces — clean.
- `npx eslint packages/db-p2p/src/storage packages/db-p2p/test/cached-raw-storage.spec.ts` —
  clean.
- `yarn workspace @optimystic/db-p2p run test` — **1676 passing, 44 pending, 0 failing**
  (1674 before; the two new regression tests are the delta). The 44 pending are pre-existing
  skips unrelated to this change. Op-count assertion still reports a 95.9% read cut with every
  write count unchanged.
