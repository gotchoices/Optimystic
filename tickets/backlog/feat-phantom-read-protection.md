description: Decide whether a transaction that reads a block which does NOT exist, and later that block gets created by someone else, should be forced to fail — the system used to do this by accident, and a recent change quietly stopped doing it.
files:
  - packages/db-core/src/transactor/transactor-source.ts (the `if (block)` guard, ~line 48)
  - packages/db-core/src/transaction/validator.ts (stale-read check, ~line 83)
  - packages/db-core/src/transform/cache-source.ts (absent block records nothing, ~line 80)
difficulty: medium
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
