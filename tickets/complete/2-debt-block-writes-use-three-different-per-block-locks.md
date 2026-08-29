description: Block writes used to be guarded by three different, partly-overlapping locks, so two writers could each hold a lock and still overwrite each other. They now share one lock per block, enforced by the type system, and this review pass confirmed it holds.
files:
  - packages/db-p2p/src/storage/block-latch.ts
  - packages/db-p2p/src/storage/i-block-storage.ts
  - packages/db-p2p/src/storage/block-storage.ts
  - packages/db-p2p/src/storage/storage-repo.ts
  - packages/db-p2p/src/dispute/invalidation.ts
  - packages/db-p2p/test/block-storage.spec.ts
  - packages/db-p2p/test/storage-repo.spec.ts
  - packages/db-p2p/test/invalidation.spec.ts
----

# One block, one write lock

## What landed

A block's metadata is a single blob (`{ latest, ranges }`) read and written whole, so any
read-modify-write of it overwrites `latest` whether it means to or not. Three different per-block
locks previously guarded pieces of that — two writers could each hold one and still clobber each
other's metadata write.

There is now exactly **one** write lock per block, `Block.write:<blockId>`, and it is enforced by
the type system rather than by documentation:

- `block-latch.ts` is the sole acquirer of the key. It mints an opaque `BlockWriteLatch` token whose
  constructor is private, assigned from a `static {}` block — nothing outside the module can build one.
- Every writing method on `IBlockStorage` takes that token as its last parameter, so an unlatched
  write does not type-check. `BlockStorage.assertLatch` additionally rejects a token minted for a
  different block, and (added in this review) a token whose latch has already been released.
- `StorageRepo.commit` is the only multi-block holder; it acquires in sorted block-id order so two
  commits cannot deadlock. Every other caller uses the scoped `withBlockWriteLatch` and holds at
  most one block latch at a time.
- The dispute path's injectable latch runner (`InvalidationContext.withBlockCommitLatch`) is gone,
  so there is no longer an injection point through which an unlatched compensating write could be
  supplied. That retires the class, not just the instance.

## Review findings

### Checked and clean

- **Every writing method takes and asserts a latch.** All 12 latch-taking methods on `BlockStorage`
  (`restoreRevision`, `saveBlockProof`, `savePendingTransaction`, `deletePendingTransaction`,
  `saveMaterializedBlock`, `pruneSupersededMaterialization`, `saveRevision`,
  `promotePendingTransaction`, `setLatest`, `recover`, `saveReplica`, `saveDeletion`) call
  `assertLatch` first. None missed.
- **Single acquirer.** `grep -rn "Latches.acquire" packages/db-p2p/src` returns exactly one hit
  (`block-latch.ts`). No `commitLatchKey` / `withBlockCommitLatch` / `ensureRevision` survives in any
  `.ts` file.
- **Every writer call site in the repo is latched.** Swept all callers of the twelve writing methods;
  every non-raw-storage hit routes through `withBlockWriteLatch` or a token threaded from `commit`'s
  multi-latch acquisition.
- **Deadlock audit.** `Latches` is a process-global map keyed only by string and the key carries no
  node identity, so in-process multi-node setups share one latch per block id — already true of the
  old lock. What is new is a network fetch (`restoreRevision`) *inside* the latch, which would
  self-deadlock if a restore could be served from the same process for the same block. It cannot, on
  two independent grounds, both verified: `RestorationCoordinator.restore` filters `selfPeerId` out
  of both ring loops, and the mesh test harness builds `BlockStorage` with no `restoreCallback` at all.
- **Tests are deterministic, not timing races.** The two repro tests use gated raw storage. The three
  `delay(25)`/`delay(10)` assertions are negative assertions (proving a parked operation has NOT
  proceeded), which can only produce a false *pass*, never a flake.
- **No test skipped, weakened, or silently dropped.** One test was deleted — the "WITHOUT the latch,
  a concurrent commit clobbers the invalidation" repro — because the unlatched write it documented is
  now untypeable; a comment marks the spot. Everything else removed was mechanical latch-threading in
  test setup. `grep` over the implement diff confirms no `.skip`/`.only` was added.
- **`RevisionNotCoveredError`'s new arm in `readCommitBase` is unreachable today**, consistent with
  the implementer's own claim from the other direction: every writer of `meta.latest` merges an
  open-ended range anchored at or below the new latest in the same `saveMetadata`.

### Fixed in this pass (minor)

- **A released latch token still passed `assertLatch`.** `withBlockWriteLatch` hands its callback the
  token; nothing stopped a callback stashing it and writing after the scope closed — defeating the
  whole invariant at runtime while still type-checking. `BlockWriteLatch` now carries a private
  `#live` field expired by `release`, and `assertLatch` rejects a dead token. Additive: no current
  caller uses a token past its scope (audited). New test: *"a write latch token stashed past its
  scope is refused, writing nothing"* in `block-storage.spec.ts`.
- **`storage-repo.ts` had gained a runtime dependency on the concrete `block-storage.ts`.**
  `RevisionNotCoveredError` was a *value* import from the implementation, so any alternate
  `IBlockStorage` had to import `BlockStorage` (and its transitive deps) purely to throw the error
  its `getBlock` contract requires. The class moved to `i-block-storage.ts`, beside the `getBlock`
  doc comment that specifies it; the three importers were updated. No cycle, public surface unchanged.
- **`commit` deduplicated `request.blockIds` twice** — once for the sorted acquisition order and once
  for the request-order storage list — leaving a reader to wonder whether the two sets could disagree
  (`latches.get(blockId)!` depends on them being identical). Both now derive from one deduped array.

### Filed as a new ticket (major)

- `backlog/debt-invalidation-reports-writes-that-did-not-land` — `applyInvalidation` computes the
  compensating content *outside* the latch and takes the latch only around the write, so a commit
  landing in between makes `saveReplica`/`saveDeletion` hit their monotonic no-op. The returned
  effective revision is discarded, so `reverted` still records a restore that did not happen, and
  that list is appended to the durable invalidation log the cascade reads. **Pre-existing** (the old
  code discarded the same value) and dormant (the dispute subsystem is not registered on any live
  node), hence `debt-` rather than `bug-`. Site-claim grep run first: no open ticket covers it —
  `invalidation-live-wiring-requires-arbitrator-set-anchoring` is about verifying *who* authorized a
  reversal, not whether it landed.

### Recorded as a tripwire, not a ticket

- `storage-repo.ts` `readCommitBase` now carries a `NOTE:` explaining that the
  `RevisionNotCoveredError` arm is unreachable today, and that if a future change can leave `latest`
  uncovered, the ordering in `get` becomes load-bearing — the read-driven promotion runs *before*
  `readBlockHealing`, so `refuseMissingBase` would delete the pending record moments before the
  healing read would have restored it.

### Empty categories, with reasons

- **Documentation** — deliberately untouched. `packages/db-p2p/docs/storage.md` and
  `packages/db-p2p/README.md` still describe the old three-lock scheme, but ticket
  `block-write-latch-docs-and-commit-path-test` (in `implement/`) owns that rewrite in full; editing
  it here would collide with in-flight work. Read that ticket to confirm the scope matches.
- **Considered-and-declined findings** — two accepted-tradeoff `NOTE:`s exist in
  `block-storage.ts` (`vetRestoredArchive`: sticky lying-peer coverage; `noDivergentRewrite`:
  first-writer-wins on held revisions). Both carry revisit conditions and neither has tripped, so
  neither was re-filed.
- **Pre-existing test failures** — none. The full suite is green, so nothing was written to
  `tickets/.pre-existing-error.md`.

## Validation

All run from a clean tree after the review fixes:

| command | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p typecheck` | pass (also confirms the ES2022 `static {}` block the token minter relies on is within target) |
| `yarn workspace @optimystic/db-p2p test` | 2300 passing, 0 failing, 44 pending (pending count unchanged from before the change) |
| `yarn lint` (root) | pass |
| `yarn build` (root) | pass |
| `yarn typecheck` (root) | pass |
