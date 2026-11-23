description: A storage node that runs out of its allotted space today keeps accepting data until the disk is full: it can narrow the range it is responsible for, but never deletes what it gave up, and it keeps every blob it holds for the network without limit. Make a node act on its allotment — shed, delete and refuse, in that order — so it stays within the space its operator gave it.
architecture: docs/arachnode-ring-handoff.md, docs/blobs.md#lifetime, docs/blobs.md#placement-copying-and-durability, packages/db-p2p/docs/storage.md
files: packages/db-p2p/src/storage/ring-selector.ts (`determineRing`, `shouldTransition`), packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts (`gcEligibleBlocks`, `createArachnodeInfo`), packages/db-p2p/src/blob/cache-budget.ts, packages/db-p2p/src/blob/cohort-reaction.ts, packages/db-p2p/src/blob/announce-receiver.ts, packages/db-p2p/src/cluster/block-transfer-service.ts (`handlePush`), packages/db-p2p/src/cluster/cluster-repo.ts (the promise vote)
difficulty: hard
prereq: blob-bytes-are-reported-by-hold-and-the-cache-gets-a-share
----

# A node stays within its allotment

## Why

Once a node knows its allotment and what it is using (the `every-store-reports-its-bytes-and-its-free-space` → `a-node-measures-its-use-against-one-allotment` → `blob-bytes-are-reported-by-hold-and-the-cache-gets-a-share` chain), it still does nothing that frees space:

- **Narrowing never deletes.** Above 85% use, ring selection moves the node one ring outward, to a narrower slice of the keyspace, through the advertise, confirm and release handoff (`RingShiftCoordinator`). The released blocks go into `gcEligibleBlocks`, which nothing reads ("no sweep consumes this set yet … grows unbounded"), so the bytes stay on disk. A code comment names a ticket for that sweep, `st-storage-sweep-archival-and-capacity-estimate`, which does not exist.
- **Nothing ever refuses.** A full node still accepts pushed replicas, blob announcements and pends as a cohort member, until a write fails on the disk itself.
- **Low space advertises the most work.** `determineRing` answers -1 when less than `minCapacity` (100 MiB) is available, and `createArachnodeInfo` clamps that to ring 0, the whole keyspace.
- **Blobs kept for the network are unbounded.** A blob's `responsible` hold follows its cohort but never the node's space.

## What to build

The node acts in a fixed order as its use rises, each step only when the one before it cannot get it back under:

1. **Evict cached blobs**: blobs held only because they were read, least recently read first. This is the existing `BlobCacheBudget` eviction, now driven by the allotment.
2. **Shed responsibility**: narrow the ring as today. A blob whose placement falls outside the narrowed slice is released the way a lost cohort member's blob is (`BlobCohortReaction`'s lost arm: drop the `responsible` hold only once enough current members hold it whole).
3. **Delete what was released**: a sweep that deletes the blocks a confirmed ring shift released, and the pieces of blobs no hold needs any longer (the existing piece sweep). Deleting only data that the handoff confirmed held elsewhere at the floor is the invariant; state it, and pin it with a test that a sweep never deletes a block the confirm step did not count.
4. **Refuse new data from others**, above a hard limit: pushed replicas, blob announcements, and taking part in a pend as a cohort member are refused with a typed, classified refusal that a sender treats as "this member is full, ask another", never as a conflict to retry here. Decide in the plan what a member's promise vote carries for it, given that a vote's signed layout is shared by every member (see `Signature` in db-core and `clusterVoteSigningPayload`), and what happens when a whole cohort is full.
5. **The host's own writes** past the hard limit fail with a typed error saying the node is out of space, before anything is staged or sent.

Also:

- **Low space advertises less work, not more.** Below the minimum, a node advertises the narrowest ring it can, or no storage role, never ring 0. Settle which in the plan.
- **Thresholds are configurable** with defaults: today's 85% outward and 40% inward, plus a hard limit for refusing. Keep the existing damping (EWMA, deadband, 10-minute dwell) for shedding; refusing is immediate.
- **Old block revisions** are the one large consumer this ticket does not reduce: backlog `feat-cold-range-transform-offload` is about them. Say in the plan whether a node at its hard limit can still make progress without it, and file what it needs.
- **Every step logs** what it did and why, with the allotment figures, so an operator can tell "shedding" from "refusing".
- **Docs:** packages/db-p2p/docs/storage.md (what a node does as it fills), docs/arachnode-ring-handoff.md (the sweep), docs/blobs.md §Lifetime, and the refusal in docs/correctness.md or docs/transactions.md wherever a member's refusals are classified.

## Expected behaviour

- A node given an allotment stays within it: it sheds, then deletes, then refuses, and never fills the disk.
- Nothing is deleted that its cohort has not confirmed holding.
- A writer whose cohort member is full gets its write placed on another member, or a typed answer saying the cohort is out of space — never a stale-revision retry loop or a silent failure.
