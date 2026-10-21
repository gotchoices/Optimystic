description: An application that delivers blocks to a peer itself (Sereus's join catch-up) can now tell the node "this peer holds this block", so the node stops owing that peer a copy and stops re-sending the block one request at a time.
architecture: docs/internals.md#write-path-local-changes
files: packages/db-p2p/src/repo/owed-copies.ts, packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/repo/i-under-replication-ledger.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/src/transactor/change-notifier.ts, packages/db-p2p/test/under-replication-drain.spec.ts, packages/db-p2p/test/kv-under-replication-ledger.spec.ts, packages/db-p2p/docs/repo.md, docs/internals.md, docs/debugging.md
----
# An embedder reports a block a peer already holds

Filed from Sereus: its peer-join catch-up pushes a joining peer every block it lacks, many per request, and Optimystic then re-sent the same blocks one request at a time — the under-replication drain about 7 s later, and on storage-profile nodes the rebalance growth arm too — because neither knew the embedder's push had landed.

## What landed

**`node.reportBlockHeld(blockId, rev, peerId): Promise<void>`** on `OptimysticNodeAttachments` (always present; `peerId` is `PeerId.toString()`). It refuses a `rev` that is not a non-negative integer with a `RangeError` before doing anything, then:

1. tells the rebalance monitor, through the existing late-bound `onBlockHolders` sink, that `peerId` holds the block (the fifth producer of holder evidence; a no-op where no monitor was built);
2. awaits `recordHeldCopy` in `packages/db-p2p/src/repo/owed-copies.ts`, which takes `peerId` off the block's under-replication entry and fires the full-replication event when that empties it.

It is attached outside the drain's `enabled` gate: disabling the drain stops pushing, not recording.

`owed-copies.ts` holds the rule the drain and the report share — `resolveOwedPeers` (who the entry still owes), `takeConfirmedCopies` (name an unnamed entry with its cohort, `satisfy` with the revision guard, emit on `cleared`) and `recordHeldCopy`. The report writes nothing unless the entry owes `peerId` a copy at or below `rev`; an older-copy report does not name an unnamed entry either. The event fired from a report carries no `collectionId`.

Introduced in `ticket(implement): an-embedder-reports-a-block-a-peer-already-holds`; review changes below.

## Review findings

Read the implement diff first, then every touched file, the ledger interface and implementation, the rebalance monitor's evidence path, and the docs that describe the drain, the event and holder evidence.

**Correctness — two defects found, both fixed.**

- *The event named the entry the caller read, not the one it cleared.* `takeConfirmedCopies` (and the drain's code it replaced) emitted `entry.rev` / `entry.actionId` from the entry read before the push or report. If a newer commit recorded a fresh shortfall for the block while the copy was in flight, and the copy was of that newer revision (the drain pushes the unpinned latest; a report can name a later revision), `satisfy` cleared the newer entry and the event announced the older revision — a host following the newer write, which clears a block on an event "at that revision or later", would wait forever. Pre-existing in the drain, now shared. Fixed at the ledger: `SatisfyOutcome`'s `cleared` arm carries the removed `entry` (`packages/db-p2p/src/repo/i-under-replication-ledger.ts`, `kv-under-replication-ledger.ts`), and `takeConfirmedCopies` emits from it. Reproduction test added: "announces the newer shortfall a copy of that revision cleared, not the entry read before it" in `under-replication-drain.spec.ts`; the two ledger specs that asserted `{ status: 'cleared' }` now assert the entry too.
- *`NaN` cleared any entry.* Every comparison against `NaN` is false, so `reportBlockHeld(block, NaN, peer)` passed both the older-copy check and `satisfy`'s revision guard and cleared the entry. Added `assertReportedRevision` in `owed-copies.ts`, called by `recordHeldCopy` and at the top of the node's `reportBlockHeld` (so a malformed report reaches neither half); documented on `OptimysticNodeAttachments.reportBlockHeld`. No test: it is a one-line guard.

**Races (checked by reading):** a report's `get` → resolve → `name` → `satisfy` spans awaits. A replaced entry is left alone by `name` (exact-revision rule) and by `satisfy` when the report is older; when the report is at or above the newer entry's revision it is satisfied correctly, and the event now names it (fix above). A report racing a drain push of the same entry: the ledger serializes per block, exactly one `satisfy` returns `cleared`, one event fires.

**Resource bounds:** the rebalance monitor holds evidence for an untracked block until the next check drops it, and only the embedder can name untracked blocks — tripwire `NOTE:` at `RebalanceMonitor.recordBlockHolders`.

**Docs:** wording fixed in `docs/internals.md` (§UnderReplicationDrain said "only one of the two" after three removers were listed) and `packages/db-p2p/docs/repo.md` ("a third route to the drain-side event" → the second way it fires; added the `RangeError` and the removed-entry rule). `docs/debugging.md`'s `report:` rows match the code. Other docs that mention the event or holder producers were checked and are current.

**Tests:** the implementer's two specs each pin a contract with real branching (the strand shape a plain `satisfy` cannot clear; a report for a non-member must not name an unnamed entry) — kept. Still untested, deliberately: the `older-copy` early return (mirrors `satisfy`'s guard, which the ledger spec covers) and the node attachment (glue).

**Type safety, DRY, modularity:** the shared rule removed the drain's private copy; `BlockDurabilitySink` is re-exported from the drain so the barrel is unchanged. `recordHeldCopy` is not on the package barrel; the host surface is the node attachment. Nothing to change.

**Accepted as before (from the implement handoff, not re-filed):** drain failure/abandon counters for a peer a report satisfied linger until `pruneState`; a rebalance reaction already under way is not recalled by a later report; log lines for the drain's `entry:cleared` and the report's `report:cleared` still print the revision the caller read, which differs from the event only in the superseded-entry race.

**Validation:** `yarn workspace @optimystic/db-p2p typecheck` clean; `yarn workspace @optimystic/db-p2p build` done; eslint on every touched source and spec file clean; `yarn lint:docs` all resolve; `yarn test` in db-p2p — 3506 passing, 73 pending, 0 failing. Not run: `yarn test:integration` and other workspaces' suites (no type outside db-p2p uses the changed `SatisfyOutcome`).
