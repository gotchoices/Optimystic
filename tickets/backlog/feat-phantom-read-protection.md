description: Decide whether a transaction that reads a block which does NOT exist, and later that block gets created by someone else, should be forced to fail — the system used to do this by accident, and a recent change quietly stopped doing it.
files:
  - packages/db-core/src/transactor/transactor-source.ts (the `if (block)` guard, ~line 48)
  - packages/db-core/src/transaction/validator.ts (stale-read check, ~line 83)
  - packages/db-core/src/transform/cache-source.ts (absent block records nothing, ~line 80)
difficulty: medium
tradeoffs: The answer may simply be "no" — the current stale-read model may be exactly the intended isolation level — in which case the right outcome is to close this having recorded that the removal was deliberate.
----
# Should reads of a not-yet-existing block create a dependency? (phantom-read protection)

## Background — what changed and why this ticket exists

A "read dependency" records "this transaction observed block X at revision R"; at
commit the validator rejects the transaction if X has since moved to a different
revision. This is how optimistic concurrency catches stale reads.

Before the `txn-read-dependency-misses-cache-hits` fix, `TransactorSource` recorded
a dependency for **any populated response entry**, including one that represented a
block that does not actually exist (the transactor can return an entry with
`block: undefined` for a missing block — the production Network transactor always
populates the key). That recorded a `blockId@revision-0` dependency for a
**nonexistent** block. Side effect: if that block was later **created** (moving it
to revision 1), the validator's strict `currentRev !== read.revision` check would
see `1 !== 0` and reject the transaction. In other words, reading "X does not exist"
used to (accidentally) protect the transaction against X being created underneath it
— a form of **phantom-read protection**.

The fix made the contract uniform — "an absent read records nothing" — for both the
cache-hit path and the source path, by guarding the record on `block` being defined.
That is deliberate and defensible (it matches the sparse-entry case, which already
recorded nothing). But it **removes** the accidental phantom-read protection: a
transaction that reads an absent block and then sees it created is no longer
invalidated.

## The decision to make

Is phantom-read protection a capability this system wants?

- **If no** (the current stale-read model — "an existing block's revision changed" —
  is the intended isolation level): nothing to do. Close this ticket; the current
  behaviour is correct and this ticket exists only to record that the removal was a
  conscious choice, not an oversight.
- **If yes** (transactions should be protected against blocks appearing under a read
  they made): it needs **deliberate design**, not a revival of the incidental
  `id@0` record. Questions to answer:
  - How is "I read that X was absent" represented distinctly from "I read X at
    revision 0" (a real block genuinely at revision 0 is ambiguous with the old
    phantom marker)?
  - Does the validator need a separate "must-still-be-absent" assertion rather than
    a revision equality?
  - Which reads count — only explicit `tryGet` misses, or also range/predicate
    scans (true phantom protection is about predicates, not single ids)?

## Why this is future work, not a blocker

The current validator only supports single-block revision-equality checks, and no
production flow is known to rely on reading absent blocks by id (new block ids are
randomly generated; navigation only touches existing blocks). The removal is not a
regression against the validator's *designed* guarantee (stale read of an existing
revision). This ticket parks the isolation-level question for a human to weigh
against the system's intended concurrency semantics.

## Arm, 2026-09-05 — a downstream consumer's correctness depends on this answer being "yes"

Added during a tending pass, from the sibling `../sereus` checkout. It does not change the ticket's
shape; it changes the weight of its `tradeoffs:` line, which currently says the answer "may simply be
no" and the right outcome may be to close it having recorded that the removal was deliberate. That
is now a costlier call than it looks, because a real consumer's schema semantics rest on it.

**Their ticket** is `sereus/tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww`,
`repro: verified`. Their unblock condition, in their words: a change making a commit whose primary
key (or unique value) was taken by a **concurrent committed** writer FAIL at merge/sync rather than
replace the earlier row — surfacing as the ordinary `UNIQUE constraint failed:` error the SQL layer
already raises for a *sequential* duplicate.

**Their measurement, three experiments:**

| | setup | result |
| --- | --- | --- |
| 1 | two real nodes, replication cohort 2 on both sides, both inserting the same primary key in one tick | both promises FULFILLED; exactly one row survives on both nodes' views (the second writer's); **no error anywhere** |
| 2 | one node, two database handles over one local store | identical shape — two writers the local write queue cannot see are sufficient; two machines are not required |
| 3 | discriminator: same setup, **different** primary keys | both rows survive — ordinary convergence |

Experiment 3 is what makes this this ticket's question rather than a replication bug: the loss is
specific to a *shared* key.

**Why it is the phantom-read case and not something else.** Each writer reads the row's block, finds
it absent, and inserts. Under the isolation this ticket describes, an absent read records no
dependency — so when the other writer creates that block, nothing makes the second commit stale, and
it merges as a plain overwrite. Turn the answer to "yes" and the second writer's commit has a
dependency on a block that has since been created, fails the stale-read check, and surfaces through
the SQL layer as the UNIQUE violation their schema is written to expect. That is the whole of their
unblock condition, reached from this ticket's decision rather than from any new mechanism.

**What this does and does not settle.** It supplies the missing thing the body asks for — a concrete
consumer and a measured consequence — so the decision can be made on evidence rather than on
principle. It does **not** decide it: "no" remains defensible if the intended isolation level really
is the current one, but choosing "no" now means telling that consumer their schema's uniqueness
guarantee does not hold across concurrent writers, and that is a statement someone has to be willing
to make out loud rather than a quiet close.

One caveat, from their own ticket: `formation-unique-token-redesign` has since shipped on their side
and removed the specific product need that first motivated their report. So this is a correctness
argument, not an urgency one — nobody is currently stuck waiting on it.

**Not promoted.** This ticket asks "should we do this at all", which is a human's call and not a
tending pull; the evidence is recorded here so that call can be made without re-deriving it.
