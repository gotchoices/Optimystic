description: A cohort member that detaches soon after its first sync keeps only part of the collections it read. On re-attach, its launch-time reads of the missing blocks are answered "absent" from its own store before it has reconnected to the rest of its cohort.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster`'s solo-self exit, `cluster-fetch:solo-self-skip`)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (the cohort-growth push: `debounceMs` 5000, `minRebalanceIntervalMs` 60000)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster`)
source: sereus-ec, from sereus's re-attach measurements for optimystic #22 (sereus tickets/blocked/report-reattach-over-partial-replica-to-optimystic.md)
----
# Re-attaching over a partial replica reads "absent"

## Report

Setup: sereus 1.5.0 on optimystic 1.6.0, `cohortQueryTimeoutMs` 5000. Two relay-only nodes on one
loopback relay, a two-member cohort, and 900 ms one-way latency per WebSocket frame. B attaches, reads
a row, and detaches a few seconds later. A writes one row. B then re-attaches over the same
`IRawStorage`.

- In 5 of 8 runs, B's launch-time read of `default/strand/Header` was answered locally as absent
  (`cluster-fetch:solo-self-skip`, with no read-repair).
- In 1 run it threw `Missing block`: the header was there, but a block it references was not.
- In 3 runs everything was present.
- B is in the cohort for these blocks (`proximity:checked … inCluster: true`).

Reproduce from the sereus repo:

```
REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=reattach-kept REATTACH_RUNS=3 DEBUG='optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:sync-service*' yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure
```

## Hypotheses (unverified)

1. **Why the replica is incomplete.** B joined a cohort whose blocks were committed before it arrived.
   Nothing copied them to B except the `RebalanceMonitor` growth push. That push waits out a 5 s
   debounce and then runs at most once every 60 s, so a peer that leaves a few seconds after attaching
   has probably not received it. Reads B made through A as coordinator are not stored on B. That is
   by design, since reads do not replicate.
2. **Why "absent" is served as the answer.** `solo-self-skip` fires only when `findCluster` returns
   this node alone. At launch, before the relay has reconnected B to A, B's routing view holds only
   itself, so its local emptiness is served as an authoritative absent. internals.md accepts this
   cost for a cold boot with an empty routing table (see the `'cohort-unreachable'` row note in
   "A block read has three answers"). The cost is worse here, because this node *did* have a cohort
   member last session. The phone report on #22 (kjeib, 01:56Z) has the same shape: on two real phones
   over relay.sereus.org, every read is `solo-self-skip`. That is being filed as its own GitHub issue
   with traces.
3. **The `Missing block` case** is the same incomplete replica, hit one block further down: B holds
   the header, and the solo exit answers for the referenced block too.

## Questions for this stage

- Should a cohort member keep a block it read, or served through read-repair, as its own replica?
- Should a node that restarts with prior cohort evidence refuse to treat a self-only view as
  authoritative? Evidence it could use includes a non-empty store, holder evidence, or remembered
  peers. It could flag `'cohort-unreachable'` until the view grows, or wait for it to grow.
- Can a detaching peer finish its pending growth push, or can a re-attaching peer detect the gap
  before answering?

## TODO

- Reproduce on the in-process or TCP mesh: two members, one joining after the commits and detaching
  inside the growth debounce, then restarting over the same storage.
- Confirm or refute hypotheses 1 and 2 from the trace.
- Output implement ticket(s). Coordinate with the kjeib phone issue once it is filed.
