description: A machine running alone now keeps a saved note for every block it writes, and after a restart its first save reads every one of those notes back before it can answer. On slow storage (a phone, a busy disk) that first save could stall for a long time.
files: packages/db-p2p/src/repo/kv-under-replication-ledger.ts (`index()`, `record`, `settle`, `evictBeyondCap`), packages/db-p2p/src/repo/coordinator-repo.ts (`noteReplicationShortfall`), packages/db-p2p/src/libp2p-node-base.ts (where the ledger is built)
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

# Directions (not a plan)

- Warm the index when the node starts, rather than on the first commit, so the load runs alongside libp2p boot. The first commit still waits if it arrives before the load finishes.
- Persist what the index needs (presence and eviction order) as its own compact record, so loading it is one read.
- Revisit whether a `local` commit on a node that has never had a partner needs a per-block entry at all, or whether one "this node has written while alone" marker plus the owned-block set would carry the same information to the drain.
