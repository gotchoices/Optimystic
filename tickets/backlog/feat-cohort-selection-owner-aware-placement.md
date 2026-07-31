----
description: Asking for four copies of a block gets four machines, but nothing checks whether those machines belong to four different people. All four can sit with one operator, so the replication factor promises more independence than it delivers.
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/docs/cluster.md
difficulty: hard
----

# Cohort selection has no notion of who owns a peer

## What is true today

`clusterSize` is documented as the replication factor — "how many copies to keep". The group of
peers that ends up holding those copies is chosen in `findCluster`
(`packages/db-p2p/src/libp2p-key-network.ts`) purely by FRET proximity to the block's key, then
filtered for network membership: does this peer advertise *this* network's `cluster`/`repo`
protocol at all. That filter separates one network from another. It does not separate one
operator from another *within* a network.

So a request for N copies yields between 1 and N independent operators, decided by the hash of
the block being written. Nothing measures which, nothing reports it, and the configured number
is satisfied exactly either way.

This is the problem distributed stores usually solve with **rack awareness** — the rule that
replicas of a block must land in different failure domains (racks, availability zones, hosts)
rather than merely on different machines. Optimystic currently has no failure-domain concept at
all.

## Why it matters here, not just in theory

An embedder whose deployment model is "each participant runs several machines" gets the worst
case by default, because that is the normal shape rather than an unusual one. Concretely, in
`@serfab/sereus` a workspace is shared between parties and each party typically runs two to
four devices (a phone, a laptop, a home server). A replication factor of 4 in a three-party
workspace can place all four copies on one party's devices. That yields:

- **one** failure domain — one house fire, one stolen laptop pair, and every copy is gone;
- **one** witness — no second operator ever saw the write, so nothing corroborates it;
- **one** reachable source — while that operator's devices sleep, nobody else can read the
  block, and read repair has nobody honest to ask.

Raising `clusterSize` improves the odds but cannot fix it, and the gap widens as operators run
more machines each: an operator with four devices can single-handedly satisfy a request for
four copies.

It also caps what the security machinery can express. Any rule of the form "this write must be
attested by two distinct operators" is unenforceable while the layer selecting attestors cannot
tell operators apart. That is a live dependency: Sereus's
`backlog/feat-open-strand-witness-policy` is blocked behind exactly this, and its counterpart
`backlog/debt-cohort-selection-party-blind` tracks the embedder side.

## Shape of the ask

Roughly: an optional grouping label per peer, plus a selection rule that takes at most one peer
per label before taking a second from any label, degrading to today's behaviour when there are
not enough distinct labels to fill the cohort.

The label itself is the embedder's to supply — Sereus already establishes a party identity per
peer in its control database and could hand one over — but only if the selection layer accepts
one and the label can travel with a peer record.

Both selection sites would need it, not just one: `findCluster` picks the initial cohort, and
`spread-on-churn.ts` picks expansion targets when peers come and go
(`assembleCohort` / `expandCohort`). A rule applied to only one of them leaks the property back
out over time.

## Open questions a design must settle

- **Can the label be trusted?** An operator wanting extra copies of its own data could claim
  several labels; one wanting to be the sole holder could claim to be several operators. A
  self-asserted label is only as good as the identity behind it — adequate for an
  invitation-only deployment, inadequate for an open one. Whether this ticket requires signed
  labels or explicitly defers that is the first call to make.
- **How does it degrade?** With fewer distinct labels than `clusterSize`, the rule must fall
  back to filling from whatever exists rather than refusing to place copies. A two-machine
  deployment under one operator must keep working exactly as it does now.
- **Does it interact with the admission gate?** A member re-derives its own view of a block's
  cohort to judge an inbound write. If selection becomes label-aware, that derivation has to
  become label-aware in the same way, or the gate rejects legitimate cohorts as inconsistent
  with its derived view.
- **Should uptime feed the same rule?** "Prefer a machine that is always on" is a different
  preference from "prefer a different owner", and possibly a more valuable one for read
  availability. Embedders already classify nodes by profile. These may want to be one placement
  rule with two inputs rather than two rules competing over the same slots.
- **Where does the label live on the wire?** Peer records, the peerStore protocol lookup that
  membership scoping already performs, or a separate exchange — the last of these is the only
  one that does not add a field to something already load-bearing.

## Not in scope

No path is currently failing and this is not a regression. It concerns what the replication
factor means, not whether replication works.
