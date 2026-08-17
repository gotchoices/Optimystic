----
description: Tests that are supposed to prove "a transaction loses a race and then recovers" all fake the rival — nothing in the test kit can actually land a competing change mid-flight, so the recovery behaviour those tests claim to cover is unproven. Build a rival writer for the test kit, then use it to close two specific gaps.
files:
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor and TestTransactor — where the rival writer belongs)
  - packages/db-core/test/transaction.spec.ts (describe "Coordinator commit backoff+jitter retry"; validator stale-read tests ~2373)
  - packages/db-core/src/transaction/coordinator.ts (commit() retry loop + re-read via collection.update())
  - packages/db-core/src/transaction/validator.ts (strict-equality stale-read check ~83)
  - packages/db-core/src/collection/collection.ts (createOrOpen wires the shared read-dependency collector ~60)
  - packages/db-core/test/read-dependency-cache-hit.repro.spec.ts (existing capture-half test)
difficulty: medium
tradeoffs: Coverage-only — both underlying features pass their current suites and no defect is known, so a maintainer could judge the existing half-tests sufficient and spend the effort elsewhere; the counter-argument is that the missing piece is a small reusable harness that two separate tickets already needed.
----

# A test transactor that actually commits a competing change

## The weakness

Optimistic concurrency in this system is defined by what happens when *someone else got there first*.
Two separate coverage gaps turn out to have the same cause: the test kit has no way to make a rival
transaction **durably commit a conflicting change while the transaction under test is in flight**.
`FlakyCommitTransactor` returns a `{success:false}` stale failure **without advancing any collection's
log tail** — it simply "stops refusing" after N calls. So every test that looks like "lose the race,
recover, win" actually reads "the obstacle vanished".

The deliverable is the harness first: a transactor (or a `TestTransactor` wrapper) that, on a chosen
attempt number or trigger, injects a genuine competing committed action into a participating
collection's log — so the transaction under test really does see a newer tail on its next read. Put it
in `packages/db-core/src/testing/test-transactor.ts` alongside the existing stand-ins, so the next
ticket that needs a rival writer does not invent a third one. Then the two gaps below become short
tests.

Coverage-only; no production change expected unless a test surfaces a rebase or capture defect.

## Arm A — the coordinator's retry never faces a real competitor

The multi-collection commit path (`TransactionCoordinator.commit`) retries a clean optimistic-concurrency
loss automatically: it backs off (jittered), re-reads every collection to fresh revisions via
`collection.update()`, then re-drives the commit. See the shipped work in `implement-occ-default-backoff`
(commit `d1d44e7`).

The retry tests added there exercise the retry *control flow* — that it backs off, is bounded by
`maxAttempts` / `deadlineMs`, honours an abort signal, and does not re-drive a partial landing. None of
them make a rival actually commit. So the property that makes the coordinator's built-in retry
meaningfully different from "try again and hope" is unproven for the multi-collection path. (The
single-collection `Collection.sync` retry has closer coverage; the coordinator's re-read-all-then-re-pend
loop does not.)

What to assert, with a **real** competing transaction durably committing a conflicting revision between
the loser's attempts — the loser:

1. observes the newer committed revision after its inter-attempt `collection.update()`,
2. rebases (replays) its staged actions against that revision (via each collection's `filterConflict` /
   replay path), and
3. commits successfully on a later attempt, with the final durable state reflecting **both** the rival's
   committed change and the loser's rebased change (no lost update, no duplicate log entry).

Cover both a non-overlapping change (clean rebase) and an overlapping-key change (exercises
`filterConflict`).

## Arm B — a stale cache-hit read is never driven through to rejection

The `txn-read-dependency-misses-cache-hits` fix made a block served from the **cache** record a read
dependency (previously only a source fetch did). It is covered by two *separate* halves:

- **Capture** — `read-dependency-cache-hit.repro.spec.ts` and the `cache-source.spec.ts` cases prove a
  cache hit produces a `{ blockId, revision }` dependency with the right revision.
- **Rejection** — `transaction.spec.ts` (~2373) proves the validator rejects a transaction whose `reads`
  array names a block whose revision has moved on (`Stale read: ...`).

Nothing drives the **full chain**: a real `Collection` (built by `Collection.createOrOpen`, which is
where the shared read-dependency collector is actually wired into both the source and the cache layers)
reads a block on a cache hit, that block is then superseded **by another writer**, and the commit is
rejected at validation. That composition — capture feeding rejection through the production wiring — is
the behavioural guarantee the fix set out to provide, and no single test proves it.

What to build:

1. Open a collection via `Collection.createOrOpen` and read block X (miss → dependency recorded, X
   cached), commit, so the read dependencies clear.
2. Read X again inside a new transaction so it is served from the **cache** — the path that previously
   recorded nothing.
3. Have the rival writer advance X's committed revision on the transactor.
4. Attempt to commit and assert rejection with a stale-read reason (`Stale read: block X ...`).

Add the positive companion: if X was **not** superseded, the same cache-hit read commits successfully
(guards against the fix over-firing).

Gotchas: the validator compares with strict `!==` against `currentState?.latest?.rev`, so the recorded
revision must equal the transactor's `latest.rev`. The capture path records `state.latest?.rev`; the
local-commit path advances the cached revision via `recordCommitted` / `applyCommittedToCache` — which
is exactly why this needs a **cross-writer** supersession rather than a local commit, and exactly why a
shared rival-writer harness is the right first step. Reads through a `Collection` happen inside action
handlers via the tracker, so wiring a read that lands as a cache hit may need an action that reads X, or
a direct probe of the collection's cache surface; budget time for harness plumbing.

Merged from `debt-coordinator-retry-real-competing-committer-test` (Arm A) and
`debt-e2e-stale-cache-hit-read-rejected` (Arm B) during backlog gardening.
