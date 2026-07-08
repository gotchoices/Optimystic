description: Add an end-to-end test proving that when a transaction reads a block from its local cache and that block has since been changed by someone else, the commit is actually rejected — today only the two halves of that guarantee are tested separately, never the whole chain.
files:
  - packages/db-core/test/transaction.spec.ts (existing validator stale-read unit tests around line 2373 — model from these)
  - packages/db-core/test/read-dependency-cache-hit.repro.spec.ts (existing capture test — the other half)
  - packages/db-core/src/transaction/validator.ts (strict-equality stale-read check, ~line 83)
  - packages/db-core/src/collection/collection.ts (createOrOpen wires the shared collector, ~line 60)
difficulty: medium
----
# End-to-end test: a stale cache-hit read is rejected at commit

## Why

The `txn-read-dependency-misses-cache-hits` fix made a block served from the
cache record a read dependency (previously only a source fetch did). The
implementation is covered by two *separate* halves of tests:

- **Capture** — `read-dependency-cache-hit.repro.spec.ts` and the new
  `cache-source.spec.ts` cases prove a cache hit produces a `{ blockId, revision }`
  dependency with the right revision.
- **Rejection** — `transaction.spec.ts` (around line 2373) proves the validator
  rejects a transaction whose `reads` array names a block whose revision has moved
  on (`Stale read: ...`).

Nothing drives the **full chain**: a real `Collection` (built by
`Collection.createOrOpen`, which is where the shared read-dependency collector is
actually wired into both the source and the cache layers) reads a block on a
**cache hit**, that block is then superseded by another writer, and the commit is
**rejected at validation**. That composition — capture feeding rejection through
the production wiring — is the ultimate behavioural guarantee the ticket set out
to provide, and it is currently unproven by any single test.

## What to build

A test that, using the existing `TestTransactor` / `TransactionSession` /
coordinator / validator harness:

1. Opens a collection via `Collection.createOrOpen` and reads block X (miss →
   dependency recorded, X cached), commits, so the read dependencies clear.
2. Reads X again so it is served from the **cache** (a hit) inside a new
   transaction — the path that previously recorded nothing.
3. Independently advances X's committed revision on the transactor (a competing
   writer), so the cached read is now stale.
4. Attempts to commit the second transaction and asserts it is **rejected** with a
   stale-read reason (`Stale read: block X ...`).

Also add the positive companion: if X was **not** superseded, the same cache-hit
read commits successfully (guards against the fix over-firing).

## Notes / gotchas

- The validator compares with strict `!==` against `currentState?.latest?.rev`, so
  the recorded revision must equal the transactor's `latest.rev`. The capture path
  records `state.latest?.rev`; the local-commit path advances the cached revision
  via `recordCommitted` / `applyCommittedToCache`. The e2e should exercise a
  **cross-writer** supersession (not a local commit) to make the stale case fire.
- Reads through a `Collection` happen inside action handlers via the tracker, so
  wiring a read that lands as a cache hit may need an action that reads X, or a
  direct probe of the collection's cache surface. Budget time for harness plumbing —
  this is why it was deferred out of the implement pass rather than being trivial.
