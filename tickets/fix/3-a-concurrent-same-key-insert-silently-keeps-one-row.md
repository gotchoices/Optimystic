----
description: When two writers insert a row with the same primary key at the same moment, both are told they succeeded and exactly one row survives — no error anywhere. A duplicate key is supposed to be refused. Every schema that uses a unique key as a safety net is silently wrong under concurrency, and applications lose data without being told.
files: packages/db-core/src/collection/collection.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transaction/validator.ts
difficulty: hard
severity: corruption
likelihood: normal-use
----

# A concurrent same-key insert silently keeps one row

## What is wrong

A sequential duplicate insert is refused with the ordinary `UNIQUE constraint failed` error. A
*concurrent* one is not. When two writers insert the same primary key in the same window:

- both writers' promises fulfil — each is told its insert committed;
- exactly one row survives, the same one on every node;
- no error is raised anywhere.

The losing write is lost, and nothing tells its author.

## Where it was measured

Measured from Sereus on 2026-08-02, at sereus `53e54bd` / optimystic `092f33f`. Full record in
`../sereus/tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`. Three experiments:

1. **Two real nodes, same key.** Two `CadreNode`s with the replication cohort confirmed at 2 on both
   sides, both inserting `FormationUsage (Token, UseNumber=1)` in the same tick. Both promises
   fulfilled; exactly one row survived on both nodes' views (the second writer's).
2. **One node, two database handles** over one local store. Same result. Two machines are not
   required — only two writers the local write queue cannot see.
3. **Discriminator: different keys**, same setup. Both rows survived. The loss is specific to a
   shared primary key: the second commit *replaces* the first rather than being refused.

**This predates the fork guard and the pend-refusal fix.** Neither change targets this path, but
both touch commit handling, so **reproduce first on current `main`** before designing anything.
If it no longer reproduces, find out which change closed it and pin that with a test, rather than
closing this as fixed-by-accident.

## Where it likely lives (from the Sereus investigation; verify)

The SQL layer's key probe and deferred CHECKs run against a snapshot taken before the other
writer's row exists, so both pass locally. When the two commits meet in `db-core`'s `Collection`
commit/sync path — reached through `quereus-plugin-optimystic`'s virtual table — the uniqueness
decision is never re-made, and the row that lands second wins.

## Why it matters

- **Applications.** The natural way to give messages a total order is an integer key assigned as
  `max(Id)+1`, with the key's uniqueness as the net that catches a collision. On this stack that
  loses messages silently. Sereus now warns sApp developers against it in its schema guide, which
  is a workaround for a defect that belongs here. Raised publicly as gotchoices/sereus#5.
- **Sereus's own control schema** leans on "a duplicate insert is refused" in several places:
  every `StampId text not null unique` anti-replay column; `Strand`'s consent branch, which
  enforces "seated once, ever" through not-exists clauses over committed rows; and
  `Revocation` tombstones, which assume a committed row cannot be silently displaced.

## The expected fix shape

A commit whose primary key — or any unique value — was taken by a concurrently committed writer
must **fail**, surfacing as the same `UNIQUE constraint failed: …` error the SQL layer raises for a
sequential duplicate. The loser must be told, and the error must be distinguishable from a transport
failure, so an application can write a retry loop.

## Edge cases & interactions

- **Unique secondary indexes**, not just primary keys. Same class; check both.
- **More than two writers** racing the same key: exactly one wins, and every other writer is refused.
- **A writer whose replica is behind by several revisions** — it proposes a key that is already
  committed, not one that is merely in flight.
- **Delete then re-insert** of the same key by different writers. A legitimate re-use must not be
  refused as a collision.
- **Interaction with the fork guard** (`storage-repo.ts`, keyed on the writer's declared per-block
  `baseRev`): a refused duplicate must not register as a divergence to reconcile.
- **Interaction with the pend-refusal channel** (`coordinator-repo.ts`): the refusal must reach the
  writer's answer on every exit, the same property that ticket had to establish four times over.
- **Multi-collection transactions**: if one collection refuses a duplicate, the whole transaction
  must fail, not commit partially.

## TODO

- [ ] Reproduce experiments 1 and 3 on current `main`, using the one-node-two-handles shape as the
      cheap reproduction.
- [ ] Locate the merge point where the uniqueness decision is lost.
- [ ] Specify the refusal and its error shape, then output an implement ticket.
- [ ] Note in the implement ticket which Sereus callers classify constraint errors by message, so
      the new refusal matches what they already handle.
