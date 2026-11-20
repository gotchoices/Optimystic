description: A machine running alone now keeps a saved note for every block it writes, and after a restart its first save reads every one of those notes back before it can answer. On slow storage (a phone, a busy disk) that first save could stall for a long time.
files: packages/db-p2p/src/repo/kv-under-replication-ledger.ts (`index()`, `record`, `settle`, `evictBeyondCap`), packages/db-p2p/src/repo/coordinator-repo.ts (`noteReplicationShortfall`), packages/db-p2p/src/libp2p-node-base.ts (where the ledger is built), packages/db-p2p/src/blob/owed-blob-ledger.ts (`index()`, `record`, `remove` — the second arm below)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: No persistent key-value store is wired by the main downstream embedder today (it falls back to memory, where the load is cheap), and the drain ticket may change how many entries a solo node keeps, so measuring after the drain lands may show this is not worth the extra moving part.
----

# What happens

`CoordinatorRepo.commit` waits on the under-replication ledger (the per-node record of blocks saved before every partner confirmed a copy) before it answers the writer. The ledger keeps an in-memory index of which blocks have entries, in oldest-first order, used for two things: skipping the store on a `full` commit with no entry, and evicting the oldest entry past the cap.

That index is loaded lazily, on the **first mutation** after the process starts — which is the first `record` or `settle`, i.e. the first commit. Loading it is one `list` plus one sequential `get` per stored entry.

On a machine that is genuinely alone, every commit is acknowledged at `local`, so every distinct block it writes gets an entry. The drain (`under-replication-drain-and-full-replication-event`) deliberately leaves those entries in place while the cohort still resolves to this node alone. So the ledger on a solo machine grows toward the number of blocks it has ever written, capped at 100,000 (`DEFAULT_UNDER_REPLICATION_MAX_ENTRIES`).

Measured store-operation counts (pinned in `packages/db-p2p/test/kv-under-replication-ledger.spec.ts`, "store operations per call"):

- index load: 1 `list` + N `get`, where N is the number of stored entries;
- a `record` once loaded: 1 `get` + 1 `set`;
- a `settle` with no entry: 0;
- a `record` past the cap: +1 `delete`.

So after a restart, the first commit on a solo node with N entries under `FileKVStore` performs N file reads before it answers. Not measured in wall clock. The sereus control-database start budget cites 50–90 ms per storage operation on a phone under launch contention; at that rate a few thousand entries is minutes. No deployment is known to hit this today: the reference peer's `--storage file` wires `FileKVStore`, and sereus supplies no `kvStore`, so its ledger is in memory and starts empty.

# Expected behaviour

The first commit after a restart costs about what any other commit costs, regardless of how many ledger entries survived the restart.

# What the drain changed

`under-replication-drain-and-full-replication-event` made the ledger's first `list` after start double as the index load (`KvUnderReplicationLedger.list` seeds the index it would otherwise build with a second scan), and the drain's start pass loads the index on every node as soon as the node is up: through `list` when a pushable peer is connected, otherwise through the `size` call that decides whether to arm its re-check timer (a node that starts alone skips the scan for pushing but still asks how many entries are outstanding). So wherever the drain is enabled with its re-check timer on (the default), the scan runs at boot, off the commit path, and the first commit finds the index loaded — or waits on the load already in flight, which is the residual this ticket is about. The cost of the scan itself is unchanged: one `list` plus one read per stored entry. Pinned by "the start pass loads the ledger index even when nobody is connected" in `packages/db-p2p/test/under-replication-drain.spec.ts`.

# Directions (not a plan)

- Warm the index when the node starts, rather than on the first commit, so the load runs alongside libp2p boot. The first commit still waits if it arrives before the load finishes. (Done incidentally by the drain's start pass — see above — whenever the drain and its re-check timer are enabled; a node with the drain disabled still loads on its first commit.)
- Persist what the index needs (presence and eviction order) as its own compact record, so loading it is one read.
- Revisit whether a `local` commit on a node that has never had a partner needs a per-block entry at all, or whether one "this node has written while alone" marker plus the owned-block set would carry the same information to the drain.

# Second arm: the blob ledger inherited the cost without the reason

`OwedBlobLedger` (`packages/db-p2p/src/blob/owed-blob-ledger.ts`, added by `feat-blob-owed-ledger-and-durability-classes` and found in its review) was shaped after the ledger above, index and all: `record` and `remove` both `await this.index()`, so the first `record` after a restart is one `list` plus one read per stored entry — the same shape as the measurement above, with the same unmeasured wall clock.

What makes it a distinct arm rather than another instance: the ledger above needs the index for correctness (it is the eviction order, and `maxEntries` is enforced from it), while the blob ledger has **no cap** and needs the index only to answer `size()` without a scan. Nothing in `record` or `remove` reads the index for a decision — they only keep it current. So the load could simply be skipped when it has not happened yet: an entry written while the index is unloaded is in the store, and the next `size()` scans and finds it. That makes this arm much cheaper to resolve than the first, and resolvable on its own.

The path that pays it is `NodeBlobService.announce` (built by `feat-blob-owed-copies-are-drained`), which awaits the entry before it resolves, so a writer announcing its first blob after a restart waits on the scan. The copy drain's start pass warms the index off that path on a node where the drain is enabled, exactly as the block drain's does — the same residual, and the same mitigation.
