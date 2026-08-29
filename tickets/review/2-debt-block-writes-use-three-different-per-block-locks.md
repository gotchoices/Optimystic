description: Review pass over the one-block-one-write-lock change. Most of the adversarial reading is done and recorded below; three small fixes and the validation run are still outstanding.
files: packages/db-p2p/src/storage/block-latch.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/invalidation.spec.ts
difficulty: medium
----

<!-- resume-note -->
A prior review run read the whole implement diff (commits `701e8d12`, `5150997b`, `6355e1b7`) and
crossed its token budget before applying fixes or running validation. **No source edits were made —
the working tree is exactly the implement output.** Everything already checked is recorded below so
this run does not repeat it. Start at "Remaining work".

# Review of: one block, one write lock

## What the prior run verified (do not redo)

- **Every `IBlockStorage` writing method takes and asserts a latch.** All 12 latch-taking methods on
  `BlockStorage` call `assertLatch` first (`restoreRevision`, `saveBlockProof`,
  `savePendingTransaction`, `deletePendingTransaction`, `saveMaterializedBlock`,
  `pruneSupersededMaterialization`, `saveRevision`, `promotePendingTransaction`, `setLatest`,
  `recover`, `saveReplica`, `saveDeletion`). None missed.
- **Single acquirer.** `grep -rn "Latches.acquire" packages/db-p2p/src` returns exactly one hit
  (`block-latch.ts:51`). No stale `commitLatchKey` / `withBlockCommitLatch` / `ensureRevision`
  anywhere in `.ts`; the only remaining hits are `packages/db-p2p/docs/storage.md` and
  `packages/db-p2p/README.md`, which ticket `block-write-latch-docs-and-commit-path-test`
  (`tickets/implement/2.5-...`) owns in full — confirmed by reading that ticket. **Do not touch the
  docs in this pass.**
- **Every writer call site outside `block-storage.ts` is latched.** Swept the whole repo for
  `saveReplica|saveDeletion|savePendingTransaction|deletePendingTransaction|setLatest|
  promotePendingTransaction|saveRevision|saveMaterializedBlock|saveBlockProof|restoreRevision|
  .recover(`; every non-raw-storage hit routes through `withBlockWriteLatch` or a token threaded
  from `commit`'s multi-latch acquisition. The dispute path no longer has an injection point for an
  unlatched write (`InvalidationContext.withBlockCommitLatch` / `CollectionEnv.withBlockCommitLatch`
  are gone), which retires the whole class rather than the instance — the right shape.
- **Deadlock audit.** `Latches` (`packages/db-core/src/utility/latches.ts`) is a **process-global
  static** map keyed only by string, and `blockWriteLatchKey` carries no node identity — so
  in-process multi-node setups share one latch per block id. That was already true of the old
  `commitLatchKey`, but this change newly puts a network fetch (`restoreRevision`) *inside* the
  latch, which would self-deadlock if a restore could ever be served from the same process for the
  same block. It cannot today, on two independent grounds, both checked:
  `RestorationCoordinator.restore` filters `selfPeerId` out of both ring loops, and
  `testing/mesh-harness.ts` constructs `new BlockStorage(blockId, rawStorage)` with **no**
  `restoreCallback` at all (its `makeFetchArchive` feeds `reconcileBlock`, not the restore wire).
  Every scoped caller holds at most one block latch; `commit` is the only multi-latch holder and
  acquires in sorted id order.
- **`readCommitBase`'s new `RevisionNotCoveredError` path is effectively unreachable**, which
  matches the handoff's own claim from the other direction. Every writer of `meta.latest`
  (`setLatest`, `saveForwardRevision`, `recover`) merges an open-ended range anchored at or below the
  new latest in the same `saveMetadata`, so `latest.rev` is always inside `meta.ranges`. The real
  restore trigger is a read pinned *below* the block's earliest held rev. Corollary worth keeping:
  the read-driven promotion in `get` runs BEFORE `readBlockHealing`, so if a coverage gap under
  `latest` were ever reachable, `refuseMissingBase` would delete the pending record moments before
  the healing read would have restored it. Not reachable today; noted so a future change that can
  make `latest` uncovered knows the ordering is load-bearing.
- **Tests read and judged sound.** The two repro tests (`block-storage.spec.ts` →
  `describe('one block, one write lock')`) are deterministic gated-raw-storage tests, not timing
  races. The scope-overlap test keeps the old `LatchProbeStorage` probe as an independent witness.
  The injected-`setLatest` interleave test survives in `storage-repo.spec.ts`. The three
  `delay(25)` / `delay(10)` negative assertions are, as the handoff says, false-**pass**-only.
  `commit`'s block-id dedup already has coverage (`storage-repo.spec.ts:346`,
  "deduplicates block IDs").
- **No test was skipped, deleted-without-replacement, or weakened.** The one deleted test
  (`invalidation.spec.ts`, "WITHOUT the latch, a concurrent commit clobbers the invalidation") is
  deleted because the state it documented is now untypeable; a comment marks the spot. Everything
  else removed from the diff is mechanical latch-threading in test setup.

## Remaining work

### Findings to fix inline (all minor, all analysed — just apply)

- **A released latch token still passes `assertLatch`.** `withBlockWriteLatch` hands the token to
  its callback; nothing stops a callback from stashing it and writing after the scope closed, which
  silently defeats the whole invariant at runtime. Make it unrepresentable the same way the private
  constructor does: give `BlockWriteLatch` a private `#live` field, add a module-scoped `expire`
  assigned from the same `static {}` block that assigns `mint`, have `acquireBlockWriteLatch`'s
  returned `release` expire the token before releasing, and have `BlockStorage.assertLatch` reject a
  non-live token. Audited: no current caller uses a token after its scope (`commit` releases in
  `finally` after every write; every `withBlockWriteLatch` body awaits its writes), so this is
  additive. Add a test beside "a write latch minted for one block is refused by another block's
  storage": a token used after its scope closed throws and writes nothing.
- **`storage-repo.ts` now has a runtime dependency on the concrete `block-storage.ts`.**
  `import { RevisionNotCoveredError } from "./block-storage.js"` is a *value* import; before this
  change `StorageRepo` referenced only the interface module (`import type { IBlockStorage }`).
  `StorageRepo` is generic over an injected `createBlockStorage`, so an alternate `IBlockStorage`
  implementation must now import `BlockStorage` (and `applyTransform` / `canonicalJson` /
  `hashString` / `mergeRanges` with it) purely to throw the error its `getBlock` contract requires.
  Move `RevisionNotCoveredError` into `i-block-storage.ts`, next to the `getBlock` doc comment that
  already specifies it, and update the three importers (`block-storage.ts`, `storage-repo.ts`,
  `test/block-storage.spec.ts`). No cycle (`i-block-storage.ts` imports nothing from
  `block-storage.ts`) and the public surface is unchanged — `index.ts` and `rn.ts` both
  `export *` from each module already.
- **`commit` computes `Array.from(new Set(request.blockIds))` twice** (once at
  `storage-repo.ts:617` for the sorted `uniqueBlockIds`, once at ~`:635` for `blockStorages` in
  request order). Derive both from one deduped array so a reader cannot wonder whether the two sets
  can disagree — `latches.get(blockId)!` at `:638` depends on them being identical.

### Still to check

- `packages/db-p2p/test/invalidation.spec.ts` beyond the latch describe, and
  `commit-proof.spec.ts` / `proof-keyspace-isolation.spec.ts` / `db-p2p-storage-fs` test diffs were
  only skimmed via removed-line grep (mechanical latch threading, nothing weakened). A quick read is
  enough.
- One thing deliberately parked, decide whether it is this ticket's or a separate one:
  `applyInvalidation` computes the compensating content OUTSIDE the latch and takes the latch only
  around the write, so a commit landing in between makes `saveReplica`/`saveDeletion` hit their
  monotonic no-op — yet the discarded return value means `reverted` still reports a restore that did
  not happen, and that feeds the dispute cascade. **This is pre-existing** (the old
  `runLatched(() => storage.saveDeletion(...))` discarded the same value) and is not the lock bug,
  so it is evidence for a separate ticket at most. Before filing anything, run the site-claim grep
  over `tickets/{backlog,fix,plan,implement,review}` for `invalidation.ts` / `applyInvalidation`.

### Validation (not yet run this pass)

- `yarn workspace @optimystic/db-p2p typecheck`
- `yarn workspace @optimystic/db-p2p test`
- `yarn lint` (root)
- `yarn build && yarn typecheck` (root)

Note `BlockWriteLatch` relies on an ES2022 `static {}` initialization block; the typecheck run is
what confirms the target allows it.

## Tripwires already recorded by the implement stage (leave alone)

- `storage-repo.ts` `readBlockHealing`: restore fetches under the block write latch; revisit if
  restore latency shows up delaying commits.
- `block-storage.ts` `vetRestoredArchive` / `noDivergentRewrite`: two accepted-tradeoff `NOTE:`s
  (sticky lying-peer coverage, first-writer-wins on held revisions). Both carry revisit conditions;
  neither has tripped.

## Output

Finish the three fixes, run the validation, then write `tickets/complete/` with a
`## Review findings` section — carrying forward the "what the prior run verified" list above as the
checked-and-clean record, and stating explicitly (with reasons) which categories came back empty.
