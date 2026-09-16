description: A node cut off from the rest of its group cannot answer an ordinary query at all — not even from the data already on its own disk — because a live read refreshes from the network first and that refresh fails hard. Reported from a real dependent application, reproduced twice.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (runQuery, the `committed` / live branch around line 1216 — the live arm calls `Tree.update()` before reading; the committed arm deliberately never refreshes)
  - packages/db-core/src/collections/tree/tree.ts (`Tree.update`)
  - packages/db-core/src/collection/collection.ts (`Collection.update` → `updateInternal`, and the `CollectionHeaderVanishedError` NOTE that says a loud failure here is intended)
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet` — the `!block && unavailable` throw, and the accepted-tradeoff NOTE below it about loud failure over silent staleness)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableError`, and the `cohort-unreachable` reason)
  - backlog/more-design/6.5-partition-healing.md (the neighbouring design question; the maintainer's CRDT decision is recorded there)
difficulty: medium
tradeoffs: The current behaviour is defensible and partly deliberate — `tryGet`'s NOTE argues at length that "I could not find out" must never be read as "absent", and a node that answers queries from an unrefreshed local view is answering from data it knows may be stale. A maintainer may reasonably say the application should ask for a committed read when it wants that, in which case this ticket resolves into documentation plus a better error, not a behaviour change.
----

# What was observed

Reported by the session tending the **sereus** repository on 2026-09-15, from its integration suite
run against optimystic `c56c2bd4`. It failed, was re-run, and **failed identically both times**, under
comparable machine load on each run — so it is not contention.

Scenario (`control-cohort-edge-carries-data.integration.ts`): three nodes A, B, C; the backbone is
severed and **B is fully isolated**; the test asserts that a revision authored on C reaches B across
the reconcile-formed B→C connection. Sereus's entry point is an ordinary read —
`ControlDatabase.readRowsOnce` → `retryControlOperation`.

```
BlockUnavailableError: Block default/Revocation is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
 ❯ TransactorSource.tryGet   db-core/src/transactor/transactor-source.ts:56:11
 ❯ Tracker.tryGet            db-core/src/transform/tracker.ts:114:17
 ❯ Collection.updateInternal db-core/src/collection/collection.ts:545:18
 ❯ Collection.update         db-core/src/collection/collection.ts:478:4
 ❯ Tree.update               db-core/src/collections/tree/tree.ts:396:3
 ❯ OptimysticVirtualTable.runQuery  quereus-plugin-optimystic/src/optimystic-module.ts:1216:9
```

rewrapped as `QuereusError: Error during query on table 'Revocation'`. Serialized error:
`{ blockId: 'default/Revocation', reason: 'cohort-unreachable' }`.

# Why it is worth a design decision rather than a quick fix

The seam is already there and is deliberate on both sides:

- `runQuery` has two arms. A **committed** read pins a moment and its comment says it "never
  refreshes from the network: a mid-constraint pull would defeat the point of reading committed
  state." A **live** read calls `Tree.update()` first. Sereus's read takes the live arm.
- `Collection.updateInternal` reads the collection header through the tracker, and
  `TransactorSource.tryGet` throws when the repo answers `unavailable` with no block. Its NOTE is
  explicit that this converts a silent wrong answer into a loud failure, and that the silent
  alternative is "a collection view that forks and freezes with no report". That reasoning is sound
  and should not be undone casually.

So the composed behaviour is: **an isolated node cannot serve a live query at all**, including for
rows it already holds, because the refresh that precedes the read cannot complete. The question this
ticket exists to answer is whether that is the intended contract.

Three candidate answers, none obviously right:

1. **It is intended.** A live read means "current as of the group", and an isolated node cannot
   provide that. Then the work is documentation — say so where an application author will read it —
   plus making the failure legible enough that a caller can fall back to a committed read
   deliberately. Sereus would change its own call, not us.
2. **The refresh should degrade.** A live read whose refresh cannot reach the cohort serves the
   committed view it already has, and reports that it did so. This needs a way to say "this answer is
   local" in the result, and it is the same shape as the durability class on the write side
   (`6.41-write-durability-reaches-the-writer`, in review) — a read-side counterpart to
   `WriteDurability`.
3. **The error is the product.** Keep the failure, but carry enough on it for a caller to retry as a
   committed read without string-matching: the reason is already `cohort-unreachable`, so this may be
   mostly about documenting the contract and exporting a predicate.

# Boundaries

- **This is not the two-machine lone-survivor question.** That is `6.5-partition-healing`, and the
  maintainer has decided the CRDT sync layer is its fix. This is three nodes, one isolated, on the
  read path, and it is about what a node may answer with rather than what it may accept.
- **The CRDT layer probably does not settle it.** Even with both sides proceeding in step and merging
  later, an isolated node still has to decide what to return *now*, which is this question.
- **No before/after measurement exists.** The reporting session was explicit that it is not claiming
  any recent optimystic change caused this; it is claiming it reproduces. Anyone picking this up
  should establish whether it is new before treating it as a regression.

# Before promoting this

Reproduce it **here**, in this repository, rather than working from the downstream stack. The mesh
harness can isolate a node (`packages/db-p2p/src/testing/mesh-harness.ts`), and
`implement/1-transaction-sweep-across-node-counts` — the maintainer's current priority — establishes
the production-shaped three-node configuration this would build on. Promote this **after** that
sweep lands, both because the sweep may already reveal the read-side behaviour at N = 3, and because
the sweep's configuration helper is the right place to build from.

Credit: found by sereus's integration suite, which is the only place in this fleet where a partition
scenario drives optimystic through a real application's read path.
