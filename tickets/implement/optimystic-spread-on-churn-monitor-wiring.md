description: A node's churn re-replication never actually runs — turn it on at node startup and feed it the blocks this node holds, so when a peer disconnects the surviving peers re-push the data and the replica count is preserved.
prereq: optimystic-churn-rereplication-persist-handlepush
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/reactivity/node-wiring.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Wire SpreadOnChurnMonitor into the node + track owned blocks

## Problem

`SpreadOnChurnMonitor` (`packages/db-p2p/src/cluster/spread-on-churn.ts`) implements the
churn-resilient spread protocol: on a debounced `connection:close` it re-pushes its tracked
blocks to expansion-cohort peers, and (with `optimystic-churn-rereplication-persist-handlepush`
landed) the receiver now durably persists those pushes. But on a real node the **sending** side
is never activated:

- `NetworkManagerService.initSpreadOnChurnMonitor(...)`
  (`network-manager-service.ts:97`) builds the monitor, but **nothing calls it**.
- Nothing ever calls `monitor.trackBlock(...)`, so `performSpread` always early-returns
  (`trackedBlocks.size === 0`, `spread-on-churn.ts:173`).
- `createLibp2pNodeBase` (`libp2p-node-base.ts`) never instantiates or starts the monitor.

Net effect: churn re-replication is inert end-to-end on a live node.

## Research findings (read before implementing)

**The "blocks this node owns" source is `StorageRepo.onAnyCollectionChange`.** The plan asked
whether to share a tracked-block source with `RebalanceMonitor`. Result of the investigation:

- `RebalanceMonitor` is **also** completely inert in production — its `initRebalanceMonitor` is
  never called either, and it depends on `ArachnodeFretAdapter` (only built when arachnode is
  enabled) and on a separate block-transfer reaction path. Wiring it (plus its reaction) is its
  own change, out of scope here. **Do not wire RebalanceMonitor in this ticket.** Unifying the
  two monitors' tracked set is filed as `optimystic-rebalance-monitor-wiring-shared-tracked-set`.
- `StorageRepo` (`storage-repo.ts:24`) implements `IBlockChangeNotifier` and exposes
  `onAnyCollectionChange(listener)` (`storage-repo.ts:70`) — a catch-all that fires one
  `CollectionChangeEvent { collectionId, blockIds, actionId, rev, tailId }` per distinct
  collection committed **and** on `saveReplicatedBlock` (`storage-repo.ts:489-495`). That is
  exactly the set of blocks this node holds locally: blocks it committed, plus replicas it
  received. This is the authoritative feed for `trackBlock`. Subscribe to **`storageRepo`
  directly**, NOT through `node.blockChangeNotifier` — the cohort-topic activation block replaces
  `blockChangeNotifier` with a decorating bridge (`libp2p-node-base.ts:763,825`), but
  `storageRepo` keeps emitting on its own surface regardless of that opt-in.

**Correctness bug to fix in the plumbing — `protocolPrefix` is dropped.**
`initSpreadOnChurnMonitor` constructs `new SpreadOnChurnMonitor({ libp2p, fret,
partitionDetector, repo, peerNetwork, clusterSize }, config)` (`network-manager-service.ts:109`)
and **never passes `protocolPrefix`**, even though `SpreadOnChurnDeps.protocolPrefix` exists
(`spread-on-churn.ts:37`) and `performSpread` feeds it to
`new BlockTransferClient(peerId, peerNetwork, this.deps.protocolPrefix)` (`spread-on-churn.ts:220`).
`BlockTransferClient` defaults `protocolPrefix = ''` (`block-transfer-service.ts:249`), so the
client would dial `buildBlockTransferProtocol('')`, but the node registers the handler under
`/optimystic/<networkName>` (`libp2p-node-base.ts:435-443`). Mismatch ⇒ every push fails to
dial. **The monitor MUST be wired with `protocolPrefix = /optimystic/<networkName>`** (the same
`protocolPrefix` already computed at `libp2p-node-base.ts:496`), and `initSpreadOnChurnMonitor`
must thread it through.

**What to feed the monitor:**
- `repo` = `storageRepo` (the **local** storage repo), not `coordinatedRepo`. `performSpread`
  reads the block to push via `repo.get(...)` (`spread-on-churn.ts:197`) and must read what this
  node physically holds — and it mirrors the blockTransfer handler, which is also wired to
  `storageRepo` (`libp2p-node-base.ts:441`).
- `peerNetwork` = `keyNetwork` (the `Libp2pKeyPeerNetwork`, an `IPeerNetwork`), the same transport
  `ClusterClient`/`SyncClient` dial over.
- `clusterSize` = `options.clusterSize ?? 10` (matches the value used for `coordinatorRepo` /
  `networkManager` elsewhere in node-base).
- `partitionDetector` = the one created at `libp2p-node-base.ts:503`.

**Self-pruning to bound the tracked set.** `onAnyCollectionChange` only ever *adds*; there is no
block-deletion event today, so a long-lived node would grow `trackedBlocks` without bound. The
plan's "kept in sync (gained/lost)" requirement is satisfied two ways:
1. *Correctness* is already handled inside `performSpread` — it skips a block when this node is no
   longer an eligible middle peer (`rank >= effectiveD`, `spread-on-churn.ts:185`) and when the
   block is no longer in local storage (`!blockResult?.block`, `spread-on-churn.ts:199`). So
   tracking a superset of currently-owned blocks never causes a wrong push.
2. *Memory* is bounded by adding a self-prune: in `performSpread`, when `repo.get` returns no
   block for a tracked id (the block left local storage), call `this.untrackBlock(blockId)`. This
   keeps the set ≈ blocks still held locally. Responsibility-loss eviction (the `lost` signal) is
   deferred to the RebalanceMonitor unification backlog ticket; it is not needed for correctness
   because of (1).

## Architecture

```
 commit / saveReplicatedBlock
        │
        ▼
 StorageRepo.emitCollectionChanges ──(onAnyCollectionChange)──► trackBlock(blockId)
                                                                      │
 libp2p 'connection:close' ──► SpreadOnChurnMonitor.handleDeparture  │
        (debounced)                      │                            │
                                         ▼                            ▼
                                   performSpread() over trackedBlocks (held locally)
                                         │   • skip if rank >= effectiveD (not a middle peer)
                                         │   • skip + self-prune if no local data
                                         │   • partition-suppressed
                                         ▼
                          BlockTransferClient.pushBlocks(... protocolPrefix=/optimystic/<net> ...)
                                         ▼
                          expansion-cohort peer → handlePush → saveReplicatedBlock (durable)
```

### Interface changes

`network-manager-service.ts` — thread the protocol prefix:

```ts
initSpreadOnChurnMonitor(
  partitionDetector: PartitionDetector,
  repo: SpreadOnChurnDeps['repo'],
  peerNetwork: SpreadOnChurnDeps['peerNetwork'],
  clusterSize: number,
  protocolPrefix: string,                 // NEW — required
  config?: Partial<SpreadOnChurnConfig>
): SpreadOnChurnMonitor {
  // ...existing libp2p/fret guard...
  this.spreadOnChurnMonitor = new SpreadOnChurnMonitor(
    { libp2p, fret, partitionDetector, repo, peerNetwork, clusterSize, protocolPrefix },
    config
  )
  return this.spreadOnChurnMonitor
}
```

`libp2p-node-base.ts` — `NodeOptions` gains config plumbing:

```ts
/**
 * Churn-resilient spread protocol tuning. Absent → enabled with defaults
 * (see SpreadOnChurnConfig). Set { enabled: false } to disable per node.
 */
spreadOnChurn?: Partial<SpreadOnChurnConfig>;
```

### Wiring location in `createLibp2pNodeBase`

Place the wiring after `coordinatedRepo` is assembled and after `protocolPrefix`,
`partitionDetector`, `keyNetwork`, and FRET are available (i.e. after
`libp2p-node-base.ts:641`, before/around the cohort-topic block). Sketch:

```ts
// --- Churn-resilient spread: drive SpreadOnChurnMonitor on a live node ---
const networkManager = (node as any).services?.networkManager as
  import('./network/network-manager-service.js').NetworkManagerService | undefined;
let spreadMonitor: import('./cluster/spread-on-churn.js').SpreadOnChurnMonitor | undefined;
let offOwnedBlockFeed: (() => void) | undefined;
if (networkManager && (options.spreadOnChurn?.enabled ?? true) !== false) {
  try {
    spreadMonitor = networkManager.initSpreadOnChurnMonitor(
      partitionDetector,
      storageRepo,
      keyNetwork,
      options.clusterSize ?? 10,
      protocolPrefix,
      options.spreadOnChurn,
    );
    await spreadMonitor.start();
    // Feed owned blocks: every block this node commits OR receives as a replica.
    offOwnedBlockFeed = storageRepo.onAnyCollectionChange((e) => {
      for (const blockId of e.blockIds) spreadMonitor!.trackBlock(blockId);
    });
  } catch (err) {
    // Spread is a resilience optimization, not a correctness requirement — a wiring
    // failure (e.g. FRET briefly unavailable) must NOT hard-fail node startup, unlike
    // the operator-opted-in cohortTopic block. Log and continue with spread inert.
    ((node as any).logger?.forComponent?.('db-p2p:spread-on-churn'))?.('init failed: %o', err);
  }
}

// expose for tests/diagnostics (mirrors node.keyNetwork / node.reputation)
(node as any).spreadOnChurnMonitor = spreadMonitor;
```

Disposal — add a `node.stop` wrapper mirroring the arachnode / clusterMember chaining
(`libp2p-node-base.ts:704-708, 747-754`):

```ts
{
  const previousStop = node.stop.bind(node);
  node.stop = async () => {
    try {
      offOwnedBlockFeed?.();
      if (spreadMonitor) await spreadMonitor.stop();
    } finally {
      await previousStop();
    }
  };
}
```

Note: `NetworkManagerService.stop()` already calls `spreadOnChurnMonitor.stop()`
(`network-manager-service.ts:145`), but the service's own `stop()` is driven by libp2p's
service teardown; the explicit wrapper guarantees the owned-block subscription is released and
the monitor stopped deterministically before transports close, and is idempotent because
`SpreadOnChurnMonitor.stop()` early-returns when not running (`spread-on-churn.ts:100`).

### Self-prune in `spread-on-churn.ts`

In `performSpread`, the existing no-local-data branch (`spread-on-churn.ts:199-202`) currently
`continue`s; add an `untrackBlock` so a block that has left local storage stops being tracked:

```ts
if (!blockResult?.block) {
  log('no-local-data block=%s (untracking)', blockId)
  this.trackedBlocks.delete(blockId)   // self-prune: no longer held locally
  continue
}
```

(Mutating `trackedBlocks` while iterating it with `for...of` is safe for a `Set` in V8 — a
deleted current element does not disturb the remaining iteration. If preferred, snapshot
`Array.from(this.trackedBlocks)` at the top of the loop.)

## Edge cases & interactions

- **Protocol-prefix match.** With the prefix threaded, assert the dialed protocol equals
  `buildBlockTransferProtocol('/optimystic/<networkName>')` and that it is in `node.getProtocols()`
  (the registered handler). A regression here silently makes every push fail to dial.
- **`enabled: false`.** `options.spreadOnChurn = { enabled: false }` must skip start AND skip the
  owned-block subscription (no listener leak), and `performSpread`/`handleDeparture` already
  early-return on `!config.enabled`. Verify no `connection:close` listener is registered.
- **Replica-persist feeds tracking too.** A block this node received as a replica
  (`saveReplicatedBlock`) emits via `onAnyCollectionChange` and so becomes tracked — correct, the
  node now holds it and should help re-spread it on future churn. Confirm the catch-all fires on
  the replica path (already covered by `storage-repo.spec.ts` "catch-all feed also receives the
  fresh-replica event").
- **Idempotent tracking.** The same block committed at multiple revs fires multiple events;
  `trackBlock` is a `Set.add` (idempotent). No growth per-rev.
- **Pre-existing blocks on restart.** Blocks already durable from a previous run (persistent
  storage) are NOT re-emitted on startup, so they aren't tracked until next touched. Acceptable
  for this ticket (memory storage in tests starts empty; churn re-replication re-derives over
  time). Document the limitation in a code comment; an initial-scan enhancement, if wanted, is a
  follow-on (note it in the backlog unification ticket).
- **Self-prune vs concurrent commit.** Pruning happens inside `performSpread` (debounced, post
  `connection:close`); a block legitimately re-committed later re-adds itself via the feed. No
  lost-tracking hazard.
- **Partition suppression.** `performSpread` returns early under a detected partition
  (`spread-on-churn.ts:168`) — the self-prune branch is therefore not reached during a partition;
  that is fine (we suppress, we don't prune).
- **Disposal ordering / double-stop.** The `node.stop` wrapper composes with the existing
  arachnode + clusterMember + (optional) cohort-topic wrappers; each calls its captured
  `previousStop` last. `spreadMonitor.stop()` and `offOwnedBlockFeed()` must both be idempotent
  (Set/flag guarded) so a double `node.stop()` does not throw.
- **Init failure is non-fatal.** Unlike the cohort-topic block (operator opt-in → hard-fail), a
  spread wiring failure logs and leaves the monitor inert; node startup still succeeds.
- **clusterSize default.** Use the same `options.clusterSize ?? 10` as the rest of node-base so
  eligibility (`neighborDistance(selfId, coord, clusterSize)`) is computed against the same cohort
  size the coordinator uses.

## Tests

Unit (default `npm test`, agent-runnable):
- **`spread-on-churn.spec.ts`** — add a case: when `repo.get` returns no block for a tracked id,
  `performSpread` returns null AND `getTrackedBlockCount()` drops by one (self-prune). Extend the
  existing "returns null when block not in local repo" test (`spread-on-churn.spec.ts:728`) to also
  assert the untrack.
- **`spread-on-churn.spec.ts`** — add a case asserting the monitor uses the configured
  `protocolPrefix`: construct with `protocolPrefix: '/optimystic/x'` and assert the mock
  peerNetwork `connect` was called with `buildBlockTransferProtocol('/optimystic/x')`. (The mock
  peerNetwork already records `connectCalls` in `block-transfer.spec.ts`'s pattern.)
- **`network-manager-service`** — a focused test that `initSpreadOnChurnMonitor(..., protocolPrefix,
  ...)` constructs a monitor whose deps carry that prefix (or assert via the dialed protocol in a
  push). Keep light; the integration value is in the wiring test below.

Wiring (real-libp2p, solo forming node — model on `reactivity/node-wiring.spec.ts`):
- Create a node with `createLibp2pNode({ ... arachnode: { enableRingZulu: false }, clusterSize: 1
  })`. Assert:
  - the blockTransfer protocol handler is registered:
    `node.getProtocols()` includes `buildBlockTransferProtocol('/optimystic/<net>')`.
  - `node.spreadOnChurnMonitor` is defined and started.
  - after a `pend`+`commit` of a block through the coordinated repo, the monitor's
    `getTrackedBlockCount()` is ≥ 1 (the owned-block feed fired).
  - `node.stop()` stops the monitor (a subsequent `checkNow()`/listener-count assertion shows it
    inert) and releases the `connection:close` listener.
  - with `spreadOnChurn: { enabled: false }`, no `connection:close` listener is added and
    `getTrackedBlockCount()` stays 0 after a commit (subscription skipped).

End-to-end (env-gated `OPTIMYSTIC_INTEGRATION=1`, extend `real-libp2p.integration.spec.ts`):
- Stand up N=4 nodes (one cluster), commit a block on one so the cohort holds it; identify an
  expansion-cohort peer that does NOT initially hold it; disconnect/stop a current owner; wait
  past `departureDebounceMs`; assert the expansion peer now serves the block via a direct local
  `repo.get` (replica landed). Keep wall-clock well under the 10-minute idle window; stream
  output with `tee` if needed. If flaky against live FRET topology, scope it down to "a surviving
  middle peer's `checkNow()` after a real departure pushes to a real expansion peer that then
  serves the block" rather than relying on the debounce timer.

## Validation

From `packages/db-p2p`:
- `yarn build` (or workspace tsc) — confirm the new `protocolPrefix` param + `NodeOptions` field
  typecheck across `libp2p-node.ts` / `libp2p-node-rn.ts` re-exports.
- `npm test --workspace @optimystic/db-p2p 2>&1 | tee /tmp/db-p2p-test.log` — stream, don't
  silently redirect.
- Integration suite is env-gated; run locally if feasible, else document the deferral.

## TODO

### Phase 1 — plumbing + monitor
- Thread a required `protocolPrefix` param through
  `NetworkManagerService.initSpreadOnChurnMonitor` into `SpreadOnChurnDeps`.
- Add the no-local-data self-prune (`untrackBlock`) in `SpreadOnChurnMonitor.performSpread`.
- Add `spreadOnChurn?: Partial<SpreadOnChurnConfig>` to `NodeOptions`.

### Phase 2 — node wiring
- In `createLibp2pNodeBase`, init + `start()` the monitor (non-fatal on failure) with
  `storageRepo`, `keyNetwork`, `clusterSize`, `protocolPrefix`, and `options.spreadOnChurn`.
- Subscribe `storageRepo.onAnyCollectionChange` → `trackBlock` per blockId; capture the
  unsubscribe.
- Expose `node.spreadOnChurnMonitor` for tests.
- Add a `node.stop` wrapper that releases the subscription and stops the monitor before
  `previousStop()`.

### Phase 3 — tests + validation
- Unit cases (self-prune, protocol-prefix) in `spread-on-churn.spec.ts`.
- Wiring spec (new `test/spread-on-churn-node-wiring.spec.ts` or add to an existing node-wiring
  spec) modeled on `reactivity/node-wiring.spec.ts`.
- Env-gated e2e in `real-libp2p.integration.spec.ts`.
- Build + `npm test` (streamed). If a failure is clearly pre-existing/unrelated, follow the
  `tickets/.pre-existing-error.md` protocol.
