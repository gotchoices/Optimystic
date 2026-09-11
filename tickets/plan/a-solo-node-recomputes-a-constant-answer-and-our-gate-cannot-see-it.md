description: A machine with no peers works out "which machines hold this block?" from scratch on every single operation, and on a one-machine deployment the answer is always the same one machine. Roughly 190 of those calculations happen during one modest schema application. Our own performance gate reports 42 of them, because it only watches one of the six places they happen — so anyone who fixed this would see almost no movement in the number we guard.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts:969 (`findCluster` — no result memo of any kind)
  - packages/db-p2p/src/libp2p-key-network.ts:282 (`coordinatorCache` — the only memo here, and it serves `findCoordinator` only)
  - packages/db-p2p/src/libp2p-key-network.ts:608 (`recordCoordinator` — drops a pick of self, so a solo node caches nothing at all)
  - packages/db-p2p/src/libp2p-key-network.ts:296 (`connection:open` listener — an invalidation hook already exists here)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 — the incomplete measurement)
  - packages/db-p2p/src/testing/mesh-harness.ts:299 (the shared key-network object every per-node wrapper closes over — how to instrument all seams)
difficulty: medium
tradeoffs: A cohort memo is a cache in the routing layer, and a stale cohort is a correctness problem rather than a slow one. The solo case is the exception — its answer is not merely stable but constant, derivable without consulting anything — which is why this ticket is scoped to it rather than to caching cohorts generally. Scoping it that way also means it buys nothing for the large networks where routing is genuinely expensive.
----

# A solo node recomputes `{self}` about 190 times per schema apply, and gate 4 sees a fifth of it

## Measured

From a trace of the existing cold-apply workload (1-node mesh, `withReadCache`, the same composition `cold-apply-cost.spec.ts` uses), counting `findCluster` at **every** seam rather than only the transactor's:

| seam | 22 objects | 67 objects |
|---|---|---|
| what gate 4 counts (transactor) | 42 — **3.00**/commit | 42 — **3.00**/commit |
| **what actually happens (all seams)** | **189 — 13.50**/commit | **279 — 19.93**/commit |

Per-site breakdown (22 objects / 67 objects):

| n | call site | reached from |
|---|---|---|
| 54 / 99 | `coordinator-repo.ts:1156` `fetchBlockFromCluster` | the read path in `get` (`:818`) |
| 42 / 42 | `network-transactor.ts:439` `consolidateCoordinators` | `pend` (`:526`) — **the only site gate 4 sees** |
| 28 / 28 | `coordinator-repo.ts:723` `isResponsibleForBlock` | `verifyResponsibility` ← `pend` (`:1951`) |
| 28 / 28 | `cluster-coordinator.ts:244` `getClusterForBlock` | `getClusterPeerIds` ← `commit` (`:2392`) |
| 23 / 68 | `coordinator-repo.ts:723` `isResponsibleForBlock` | the soft proximity check in `get` (`:762`) |
| 14 / 14 | `cluster-coordinator.ts:244` `getClusterForBlock` | `getClusterSize` ← `pendThroughCluster` (`:1969`) |

## Two separate findings, and the gate one comes first

**1. The gate is 2.2× to 5.6× incomplete, and it is blind to the part that grows.** Gate 4's own comment says it excludes the coordinator side and calls the seam "stable, not complete". "Stable" is doing a lot of work there: the two sites it misses that scale with schema size (54→99 and 23→68) are precisely the ones an optimization would move, while the 42 it does count are pinned by blocks-per-pend and never change. **A change that eliminated three quarters of the real calls would show gate 4 at exactly 3.00 before and after.** Fix the measurement before optimizing against it, or the optimization is unguarded and the gate is a false comfort.

The technique is known: instrument the *shared* mesh key-network object every per-node wrapper closes over (`mesh-harness.ts:299`), rather than reassigning `mesh.keyNetwork`, which only catches the transactor's seam.

**2. On a solo node every one of those calls provably returns the same answer.** For a node with no peers, `findCluster` is a pure function of self: `assembleCohort` over an empty ring yields `[]`, so `ids = [selfId]` (`libp2p-key-network.ts:980`), the membership-scoped branch does zero peerStore reads because `nonSelf` is empty (`:1001`), and the single member takes the `idStr === selfId` arm (`:1073`). Every call, every key, returns `{self}`.

So 100% of the 189 / 279 calls are incapable of returning information the node does not already have. The spec header prices a call at ~3.4 ms on Node; on React Native over a native storage bridge it is worse, and this is one of the costs the reporters on GitHub issue #8 are paying.

There is no coordinator cache to soften it either: `recordCoordinator` deliberately drops a pick of self (`:608`), for the sound reason that a self entry would pin the key to our own possibly-stale replica for the full TTL and skip `shouldAllowSelfCoordination`. Correct, and it means **a solo node memoises nothing whatsoever** — neither cohorts nor coordinators.

## What a design pass has to settle

**1. Scope: solo-only, or a general cohort memo?** Recommend solo-only. The solo answer is *constant*, not merely stable, so it needs no staleness reasoning at all — which is not true of a cohort memo in general, where the invalidation story is the whole risk. Do not let this ticket grow into the general case.

**2. What invalidates it.** A peer appearing is the only event that can change the answer, and it is observable — the class already listens to `connection:open` (`:296`). Settle whether that alone is sufficient or whether FRET routing-table changes need their own hook. Getting this wrong means a node that gains a peer keeps behaving as though alone, which is materially worse than the cost being saved.

**3. The mid-identify window.** `findCluster` deliberately never admits a not-yet-identified member and re-includes it once identify completes. A memo must not freeze a self-only cohort across that transition. Note that `coordinator-repo.ts:1184` explicitly relies on a later `findCluster` widening for read-repair recovery — this memo must not defeat that.

**4. Where it lives.** A memo on `Libp2pKeyPeerNetwork` will not appear in mesh tests, which inject their own key network. Put it where the mesh exercises it, or the new gate measures a configuration nothing ships — the same trap recorded in the schema-batch ticket about `withReadCache`.

**5. Whether the call count itself should drop.** Six sites ask the same question about the same block within one operation. A memo makes each cheap; passing the answer along would make most unnecessary. Decide whether to do only the first now and file the second, or whether the second makes the first pointless. See the related finding in `fix/1-bug-writer-and-cohort-disagree-on-where-a-block-lives` — that ticket establishes the writer and the cohort currently compute *different* coordinates, so plumbing one answer through both is not merely a refactor today.

## A second finding from the same trace, recorded so it is not lost

`consolidateCoordinators` computes a full cohort per block and then keeps only `Object.keys(clusterPeers)` (`network-transactor.ts:440`); nothing downstream ever receives the cohort, so the coordinator re-derives the same block's cohort from scratch on arrival. On a co-located or solo node that is the same process answering its own question twice. Passing it over the wire is **not** a safe fix — the cohort would then be attacker-supplied, and the membership-admission argument at `cluster-repo.ts:1260` applies. Recorded as context for question 5, not as a proposed change.

Also verified while there: the NOTE at `coordinator-repo.ts:2358` is true as written (the cancel path's doubling is O(N) where pend's and commit's is O(1)), but its phrasing "they pay it once" reads as though pend and commit avoid the duplicate pair, and they do not — on a multi-peer cohort both pay it for `blockIds[0]`, exactly the cancel shape, just not multiplied by N. The NOTE's own suggested remedy would fix all three. Worth correcting the wording whenever that file is next touched; not worth a ticket of its own.

## Scope handed over from `a-block-we-do-not-hold-is-consulted-on-every-read`

That ticket's plan pass (2026-09-11) split its work with this one. Recorded here so neither pass redoes the other's:

- **That ticket (now in `implement/`) owns the consult RATE for a block this node does not hold.** A missing block now skips its consult for one `readRepairWindowMs` after a consult settled its absence. On the cold-apply trace above, that should shrink the `fetchBlockFromCluster` site (54 / 99), because repeat absent reads within one window stop consulting. Re-measure after it lands before sizing this ticket's gain; some of the growth this ticket attributes to that site may already be gone.
- **This ticket owns the per-consult COST on a solo node:** that ticket's question 1 proposed short-circuiting "before `findCluster`, so the cohort lookup is saved too", which cannot be done without knowing the cohort is solo, and that is exactly this ticket's memo. Every consult that ticket still runs (the first per window, per block) calls `findCluster` as before.
- The superseded ticket `every-read-re-derives-its-routing` was deleted in commit 874d87c7. Its one surviving observation, that `recordCoordinator` drops self picks, is already recorded here at `:608`.

## TODO

- [ ] Fix gate 4's measurement first, and record the honest before-number in this ticket. Do not optimize against the current gate.
- [ ] Settle questions 1–5; emit implement ticket(s).
- [ ] Whatever ships must be guarded by the corrected gate at both scales, and must include a test that a solo node which *gains* a peer stops answering `{self}`.
