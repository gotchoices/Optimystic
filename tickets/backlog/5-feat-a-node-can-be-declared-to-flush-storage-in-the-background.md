description: Let a deployment whose machines are far apart declare that a node may write to disk in the background, losing at most a short window of writes on power loss, the window growing with how many machines hold each write, under a declared independence assumption, in exchange for never waiting on the disk before it answers.
prereq: decide-what-a-node-must-have-on-disk-before-it-reports-holding-a-write, storage-flushes-once-per-write-group, file-storage-pays-one-fsync-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p/readme.md, packages/db-p2p/docs/storage.md, docs/correctness.md
tradeoffs: Once the file store syncs once per write group, the default may already be cheap enough everywhere that nobody needs this mode, and it adds a second meaning of "saved" that every reader of the durability class has to keep in mind.
----

# A node can be declared to flush storage in the background

The relaxed half of `decide-what-a-node-must-have-on-disk-before-it-reports-holding-a-write`; adjust to whatever that ticket settles. GitHub #37 asked for "a durability setting". The maintainer's direction (2026-10-15): "lean on theory — the more nodes in a cluster, the more relaxed we can be." So the loss window is not one declared number per node: it is computed per write from the cohort that write's consensus ran on, under a declared independence assumption (see that ticket's "How the theory sets the loss window").

## What the mode is

A deployment declares that its machines fail independently, with a per-machine failure rate and a loss target (shape and name per the decision; for example `NodeOptions.storageDurability: { independentFailures: true, lossRate, target }`). Undeclared, every node stays strict. Given the declaration:

- For each write group, the node computes its allowed window `w` from the cohort the write's consensus ran on (`record.peers`, capped at the declared cohort size) with the decision ticket's formula, capped at a hard maximum. One pure function, unit-tested against the table the docs publish.
- Writes become visible and survive a process crash when they resolve (every backend already reaches the OS by then), and survive a power cut within `w`.
- `StorageRepo`'s end-of-group flush (from `storage-flushes-once-per-write-group`) becomes a request with a deadline of `w` rather than a wait: the method returns without awaiting the sync, and the store syncs before the earliest outstanding deadline.
- `w = 0` (strict) wherever only one machine would hold the write: `CoordinatorRepo.pendSolo` and `commitSolo` in `packages/db-p2p/src/repo/coordinator-repo.ts`, the shortfall entry `noteReplicationShortfall` records for it, and any cohort the formula gives no window. This falls out of the formula (`m = 1`), not a separate rule.
- The node's reports count toward `majority` and `full` like any other member's. `WriteDurability` is unchanged; the docs state what `full` means for a background-flushing member.
- The node logs its mode and bound once at start.

## Requirements and edge cases

- **Prefix order is kept.** Background syncing must still leave a prefix after a power cut. The file log appends in order and syncs on a timer, which keeps it. LevelDB as vendored by `gotchoices/rn-leveldb` does not: written unsynced, groups left in a log file that LevelDB then switches away from are closed without a sync (`DBImpl::MakeRoomForWrite`), so a power cut can lose an older group while a newer one survives. A backend that cannot keep the prefix is not offered this mode until it can (for LevelDB, a sync of the old log at the switch, in the binding's vendored copy).
- **Order across stores.** Two writes in different stores where the second describes the first — the executed marker `ClusterMember.handleConsensus` writes after an apply, a ledger entry after a commit — must not become durable in the wrong order. Under the default this holds because `StorageRepo` syncs before returning; here, either the stores share one log (the file store's shared log for a common base path) or the describing store syncs only after the described store has. Otherwise a power cut can keep an executed marker whose apply was lost, and the member then skips that transaction forever on redelivery.
- **Bounded memory.** The file store's overlay holds up to `w` of writes; bound it by bytes as well and sync early when it fills.
- **The loss window is a promise.** A sync that cannot keep up (a slow disk) must not let the window grow silently: log it, and sync on the write path once the backlog exceeds the bound.
- **Mixed cohorts** (some members background, some not) need nothing special.
- **The known hazard stays documented, not fixed here:** a background node that loses its last writes and then writes alone forks the collection (case 2 in the decision ticket). Whether to refuse solo writes in this mode is the decision's option F; the general fix for that forked state belongs to backlog `partition-healing` and `docs/crdt-sync.md`.
- Applies per node, so a deployment can run its always-on servers in background mode and its phones under the default.

## Verification

- The power-loss storage double from `mobile-and-browser-storage-lose-acknowledged-writes-on-power-loss`, extended to sync on a timer: a background node that loses power loses at most the writes inside each one's window, always a suffix, and never a write it acknowledged as the only holder.
- One test that a solo commit on a background node is synced before it is acknowledged.
- `packages/db-p2p/readme.md` documents the option, and `docs/correctness.md` (Theorem 6, and §1.2's storage durability paragraph from the decision) states what the class means under it.
