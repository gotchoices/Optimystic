description: When a transaction commits, it locks each data collection it writes to so nothing else can refresh that collection mid-commit. Only one of the two places that take this lock has a test proving it works, and neither is tested with more than one collection or with a commit that fails. Add those tests.
files:
  - packages/db-core/src/transaction/coordinator.ts (`commitOnce` lock span, sorted acquisition at line 290; `execute` lock span, deduped sorted acquisition at line 676)
  - packages/db-core/test/coordinator-latch-interleaving.spec.ts (existing spec — source of the freeze helpers)
  - packages/db-core/src/testing/test-transactor.ts (`DelegatingTransactor` and the existing wrappers; new home for the two gated wrappers)
  - packages/db-core/src/collection/collection.ts (`acquireLatch` line 839, `act` 434, `update` 463, `recordCommitted` 819)
  - packages/db-core/src/transaction/actions-engine.ts (`ActionsEngine` — the pure translator `execute` needs)
difficulty: medium
----

# Prove the commit-time collection lock on the second code path, and with more than one collection

## Background, in plain terms

A *collection* here is one logical set of data — a table or an index — held as a local object
(`Collection`) over shared storage. While a commit is in flight, nothing else in the same process
may refresh the collections it is writing to: a refresh landing mid-commit used to leave the
collection's local revision counter permanently one step ahead of what storage recorded, after
which every later read silently served stale data.

The fix already shipped: the commit takes a lock (`Collection.acquireLatch()`) on each collection
it writes to and holds it across the whole commit — log append, the pend/commit round trips, and
the local fold afterward. `coordinator-latch-interleaving.spec.ts` proves that for **one** of the
two code paths (`commitOnce`), with **one** collection, on the **success** path. This ticket
closes the other three corners.

Everything below was verified by running it during planning; the constructions are known-good, not
sketches.

## Arm 1 — the `execute` code path

`TransactionCoordinator.execute` (`coordinator.ts:600`) takes the same locks over the same span as
`commitOnce`, but with two ordering constraints `commitOnce` does not have. The lock is
non-reentrant, so:

- `execute` must acquire **after** `applyActions`, because applying an action calls
  `Collection.act`, which takes that very lock. Acquiring earlier self-deadlocks.
- `execute` must **de-duplicate** its collection list before locking, because the action list can
  name the same collection twice and taking one instance's lock twice self-deadlocks.

Two cases:

**1a — a refresh released mid-span is blocked, and `execute` completes.** Same freeze mechanism as
the existing spec: wrap the transactor so the first `commit` call lands durably on the inner
transactor and then parks. With the commit parked, start `Collection.update()` on every
participant, drain macrotasks, and assert each is still pending. Open the gate; assert `execute`
resolves with success, and every refresh settles. `execute` resolving at all is the
no-self-deadlock assertion — a version that hoisted the acquisition above `applyActions` would
never reach the transactor and the mocha timeout would fire.

Run this case with **two** collections, which also covers Arm 2's participant fan-out.

**1b — duplicate collection entries take exactly one lock.** Drive `execute` with a transaction
whose statements name the same collection twice. Spy on `acquireLatch` (see Arm 2) and assert the
span took exactly **one** lock for that collection, and that the transaction reached storage
(`TestTransactor.getCommittedActions()` carries the transaction id).

> This case must NOT assert `execute`'s return value. Verified during planning: the duplicate
> path commits correctly and durably, then **throws** out of the post-commit fold — a separate,
> currently dormant defect filed as `debt-execute-duplicate-collection-actions-double-record`.
> Catch and discard the outcome, and say in a comment that the outcome is deliberately unasserted
> and why, so the case keeps passing once that defect is fixed.

## Arm 2 — more than one collection, and the sorted acquisition

Both paths sort participants by collection id before locking, so two commits over overlapping sets
cannot take locks in opposite orders and deadlock. Two cases.

**2a — the acquisition order itself (the load-bearing assertion).** `Collection.acquireLatch` is a
public method on the instance, so a test can shadow it with an instance property that records the
id and delegates:

    const order: string[] = [];
    for (const c of [a, b]) {
      const original = c.acquireLatch.bind(c);
      (c as unknown as { acquireLatch: () => Promise<() => void> }).acquireLatch = () => {
        order.push(c.id);
        return original();
      };
    }

Only the span acquisitions are recorded: `act`/`update`/`sync` call `Latches.acquire` directly
rather than through `acquireLatch`, so the spy sees exactly what this ticket is about.

Assert the recorded order is `a` then `b` on both paths, while feeding each its participants in the
**opposite** order:

- `execute` — a transaction whose actions are ordered `[b, a]`. Verified: records `a, b`.
- `commitOnce` — a coordinator whose collection map is built in insertion order `b, a` (that map's
  order is what the acquisition falls back to when the sort is removed). Verified: records `a, b`;
  with the sort removed it records `b, a` and the assertion fails.

**2b — two concurrent commits over overlapping sets both complete.** Verified construction, and
verified to deadlock (mocha timeout) with the `commitOnce` sort removed:

- Two collections `a`, `b`; two `TransactionCoordinator`s over the **same instances**, one with map
  order `a, b` and one with `b, a`. Two coordinators are required — the lock is per-instance, so
  separate `Collection` instances never contend, and one coordinator would give both commits the
  same participant order.
- Stage each coordinator's actions via `applyActions`, then externally hold **both** collections'
  locks (`await a.acquireLatch()`, `await b.acquireLatch()`). This pins each commit at its *first*
  span acquisition: `Latches` registers its queue position synchronously at call time and is FIFO,
  so starting commit 1, draining macrotasks, then starting commit 2 makes the queue state
  deterministic.
- Release both external holds. With the sort, both commits want `a` first, serialize, and both
  resolve. Without it, commit 1 holds `a` and wants `b` while commit 2 holds `b` and wants `a`.
- Assert both promises resolve (verified: both succeed — no retry noise). The mocha timeout is the
  deadlock detector.

**Why there is no `execute`-path version of 2b, and why that is fine.** A real cross-order deadlock
is unreachable through `execute`: it locks exactly the collections `applyActions` just wrote, and
`applyActions` already serialized on those same per-instance locks, so a second `execute` over an
overlapping set cannot even reach its span while the first holds one. The sort is
defence-in-depth there, and 2a is what pins it. Say this in the spec's header comment — a later
reader who tries to build the "obvious" concurrent-`execute` deadlock needs to know it cannot
exist rather than concluding the test is flaky.

## Arm 3 — the release path on failure

Both paths release in a `finally`, but no test drives a failing commit through the span and then
shows the collections are still usable. A leaked lock is silent: the next operation on that
collection simply never returns. Two shapes, both verified, both with two collections:

- **`execute`, early return inside the span.** `FlakyCommitTransactor(inner, Infinity)` makes
  `coordinateTransaction` fail, so `execute` returns a failure result from inside the locked block.
  Then `await a.update()` and `await b.update()` must complete.
- **`commitOnce`, rejection out of the span.** Same transactor via `coordinator.commit(trx, {
  maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 2, deadlineMs: 2000 })` rejects with
  `CoordinatorStaleLossError`. Then both refreshes must complete.

Do **not** build a case around a transactor whose `commit()` throws: verified that `commitPhase`
absorbs it into a failure result after its own retries, so it is not a distinct escape path.

## Design decisions already settled — do not relitigate

- **No stub engine is needed.** The plan-stage note asked for one; the existing `ActionsEngine`
  (`src/transaction/actions-engine.ts`) is already the pure translator `execute` documents — it
  parses statements into `CollectionActions[]` and returns them without applying. Build the
  transaction with `createActionsStatements(actions)` and pass `new ActionsEngine()`.
- **Do not call `applyActions` before `execute`.** `execute` applies the actions itself; the
  existing spec's `stageOne` helper pre-applies (correct for `commitOnce`, wrong here). The new
  cases need a `buildTransaction`-style helper that builds the stamp, id, and statements only.
- **File layout.** New sibling spec `packages/db-core/test/coordinator-latch-span.spec.ts` for all
  the cases above; leave `coordinator-latch-interleaving.spec.ts` as the single-collection
  interleaving file. Promote `GatedCommitTransactor` and `GatedPendTransactor` out of that spec
  into `src/testing/test-transactor.ts` (which already houses `FlakyCommitTransactor`,
  `CommitLandsButReportsStale`, `CompetingWriterTransactor`) and import them from both specs —
  copying them would let the two drift. `GatedPendTransactor.collection` is typed to the old
  spec's action type; make the class generic in its action type when promoting.
- **Reuse `drainMacrotasks` and the still-pending check.** Read `drainMacrotasks`' doc comment
  before reusing it: the turn count is load-bearing, not arbitrary. Same for the
  gate-opens-in-a-`finally` pattern — a failing assertion must still let the parked commit finish,
  or the case reports its real failure buried under a leaked lock.

## Edge cases & interactions

- **Gate fires once.** With two collections `commitPhase` issues several `commit` calls; the gated
  wrapper must park only the first and delegate the rest, or the span never completes.
- **Unhandled rejections.** The refreshes sit unawaited across `drainMacrotasks`; attach both
  handlers synchronously (the existing `releaseRefresh` helper does) or a rejection kills the
  process instead of failing the case.
- **Every participant, not just one.** The two-collection cases must check the refresh on *both*
  collections; a span that latched only the first would otherwise pass.
- **The order spy must not perturb.** It delegates to the bound original and returns its promise
  unchanged; it must not `await` before delegating, or it changes the queue registration order it
  is measuring.
- **External holds must be released exactly once**, and the concurrency case must not leave them
  held on a failing assertion — hold them in local variables and release before the assertions.
- **Duplicate-collection case leaves state behind.** It commits durably and throws; do not reuse
  that coordinator or collection for further assertions in the same case.
- **Cross-path consistency.** `commitOnce` also calls `beginInFlightAction` per participant inside
  the acquisition loop; the new multi-collection `commitOnce` cases run through that loop twice, so
  a disposer bug (a mark left behind on one of two participants) shows up as a later case failing.
- **Test-only monkey-patching stays in the spec file.** Do not add a spy hook to `Collection`.

## Verification

- `yarn test` from `packages/db-core` (narrow with `yarn test -- --grep "latch span"`).
- Before calling Arm 2 done, temporarily delete the `.sort(...)` at `coordinator.ts:290` and
  confirm **2a fails on the order assertion and 2b times out**; then restore the file and confirm
  `git diff` on `coordinator.ts` is empty. Do the same for the `.sort()` at `coordinator.ts:676`
  against 2a's `execute` case. If any of these cannot be made to fail, say so in the handoff
  rather than shipping a test that proves nothing.

## TODO

- Promote `GatedCommitTransactor` and `GatedPendTransactor` from
  `test/coordinator-latch-interleaving.spec.ts` into `src/testing/test-transactor.ts`, making
  `GatedPendTransactor` generic in its action type; update the existing spec to import them and
  confirm it still passes unchanged.
- Add `test/coordinator-latch-span.spec.ts` with a header comment covering: what the span is, that
  the acquisition-order case is the load-bearing proof of the sort, and why a concurrent-`execute`
  deadlock is unreachable by construction.
- Add the shared helpers to the new spec: two-collection setup, `buildTransaction` (no
  pre-`applyActions`), the `acquireLatch` order spy, and a refresh-still-pending check reusing
  `drainMacrotasks`.
- Arm 1a: gated-commit `execute` over two collections — both refreshes blocked mid-span, `execute`
  succeeds, both refreshes settle, and each collection's recorded revision matches a freshly opened
  handle over the same storage.
- Arm 1b: duplicate-collection `execute` — exactly one span lock for that collection, transaction
  durable in the inner transactor, outcome deliberately unasserted with a comment naming
  `debt-execute-duplicate-collection-actions-double-record`.
- Arm 2a: acquisition-order assertion for both `execute` (actions ordered `b, a`) and `commitOnce`
  (collection map ordered `b, a`).
- Arm 2b: two coordinators over shared instances with opposite map orders, pinned by externally
  held locks, both commits resolve.
- Arm 3: `execute` early-return failure and `commitOnce` rejection, each followed by a completing
  refresh on both participants.
- Add a `NOTE:` comment at `execute`'s post-commit fold loop in `coordinator.ts` recording that it
  iterates `result.actions` rather than the distinct collection set, and naming the backlog slug.
- Run the sort-removal verification described above, restore `coordinator.ts`, and confirm the tree
  is clean.
- Run `yarn test` from `packages/db-core` and report the result honestly in the review handoff,
  including anything an arm could not prove.
