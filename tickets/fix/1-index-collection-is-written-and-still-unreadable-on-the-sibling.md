description: The trace we just added settles a twelve-day-old question in the negative. Every write to the affected table does carry its index tree, staged and dirty, so nothing is being left out of the transaction. The row still cannot be found through that index on the other machine, which means the fault is somewhere after the commit, not in it.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-p2p/test/two-node-convergence-invention-race.spec.ts
difficulty: hard
repro: verified (in sereus, not here)
----

# The index IS in the write transaction — so the defect is downstream of the commit

## What the trace said

`1-name-the-collections-a-write-carries` landed to make one question answerable. It has been
answered, on the machine where the defect actually reproduces (sereus, 2026-08-25T04:18Z, this
repo built at `f008c0b`). **All four** writes to the failing table carry both collections, both
`staged`:

```
commit:collections mode=legacy count=2 \
  default/FormationUsage=staged default/FormationUsage/index/FormationUsageByToken=staged
```

Four lines is exactly right for the scenario — two machines × two cases, each writing one row.

Every other indexed write in the same run looks the same, including a three-collection one:

```
default/Strand=staged default/Strand/index/_uniq_1=staged default/Strand/index/_uniq_3=staged
default/OwnerKey=staged default/OwnerKey/index/_uniq_1=staged
default/CadrePeer=staged default/CadrePeer/index/_uniq_5=staged
default/FormationInvite=staged default/FormationInvite/index/_uniq_6=staged
```

**So the downstream claim this repo has been asked to explain three times — "the index collection
is absent from the write transaction entirely" — is refuted.** It was a reasonable reading of a
pend/commit log in 2026-08-12, the 2026-08-13 fix stage already corrected part of that reading, and
this closes it. Nobody should spend another pass on the staging or flushing path.

## What that leaves

The write is correct and the sibling still cannot find the row through the index, while a
primary-key descent and a full scan on that same sibling both find it. The fault is therefore in
what happens to the index collection **after** commit — replication, or the sibling's read of it.

The most specific candidate this repo already suspects is the **collection-invention race**. The
parent ticket added `two-node-convergence-invention-race.spec.ts` for the pure-reader arm — a node
that invents a collection and only ever reads it, which is exactly the shape an index
sub-collection takes on a sibling that never writes to the indexed table. That case converges in
isolation here, but it was written from reasoning, not from this measurement.

**The trace prints collection URIs, not block ids or revisions, and both machines print the same
URI (`default/FormationUsage/index/FormationUsageByToken`).** Identical URIs do not prove identical
lineage. The obvious next question is whether the two machines' index collections are the same
collection — same header block, same revision history — or two independently invented ones wearing
one name. The trace cannot currently answer that.

## Suggested next step

Extend the trace, or add a sibling to it, so a line names the **block id and revision** of each
collection at commit, not just its URI. Then one more downstream run says directly whether the two
machines committed into one lineage or two — the third outcome the parent ticket anticipated and
could not distinguish.

That is another observability step rather than a fix, and it should be weighed against just
instrumenting the sibling's *read* path instead: the failing read knows which index collection it
descended and at which revision, and that may be the cheaper end to open up.

## What is already ruled out — do not re-derive

From the parent (`1-two-node-index-divergence-guard-never-fires`) and its predecessors:

- Not the read-repair corroboration floor (sereus declares `assumedClusterSize: 2`, so a two-machine
  cohort relaxes to one voter).
- Not the maintained-index guards (each machine serves its own rows through the same seek, so each
  maintains the index; the guard's condition is provably absent).
- Not a forked *data* collection (a PK descent converges and a full scan sees the row on the same
  sibling in the same window).
- Not the mock transport, not write concurrency, not the cluster-size configuration, not composite
  text primary keys — all covered by the two-real-node spec added by the parent, which converges.
- **And now: not the write transaction's collection set.**

## Reproduce

Only in the sereus checkout — it is still not reproducible here:

```bash
cd packages/integration-tests
DEBUG='optimystic:quereus-plugin:txn-bridge' \
  npx vitest run src/scenarios/strand-formation-concurrent-redemption.integration.ts
```

Deterministic there: all 3 cases fail, every run since 2026-08-20.

One incidental observation worth a glance, not a ticket unless it means something: 123 of the 136
`commit:collections` lines in that run were `count=0`. Presumably read-only or no-op transactions,
but nobody has checked that a `count=0` commit is always legitimate.
