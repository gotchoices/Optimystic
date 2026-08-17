description: A fix made the system remember which data a transaction read even when that data came from memory rather than storage — but the tests only check the two halves separately. Nothing proves the whole chain: read from memory, another writer changes that data, and the transaction is correctly rejected.
prereq: debt-competing-writer-test-transactor
files:
  - packages/db-core/test/read-dependency-cache-hit.repro.spec.ts (existing capture-half test — the shape to build on)
  - packages/db-core/test/transaction.spec.ts (~2690-2850 — existing validator stale-read tests, the rejection half)
  - packages/db-core/src/transaction/validator.ts (~102 — strict-equality read-dependency check)
  - packages/db-core/src/collection/collection.ts (probeHeader ~145 — where the shared read-dependency collector is wired; getReadDependencies ~626)
  - packages/db-core/src/transform/cache-source.ts (cache-hit dependency re-emit)
  - packages/db-core/src/testing/competing-writer.ts or src/testing/test-transactor.ts (commitRivalTreeWrite, from the prereq ticket)
difficulty: medium
----

# Prove the full chain: cache-hit read → superseded by another writer → rejected at validation

## Why

The `txn-read-dependency-misses-cache-hits` fix made a block served from the **cache** record a
read dependency; previously only a fetch from storage did. It is covered by two *separate*
halves:

- **Capture** — `test/read-dependency-cache-hit.repro.spec.ts` (and the `cache-source.spec.ts`
  cases) prove a cache hit produces a `{ blockId, revision }` dependency with the right revision.
  But they hand-wire a `TransactorSource` + `CacheSource` + collector by hand.
- **Rejection** — `test/transaction.spec.ts` (~2690–2850) proves `TransactionValidator` rejects a
  transaction whose `reads` array names a block whose revision has moved on. But its `reads` are
  hand-written literals.

Nothing drives the chain end to end: a **real** `Collection` — built by `Collection.createOrOpen`,
which is where the shared read-dependency collector is actually wired into *both* the source and
the cache layers (`collection.ts:145` `probeHeader`) — reads a block on a **cache hit**, that
block is then superseded **by another writer**, and the resulting commit is rejected at
validation. That composition, capture feeding rejection through the production wiring, is the
behavioural guarantee the fix set out to provide.

Coverage-only. No production change expected.

## The test to build

Use the `commitRivalTreeWrite` helper from the prereq ticket for step 4 — it opens a second
`Tree` over the same transactor and collection id and commits durably, which is exactly the
cross-writer supersession this needs. This ticket does **not** need the
`CompetingWriterTransactor` interceptor: there is no mid-flight timing here, the rival simply
runs between the read and the validation call.

1. `const tree = await Tree.createOrOpen(transactor, 'users', e => e.key)`; seed a few entries and
   commit them (`tree.replace(...)`). This is the production wiring — the shared collector is
   live on both layers.
2. `tree.getCollection().clearReadDependencies()` — the transaction boundary; the read set is now
   empty. Assert that.
3. `await tree.get(someSeededKey)` — the collection's tracker was reset by the commit, so this
   read falls through to the **cache**, which now holds the committed blocks. This is the path
   that previously recorded nothing.
4. `const deps = tree.getCollection().getReadDependencies()` — **assert it is non-empty**, and
   for at least one dep assert `dep.revision === (await transactor.get({ blockIds: [dep.blockId] }))[dep.blockId].state.latest.rev`.
   This guard is what stops the test from passing vacuously, and it is the exact equality the
   validator will apply.
5. Rival: `await commitRivalTreeWrite(transactor, 'users', ..., [[otherKey, {...}]])` — a
   different key, which in a tree this small lands in the **same leaf block**, so it advances the
   revision of a block the reader depends on.
6. Build the transaction with `reads: deps` (`statements: []`, `ActionsEngine` registered under
   `ACTIONS_ENGINE_ID`, matching schema hash) and validate with a `BlockStateProvider` reading the
   same transactor — copy the wiring from `transaction.spec.ts:2722`+.
7. Assert `result.valid === false`, `result.reason` includes `'Stale read'`, and includes the
   block id whose revision actually moved (compute that set by re-reading each dep's current rev
   after step 5; assert at least one moved, and name that one in the message assertion).

**Positive companion** — same flow with step 5 removed: the same cache-hit read validates
`valid === true`. Without this, the test cannot tell a correct rejection from a fix that fires on
everything. Use `hashOperations([])` and the stub validation-coordinator factory
(`{ applyActions: async () => {}, getTransforms: () => new Map(), dispose: () => {} }`) so the
positive case reaches the end of `validate()` rather than tripping the operations-hash compare.

Put both cases in a new `test/read-dependency-e2e.spec.ts` (the existing repro file is
deliberately hand-wired and should keep documenting the unit-level fix), or as a clearly-named
describe alongside it — implementer's call, but do not dilute the existing repro.

## The gotcha that shapes this test

`validator.ts:107` compares with strict `!==` against `currentState?.latest?.rev`. The capture
path records `state.latest?.rev`, and the local-commit path advances the *cached* revision via
`recordCommitted` / `applyCommittedToCache` (and `syncInternal`'s `transformCache`). So a
**local** commit keeps the recorded revision and the transactor's revision in lockstep — it can
never produce a stale read. Only a **cross-writer** commit moves the transactor forward while the
reader's recorded revision stays behind. That is why step 5 must be a genuinely separate writer
and not a second write through the same tree.

## Edge cases & interactions

- **Vacuous-pass guard.** If step 4's dep list is empty, or if no dep's revision moves in step 5,
  the test proves nothing. Assert both explicitly, with messages that say which invariant broke.
- **Cache hit, not a tracker hit.** The read in step 3 must be served by the `CacheSource`, not by
  the collection tracker's own transforms (which would bypass the fix entirely). The commit in
  step 1 resets the tracker, so this holds — but assert it rather than assume it, e.g. by
  checking the collection's tracker transforms are empty before step 3.
- **Untouched blocks keep their own revision.** `TestTransactor` tracks `latestRev` **per block**,
  so a dep on a block the rival never touched must still match after step 5 and must not
  contribute a false rejection. The positive companion covers the all-untouched case; consider
  also asserting the mixed case (one moved dep, one untouched) still rejects for the *moved* one
  and names it in the reason.
- **Absent blocks (revision 0).** `validator.ts:106` reads `currentState?.latest?.rev ?? 0`, and
  the capture path records nothing for an absent block (see the third case in
  `read-dependency-cache-hit.repro.spec.ts`). Confirm no phantom `revision: 0` dep leaks into
  `deps` from a probe of a block that does not exist — a spurious one would make every
  transaction that touched a missing block fail validation the moment that block is created.
- **Read dependencies must not survive the boundary.** Step 2 asserts the set is empty after
  `clearReadDependencies()`. If a stale dep from step 1's seeding leaked through, the rejection in
  step 7 could be attributed to the wrong block — assert on the *specific* block id, never just
  on the string `'Stale read'`.
- **Rival collides with nothing pending.** Nothing of the reader's is pending at step 5 (its
  transaction is never actually pended — validation is invoked directly), so the rival's own
  `policy: 'r'` pend cannot collide. If a future variant of this test pends the reader's
  transaction first, the rival must move ahead of it — see the pend-ordering rationale in the
  prereq ticket.

## Validation

```
yarn workspace @optimystic/db-core test
```
Foreground, unredirected. Only test files should change.

## TODO

- Build the end-to-end cache-hit → supersession → `Stale read` rejection case using a real
  `Collection`/`Tree` and `commitRivalTreeWrite`.
- Add the positive companion (unsuperseded cache-hit read validates clean).
- Add the vacuous-pass guards (non-empty deps; at least one dep's revision moved; tracker empty
  before the cache-hit read).
- Add the mixed moved/untouched-dep case and the absent-block (no phantom rev-0 dep) check.
- Run the db-core suite green; hand off to `review/` naming anything left uncovered.
