description: Let a node join a network as a pure client that reads and writes through the network but never stores blocks for others or signs their commits. In very large networks made mostly of phones, this keeps sleeping, metered devices off the critical path of other people's writes.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/libp2p-node-base.ts (NodeOptions; service registration ~1143 cluster, ~1177 repo, ~1197 sync, ~1211 block-transfer; rebalance, spread-on-churn, under-replication drain, cohortTopic wiring), packages/db-p2p/src/libp2p-key-network.ts (selfServes ~1430, membershipOf ~1491, assembleServingCohort ~1855, findCoordinator ~990 and the self-coordination tiers ~1202), packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/reactivity/, docs/internals.md, docs/architecture.md
----

# Client-only node: `NodeOptions.servesBlocks: false`

## Need

Requested by `@serfab/sereus` (`../sereus/tickets/blocked/strand-node-that-holds-no-blocks`). Sereus runs one Optimystic network per shared workspace (a "strand"). Today every machine in a strand, phones included, is a potential storage-group member for every block. That is the right default and stays the default. For very large strands, such as a public vote with tens of thousands of phones, the embedder needs to let a node opt out of holding blocks and signing commits while still reading and writing through the network.

## What exists

Cohort selection already supports a node that does not serve. `findCluster` admits a peer only when its protocol list names this network's `cluster` or `repo` protocol (`servesThisNetwork`), and `selfServes()` applies the same test to the node itself. With `false`, `assembleServingCohort` drops self from every band, so the node is never in a cohort and never a coordinator pick. The comment there calls this "defence in depth ... what keeps a future client-only node out of every cohort". What is missing is a supported way to be that node: `createLibp2pNode` always registers all four storage services.

## Proposed shape

`NodeOptions.servesBlocks?: boolean`, default `true`. With `false`:

- **Do not register** the `repo`, `cluster`, `sync` and `block-transfer` services. Peers then classify the node `foreign` from its identify protocol list, and `selfServes()` returns false. No new wire data is needed, and peers on older builds also leave the node out.
- **Reads and writes go remote.** Every get and commit resolves a remote coordinator through the existing `NetworkTransactor` path. Decide what the node's local storage is for. The proposed answer is none: no raw storage is required, and `storage` and `kvStore` are refused or ignored with a warning.
- **Subsystems that assume local blocks do not start:** rebalance monitor, spread-on-churn, under-replication drain, peer-join catch-up, Arachnode storage monitor. List each subsystem `createLibp2pNode` starts and state whether it runs on a client.
- **Reactivity.** A client can subscribe but is never in a root (announcing) group, since that group is a storage group. Confirm subscription, renewal and the watch service's tail reads work when every read is remote.
- **FRET** is unchanged. The node still joins the ring for routing, at whatever `fretProfile` the embedder chose.

## Questions the plan must settle

- **No serving peer reachable.** A client write cannot commit locally. Does it fail with a retryable error, or wait under the existing remote-coordinator retry? Match what a remote-coordinator write does today, and document it.
- **Network creation.** A client cannot create a network alone, and a collection create with no serving peer must fail clearly, not report the collection absent. The bootstrap-contact rule (`heardFromBootstrapPeer`) is the nearest precedent.
- **Declared membership.** `backlog/feat-declared-membership-feeds-cohort-assembly` must exclude client nodes from a declared list, or cohorts include a peer that refuses to serve. Add an arm there or note the interaction.
- **Transient misclassification.** Between a connection opening and identify landing, a serving peer can briefly read `foreign` (the NOTE at `membershipOf`). Check that the reverse cannot happen, so a client never reads as `serves` from a remembered verdict (`rememberedServing`) saved before it switched to client mode under the same peer id.

## Out of scope

- Choosing which peers serve. That is the embedder's call (Sereus exposes it as a per-node role).
- Owner-aware placement (`backlog/feat-cohort-selection-owner-aware-placement`), which selects among serving peers and is unaffected.

## Evidence: GitHub sereus#63

Sereus asked for the same capability from the application side (cadre-core 1.23.0). Every machine of a party is put into the party's control-network write cohorts, including machines that should only read (a paired officer's dashboard browser, voters' phones). With one unresponsive browser in the cohort they measured 84 to 105 s per control write, against well under 1 s without it. The wait itself is the other-peer stall tracked from Optimystic's own GitHub #64; this ticket is what keeps such a machine out of the cohort in the first place. What the report adds to the plan:

- **Both kinds of network.** The need is for Sereus's control network as well as its per-workspace networks, so the option is per node, whatever the network is used for.
- **The client still writes, and the plan must say at what cost.** The reporter requires a refused machine to keep reading (remotely when it holds nothing) and to write its own rows. Their interim patch let it coordinate its own writes and measured about 120 ms for a voter's registration write. Under this plan a client's write goes to a remote coordinator instead; the plan should state that this is the intended trade and what a client write costs on a relayed link.
- **The other side of the same choice already exists.** `NodeOptions.isNetworkMember` lets every other node refuse a peer as a cohort member or coordinator ([docs/internals.md §Network Membership Predicate](../../docs/internals.md#network-membership-predicate)); Sereus's patch was the same idea (`controlCohortRefusal` / `strandCohortRefusal` predicates, plus an edge node withdrawing its storage protocols behind a closed identify gate). The plan should say how `servesBlocks: false` (the node declares itself a client) and the predicate (others decide) relate, and which one an embedder with a read-only role should use, so Sereus can drop its patch.
