description: Machines that hold no data still take places in the peer-discovery ring, and storage groups are picked from the few ring members nearest each block. When most machines are such clients, as in a vote with tens of thousands of phones and a few storage machines, the nearest members are almost all clients and storage groups come up short or empty. Decide how clients should sit in the ring so storage groups stay full.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/libp2p-key-network.ts (`membershipOverfetch`, `assembleServingCohortOnce`), packages/db-p2p/src/libp2p-node-base.ts (FRET construction), ../Fret/packages/fret/src/service/fret-service.ts (`applyMembershipSignal`, `assembleCohort`, sibling repository), ../Fret/docs/fret.md (*Network-scoped admission*), packages/db-p2p/src/cohort-topic/host.ts (non-root tiers use `fret.assembleCohort`), tickets/backlog/feat-fret-honours-the-network-membership-predicate.md
----

**Blocked: the architecture is silent on whether a node that holds no blocks is a ring member, and the answer needs a release of the FRET library.** Unblocks when a maintainer accepts or edits the proposal below.

## The problem

The client-only node (`servesBlocks: false`, implement ticket `client-only-node`) leaves FRET unchanged, so a client is an ordinary FRET ring member at its `fretProfile`. The key network builds a block's storage group by asking FRET for the `max(4 × clusterSize, clusterSize + 16)` ring members nearest the block (40 at the default `clusterSize` of 10) and keeping the ones that serve storage (`membershipOverfetch`, `assembleServingCohortOnce` in `packages/db-p2p/src/libp2p-key-network.ts`). By arithmetic, not measurement: a group is full only where at least 10 of those 40 serve, so with servers a quarter of the ring a group is full on average and short often, and with servers 1% of the ring a group is usually empty and the write fails with `FindCoordinatorError`.

Widening that band in the key network does not fix it. The band comes from this node's own FRET table, which holds peers near this node plus a few far ones; for a block far from this node, a mostly-client ring leaves few or no servers near the block in that table, and two nodes with different tables would assemble different storage groups for one block (the disagreement `routing-key-convention-divergence.integration.spec.ts` exists to catch). Every node has to agree on the serving peers near a block, which only FRET's ring can provide.

The same membership also puts clients in cohort-topic tiers below a reactivity root and in matchmaking cohorts (`fret.assembleCohort` in `packages/db-p2p/src/cohort-topic/host.ts`), which is the "sleeping devices on the critical path" concern for notifications rather than writes.

## Proposal (recommended default)

FRET gains a per-node participation setting, `FretConfig.participation: 'member' | 'client'`, default `'member'`. A `'client'` node:

- keeps a routing table and routes its own requests (`RouteAndMaybeAct`), and can still be dialled directly by peer id (reactivity notifications to a subscriber dial it by id, not through the ring);
- advertises itself as a client in the FRET protocols other nodes classify by, so every other node classifies it as `client`, not `member`;
- is never returned by another node's `assembleCohort`, neighbour sets, snapshots or routing-candidate lists, and never counts in the network-size estimate.

db-p2p sets `participation: 'client'` from `servesBlocks: false`. Then storage groups, cohort-topic tiers and matchmaking cohorts are all drawn from serving machines only, and a ring of thousands of clients around a few dozen servers assembles the same full groups the servers alone would.

What it costs: the network-size estimate counts serving machines only, which changes the cohort-topic tree depth (`d_max`) a large client population would otherwise drive — arguably the right count, since the tree's cohorts are made of members. A client also stops being a routing hop, so routing capacity comes from servers alone.

## Alternatives considered

- **Widen the key network's band adaptively** — rejected for the table-locality reason above.
- **A filtered FRET query, `assembleCohort(coord, want, predicate)`, that walks past non-matching peers** — needs the same table knowledge of servers near every block, which a mostly-client ring does not give a node, and leaves clients in tiers and routing.
- **Servers join a second FRET ring of their own** (a FRET `networkName` suffix used only for storage placement) — works without a FRET change, but doubles every server's ring maintenance and splits one deployment into two rings that can disagree on liveness.
- **Fold into `feat-fret-honours-the-network-membership-predicate`**: that ticket refuses strangers by a predicate; this is a node declaring its own role. Both end at FRET's `applyMembershipSignal`, so whoever designs either should design both, but they answer different questions.

## If nothing is done

Client-only nodes work where clients are a minority of the ring (Sereus's control network, a strand with a few read-only machines). Sereus's large-strand use case — the original reason for client-only nodes — does not: its writes fail for want of a storage group.

## Reversibility

A configuration value with a default of today's behaviour; turning it off restores ring membership at the next identify. The FRET wire change (advertising the role) is additive.
