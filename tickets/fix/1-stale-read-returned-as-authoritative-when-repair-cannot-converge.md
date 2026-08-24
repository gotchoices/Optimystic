description: A node whose copy of a collection has fallen behind can be permanently unable to catch up, because the repair that would fix it needs to reach a peer whose address is the very thing it is missing. The repair fails forever, and the stale answer is handed back to the caller as if it were current, with nothing raised.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-core/src/collection/collection.ts
difficulty: hard
repro: verified (in sereus, not here)
----

# A repair that cannot converge still answers, and answers stale

## The circular dependency

Three nodes, A, B and C. C joins last and publishes its address into a replicated directory
table. A sees it, C sees it, **B never does** — not in 45 s, not afterwards. B cannot dial C, so
the two never connect. Nothing is thrown and nothing is logged as an error. B keeps serving reads
and committing writes to that table perfectly happily, from a different history of it.

B's lazy read-repair fires constantly on the block and fails the same way every pass:

```
cluster-fetch:no-quorum { blockId: 'default/CadrePeer', responders: 1, required: 2 }
```

Measured over one boot: **1821 `cluster-fetch:no-quorum`, 954 `read-repair-triggered`, 952
`read-repair-noop`, 2 `read-repair-applied`.**

The reason it can never converge is worth stating slowly, because it is the whole ticket. The
cohort B sees for that block is `[A, B, C]`, so `corroboratorCapacity` is 2 and the corroboration
floor stays at 2 (`quorum-restore.ts`). B can reach A. **The second corroborator B needs is C — and
C is unreachable precisely because the record being repaired is C's address.** The repair's
precondition is its own postcondition.

## The part that turns a stall into a wrong answer

`CoordinatorRepo.get` acts on an `inconclusive` outcome only under `if (isMissing && …)`. For a
block that is **present but stale**, the inconclusive verdict is discarded and the stale revision
is returned to the caller as an authoritative answer, unflagged.

That is the defect this ticket most wants fixed. A node that cannot establish whether its copy is
current has two honest options — say so, or keep trying — and it currently takes a third: answer
confidently with data it has no grounds to trust.

## Evidence that it is a genuine fork, not lag

Measured 2026-08-12 in sereus, six runs of a probe that boots a three-node control party in a loop
until it fails, then interrogates all three. Sibling repos clean and freshly built.

**1. B's view is stuck permanently; A's and C's are not.** Byte-identical across all five failing
runs, sampled every 2 s after the failure:

```
A[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
B[updatedAt=1786519566062 addrs=0 sig=(empty)]     ← the owner-vouch revision
C[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
```

**2. Routing is not the cause.** B does self-coordinate the block (930 of 930 `findCoordinator`
calls for it picked itself, while A picked B and C picked A) — but pinning every coordinator to A
and re-reading on B *still* returns 0 addresses. B asks A, and A answers with the old revision,
honestly, because the read is context-pinned: `TransactorSource.tryGet` passes
`context: this.actionContext` on every read, so a collection sitting at an old revision asks every
peer for that old revision's view and gets it.

**3. B has forked, not fallen behind.** After the failure, B commits a brand-new revision to that
same table successfully — and its read of C's row is *still* pre-refresh. B is committing on a
lineage that does not contain C's refresh, and the commit is accepted.

## Why it is being filed only now

Sereus has carried this as `control-peer-row-refresh-invisible-to-third-node` since 2026-08-12,
recording an upstream ticket `collection-view-forks-silently-when-repair-cannot-reach-quorum` as
filed here. **That ticket does not exist in this repository** — not on the board, not in
`complete/`, and no run log. It was never created, or was removed without one. So this analysis has
sat unowned for twelve days while three sereus integration suites failed on it.

## Relationship to the other two open fix tickets

Read `1-two-node-index-divergence-guard-never-fires` before starting. It describes two nodes that
each hold only their own row and never see each other's — plausibly this same fork seen from a
two-node shape. Sereus also tracks a third face of it (`forked-control-collection-sync-livelocks`),
which announces itself as `SyncRetryExhaustedError` where this one stays silent. **If they are one
defect, finding that out is worth more than fixing any one of them.** Do not assume it; the
fingerprints differ.

`1-inbound-relayed-connection-addr-is-never-published` is likely *not* the same thing, but it
touches the neighbouring question of which peers are reachable at all, so a change there may move
the numbers here.

## Reproduce

In the sereus checkout, from `packages/integration-tests`, at least five times — it is a boot race
(measured hit rate 5 failures in 66 consecutive boots):

```
npx vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

`control-write-degraded-cohort-member` and `control-cohort-edge-carries-data` fail their boot gate
on the same shape.

## Done means

At minimum, **the unflagged stale answer stops** — a present-but-stale block whose corroboration is
inconclusive must not be returned as authoritative. That is a self-contained change in
`CoordinatorRepo.get` and is worth landing on its own, ahead of any convergence fix.

Then, ideally, the circularity itself: a node that cannot corroborate because it cannot reach a
peer whose address it is missing needs some path that does not require the thing it lacks. Note
that the corroboration floor already drops to 1 when capacity is 1 — the problem here is that
capacity *looks* like 2 because C is in the cohort list while being unreachable.
