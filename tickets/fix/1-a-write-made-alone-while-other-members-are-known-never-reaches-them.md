description: A node that knows other members of its group exist, but holds no connection to any of them when it writes, resolves a cohort of only itself, commits at `quorum: 'local'`, reports success, and records nobody as owed a copy. If that node then stops (a backgrounded phone, a restart), the write never reaches the other members. Reported from sereus as data loss reported as success.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commitSolo`, `pendSolo`, `soloCohortDurability`, `noteReplicationShortfall` / `noteBlockShortfall` — a `local` commit records `missingPeerIds: []`)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster`, `membershipOf`, `awaitingBootstrapContact`, `rememberedServing` — what the node knows about members it is not connected to)
  - packages/db-p2p/src/repo/under-replication-drain.ts (what it pushes, and to whom, for a `local` entry)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`grown` — the other path that could deliver the copy after restart)
  - docs/internals.md (the "Out of scope here: a write to a collection the node already holds, made before contact, still commits alone" sentence under the three-answer block read; *Supported deployment sizes* in docs/architecture.md)
  - packages/db-p2p/docs/repo.md §The under-replication drain and the full-replication event
----

# A write made alone while other members are known never reaches them

Reported by sereus (sereus-sam, sereus GH issue #44, https://github.com/gotchoices/sereus/issues/44 — `gh issue view 44 -R gotchoices/sereus` has the full scenario file). Sereus ranks this first: it is a write reported as saved that is lost.

## What happens

Two relay-only parties form a closed two-member strand. The joiner passes its first-sync gate, then, over a slow relay (20 ms per-frame cap plus an event loop kept 70% busy, modelling a phone), its strand node is connected to nothing but the relay when it makes its first write: one transaction across three tables.

- Every block resolves a cohort of only the joiner: `cluster-tx:cluster-members { peerIds: [ '<joiner>' ] }`.
- It commits alone: `commit:solo-cohort { cohortSize: 1, soleIsSelf: true, quorum: 'local' }`, then `network-transactor commit:done ... path=one-round success=true`, about 0.1 s.
- The joiner stops the moment the commit returns. The founder never receives the rows (180 s gate), 3 of 3 runs.
- If the joiner stays up, the rows reach the founder 38–83 s later once it reconnects.
- On the real phones (Galaxy S7 + emulator, Taleus app) the founder still lacked the rows 30+ minutes later, **after both apps restarted**. So restart did not deliver the copy either.

Control arms pass: loopback, and 100 ms pipelined latency (in both the joiner was connected to the founder when it wrote).

## What the code does today (verified by reading)

- `CoordinatorRepo.commitSolo` takes the short-circuit whenever the cohort has at most one peer; `soloCohortDurability` reports `local` when that peer is self. Honest, but the SQL caller cannot see the class (GitHub #26).
- `noteBlockShortfall` records a `local` commit in the under-replication ledger with `missingPeerIds: []`. So the drain has nobody to push to, and the docs describe the solo case as one that "counts no attempt".
- `awaitingBootstrapContact` protects only reads, and only for configured bootstrap peers never heard from. docs/internals.md says so explicitly: "a write to a collection the node already holds, made before contact, still commits alone." The joiner had heard from the founder (it passed first sync), so even the read-side guard is off.
- After restart, the remaining delivery path is the rebalance monitor's `grown` arm (first check after start reports the whole non-self cohort). It needs FRET to put the founder back in the block's cohort. Why it did not deliver on the phones is unknown and is part of this ticket.

## Design constraints (do not violate)

- One- and two-machine groups are first-class (docs/architecture.md *Supported deployment sizes*). A lone survivor of a pair must still be able to write; its write is `local` and heals later. So **refusing every write whose cohort resolved self-only is not acceptable** as a blanket rule; the two-machine lone-survivor policy is owned by `backlog/more-design/6.5-partition-healing` and must not be pinned here.
- What *is* wrong regardless of policy: a write that the node knows other members should hold is recorded as owed to nobody. The node has evidence of other members (it heard from the founder; FRET or `rememberedServing` may still list it; the cohort it last assembled named it).

## Hypotheses to test

1. **Owed peers are dropped.** A solo commit should record, as owed, the members this node knows serve the network but is not connected to (e.g. the last cohort it assembled for the block, or remembered serving peers), so the drain pushes on reconnect and after restart (the ledger is durable). This is the likely fix and needs no policy decision.
2. **Restart does not deliver.** Find why neither the drain nor `grown` delivered after both phones restarted. Possibly the ledger entry's empty `missingPeerIds`, possibly FRET not re-admitting an address-less peer (note: `p2p-fret` 1.0.2, in an uncommitted bump in the working tree owned by another session, changes how address-less peers leave the ring — check whether it interacts).
3. **Writability.** Whether a node with known-but-unconnected members should briefly wait for, or retry, cohort assembly before the solo short-circuit (similar to `bootstrapContactImminent` for reads), rather than refusing. If you conclude the answer has to be "refuse, retryably" for some shape, that is a product decision: route that part to `blocked/` with proposed text, and still land hypothesis 1.

## Reproduction

The sereus scenario runs against cadre-core over real sockets and is too heavy to vendor. Reproduce at the lowest layer that shows it: a two-member db-p2p mesh where member B has served and then disconnected, member A commits (solo cohort, `local`), A stops, A restarts with the same storage while B is reachable, and B must end up holding the block. See `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts` for the closest existing fixture (it already covers "one is away for a while").

## Downstream

Sereus wants a release as soon as this lands; tell sereus-sam the version. Sereus's own option (cadre-core treats "no strand peer connected" as not writable) is theirs to choose separately.

## TODO

- Reproduce at the db-p2p level (mesh, disconnect, solo commit, stop, restart, assert delivery).
- Confirm or refute hypotheses 1 and 2; produce implement ticket(s).
- Update the internals.md sentence about writes made before contact to match whatever lands.
