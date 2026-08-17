description: Add a test that restarts a node on top of storage that already holds blocks and proves the node's resilience monitors really do learn about those on-disk blocks, and correct two comments that describe which blocks that startup scan picks up.
prereq:
files: packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts (new), packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/owned-block-seed.spec.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts
difficulty: medium
----

# End-to-end restart-seed test over a pre-populated backend

## Background

A node's two resilience monitors — churn-spread (`SpreadOnChurnMonitor`) and rebalance
(`RebalanceMonitor`) — share ONE `Set<string>` of "blocks this node holds"
(`ownedBlocks`, `libp2p-node-base.ts:937`). Two things populate it:

- the **live feed** — `storageRepo.onAnyCollectionChange`, registered lazily by whichever monitor
  wires first (`ensureOwnedBlockFeed`, `libp2p-node-base.ts:949`). It fires only on a NEW commit or
  a RECEIVED replica.
- the **startup scan** — `seedOwnedBlocksFromStorage(rawStorage, ownedBlocks, …)`, fired-and-forgotten
  at `libp2p-node-base.ts:1261-1270`, gated on `offOwnedBlockFeed` being set (i.e. at least one
  monitor is actually consuming the set) and on the backend implementing `listBlockIds`.

The scan exists because the feed does not re-emit blocks that were already durable from a previous
process run: without it, a freshly restarted node under-protects exactly the data it already holds.

Every piece is unit-tested in isolation — the scan loop (`test/owned-block-seed.spec.ts` against
`MemoryRawStorage`), the subscribe/gate/teardown wiring (`test/spread-on-churn-node-wiring.spec.ts`,
`test/rebalance-monitor-node-wiring.spec.ts`), each backend's `listBlockIds` (that backend's spec).
Nothing tests the seam: that `createLibp2pNodeBase` calls the helper with the *shared* set, under the
right gate, and that the ids actually arrive. A regression that reordered the gate, passed a fresh
`Set` instead of `ownedBlocks`, or dropped the `void`-dispatch would pass every current test.

## Design (resolved — build exactly this)

### Harness: one storage instance across two node lifetimes

`resolveStorage` (`libp2p-node-base.ts:330-335`) returns a supplied `IRawStorage` instance verbatim,
and **nothing in the node closes or clears it** — `rawStorage` is only read at `libp2p-node-base.ts`
lines 377/386/1041/1077/1261/1268, with no `close()` on the stop path. So a single
`MemoryRawStorage` handed to two sequential `createLibp2pNode({ storage })` calls is a faithful
restart: the second node comes up over the first node's durable state. No temp dirs, no fs backend.

### Arm 1 — real restart of a spread-only node

- Boot node1 over a fresh shared `MemoryRawStorage`, spawn shape copied from
  `spread-on-churn-node-wiring.spec.ts` (`port: 0`, `bootstrapNodes: []`, `fretProfile: 'edge'`,
  `clusterSize: 1`, `clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 }`,
  `arachnode: { enableRingZulu: false }`) plus `storage: shared`.
- Commit 2–3 blocks through `node1.coordinatedRepo` using the `pendCommit` helper the sibling wiring
  specs already use (pend with `policy: 'c'`, then commit; `clusterSize: 1` → self-only consensus).
  Sanity-assert node1's monitor tracked them — that is what proves the *real commit path* wrote the
  metadata the scan later enumerates, rather than the test hand-seeding a shape production never
  produces.
- `await node1.stop()`.
- Boot node2 over the SAME storage instance. node2 commits nothing, so anything in its tracked set
  can only have come from the startup scan — that is the whole assertion.
- Poll (bounded) until node2's set holds the expected ids, then assert **set equality** with the
  committed ids, not merely a non-zero count.

### Arm 2 — the gate is the feed, not the spread block

Boot ONE node with `spreadOnChurn: { enabled: false }` and `arachnode: { enableRingZulu: true }` over
a `MemoryRawStorage` pre-populated **directly** (`storage.saveMetadata(id, { ranges: [[1, rev]],
latest: { rev, actionId } })` per id — the `makeMeta`/`populate` shape from
`test/owned-block-seed.spec.ts:8-13`). No producer node boot needed here: arm 1 already established
that a real commit writes metadata `listBlockIds` enumerates, so this arm only needs *some* durable
metadata to prove the gate. Then assert the rebalance monitor's set holds those ids.

This is the path arm 1 cannot reach: with spread disabled, `ensureOwnedBlockFeed()` is called by the
rebalance block (`libp2p-node-base.ts:1174`), and the scan's `if (offOwnedBlockFeed …)` gate must see
that. Assert `node.rebalanceMonitor` exists **before** polling, so a rebalance wiring failure (that
block is inside a swallow-and-continue `try/catch`) reads as a clear failure rather than a poll
timeout.

### Reading the tracked set

The monitors expose only `getTrackedBlockCount()` — no id enumeration. Read
`(monitor as any).trackedBlocks as Set<string>`; this both proves identity (it IS the shared
`ownedBlocks` instance the node passed in) and gives the ids. Follow the sibling specs' existing
`const node: any` style — the monitors are deliberately absent from `OptimysticNodeAttachments`
(`src/optimystic-node.ts:13-15` calls them node-internal wiring), so this test adds no new debt of the
kind `debt-node-attachment-reads-bypass-typed-surface` tracks. Add a one-line comment saying so.

### Polling, not sleeping

The scan is dispatched with `void …` — it is NOT awaited by node construction. Poll the set on a short
interval (25ms) with a bounded deadline (5s) and fail with a message naming the missing ids. Never
`await new Promise(r => setTimeout(r, N))` and assert once: that is either flaky or needlessly slow.

### Pending-only blocks ARE seeded — assert the truth, then document it

The plan ticket asked to assert that a pended-but-never-committed block is NOT seeded. **That is false
at the node seam, and the test must not assert it.** Verified:

- `BlockStorage.savePendingTransaction` (`src/storage/block-storage.ts:107-119`) writes
  `{ latest: undefined, ranges: [] }` metadata for a block that has none, *before* storing the pending
  transform. `StorageRepo.pend` goes through `BlockStorage` (`storage-repo.ts:496-500`), so every
  `repo.pend` seeds metadata.
- Every backend's `listBlockIds` enumerates **metadata keys** (`MemoryStoreDriver.listBlockIds`,
  `src/storage/memory-store-driver.ts:135-143`; same contract in `raw-store-driver.ts:74`, and the fs /
  sqlite / leveldb / indexeddb drivers in the sibling `db-p2p-storage-*` packages implement it the same
  way).

So a pend-only block IS enumerated and IS seeded. The existing helper spec's
"pending-only excluded" case (`test/owned-block-seed.spec.ts:28-37`) only holds because it calls
`KvRawStorage.savePendingTransaction` directly, bypassing the `BlockStorage` layer that writes the
metadata. That spec is not wrong about the helper; it is just not a statement about the node path.

**Decision: do not change production behavior.** Filtering to committed-only would mean reading and
decoding metadata for every id at startup — a per-block read on the fs backend, which is exactly the
cost the streamed key enumeration exists to avoid. And the over-inclusion is self-correcting and
inert:

- `SpreadOnChurnMonitor.spreadCheck` untracks any tracked block whose `repo.get` returns no block
  (`src/cluster/spread-on-churn.ts:232-240`) — precisely a pend-only block.
- `BlockTransferCoordinator.confirmReplicated` returns a no-local-data block as *unconfirmed*
  (`src/cluster/block-transfer.ts:339-344`), so it is never released and never added to `gcEligible`.
- `gcEligible` has no consumer at all yet (`libp2p-node-base.ts:1030-1031`).

So the test **asserts the actual behavior** — a pend-only block is present in the seeded set — with a
comment naming the cause and why it is benign. A future change that starts filtering then fails
loudly instead of silently altering what a restarted node protects.

Put the pend-only block in arm 1: pend (no commit) a fourth block through `node1.coordinatedRepo`
before stopping node1, and include its id in node2's expected set. Note in the comment that node2's
spread monitor would prune it on its first spread sweep, which a solo node with no peers never runs
during the test — so the assertion is deterministic.

### Comment corrections (part of this ticket)

Two comments now say something the code does not do. Fix both, and leave the tripwire where the next
reader meets it:

- `src/owned-block-seed.ts` docstring: "enumerating the metadata store (one id per block with a
  committed revision or persisted replica — the same population the live feed tracks)". It is not the
  same population — it also includes a block whose only durable state is a pending transform. Restate
  it honestly.
- `src/storage/i-raw-storage.ts:42-46` on `listBlockIds`: "one id per block that has
  committed/replicated metadata". Same correction — it is one id per block with ANY durable metadata.
- Add a `NOTE:` tripwire at the seed call site in `owned-block-seed.ts` recording the accepted
  over-inclusion, why it is benign today (the two self-correcting paths above), and the revisit
  condition: *if any consumer of the shared owned-block set ever takes a destructive or irreversible
  action keyed on membership alone, without a local-data check, the scan must filter to committed
  blocks.*

## Edge cases & interactions

- **Scan is fire-and-forget.** Construction returns before the scan runs. Poll; never assume the set is
  populated when `createLibp2pNode` resolves.
- **Feed/scan overlap.** The feed is subscribed *before* the scan (ordering is load-bearing, see
  `libp2p-node-base.ts:1248-1250`). `Set.add` is idempotent, so a block committed mid-scan is counted
  once. Arm 1 sidesteps this by committing nothing on node2 — do not add a commit-during-scan race to
  this spec; it belongs to the helper spec's idempotence case, already covered.
- **Both monitors disabled → no scan.** `offOwnedBlockFeed` is undefined, so the scan never runs. Not
  externally observable (no monitor exists to inspect), so do not try to assert it; the existing
  wiring specs cover the disabled paths. Say so in a comment rather than leaving a reader wondering.
- **Backend without `listBlockIds`.** Second half of the same gate. Covered by the helper spec's
  no-op case; do not restage it at node level.
- **Stop during scan.** `node.stop()` flips `seedStopping` and the loop breaks. With 3–4 ids the scan
  finishes far too fast to test this deterministically at node level — the helper spec's `isStopping`
  case covers the mechanism. Do NOT build a timing-dependent arm for it; note the deliberate omission.
- **Stop-wrapper composition.** The seed's stop wrapper is registered LAST (outermost). Both arms must
  `await node.stop()` in a `finally`; a hang or throw there means the wrapper chain broke. Arm 1 stops
  two nodes — make sure node1's stop is not skipped when an assertion between the two fails.
- **Storage instance reuse across arms.** Each `it` must build its OWN `MemoryRawStorage`; sharing one
  across arms leaks ids between them and makes a set-equality assertion wrong.
- **Distinct network names per arm.** Sibling specs give each spawned node a unique `networkName`
  (`spread-wiring-on`, `rebalance-wiring-off`, …) — keep that, and give node1/node2 in arm 1 the SAME
  network name (a restart keeps its network).
- **Real libp2p boot cost.** Set `this.timeout(60_000)` on the describe — arm 1 boots two nodes, and
  the siblings already use 40s for one.
- **Arachnode gate in arm 2.** The rebalance block lives behind `arachnode.enableRingZulu` + FRET
  availability and swallows its own wiring errors. Assert the monitor exists before polling.

## TODO

- [ ] Read `packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts` and
      `rebalance-monitor-node-wiring.spec.ts`; lift their `makeHeader`/`makeBlock`/`makeTransforms`/
      `pendCommit`/`spawn` helper shapes rather than inventing new ones.
- [ ] Create `packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts` with a file-level docstring
      stating what this spec adds over the three isolated specs (the seam: node-base calls the helper
      with the shared set under the feed gate).
- [ ] Add a bounded poll helper — `waitForTrackedIds(monitor, expectedIds, timeoutMs = 5000)` — that
      polls every 25ms and throws naming the missing ids on timeout.
- [ ] Arm 1: shared `MemoryRawStorage` → node1 commits 3 blocks + pends a 4th → assert node1 tracked
      the 3 committed ids → `node1.stop()` → node2 over the same storage → poll → assert the tracked
      set equals all 4 ids (3 committed + the pend-only one), with the comment explaining the
      pend-only inclusion.
- [ ] Arm 2: directly pre-populated `MemoryRawStorage` → one node with `spreadOnChurn:{enabled:false}`,
      `arachnode:{enableRingZulu:true}` → assert `node.rebalanceMonitor` exists → poll → assert the
      tracked set equals the pre-populated ids.
- [ ] Both arms: `await node.stop()` in `finally`.
- [ ] Correct the `owned-block-seed.ts` docstring and the `i-raw-storage.ts` `listBlockIds` doc; add
      the `NOTE:` tripwire at the seed site (wording per *Comment corrections* above).
- [ ] Add a one-line pointer in `test/owned-block-seed.spec.ts` above the "pending-only excluded" case
      noting it holds at the RAW-storage layer only, and that the node path seeds metadata on pend
      (cross-reference the new spec) — so the two specs do not read as contradicting each other.
- [ ] Typecheck: `yarn workspace @optimystic/db-p2p run build`
- [ ] Test: `yarn workspace @optimystic/db-p2p test` (run in the foreground, no redirection). To
      iterate on just this spec:
      `yarn workspace @optimystic/db-p2p exec node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/owned-block-seed-node-wiring.spec.ts" --reporter spec`
- [ ] Handoff to `review/`: state the measured wall-clock of the new spec, and be explicit that the
      pend-only assertion was INVERTED relative to the plan ticket, with the verified reason.
