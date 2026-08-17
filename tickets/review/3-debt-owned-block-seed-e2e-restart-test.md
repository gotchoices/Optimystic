description: A new test restarts a node on top of storage that already holds blocks and proves the node's resilience monitors really do learn about those blocks at startup; three comments that described the wrong set of blocks were corrected.
prereq:
files: packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts (new), packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/test/owned-block-seed.spec.ts
difficulty: medium
----

# Owned-block startup seed — node-level restart test + comment corrections

## What landed

### New spec: `packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts`

Covers the seam nothing tested before: that `createLibp2pNodeBase` calls
`seedOwnedBlocksFromStorage` with the **shared** owned-block `Set` (the same instance both
resilience monitors read), under the "at least one monitor consumes it" gate, and that the ids
actually arrive. The scan loop, the feed subscribe/gate/teardown, and each backend's
`listBlockIds` were each already unit-tested in isolation — the assembly was not.

**Arm 1 — real restart.** One `MemoryRawStorage` instance handed to two sequential
`createLibp2pNode({ storage })` calls. This is a faithful restart, not a simulation:
`resolveStorage` (`libp2p-node-base.ts:330-335`) returns a supplied `IRawStorage` verbatim and
nothing on the stop path closes or clears it. node1 commits 3 blocks through
`node1.coordinatedRepo` (real commit path, `clusterSize: 1` → self-only consensus) and pends a
4th without committing; node2 boots over the same storage and commits **nothing**, so anything in
its tracked set can only have come from the startup scan. Asserts **set equality** with all 4 ids.

**Arm 2 — the gate is the feed, not the spread block.** One node with
`spreadOnChurn: { enabled: false }`, `arachnode: { enableRingZulu: true }`, over a directly
pre-populated `MemoryRawStorage`. Here the feed is registered by the *rebalance* block's own
`ensureOwnedBlockFeed()` call, and the scan's `if (offOwnedBlockFeed …)` gate must see it — a path
arm 1 cannot reach. `node.rebalanceMonitor` is asserted to exist **before** polling, because that
wiring block swallows its own errors; without the check a wiring failure would read as an opaque
poll timeout.

Both arms poll (25ms interval, 5s deadline, error names the missing ids) rather than sleeping —
the scan is dispatched with `void …` and is not awaited by construction. Both stop their nodes in
`finally`; arm 1 stops node1 in its own `finally` so an assertion failure between the two lifetimes
cannot leak a live node.

The tracked set is read as `(monitor as any).trackedBlocks` — the monitors expose only
`getTrackedBlockCount()`. That is the stronger assertion: it proves the set IS the shared instance,
not just that a count moved. The `node: any` style matches the two sibling wiring specs (the
monitors are deliberately absent from `OptimysticNodeAttachments`), so this adds no new instance of
the debt `debt-node-attachment-reads-bypass-typed-surface` tracks — noted in a comment in the spec.

### Comment corrections

- `src/owned-block-seed.ts` docstring no longer claims the scan enumerates "the same population the
  live feed tracks" — it is a **superset**, and the docstring now says why.
- `src/storage/i-raw-storage.ts` `listBlockIds` doc no longer says "one id per block that has
  committed/replicated metadata" — it is one id per block with **any** durable metadata. Added an
  explicit instruction that implementations must enumerate metadata keys only and must not read each
  block's metadata to filter (that would turn a cheap key scan into a per-block read).
- `NOTE:` tripwire added at the top of `seedOwnedBlocksFromStorage`, recording the accepted
  over-inclusion of pend-only blocks, the two self-correcting paths that make it benign today, and
  the revisit condition: *if any consumer of the shared owned-block set ever takes a destructive or
  irreversible action keyed on membership alone, without a local-data check, the scan must filter to
  committed blocks.*
- One-line pointer added above the "pending-only excluded" case in `test/owned-block-seed.spec.ts`
  saying it holds at the raw-storage layer only, cross-referencing the new spec — so the two specs
  do not read as contradicting each other.

## THE PLAN TICKET'S PEND-ONLY ASSERTION WAS INVERTED — read this

The plan ticket asked for an assertion that a pended-but-never-committed block is **NOT** seeded.
That is **false at the node seam** and the test asserts the opposite. Verified in code:

- `BlockStorage.savePendingTransaction` (`src/storage/block-storage.ts:107-119`) writes
  `{ latest: undefined, ranges: [] }` metadata for a block that has none, *before* storing the
  pending transform. `StorageRepo.pend` goes through `BlockStorage`
  (`src/storage/storage-repo.ts:496-500`), and `CoordinatorRepo.pend` with `peerCount <= 1` calls
  `storageRepo.pend` directly (`src/repo/coordinator-repo.ts:972-975`) — so a pend through the real
  coordinated repo does write metadata locally.
- `MemoryStoreDriver.listBlockIds` (`src/storage/memory-store-driver.ts:135-143`) enumerates
  **metadata keys**; the same contract holds for the other drivers.

So a pend-only block IS enumerated and IS seeded. The existing helper spec's "pending-only excluded"
case only holds because it calls `KvRawStorage.savePendingTransaction` directly, bypassing the
`BlockStorage` layer that writes the metadata.

**No production behavior was changed.** Filtering to committed-only would require reading and
decoding metadata for every id at startup — a per-block read on the fs backend, exactly the cost the
streamed key enumeration exists to avoid — and the over-inclusion is inert:
`SpreadOnChurnMonitor.spreadCheck` untracks a tracked block whose `repo.get` returns nothing
(`src/cluster/spread-on-churn.ts:232-240`); `BlockTransferCoordinator.confirmReplicated` reports a
no-local-data block as unconfirmed so it is never released (`src/cluster/block-transfer.ts:339-344`);
and `gcEligible` has no consumer at all yet (`libp2p-node-base.ts:1030-1031`). The test asserts the
real behavior with a comment naming the cause, so a future change that starts filtering fails loudly
rather than silently altering what a restarted node protects.

If a reviewer disagrees with that call, the disagreement is about **production filtering behavior**,
not about the test — the test is reporting what the code does.

## Validation performed

- `yarn workspace @optimystic/db-p2p run build` — clean.
- `yarn workspace @optimystic/db-p2p test` — **1805 passing, 44 pending, 0 failing.** No
  pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- New spec in isolation: **413ms wall-clock** for both arms (two real libp2p node boots in arm 1,
  one in arm 2). Far under the 60s describe timeout — that headroom is for slower CI, not because
  the spec is slow.
- **Negative control (mutation test), run and observed:** temporarily changed the seed call site to
  pass `new Set<string>()` instead of the shared `ownedBlocks`, re-ran the spec — **both arms
  failed** with `startup seed never delivered [...] (tracked: [])`. Reverted; `git diff --stat`
  confirms `libp2p-node-base.ts` is unmodified. This proves the spec catches the exact
  shared-set regression it exists to catch.

## What a reviewer should probe

- **Set equality depends on nothing else writing to `rawStorage` during node boot.** Checked: the
  only other `rawStorage` consumers in `libp2p-node-base.ts` are `StorageMonitor` (read-only,
  `getApproximateBytesUsed`) and the `BlockStorage` factory. Arm 1 runs with arachnode disabled, so
  those lines are not even reached. If a future change adds a boot-time metadata write, arm 1's
  `deep.equal` will fail — that is intended, but the failure will look confusing, so it is worth a
  reviewer confirming the reasoning holds.
- **The 413ms runtime is suspiciously fast for "real libp2p".** It is real — `port: 0`,
  `bootstrapNodes: []`, `fretProfile: 'edge'` boots quickly and there is no network to converge.
  The mutation test (which took 10s, i.e. two full 5s poll timeouts) confirms the nodes and the poll
  loop are genuinely running.
- **Arm 1's pend-only assertion is deterministic only because a solo node with no peers never runs a
  spread sweep during the test.** If the spread monitor ever gained an unconditional startup sweep,
  this assertion would become timing-dependent. Called out in a comment in the spec, but not guarded
  against — a reviewer may judge that insufficient.

## Known gaps (deliberate, per the plan)

- **Both monitors disabled → no scan.** Gate holds, but with no monitor wired there is no tracked
  set to inspect, so it is not observable at node level. Not staged; noted in the spec's docstring.
- **Backend without `listBlockIds`.** Second half of the same gate; covered by the helper spec's
  no-op case. Not restaged.
- **Stop during scan.** With 4 ids the scan finishes far too fast to hit deterministically; the
  helper spec's `isStopping` case covers the mechanism. Not staged — a timing-dependent arm here
  would be flaky.
- **Only `MemoryRawStorage` is exercised.** The fs / sqlite / leveldb / indexeddb backends live in
  sibling `db-p2p-storage-*` packages and each tests its own `listBlockIds`; no node-level restart
  test runs against a real on-disk backend. That is the honest coverage boundary of this ticket.

## Review findings

- Tripwire parked at `src/owned-block-seed.ts` (`NOTE:` at the top of `seedOwnedBlocksFromStorage`):
  the startup scan over-includes pend-only blocks; benign today because every consumer re-checks
  local data before acting; revisit if any consumer ever acts destructively on set membership alone.
