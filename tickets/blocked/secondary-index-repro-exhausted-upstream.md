description: Another project reports that a saved record is findable one way but not another on a second machine. Six attempts to reproduce that here have all succeeded in reproducing nothing, and the remaining leads all point at that other project's setup rather than at this one — so someone needs to decide whether to keep looking here or move the investigation there.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-shared-index-key.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
difficulty: medium
----

# The decision being asked for

Stop adding two-machine reproduction attempts in this repository, and move the investigation into
the reporting project — or say why not.

This is filed for a human because both of the things that would settle it are outside this
repository: the failing run lives in another project's test suite, and the remaining leads are all
differences in **how that project wires this library up**, not in the library's own behaviour.

# The report

A downstream project (`sereus`, checked out alongside this one) reports that a row written on one
machine replicates to a second machine, and on that second machine:

- a **full table scan** finds it,
- a **primary-key lookup** finds it,
- a **lookup that goes through a secondary index** does not — silently, and permanently.

Their ticket is `sereus/tickets/blocked/secondary-index-seek-blind-to-sibling-rows`, where it is
`repro: verified` on their side. The combination above is the part that keeps pointing at the index
specifically: a table that had simply failed to replicate would fail the scan and the primary-key
lookup too.

# Six attempts, six negatives

| # | attempt | result |
|---|---|---|
| 1–4 | four hand-written two-machine scenarios | all converge |
| 5 | 144 generated two-machine orderings, crossing which machine declares the table first, how the second machine opens it, when the index is created, write order, read-before-write, and whether the two machines share an indexed value (`test/two-node-index-interleaving-sweep.spec.ts`) | all 144 pass |
| 5b | the same sweep re-run on **real libp2p sockets** under the downstream project's own cluster settings | converges |
| 6 | shared indexed value created from nothing, three machines instead of two, a UNIQUE index across machines, and an index tree large enough to span more than one storage block (`test/two-node-shared-index-key.spec.ts`) | all 6 pass |

Attempt 6 also **refuted** the hypothesis that motivated it. It had been proposed that two machines
writing rows under one indexed value would fight over a single shared index slot, with the loser's
row silently dropped. That cannot happen: each row gets its **own** index entry, keyed by the
indexed value followed by the primary key, and a lookup scans the range of entries sharing the value
prefix. There is no single slot to fight over. Details are on
`review/two-node-shared-index-key-coverage`.

Two earlier hypotheses were likewise settled by measurement and should not be reopened: the index
**is** present in the write transaction (proved from the downstream project's own logs), and the
guards added by two earlier tickets are correct and simply cannot fire in this situation.

# Why the remaining leads are not in this repository

What is still different between the runs that pass here and the run that fails downstream is how
that project drives this library:

- The second machine opens its database by **loading the saved catalog** rather than re-issuing the
  table and index declarations.
- It runs a **write-through cache in front of raw storage**; none of the passing tests here do.
- The two machines hold **different roles** in that project's own node topology.
- Both machines print the **same collection name** in the logs, which does not prove they are
  writing into the **same** underlying collection. Two independently created collections wearing one
  name would produce exactly the reported symptom. Deciding that needs the block identifier and
  revision at the point of the failing read — i.e. instrumentation of the **downstream** read path.

None of these can be exercised from this repository without rebuilding that project's host wiring
here, which is a larger job than the instrumentation it would substitute for.

# What a human needs to choose between

- **Move it downstream.** Instrument the failing read on the machine that cannot see the row, and
  record which collection instance and revision it descended. This is the cheapest remaining step and
  the only one that distinguishes the same-name-different-collection theory from the rest.
- **Keep going here anyway**, by porting the downstream host wiring — catalog loading, the storage
  cache, asymmetric node roles — into a test in this repository. More expensive, and it is a guess
  about which of those three matters.
- **Close the downstream ticket as not-our-defect** until a run appears that implicates this library
  directly. Defensible after six negatives, and wrong if the collection-identity theory is right.

# One thing that should happen regardless, and that this agent did not do

`sereus/tickets/blocked/secondary-index-seek-blind-to-sibling-rows` still says the upstream count is
five. It should record the sixth negative and the refuted shared-slot hypothesis, so a seventh
attempt is not commissioned from stale information.

That edit was **not** made: it is a different repository and a different ticket board, and writing
into it would leave an uncommitted change in someone else's working tree that this project's commit
process would never pick up. Whoever picks this ticket up should make that edit there.

---

## Update 2026-08-30 — the "move it downstream" arm was taken, and it worked

The first of the three choices above has since happened, and the human deciding this ticket should
know before choosing again. `db-core` grew a diagnostic (`collection:lineage-divergence`) that a
collection emits when its own record of which action produced revision N disagrees with what storage
says. `sereus` re-enabled its reproducer and ran it. The line fired:

```
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=1 held=63cJ50MoBCietBFJBvxWeQ read=vPYEKDif1s1ItefiE-5DQw
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=2 held=W0vdcSKMif20MB6UYylCjQ read=NEJ50gSY7mr9KGV5QUKQDw
collection:context-not-lowered id=default/FormationUsage/index/FormationUsageByToken held=4 read=3
```

That settles the question the table of six negatives could not: the two machines are **not** on one
collection with one lagging. Two different actions occupy revisions 1 and 2 of the index collection,
and the machine that is a revision ahead then refuses the lower revision storage offers, so the split
never closes. The same-name-different-collection theory listed above is the right one, in the
specific form "one collection id, two lineages".

The capture was re-taken after `read-cache-dedupe-by-store-identity` landed and was unchanged, so the
"two caches over one store" explanation is ruled out.

What this means for the decision being asked:

- **Do not close it as not-our-defect.** The divergence is in this library's own bookkeeping, and it
  is reported by this library's own instrument.
- **Do not commission a seventh two-machine reproduction attempt here.** Six negatives plus a
  positive downstream is enough; more scenarios of the same shape are unlikely to add anything.
- The active work moved to `implement/coordinator-mutates-collections-outside-their-latch`, which
  names an in-repo cause that produces this exact fingerprint without needing two machines at all —
  the transaction commit path mutates a collection's revision bookkeeping without holding that
  collection's own latch, so a concurrent refresh can make a commit record a revision the storage
  layer assigned to somebody else. That ticket carries a local reproduction as its first task, so it
  will confirm or refute the cause without another downstream run.
- The architectural half — what the system should *do* once two lineages exist — was appended as an
  arm to `backlog/more-design/6.5-partition-healing`, which already owns the "Forked (conflict)"
  case.

The edit this ticket asked for in `sereus`'s own ticket (recording the sixth negative and the refuted
shared-slot hypothesis) still has not been made here, for the same reason as before: it is another
repository's board. It should now also record the positive capture above.
