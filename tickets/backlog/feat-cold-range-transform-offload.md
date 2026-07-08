description: Even after we stop keeping a full copy of every block version, the small change-logs for every version are still kept forever, so very old history keeps consuming disk on each node. Let a node offload cold, rarely-read history and re-fetch it from the network on demand.
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, docs/repository.md
----

# Cold-range transform offload — let a node drop rarely-read history and restore it on demand

## Context

The materialization checkpoint sweep (`st-materialization-checkpoint-sweep`, landed) removed the
dominant storage-growth driver: a full block copy per revision. What remains is the **transform
log** — one forward change per revision — which is retained for *every* revision so that every
revision stays locally reconstructible by replay. That log still grows without bound
(O(revisions × delta size)) on a node that holds a block for a long time.

Transforms are the replay log, so they cannot simply be deleted without losing the ability to
reconstruct old revisions **locally**. But the system already has a **restoration** path: a block
range that a node does not hold locally can be fetched from the cluster on demand
(`RestoreCallback` / `restoration-coordinator.ts`, driven by `ensureRevision` in
`block-storage.ts`). This is the mechanism `docs/repository.md` gestured at with "Older revisions
are archived based on resource pressure ... Previous versions can be restored from archival storage
as needed."

## What this is

Under resource pressure, let a node **offload a cold, low-rev range** of a block — drop its
transforms *and* materializations below some horizon — and **honestly narrow `meta.ranges`** so it
no longer claims to hold that range. A later read of an offloaded rev falls through
`ensureRevision` to the restoration path, which re-fetches it from a peer that still holds it.

The hard part, and why this is a separate future capability rather than part of the sweep:

- **`ranges` must fragment honestly.** Offloading `[E, H)` narrows coverage to `[H, +inf)`. This is
  the inverse of the sweep, which deliberately keeps `ranges` unchanged. A bug here re-creates the
  "claim a range you cannot serve" class of lie that the ranges-honesty work
  (`st-pend-seeds-open-ended-ranges`, complete) fixed.
- **New floor needs a materialization.** After offloading below `H`, rev `H` becomes the new range
  floor and MUST carry a materialization (the descending walk needs a replay base), so offload has
  to checkpoint at `H` before dropping `[E, H)`.
- **Crash mid-offload.** Dropping transforms + materializations + narrowing `ranges` must be ordered
  so no crash leaves a rev that `ranges` still claims but can no longer reconstruct or restore.
- **Restoration availability.** Offloading is only safe if enough peers still hold the cold range to
  restore it — this couples to the replication / responsibility model, not just local storage.
- **Pressure trigger + policy.** What counts as "resource pressure", what horizon `H` to pick, and
  how much to offload per pass need a defensible policy (bytes-pressure-based, with access recency as
  a tie-breaker), documented so doc and code agree.

## Why backlog, not plan

This needs a decision on the restoration-availability guarantee (can a node prove the cold range is
restorable from peers before dropping it locally?) that touches replication/responsibility and may
warrant human sign-off on the durability model. Promote to `plan/` once the sweep + capacity work has
settled and the restoration-availability question is scoped.
