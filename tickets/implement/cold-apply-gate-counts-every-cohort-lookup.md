description: Our performance test for a cold schema apply is meant to count how often a machine asks "which machines hold this block?", but it only sees 3 of the 54–144 times that actually happen, because most of the asking happens in a part of the test setup it cannot observe. Make the test count all of them, and record why making each question cheaper is not worth doing today.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions`, `createMesh` — the shared `MockMeshKeyNetwork` that `makeNodeKeyNetwork` wraps per node; add the observation hook here)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (`measureColdApply`, gate 4, `MEASURED`, the file header's dimension 4, the diagnostic print)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster` — add the accepted-tradeoff NOTE only; no behaviour change)
  - packages/db-p2p/test/bench-findcluster.mjs (header comment — record today's figure next to the historical one)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel path, the NOTE containing "they pay it once" — comment-only wording fix carried over from the plan ticket)
difficulty: easy
----
# Gate 4 counts every cohort lookup, and the solo-node memo is declined on measurement

## Background

`findCluster` answers "which machines form the cohort (the replica group) for this block?". `cold-apply-cost.spec.ts` runs a cold `APPLY SCHEMA` through a 1-node mesh (the in-process test network in `mesh-harness.ts`) and gates its cost. Gate 4 is meant to gate cohort lookups. It counts them with a proxy that replaces `mesh.keyNetwork`. Only the `NetworkTransactor` reads that property, though. Each node's coordinator and cluster member instead closes over the shared `MockMeshKeyNetwork` instance inside `createMesh`, through a per-node wrapper (`makeNodeKeyNetwork`). The proxy never sees their lookups.

## Measured (2026-09-11, current HEAD)

I counted by patching `findCluster` on the shared instance itself and attributing each call by stack frame. The composition was the same as the spec: a 1-node mesh with `withReadCache`.

| scale | objects | all seams | transactor seam (what gate 4 sees today) |
|---|---|---|---|
| SMALL (9 tables + 13 indexes) | 22 | **54** (2.45 / object) | 3 |
| LARGE (54 + 13) | 67 | **144** (2.15 / object) | 3 |
| SMALL_X3 (27 + 39) | 66 | **142** (2.15 / object) | 3 |

Per site, at 22 / 67 / 66 objects:

| n | site |
|---|---|
| 23 / 68 / 67 | `CoordinatorRepo.isResponsibleForBlock` ← the soft proximity check at the top of `CoordinatorRepo.get` |
| 23 / 68 / 67 | `CoordinatorRepo.fetchBlockFromCluster` ← the cohort consult in `get` |
| 3 / 3 / 3 | `NetworkTransactor.consolidateCoordinators` ← `pend` (the only seam gate 4 sees) |
| 3 / 3 / 3 | `ClusterCoordinator.getClusterForBlock` ← `getClusterPeerIds` / `getClusterSize` (commit path) |
| 2 / 2 / 2 | `isResponsibleForBlock` ← `verifyResponsibility` ← `pend` |

The plan ticket's figures (189 / 279 total, gate 4 at 42) predate the index-tree deferral and the solo absence memo (`settledAbsences`), and are obsolete. The shape today:
- **Two lookups per distinct block `get` reads.** One is the proximity check, which has a 60 s `responsibilityCache`, so a block pays it once. The other is the consult, which the absence memo now limits to once per `readRepairWindowMs` for a missing block on a solo node.
- **The commit side's fixed eight.**
- Gate 4 sees **1/18 to 1/48** of the real count, and none of the part that scales with schema size.

## Decided

**1. Fix the measurement (this ticket's code change).** Add an observation hook to the harness so a spec can wrap the *shared* key network before anything captures it. That is cleaner than reassigning `mesh.keyNetwork` after the fact, or monkeypatching a method on the instance:

```ts
// MeshOptions
/**
 * Wraps the mesh's shared key network before any node, member derivation or transactor captures it —
 * so a wrapper here observes EVERY cohort lookup in the mesh (each node's coordinator, cluster
 * coordinator and admission derivation, plus `mesh.keyNetwork`), not only the transactor's.
 * Reassigning `mesh.keyNetwork` after `createMesh` reaches the transactor alone.
 * Omitted → identity.
 */
wrapKeyNetwork?: (shared: IKeyNetwork) => IKeyNetwork;
```

In `createMesh`, apply it to the `MockMeshKeyNetwork` at its construction. The result is what `makeNodeKeyNetwork` closes over and what the returned `Mesh.keyNetwork` is. It must be applied before phase 1 builds any `deriveExpectedCluster` closure.

**2. Re-shape gate 4 as "cohort lookups per object, at every seam".** With one commit per apply, a per-commit ratio of the complete count is meaningless: 54 "per commit". Use the same shape as gates 5 and 6:
- a per-scale ceiling, about 20 % over the measured value: small **2.9**, large **2.6**;
- a no-growth check: `scaled ≤ small × SCALE_GROWTH_TOLERANCE` (1.05).

Keep the transactor-seam count in the diagnostic print, so a reader can see the split. It is not asserted: it equals the blocks per catalog pend, which is pinned by gate 2's single commit.

**3. The solo-node memo is declined, on measurement.** The plan ticket assumed a solo `findCluster` costs ~3.4 ms. That figure predates self-address memoization (`selfMultiaddrsCache`). `N=2000 node test/bench-findcluster.mjs`, a real solo `createLibp2pNode` with a wildcard TCP listener (the expensive-address configuration), now measures:

| call | cost per call |
|---|---|
| `findCluster` | **0.009 ms** |
| `hashKey` | 0.002 ms |
| `assembleCohort` | 0.004 ms |

144 calls therefore cost about **1.3 ms** per 67-object cold apply on Node.

A memo would have to be invalidated correctly on peer arrival and across the mid-identify window. `fetchBlockFromCluster`'s read-repair recovery relies on a later `findCluster` widening, so a stale "I am alone" answer is a correctness hazard, not a slowdown. That risk is not worth 1.3 ms. React Native is **not measured**: `hashKey`'s sha256 may be slower there. That is the revisit condition. Record the decision as an accepted-tradeoff `NOTE:` at `findCluster` (text in the TODO).

**4. Not pursued: passing one lookup to several sites.** The pair inside `get` (proximity check + consult) could share one lookup, halving the count. At 9 µs a call there is nothing to win. The proximity check's future also belongs to the human decision in `blocked/writer-and-servers-disagree-on-where-a-block-lives` (its option D2(b) would make `isResponsibleForBlock` live). The plan ticket's other observation stays declined, for the security reason it gave: `consolidateCoordinators` discards the cohort it computed, and the coordinator re-derives it. Sending the cohort over the wire would make it attacker-supplied.

## Edge cases & interactions

- **The seam silently detaching.** If a future edit drops `wrapKeyNetwork`, or captures the shared instance before it is applied, the complete count collapses. Gate 4 would then *pass* its ceiling and look like a large improvement. Add a sanity assertion that the coordinator side is observed. For example, count calls at the transactor seam separately (keep a proxy on `mesh.keyNetwork` for that) and require `complete > transactorSeam`, with a message telling the reader to check the hook is still attached. This mirrors gate 1's "check the cache is still attached".
- **Double counting.** If the spec keeps a transactor-seam proxy on top of the wrapped `mesh.keyNetwork`, the transactor's 3 calls land in both counters. That is correct as long as the two counts are separate `Counts` objects and only the complete one is gated.
- **The per-node wrapper mutates the returned record.** `makeNodeKeyNetwork` deletes partitioned-out peers and adds self to the object `findCluster` returns. The wrapper must return the inner result unchanged (pass-through, no freezing and no cloning assumptions).
- **Failure injection still works.** `failures.findClusterFails` and `partitionSides` are read inside `MockMeshKeyNetwork` and the per-node wrapper, so a wrapped instance must behave identically. Add one harness-level spec in db-p2p: a counting `wrapKeyNetwork` on a 3-node mesh sees a node coordinator's lookup (for example via a direct `node.coordinatorRepo.get`) *and* a lookup through `mesh.keyNetwork`. Omitting the option leaves `mesh.keyNetwork` as the unwrapped mock.
- **Timing sensitivity.** The consult site's count relies on the absence memo (10 s `readRepairWindowMs`), and the proximity site's on the 60 s `responsibilityCache`. The apply takes ~200 ms, far inside both windows. Name this in the gate comment, so a failure on a pathologically slow host is recognisable.
- **Moves that are deliberate, not regressions.** If the blocked writer/cohort ticket lands option D2(b) or its routing-key change, these counts can shift. Re-measure and move the number, with the new figures recorded in `MEASURED`, per the spec header's existing rule.
- **No behaviour change anywhere.** The hook defaults to identity at the ~40 existing `createMesh` sites. The `findCluster` and `coordinator-repo.ts` edits are comments only.

## Expected outputs (re-measure through the new hook; it should reproduce these exactly)

- small: 54 lookups / 22 objects = 2.45; transactor seam 3
- large: 144 / 67 = 2.15; transactor seam 3
- small x3: 142 / 66 = 2.15; transactor seam 3

## TODO

- Add `MeshOptions.wrapKeyNetwork` and apply it in `createMesh` at the `MockMeshKeyNetwork` construction, before phase 1. Add the db-p2p harness spec described in *Edge cases*.
- In `cold-apply-cost.spec.ts`:
  - count through `wrapKeyNetwork` (complete) and keep the `mesh.keyNetwork` proxy (transactor seam) as a second counter;
  - `ApplyCost` gains the complete count and a per-object figure;
  - rewrite gate 4 as per-object ceilings (small 2.9, large 2.6), a no-growth check and the "seam still attached" assertion;
  - replace gate 4's SCOPE comment, which says the coordinator side "needs its own gate in `db-p2p`" (no longer true), and update the header's dimension 4 to say it counts every seam;
  - update `MEASURED` with the new per-object figures, plus a history line: "gate 4 counted only the transactor seam until 2026-09-11 — 3 of 54 / 144 / 142";
  - print both counts in the diagnostic line;
  - in dimension 4's cost remark, add today's 0.009 ms/call next to the historical 3.4 ms.
- Add an accepted-tradeoff NOTE at `Libp2pKeyPeerNetwork.findCluster`, roughly: `NOTE: accepted tradeoff — a node with no peers recomputes the self-only cohort on every call (~2 per distinct block read; 144 calls in a 67-object cold apply). Measured 0.009 ms/call on Node with a wildcard TCP listener (test/bench-findcluster.mjs, N=2000, 2026-09-11), so a memo would save ~1.3 ms per apply while adding an invalidation hazard: a node that gains a peer, or finishes identifying one, must stop answering self-only immediately, and read-repair recovery relies on that widening. Revisit if an on-device (React Native) profile shows findCluster as material; then memoize ONLY the solo answer, invalidated on connection:open and peer:identify.`
- In `bench-findcluster.mjs`'s header, keep the historical 13.8 ms figure and add today's measurement and date.
- `coordinator-repo.ts` cancel path, comment only. The NOTE reading "Same shape `pend` and `commit` already pay, but they pay it once (they only ever consult `blockIds[0]`) where this scales with N" implies pend and commit avoid the duplicate lookup. They do not: on a multi-peer cohort both pay the same doubled lookup for `blockIds[0]`. Reword to say theirs is constant (one block) where the cancel's scales with N. The NOTE's suggested remedy (have `executeClusterTransaction` return the cohort it fetched) would fix all three.
- Build (`yarn workspace @optimystic/db-p2p build`, then the plugin build), then run `cold-apply-cost.spec.ts`, the new harness spec, and the full db-p2p suite (the harness change touches every mesh spec).
