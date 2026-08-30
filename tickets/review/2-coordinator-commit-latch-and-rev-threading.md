description: Fixed a bug where a database commit could record itself under the wrong revision number if another write snuck in at the same time; the fix now holds a per-collection lock for the whole commit and threads the correct revision number through instead of recomputing it late.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/test/coordinator.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: easy
----

# Review: coordinator commit-latch + rev-threading

Full design/implementation lineage: `2-coordinator-mutates-collections-outside-their-latch`
(completed) → `2-coordinator-commit-latch-and-rev-threading` (implemented) → this validate/handoff
pass. Sibling tickets still open in `tickets/implement/`: `2.2-coordinator-interleaving-spec`
(owns a direct repro test for the latch-held-across-span property) and
`2.4-collection-divergence-report-fields` (diagnostics; depends on the `instanceTag` field added
here). Neither blocks this review.

## What changed and why

Two related bugs, one root cause: the coordinator was reading/writing collection state
(`getNextRev()`, `recordCommitted()`) *outside* the span during which it held any lock on that
collection, so a concurrent writer could interleave and cause a commit to record its write under
a stale or wrong revision number.

Fix has two parts:

1. **Instance-scoped latch held across the whole commit span.** `Collection` now carries a public
   `instanceTag` (4 random base64url bytes, generated pre-construction in `open`/`createOrOpen`)
   and its `latchId` is `Collection:${id}#${instanceTag}` instead of a process-global
   `Collection:${id}` key. `Collection.acquireLatch()` exposes that instance latch.
   `coordinator.ts`'s `commitOnce` and `execute` now acquire every participant collection's latch
   (sorted by collection id, mirroring `StorageRepo.commit`'s sorted block-id discipline) and hold
   it for the full commit body, releasing in a `finally`.
2. **Revision number threaded, not recomputed.** `applyActionsToCollection` returns the `rev` it
   stamped on the log entry; that value flows through a new `pendedRevs: Map<CollectionId, number>`
   into `coordinateTransaction`, `pendPhase`/`commitPhase`, and both `recordCommitted` call sites.
   `Collection.recordCommitted(actionId, rev)` now takes `rev` explicitly and **throws** if it
   doesn't match `getNextRev()` — the throw message says the action "was pended at rev X but the
   collection now expects rev Y — the collection was refreshed mid-commit". This replaces the old
   pattern of calling `collection.getNextRev()` again at commit time, which was the actual bug: a
   second read of mutable state after the latch that guarded the first read had already been
   released.

Why the latch is per-instance rather than per-collection-id: a process-global lock would
deadlock the coordinator's whole-span hold against `CompetingWriterTransactor`-style rivals
(separate `Collection` instances of the same id, e.g. across nodes/processes) since `Latches` is
non-reentrant. Cross-instance races are left to the transactor's optimistic-concurrency retry
loop, which is unchanged and stays outside the held span (the blanket `collection.update()` in
`commit()`'s retry loop still runs unlatched).

## Validation performed this pass

- `yarn build` and `yarn typecheck` from repo root: both pass (done in the prior session, not
  re-verified this pass since no source changed).
- `yarn test` from repo root, foreground, full log inspected: **1436 + 2334 + 683 + several
  smaller suites all green**, **zero** new `recordCommitted` mismatch throws anywhere in output
  (that throw is the tripwire for a latch-bypass regression — a firing one would mean some commit
  path still reads `getNextRev()` behind the coordinator's back).
- `yarn workspace @optimystic/db-core test` run standalone (isolates `coordinator.spec.ts` and
  `transaction.spec.ts`, including the "real competing writer" describe block ~line 4465-4830 of
  `transaction.spec.ts`, which doubles as the non-reentrancy regression test for the latch key
  change): **1436 passing, 14s, no hang.** A hang there specifically would indicate the
  instance-scoped latch key wasn't applied, or a latched `Collection` method got called from
  inside an already-held span — neither happened.
- One test failure found, isolated and confirmed pre-existing/unrelated (see below) —
  filed to `tickets/.pre-existing-error.md` for triage, not chased here.

## Known gap (flagged honestly, not papered over)

**No test added in this lineage exercises "the latch is held across the whole commit span" as a
direct, deliberate property test** — the passing `transaction.spec.ts` competing-writer suite
exercises it indirectly (it would hang/fail if the latch were broken), but there's no test that,
e.g., asserts a second commit attempt on the same collection instance literally blocks until the
first's `finally` releases. That direct repro is explicitly the job of the still-open sibling
`2.2-coordinator-interleaving-spec` ticket in `tickets/implement/` — it is scoped out of this
review, not missed by it.

## Pre-existing failure noticed (not this ticket's bug)

`packages/reference-peer/test/distributed-diary.spec.ts` — `Distributed Diary Operations >
should handle concurrent writes from multiple nodes` fails with `Timeout of 10000ms exceeded`,
reproduced twice (full suite + standalone rerun), same result both times. Root cause: the test's
own `waitForValue` convergence poll allows 30s but the package's mocha config caps per-test
timeout at 10s (`packages/reference-peer/package.json` test script: `--timeout 10000`) — a
pre-existing test-harness timeout-budget mismatch, unrelated to `db-core`/coordinator (package
untouched by this ticket's diff — confirmed via `git diff --stat` across both commits in this
lineage). Full detail in `tickets/.pre-existing-error.md` for the triage pass to pick up.

## Use cases / surface for reviewer to probe

- Two concurrent commits touching an overlapping set of collections: confirm serialization via
  the sorted-latch-acquisition order (deadlock-freedom argument lives in the `commitOnce` comment
  in `coordinator.ts`) rather than by inspection alone if time allows.
- A commit that fails partway (partial-commit loop in `commitOnce`/`execute`): confirm
  `recordCommitted` is still called with the correct originally-pended `rev`, not a
  re-fetched one, on every path (success fold, partial-commit fold, and `execute`'s early-return
  paths where latches release via `finally` even on failure).
- `optimystic-module.ts` (~line 2945): audit comment now claims live-scan serialization rests on
  the instance latch held for the whole commit span — worth a skim to confirm the claim matches
  the code it's commenting on, since it was a documentation-only correction in this pass.
