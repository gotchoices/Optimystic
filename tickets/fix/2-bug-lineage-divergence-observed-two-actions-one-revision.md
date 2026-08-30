----
description: The divergence diagnostic added for this defect fires on the only workload that reproduces it — two different actions occupy the same revision slot of one collection, and the guard that refuses to move a collection backwards then makes the split permanent. Captured downstream; this is the observation that ticket was built to obtain.
prereq:
files:
  - packages/db-core/src/collection/collection.ts (advanceContext / reportShortfall — the diagnostic that fired)
  - packages/db-core/test/two-handle-collection-fork.spec.ts (the negative control that still passes)
  - packages/db-p2p/src/storage/shared-cache-pool.js (see "where to look next")
difficulty: hard
severity: silent-wrong-answer
likelihood: deterministic-in-the-reporting-repo
repro: measured downstream
----

# `collection:lineage-divergence` FIRES — two actions occupy one revision slot

The diagnostic added by `make-a-refresh-able-to-say-the-two-copies-disagree` fires on its first
run against the only workload that reproduces the fork. Captured in `sereus` on 2026-08-29 with
the reproducer temporarily restored, against optimystic at `17c6b685`.

```
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=1 held=63cJ50MoBCietBFJBvxWeQ read=vPYEKDif1s1ItefiE-5DQw
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=2 held=W0vdcSKMif20MB6UYylCjQ read=NEJ50gSY7mr9KGV5QUKQDw
collection:context-not-lowered id=default/FormationUsage/index/FormationUsageByToken held=4 read=3
```

## RE-MEASURED after `read-cache-dedupe-by-store-identity` — NOT closed by it

Re-ran the same reproducer against HEAD with that work landed (and
`store-identity-plumbing` / `duplicate-store-identity-guard` alongside it). The fork is unchanged:

```
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=1 held=7dYxrbrubG8Vu_iWLwm7Hw read=CawkObrpMIdukvK1GIvN7w
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=2 held=lqqTpGD5JdJHBEMPy1jD0A read=UPVDy94VBVHD1o30U3uihQ
collection:context-not-lowered id=default/FormationUsage/index/FormationUsageByToken held=4 read=3
```

Same collection, same two revision slots, same `held=4 read=3` seal — fresh action ids, so it is a
new occurrence rather than a cached artifact of the earlier run. All three scenario cases still
fail. **So "two caches over one store" is not the mechanism here**, or not the only one; whatever
splits the lineage survives deduping the caches by store identity.

Worth stating because the plan for that work reads as though it would cover this: it does not, and
assuming otherwise would close this ticket on a passing sibling test rather than on the workload
that actually diverges.

## What it says

**At the same revision number, the held action id and the stored action id differ** — twice, at
rev 1 and rev 2 of one collection. That is the fork, named: two branches occupying one revision
slot of one collection id, not a follower lagging behind a shared history.

Then `context-not-lowered` closes it: the local copy is at rev 4, storage offers 3, and the guard
that refuses to move a collection backwards declines. So the node stays on its own branch and
nothing merges the other one in. That guard is correct in isolation — it is what stops a stale
read from rewinding a collection — but on a forked lineage it is what makes the fork permanent.

## What it rules in and out

- **It fires ONLY on the index sub-collection.** In the same run, on the same two nodes, under the
  same writes, the main table collection of that same table never diverges — it converges to a
  byte-identical action id. Whatever forks the index does not touch the main tree.
- **It is not the db-core reconciliation path.** `two-handle-collection-fork.spec.ts` (landed with
  the diagnostic) drives two handles over one transactor through five shapes and every one
  converges. That negative control still holds; this fork is produced above it.
- **`collection:invented` fired 68 times** in the same run, uniformly across collections — normal
  per-node bring-up, not a signal, as established previously.

## Reproducing it

Still only here. The workload is two machines concurrently inserting rows under one shared
SECONDARY-INDEX key, then reading back through that index; each node then sees only its own row,
permanently. In `sereus` the reproducer is switched off (the index it needed was removed because
the invitation seat cap counted through it and over-admitted without bound across machines) and is
restored by re-adding one schema line — recipe on
`tickets/blocked/secondary-index-seek-blind-to-sibling-rows.md` there. This run used it and removed
it again.

The scratch spec in your tree (`zz-repro-index-drift.spec.ts`) is chasing the same thing; the two
`rev=N held=X read=Y` pairs above are what a successful reproduction should print.
