description: The client library works out which machines are responsible for a piece of data using a different calculation from the one every server uses to answer that same question. On small networks nobody notices, because every machine is responsible for everything. On a network bigger than the replication group, the client sends writes to machines that will refuse them.
prereq:
files:
  - packages/db-core/src/utility/block-id-to-bytes.ts (pre-hashes: `sha256(utf8(blockId))`)
  - packages/db-core/src/transactor/network-transactor.ts:439 (`consolidateCoordinators` — picks the coordinator for every write from the pre-hashed key)
  - packages/db-core/src/transactor/network-transactor.ts:140,205,215,485,557,562,686,952,1089 (the other nine routing sites, all pre-hashed)
  - packages/db-p2p/src/libp2p-key-network.ts:972 (`findCluster` hashes whatever it is given — `hashKey(key)`)
  - packages/db-p2p/src/libp2p-key-network.ts:709 (`findCoordinator`, same)
  - packages/db-p2p/src/repo/coordinator-repo.ts:720 (`isResponsibleForBlock` — raw utf8)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1155 (`fetchBlockFromCluster`, the read path — raw utf8)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:242 (`getClusterForBlock` — raw utf8)
  - packages/db-p2p/src/repo/service.ts:229 (`checkRedirect` — raw utf8, with a comment explicitly warning against pre-hashing)
  - packages/db-p2p/src/reactivity/topic-bytes.ts:29 (names db-core's helper "double-hashing" and deliberately refuses it)
  - packages/db-p2p/src/reactivity/subscription-manager.ts:85 (same warning, independently)
severity: high
likelihood: certain-above-cluster-size
difficulty: hard
repro: not-yet-attempted
tradeoffs: Both conventions are self-consistent; the bug is that two subsystems picked different ones for the same keyspace. Either can be made to match the other, and whichever moves relocates every block's cohort on the ring — so for any network that already holds data, the fix is a migration, not an edit. That is why this ticket stops at reproduction and analysis and hands the convention choice to a human.
----

# The client routes by `H(H(id))`; every server decides responsibility by `H(id)`

## What is wrong

A block id becomes a ring coordinate twice in this system, by two different routes.

**db-core (the client/writer) pre-hashes.** `blockIdToBytes` returns `sha256(utf8(blockId))`, and `NetworkTransactor` passes that to `findCluster` / `findCoordinator`. Those then apply `hashKey` to whatever they receive (`libp2p-key-network.ts:972`, `:709`). So the writer's coordinate is **`hashKey(sha256(utf8(id)))`**.

**db-p2p (every server-side consumer) does not.** `isResponsibleForBlock`, `fetchBlockFromCluster`, `ClusterCoordinator.getClusterForBlock` and `RepoService.checkRedirect` all pass `new TextEncoder().encode(blockId)` — raw utf8. Their coordinate is **`hashKey(utf8(id))`**.

These are different ring positions for the same block, unrelated to each other.

## This is not a new discovery — two subsystems already worked it out and routed around it

`repo/service.ts:229` carries the warning in full, about this exact hazard:

> Pass the RAW encoded block-key bytes to getCluster. getCluster hashes internally (hashKey == sha256), so the responsible-set coordinate becomes `hashKey(encode(blockKey))` — identical to how the cluster coordinator derives it. **Pre-hashing here would double-hash (`hashKey(sha256(encode(blockKey)))`), placing the cohort at an unrelated ring coordinate and redirecting requests the coordinator legitimately routed to this peer.**

The reactivity subsystem reached the same conclusion independently and pinned its own encoding to avoid it — `topic-bytes.ts:29` calls `blockIdToBytes` "db-core's double-hashing" in as many words, and `subscription-manager.ts:85` repeats the warning, noting that a mismatch means "origination silently never reaches" the subscriber.

So three places in this repo know the double hash is wrong. The transactor's routing was never brought in line.

## Why every test passes

`assembleCohort(coord, wants)` returns the `wants` nearest peers to `coord`. When the network has **fewer peers than the cluster size**, every peer is among the nearest for *every* coordinate — so both conventions return the same set, and the mismatch cannot be observed.

Every mesh fixture in this repo is in that regime: small node counts against `DEFAULT_CLUSTER_SIZE = 10`. The mesh harness's `MockMeshKeyNetwork.findCluster` returns the single node for any key at all. So the defect is invisible to the entire suite by construction, and will stay invisible however many tests are added at those sizes.

**It becomes reachable exactly when the network grows past the cluster size** — which is the point of the system.

## What it costs when it is reachable

The writer picks a coordinator from the cohort at `H(H(id))` and sends the pend there. That node then runs `verifyResponsibility`, which computes the cohort at `H(id)`, does not find itself, and **throws**:

```
Not responsible for block(s): <id>
```

(`coordinator-repo.ts:747`.) The read path has a softer failure — `get`'s proximity check only logs `proximity:get-warning` and serves anyway — and `RepoService.checkRedirect` may bounce the request to a peer from the correct cohort, turning the fault into extra round trips rather than an error. **Which of those three outcomes dominates is exactly what the reproduction has to establish**; do not assert it from this ticket.

## Reproduce first — this ticket's whole job

Build a mesh with **more nodes than the cluster size** (the opposite of every existing fixture — e.g. 16 nodes at `clusterSize: 4`) and assert the two coordinates agree:

1. For a set of block ids, compute `findCluster(blockIdToBytes(id))` and `findCluster(utf8(id))` and show the returned peer sets diverge. This alone proves the bug without any I/O and should be the first test written.
2. Then drive a real write through `NetworkTransactor.pend` on that mesh and record what actually happens: a `Not responsible` throw, a redirect, or a silent success. Count redirects.
3. Do the same for a read, which takes the softer path.
4. Establish the threshold — at what network-size-to-cluster-size ratio does divergence begin?

A fixture with more peers than the cluster size is worth having whatever this ticket concludes; several other subsystems (cohort selection, ring shift, repair) are only ever exercised in the degenerate everyone-is-responsible regime today. Consider filing that fixture as its own `debt-` ticket if it outgrows this one.

## Do NOT fix the convention in this pass

Both conventions are internally consistent. Making them agree means moving one, and **whichever moves relocates every block's cohort on the ring**. For any network that already holds data, blocks stay where the old coordinate put them while lookups go to the new one — the data is still there and nobody can find it. That is a migration with a compatibility story, not a one-line edit, and it is adjacent to `backlog/debt-optimystic-key-format-migration`.

There is a defensible default — db-p2p's raw-utf8 convention is used by five sites including two that documented the hazard deliberately, against db-core's one subsystem — but "defensible default" is not the same as "safe to apply to deployed networks without asking". **Route the convention choice and its migration to `blocked/` for a human**, with the reproduction's numbers attached. Emit an implement ticket only for things that do not change wire behaviour (tests, the fixture, diagnostics that would have caught this).

## Edge cases and interactions

- **`repo/client.ts:138` and `cluster/client.ts:115` deliberately match db-core's pre-hashed convention** for the coordinator-cache key, and say so. They are consistent with the writer, so they move with whatever db-core does — but they are a third place the choice has to land, and their comments will be wrong the moment it changes.
- **`recordCoordinator` is fed pre-hashed keys** (`network-transactor.ts:562`), so the coordinator cache is keyed in the writer's space. A convention change invalidates every cached entry; confirm that is harmless rather than assuming it.
- **Reactivity is already on the raw convention** and pins it with a spec (`topic-bytes-encoding`). If db-core moves to raw utf8, check whether reactivity's coordinates collide with routing coordinates in a way they previously could not.
- **A mixed-version network.** If one node upgrades and another does not, they disagree about where every block lives. Whatever ships needs to say what happens during a rollout — this may be the hardest part of the migration, harder than the change itself.
- **`fretCohort` diagnostics** in the reporters' device logs are computed on the raw convention; a writer-side log of the same block would report a different cohort. Anyone comparing the two today is comparing incomparable numbers.

## What this does not explain

The device reports on GitHub issue #8 are **solo nodes**, where both conventions return `{self}` for every key. This bug cannot be their cause, and nothing here should be offered to those reporters as an explanation. It was found while tracing their problem, not by it.

## TODO

- [ ] Write the coordinate-divergence test first (no I/O, proves or disproves the whole ticket in one assertion).
- [ ] Build the larger-than-cluster-size mesh fixture and establish what a misrouted write actually does.
- [ ] Record the divergence threshold and the observed failure mode, with numbers, in the ticket you emit.
- [ ] Route the convention choice + migration to `blocked/` with those numbers. Do not change routing key derivation in this pass.
- [ ] Note for whoever takes the decision: `repo/service.ts:229` is the clearest statement of intent anyone has written down on this, and it chose raw utf8.
