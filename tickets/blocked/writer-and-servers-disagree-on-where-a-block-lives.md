description: The client library and the storage servers use two different calculations to decide which machines hold a block, and on top of that a machine that writes a block always keeps a copy and always takes one of the block's replica slots, even when it is not one of the responsible machines. Measured on a real six-node network, most blocks end up one responsible holder short and half of all reads from another machine bounce once before finding the data. Fixing either changes where copies land, so a human should choose the convention and the order of the fixes.
prereq:
files:
  - packages/db-core/src/utility/block-id-to-bytes.ts (the client's pre-hash: `sha256(utf8(blockId))`)
  - packages/db-core/src/transactor/network-transactor.ts:439 (`consolidateCoordinators` — the pend path; picks the first peer covering the most blocks, which is always the writer's own node)
  - packages/db-core/src/transactor/network-transactor.ts:140,205,215,485,557,562,686,952,1089 (the other pre-hashed routing sites, including `queryClusterNominees`)
  - packages/db-p2p/src/libp2p-key-network.ts:972 (`findCluster` — hashes whatever it is given; ALWAYS includes self; on the membership-scoped path self takes one of the `clusterSize` slots and displaces a responsible peer)
  - packages/db-p2p/src/libp2p-key-network.ts:709 (`findCoordinator` — same hashing)
  - packages/db-p2p/src/network/network-manager-service.ts:311 (`getCluster` — the redirect check's cohort; no self)
  - packages/db-p2p/src/repo/service.ts:229 (`checkRedirect` — raw utf8; only ever sees REMOTE ops, so never a write from the node's own transactor)
  - packages/db-p2p/src/repo/coordinator-repo.ts:720 (`isResponsibleForBlock` — vacuous in production because `findCluster` always includes self)
  - packages/db-p2p/src/repo/coordinator-repo.ts:747 (`verifyResponsibility`'s `Not responsible` throw — dead code in production, for the same reason)
  - packages/db-p2p/src/repo/coordinator-repo.ts:752 (the `NOTE` on `get` about soft-served reads acquiring replicas — its tripwire has tripped, see Finding C)
  - packages/db-p2p/src/repo/client.ts:138 and packages/db-p2p/src/cluster/client.ts:115 (coordinator-cache keys deliberately matching the pre-hash; their comments go stale with any change)
  - packages/db-p2p/src/reactivity/topic-bytes.ts:29 (already raw utf8, pinned by a spec)
  - packages/reference-peer/src/cli.ts:464 and packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:280 (production transactor wiring: self goes straight to the local coordinated repo, bypassing the redirect check)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts (evidence, runs in `yarn test`)
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (evidence over real sockets, gated on OPTIMYSTIC_INTEGRATION=1)
difficulty: hard
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Both routing conventions are internally consistent and the writer-keeps-a-copy behaviour could be called a feature; every option below changes which machines hold which blocks on a live network, and a maintainer may reasonably decide the current behaviour is acceptable until the network is large enough for the shortfall to matter.
----

# The writer and the servers disagree on where a block lives — and the writer always keeps a seat

This replaces `fix/bug-writer-and-cohort-disagree-on-where-a-block-lives`. That ticket asked for a reproduction before any decision. The reproduction is done, the numbers are below, and they change the picture in two ways: the failure mode the ticket predicted (`Not responsible` throws) **cannot happen** in production, and a second, independent cause turned out to dominate what actually goes wrong. Both are laid out here so one decision can cover them.

## What was measured

Three specs, all committed alongside this ticket. Run the first two with `yarn workspace @optimystic/db-p2p test --grep "routing-key convention"`; the third needs `OPTIMYSTIC_INTEGRATION=1` in the environment and `test:integration` instead of `test`.

**1. FRET's real cohort assembly, no network (unit spec).** Sixteen freshly generated peers on the real ring, cohort width 4, 400 block ids. The writer's cohort (at the double hash) and the servers' cohort (at the single hash) were compared per block:

| measure | count of 400 |
| --- | --- |
| cohorts differ | 349 (87%) |
| writer's nearest peer is not in the servers' cohort at all | 276 (69%) |
| cohorts share no member | 208 (52%) |

**The threshold is exact.** Sweeping ring size with cohort width 4 over 200 ids: 1, 2, 3, 4 peers disagree on **zero** ids; 5 peers disagree on 135; 6 on 154; 8 on 163; 16 on 183; 32 on 190. Agreement is perfect while the ring is no wider than the cohort, because the cohort is then "everyone" from any coordinate. It breaks at the very next peer. Every mesh fixture in this repo is at or below that width, which is why nothing had noticed.

**2. Mesh harness, 16 nodes, cohort width 4 (unit spec).** A direct pend and commit through `NetworkTransactor` succeed. The coordinator the transactor chose was outside the responsible cohort; it ran the cluster transaction anyway (the harness's key network, like production's, adds self to every cohort), and the block landed on **five** nodes: all four responsible ones plus the coordinator. A Diary written the same way reads back complete from another transactor.

> **2026-09-11 correction:** that last sentence depends on where the random log-block id falls on the ring. On the spec's now-seeded mesh (`keySeed: 16`), about 1 run in 5–8 reads the Diary back **empty**. Revision 1 of the log block lands on one out-of-cohort node, and revisions 2 and 3 are acknowledged but stored on no node. The lost acknowledgement is a defect under any convention and is tracked in `fix/acknowledged-diary-commits-land-on-no-node`. This ticket's divergence is what sets it up.

**3. Six real libp2p nodes over TCP, `clusterSize: 2`, 24 blocks (integration spec).** A `NetworkTransactor` wired exactly as `reference-peer/cli.ts` and the Quereus plugin wire it (self goes to the local coordinated repo, remote peers through `RepoClient`), driven from one node; every node's `RepoService.checkRedirect` and served repo instrumented; then all 24 blocks read back through a second node's transactor.

| write-side measure | count of 24 |
| --- | --- |
| writes that failed | 0 |
| pends coordinated by the writer's own node, locally, no redirect check on the path | 24 |
| redirect decisions that saw a pend or commit | 0 |
| blocks for which the writer's node is one of the two responsible peers | 5 |
| blocks stored on the writer plus only ONE of the two responsible peers | 19 |
| blocks where a responsible peer never received the block | 19 |

| read-side measure (24 reads from a different node) | count |
| --- | --- |
| reads that failed | 0 |
| reads that went to a remote node | 22 |
| redirect checks run | 35 |
| reads redirected at least once | 13 |
| blocks that gained an extra replica because a non-holder served the read and kept it | 11 |

## Finding A — two conventions for one keyspace (the original ticket)

`blockIdToBytes` in db-core returns `sha256(utf8(id))`; `findCluster` and `findCoordinator` hash again, so the transactor routes on `sha256(sha256(utf8(id)))`. Every server-side decision — responsibility, cluster membership for consensus, the redirect check, the read-path cohort consult, reactivity — routes on `sha256(utf8(id))`. Three places in the tree already say the double hash is wrong (`repo/service.ts:229`, `reactivity/topic-bytes.ts:29`, `reactivity/subscription-manager.ts:85`).

**What it costs today.** Only reads and the transactor's coordinator-based paths (commit fallback, retry, cancel, `queryClusterNominees`) actually use the double-hashed coordinate, because writes never leave the writer's node (Finding B). On the six-node network, 13 of 24 reads from a non-writer node paid a redirect round trip, and 11 of 24 reads were served by a node that did not hold the block and now does (Finding C). As the network grows, the fraction of reads that start at the wrong node approaches 100%.

**The migration the original ticket feared is smaller than it looks.** Nothing durable is keyed by the double hash. Servers have always placed and judged blocks at the single hash; the data is already where the servers think it is. The only double-hash-keyed state is the in-memory coordinator caches (`recordCoordinator`, `repo/client.ts:138`, `cluster/client.ts:115`), all TTL-bounded. Moving db-core to raw utf8 changes the client's **first hop** and nothing else. A mixed-version rollout keeps working: an old client keeps misrouting and being redirected exactly as it is today. This is worth double-checking during implementation, but it is what the code says.

## Finding B — the writer's own node always coordinates, and always takes a replica slot (new)

This is what the reproduction actually found dominating, and it is **independent of Finding A**: it would be true under either convention.

- `Libp2pKeyPeerNetwork.findCluster` always includes self. On the membership-scoped path — every production node, since `networkName` sets `protocolPrefix` — it builds the cohort as `[self, ...nearest (clusterSize − 1) serving peers]`. Self is put **first** and **reserves a slot**, displacing a responsible peer whenever self is not among the nearest. The comment there justifies this by assuming the caller is the coordinator and "self is near the key". Under the transactor that assumption is never checked.
- `NetworkTransactor.consolidateCoordinators` (the pend path) asks `findCluster` for every block, then greedily picks the peer covering the most blocks, first-seen wins ties. Self is first in every cohort and in every block's cohort, so **self always wins**. Every pend from a node is coordinated by that node, through the local coordinated repo, with no `RepoService` and therefore no redirect check anywhere on the path. The integration run shows this for 24 of 24 blocks.
- The writer's coordinator then runs consensus over `[self, one responsible peer]`. The other responsible peer never hears about the block. Result: 19 of 24 blocks are one responsible holder short, with the missing copy sitting on the writer, which the ring never consults for that block.

Two consequences the decision-maker should know about:

- `CoordinatorRepo.isResponsibleForBlock` and `verifyResponsibility` are **vacuous in production**. Self is always in the cohort, so the answer is always "responsible" and the `Not responsible for block(s)` throw at `coordinator-repo.ts:747` is dead code. The doc comment on `isResponsibleForBlock` ("self is always included in the cohort when this node is responsible") is misleading — self is included unconditionally. The original ticket's predicted failure mode cannot occur.
- The harness models the **other** shape: the mesh harness's per-node key network adds self as an *extra* (cohort + self), which is also what production's unscoped path does (`[...cohort, self]`). Under that shape the responsible cohort stays full and the writer is a fifth, phantom holder (spec 2). Under the scoped path's shape the writer displaces a responsible peer (spec 3). The scoped shape is the worse one, and it is the one production runs.

## Finding C — a tripwire has tripped

The `NOTE` on `CoordinatorRepo.get` (`coordinator-repo.ts:752`) says a soft-served read acquires the block durably on a node that is not responsible for it, that nothing ever sweeps such replicas, and that this is fine "while soft serves are what they are meant to be — a rare degradation during routing churn"; if they become routine, "gate acquisition on `isResponsibleForBlock`". Under Finding A they are routine — 11 of 24 reads from another node left a replica behind — and the suggested gate is vacuous under Finding B. Fixing A removes the cause (reads land on holders); nothing separate needs filing, but the NOTE's condition should be re-read once A lands.

## Decisions requested

**D1 — which convention.** Recommendation: **raw utf8**, the servers' convention. Five server sites use it, two of them with the hazard written down, reactivity is pinned to it by a spec, and it needs no data movement. The shape that makes the mismatch unrepresentable is to route by `BlockId` and encode in exactly one place: either `IKeyNetwork.findCluster`/`findCoordinator` accept a `BlockId`, or db-core exports a single `routingKeyBytes(blockId)` that both packages use and `blockIdToBytes` is retired. Sites that move: the eleven transactor sites in `files:` above, `repo/client.ts:138–160` and `cluster/client.ts:115` (and their comments), and the redirect spec's `blockKeyMapKey` helper. The new unit spec's first assertion ("the two coordinates never coincide") must flip to "always coincide" when this lands — that is deliberate; it is the regression pin.

**D2 — does a writer keep a copy and take a slot?** Options:

- (a) **Self is an extra, never a replacement.** Cohort = nearest `clusterSize` responsible peers, plus self if self is not among them. This is what the unscoped path and the harness already do. Smallest change (the scoped path's `nonSelfTarget = clusterSize − 1` becomes `clusterSize`); the responsible cohort is always full; the writer keeps a phantom copy that nothing sweeps. The admission gate tolerates it (one symmetric-difference under the default 0.5 tolerance at any cluster size ≥ 2).
- (b) **Self only when genuinely nearest.** `findCluster` stops adding self; `isResponsibleForBlock` becomes live; `consolidateCoordinators` picks a genuinely responsible peer and the write goes remote through `RepoService` (where the redirect check finally sees writes). Correct placement, no phantom copies, but a real behaviour change: a node's own writes now cost a network hop, and every "solo node" and "self-coordination" path in `findCoordinator` must be re-read against it.
- (c) **Keep it, document it as a feature** ("a writer holds what it writes") and accept that the responsible cohort is one short for most blocks. Not recommended: it silently violates the replication factor the operator configured.

Recommendation: (a) now, because it is one line and repairs the shortfall; (b) as a follow-up if phantom copies ever matter (`feat-cohort-selection-owner-aware-placement` will care, since a phantom is a copy on an operator the placement rule did not choose).

**D3 — order.** A and B(a) are independent and can land together. If they must be sequenced: A first is safe (reads improve; writes unchanged). B(b) before A would make `verifyResponsibility` live while the transactor's self-pick is still on the wrong coordinate, turning today's silent shortfall into a throw-retry-redirect loop on every write — functional, but noisy. Do not ship B(b) without A.

## Things that stay true whatever is decided

- `RepoService.responsibilityK` defaults to 1, so its "small mesh, skip the redirect" branch never fires on a real network; the redirect check is live for every remote op.
- The harness supports meshes wider than the cohort today (`createMesh(16, { responsibilityK: 4, clusterSize: 4 })` worked with no changes). No new fixture is needed for this; `debt-no-mesh-fixture-forces-two-coordinator-batches` has been given an arm explaining why production never produces two pend batches either.
- The device reports on GitHub issue #8 are solo nodes. Neither finding applies to them; nothing here should be offered to those reporters.
- Logs from the runs that produced the tables above are in `tickets/.logs/bug-writer-and-cohort-disagree.*.log` until the pruner removes them; the specs regenerate them.
