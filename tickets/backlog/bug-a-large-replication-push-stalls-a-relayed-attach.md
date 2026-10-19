description: On a link through a public relay, one large block-copy push between two machines was seen taking 8 seconds to arrive, and everything else the joining machine needed from the same peer waited behind it, so about one join in three took 10–13 seconds instead of 3.5; find out why the push is that slow and keep it from holding up reads.
architecture: docs/internals.md#rebalancemonitor
files: packages/db-p2p/src/cluster/block-transfer-service.ts (`pushBlockToPeers`, `handlePush`), packages/db-p2p/src/cluster/rebalance-monitor.ts (the `grown` arm), packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts (the rebalance and growth reaction wiring)
repro: none
severity: edge-case
likelihood: normal-use
tradeoffs: The cause is not established — payload size, a second relayed connection between the same two machines, and backpressure on the relayed stream are all candidates, some outside this repository — and the slowdown was seen only through one public relay, so the work may end in a relay or libp2p change rather than one here.
----
# A large replication push stalls a relayed attach

Reported in a comment on GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39) (Optimystic 1.15.0, sereus 1.16.0, through relay.sereus.org; not reproduced here). The rest of #39 is planned as implement tickets `a-cold-read-reuses-the-consults-archives` and `a-collection-open-reads-its-log-ends-once`; this part is separate because its cause is unknown.

## What was observed

A joiner's `connectToStrand` (10 hydrated tables) had a median of about 3.5 s with debug logging on, but 6 of 19 runs took 10.5–13.2 s. None was slow on a loopback relay. In one traced 13.3 s attach:

- A `block-transfer` push of 33 blocks with reason `replication` was dialled, and the receiving service logged it 8.0 s later; it answered in 38 ms. The client logged `first-byte … ms=8078`.
- While it was in flight, a single-block `sync` reply between the same two machines took 1,378 ms, against 90–150 ms otherwise, and another `block-transfer` request had `first-byte ms=3843`.
- The same 33-block push appears twice per join.
- FRET logged `contact strike` / `negotiate strike` against both parties' peers during the window.
- Through the public relay each machine held two relayed connections to the other (one on loopback). The relay applies no connection limits.

The reporter's repro script (`formation-cost.mjs`, in the issue) reproduces it in roughly one attach in three with `IDLE_S=…`, `SHOW_LIMITS=1` or `RUNS=5`.

## Questions to answer

- Why does one push take 8 s to cross the relay: the size of 33 blocks in one message, the duplicate relayed connection, or stream backpressure?
- Why is the same push sent twice per join? The holder-evidence path (`RebalanceMonitor.recordBlockHolders`, fed by reconcile and by push acceptance) exists so a block the joiner just received is not pushed again; check whether the second push is the cohort-growth arm re-reporting before its first push's outcome was recorded, or a different sender.
- Should replication pushes be split into smaller messages, or deferred while the link has read traffic waiting, so a reader is not queued behind them?

## Expected behaviour

A replication push between two machines does not delay their read-path requests by more than the time the push's own bytes need on the link, and a block that has just been copied to a machine is not pushed to it a second time in the same join.
