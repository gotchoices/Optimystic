----
description: New tests prove the whole chain works: a transaction reads data that came from memory rather than storage, another writer changes that data, and the transaction is correctly rejected. Previously only the two halves were tested separately.
files:
  - packages/db-core/test/read-dependency-e2e.spec.ts (the new spec; one test rewritten during review)
  - docs/internals.md (stale read-dependency claim corrected during review)
  - docs/architecture.md (same stale claim corrected during review)
  - packages/db-core/src/transform/cache-source.ts (behaviour under test; NOT modified)
  - packages/db-core/src/transaction/read-dependency-collector.ts (behaviour under test; NOT modified)
  - packages/db-core/src/transaction/validator.ts (behaviour under test; NOT modified)
  - packages/db-core/src/collection/collection.ts (probeHeader wires the shared collector; NOT modified)
  - packages/db-core/src/testing/test-transactor.ts (commitRivalTreeWrite, used as-is; NOT modified)
difficulty: medium
----

# What landed

Coverage for the `txn-read-dependency-misses-cache-hits` fix, driven end to end for the first time.
Before this ticket the fix was covered in two disconnected halves: `cache-source.spec.ts` and
`read-dependency-cache-hit.repro.spec.ts` proved a cache hit *records* a dependency (against a
hand-wired source + cache + collector), and `transaction.spec.ts` proved the validator *rejects* a
transaction whose recorded revision moved (against hand-written dependency lists). Nothing joined
them.

`packages/db-core/test/read-dependency-e2e.spec.ts` now does, through production wiring only —
`Tree.createOrOpen` → `Collection.createOrOpen` → `Collection.probeHeader`, which is the single
place the shared `ReadDependencyCollector` is handed to both the `TransactorSource` and the
`CacheSource`. Four tests:

- **the full chain** — seed and commit a tree, open a transaction boundary, prove the tracker is
  empty so the next read *must* come from the cache, read a key, prove the captured dependencies are
  non-empty and sit at exactly the revisions the validator compares against, let a genuinely
  separate writer commit over the same collection, then validate. Asserts rejection, asserts the
  reason is staleness rather than some other validation step, and asserts the reason names a block
  whose revision actually moved (computed after the rival, not hard-coded).
- **the positive companion** — the same flow with no rival; must validate clean, so the rejection
  above cannot be a check that fires on everything.
- **the mixed read set** — a second collection the rival never touches supplies untouched
  dependencies, placed first in the read list so the validator scans past matching entries before
  rejecting. Asserts the untouched set alone validates, the combined set rejects, and the untouched
  blocks are never blamed.
- **the absent-collection probe** — opening a collection that has never committed must not record a
  phantom dependency at revision 0. Rewritten during review (below).

Only the header block and one B-tree node are captured by the seeded read; the rival moves the node
and leaves the header alone, so the primary test is a mixed moved/untouched set by construction.

## Non-vacuity, as measured by the implementer

The cache-hit re-emit in `cache-source.ts` was temporarily gated off and the file re-run: three of
the four tests fail, all with the captured set collapsing to `[]`. So every read in the flow is
genuinely a cache hit and the whole chain depends on the fix. The fourth test asserts what must
*not* be recorded, so it correctly survives a mutation that only removes recording.

# Review findings

## Checked

Read the implement diff (`889f1dd`) before the handoff summary. Read every production file the tests
exercise (`cache-source.ts`, `validator.ts`, `collection.ts` `probeHeader`, `test-transactor.ts`
`commitRivalTreeWrite`) and the two adjacent specs the new file positions itself against
(`occ-structural-read-exclusion.spec.ts`, `transaction.spec.ts`). Checked every assertion for
vacuity by measuring the actual captured dependency sets with a throwaway spec (deleted). Checked
the docs the change *should* have touched even though it touched none. Checked the board for tickets
already claiming these sites, and checked the code for accepted-tradeoff `NOTE:` markers at every
site in scope.

## Found and fixed in this pass

- **One of the four tests was entirely vacuous.** `probing a collection that does not exist leaks no
  phantom revision-0 dep` iterated over the captured dependency set and validated a transaction
  built from it — but measurement shows opening an absent collection records **zero** dependencies.
  Every loop ran zero times, and `TransactionValidator` skips the stale-read check outright when
  `reads` is empty, so the closing `expect(valid).to.be.true` was guaranteed regardless of
  behaviour. The test passed identically with read-dependency capture removed wholesale. Rewritten
  to assert the emptiness *explicitly* (the measured fact, and the thing a phantom record would
  break), and to demonstrate the failure mode rather than gesture at it: a synthesized
  `{ blockId: 'brand-new', revision: 0 }` dependency is pushed through the same real validator,
  shown inert while the block is absent and shown to reject the instant the block is created. The
  per-dependency guards are retained as the check that bites if the open path ever legitimately
  starts recording.
- **Two live documentation lines contradicted the code and the new test.**
  `docs/internals.md` (read-dependency key design decisions) and `docs/architecture.md`
  (read dependency validation) both stated "non-existent blocks record `revision: 0`; if
  subsequently created, the read is detected as stale". The `txn-read-dependency-misses-cache-hits`
  fix removed exactly that behaviour — deliberately, as the open `feat-phantom-read-protection`
  ticket records — and the new test asserts it does not happen. Both lines corrected. The
  `architecture.md` line also claimed reads are recorded at `TransactorSource.tryGet()`, omitting the
  cache-hit path that is the entire subject of this work; corrected in the same edit.
  `docs/transactions.md` carries the same stale claim inside a completed phase-completion checklist
  (a historical record of what was ticked off at the time, not a live behaviour statement) — left
  alone deliberately.

## Found and filed

- **The read-exclusion safety argument has never been raced against a real competing writer.**
  Filed as `tickets/backlog/debt-navigation-read-exclusion-never-raced.md`. A B-tree point lookup
  drops the interior blocks it merely navigated through from the conflict set, and the safety
  argument (`docs/correctness.md` Theorem 5) is that any change altering the answer must also move
  the retained leaf. If that is wrong the failure mode is a lost update, not a spurious rejection.
  The capture half is tested against a real multi-level tree; the rejection half is tested against
  two hand-written block ids and a hand-written revision map. Nothing joins them, and this ticket's
  new spec cannot reach the case because its tree is a single node at the default fan-out of 64.
  Filed at the generalized-test rung rather than as a point bug: the ticket asks for a generator
  over random fan-out and random rival mutations asserting "rejected if and only if the observed
  answer changed", not two fixed scenarios. It names the concrete blocker — `commitRivalTreeWrite`
  hard-codes fan-out 64 and needs a capacity parameter threaded through both writers, which its own
  `NOTE:` already anticipates.
- **Validator test wiring is copied at roughly seventeen sites across three files.** Appended as an
  arm to the existing `debt-transaction-spec-oversized` backlog ticket rather than filed fresh —
  that ticket already owns the site and already proposes the `test/helpers/` module that is the
  natural home. The copies have drifted (differing constructor arguments, real transactor versus
  synthetic revision map), so a reader cannot tell at a glance whether two tests validate under the
  same conditions.

## Considered and not filed

- **A rival that deletes the reader's key is untested.** Real gap, but the prior review of
  `debt-competing-writer-test-transactor` weighed this exact case and recorded a deliberate decision
  not to file it ("a further multiplication of an already-covered mechanism"). Nothing has changed
  since, so it stays not-filed rather than being re-discovered and re-queued.
- **The reader's transaction is never pended; validation is invoked directly.** So no pend-ordering
  or coordinator-retry interaction is covered. Reaching it needs the rival to move ahead of a pended
  reader, which the `CompetingWriterTransactor` class doc rules out by design for livelock reasons.
  A different tool, not a gap in this work.
- **The mixed-collection test concatenates two dependency sets by hand rather than going through
  `TransactionCoordinator`.** The shape it produces is the shape the coordinator produces, and the
  coordinator's own aggregation is covered elsewhere; the adjacent `debt-txn-coordinator-cache-tests`
  plan ticket owns that area.
- **The revision-equality guard asserts on every captured dependency**, which is stronger than the
  ticket asked for. Deliberate tightness, correct today for both captured blocks, and its failure
  message names the offending block — left as-is.

## Tripwires

None recorded. Nothing conditional surfaced that needed parking at a code site: the vacuous test and
the stale docs were present-tense defects and were fixed, and the read-exclusion gap is a real
untested path today rather than a "fine now, matters if X" concern.

## Accepted tradeoffs

None encountered. No `NOTE:` marking a previously-declined finding exists at any site this review
touched, so nothing was left alone on those grounds. Two `NOTE:` markers do sit in
`cache-source.ts` (the unpruned `generations` map, and the stale `revisions` entry an LRU eviction
can leave behind) — both are tripwires from earlier work with stated benign rationales, neither is
in this ticket's scope, and neither revisit condition has tripped.

# Validation performed

```
npx tsc --noEmit -p packages/db-core     → clean
yarn lint                                 → clean
yarn workspace @optimystic/db-core test   → 1381 passing, 0 failing
```

Same 1381 as the implement handoff — the review rewrote assertions inside an existing test rather
than adding or removing tests. No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

# Remaining coverage boundary

Recorded so the next reader knows where the floor is, not as queued work. Beyond the read-exclusion
race filed above: `commitRivalTreeWrite` is exercised only as an upsert; validation is invoked
directly rather than through a pended transaction; and `hashOperations(collectOperations(new Map()))`
is the only operations hash used, so these tests say nothing about the hash-compare step — they are
aimed squarely at the stale-read step of `validate()`.
