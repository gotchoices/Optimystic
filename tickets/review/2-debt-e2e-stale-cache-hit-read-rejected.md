----
description: New tests prove the whole chain works: a transaction reads data that came from memory rather than storage, another writer changes that data, and the transaction is correctly rejected. Previously only the two halves were tested separately.
files:
  - packages/db-core/test/read-dependency-e2e.spec.ts (NEW — the only file changed)
  - packages/db-core/src/transform/cache-source.ts (the behaviour under test; NOT modified)
  - packages/db-core/src/transaction/read-dependency-collector.ts (the behaviour under test; NOT modified)
  - packages/db-core/src/transaction/validator.ts (the behaviour under test; NOT modified)
  - packages/db-core/src/collection/collection.ts (probeHeader wires the shared collector; NOT modified)
  - packages/db-core/src/testing/test-transactor.ts (commitRivalTreeWrite, used as-is; NOT modified)
difficulty: medium
----

# What landed

**Coverage only. No production code changed.** `git status` shows exactly one entry: the new,
untracked `packages/db-core/test/read-dependency-e2e.spec.ts`. Everything else in the repo is
byte-identical to HEAD.

Four tests in one new file, all under
`describe('read dependencies end to end: cache hit -> superseded -> stale-read rejection')`.

## What the tests actually drive

Everything goes through the production wiring — `Tree.createOrOpen` → `Collection.createOrOpen` →
`Collection.probeHeader`, which is the one place the shared `ReadDependencyCollector` is handed to
*both* the `TransactorSource` and the `CacheSource`. Nothing is hand-wired.

The shared flow (a helper, `captureCacheHitReads`, carries steps 2–4 plus the vacuity guards):

1. `Tree.createOrOpen(transactor, 'users', e => e.key)` and `tree.replace(...)` with three entries.
   `syncInternal` resets the collection tracker and folds the committed blocks into the read cache.
2. `collection.clearReadDependencies()` — the transaction boundary. Asserted empty.
3. `isTransformsEmpty(collection.tracker.transforms)` asserted **true**, so the next read cannot be
   served by staged transforms and must fall through to the `CacheSource`.
4. `await tree.get(2)` — a pure cache-hit read.
5. `collection.getReadDependencies()` — asserted non-empty, and every captured revision asserted
   equal to the transactor's current revision for that block (the exact `!==` the validator applies)
   and `> 0`.
6. `commitRivalTreeWrite(transactor, 'users', e => e.key, [[99, …]])` — a genuinely separate writer,
   a second `Tree` over the same transactor committing durably.
7. Recompute which deps moved; assert at least one did; validate through `TransactionValidator` with
   a `BlockStateProvider` reading the same transactor.

### The captured set, measured

Probed directly (throwaway spec, since deleted). `tree.get(2)` on the seeded tree captures exactly
two dependencies, **both cache hits**:

| block | what it is | rev at capture | rev after the rival |
|---|---|---|---|
| `users` | the collection header block, read via `CollectionTrunk` | 1 | 1 (untouched) |
| `0ECBd…VnM` | the single B-tree root/leaf node | 1 | **2 (moved)** |

So the primary test is already a mixed moved/untouched set by construction, and the rejection names
the leaf, not the header.

## The four tests

- **`rejects a transaction whose cache-hit read was superseded by another writer`** — the full
  chain. Asserts `valid === false`, `reason` includes `'Stale read'`, and that the reason names a
  block whose revision *actually* moved (computed after the rival, not hard-coded).
- **`validates the same cache-hit read clean when nothing supersedes it`** — the positive companion,
  same flow minus the rival. Uses `hashOperations(collectOperations(new Map()))` and the stub
  validation-coordinator factory so it reaches the end of `validate()` rather than tripping the
  operations-hash compare.
- **`rejects for the moved block while untouched deps in the same read set stay clean`** — the
  deterministic mixed case. A second collection `posts` the rival never touches supplies untouched
  deps; they are placed **first** in the `reads` array so the validator must scan past matching
  entries before rejecting. Asserts the `posts` deps alone validate clean, the combined set rejects,
  the reason names a moved `users` block, and the reason names **no** `posts` block.
- **`probing a collection that does not exist leaks no phantom revision-0 dep`** — opens
  `'brand-new'` on an empty transactor (the absent-header probe), asserts no dep at revision 0, no
  dep naming a block the transactor does not hold, and that the header id itself is absent from the
  set. Then actually creates the collection and re-validates the captured set — still `valid`,
  proving the phantom-dep failure mode (every transaction that touched a missing block failing the
  instant that block is created) does not occur.

# Validation performed

```
npx tsc --noEmit -p packages/db-core     → clean
yarn lint                                 → clean
yarn workspace @optimystic/db-core test   → 1381 passing, 0 failing
```

The prereq ticket's handoff recorded **1377 passing**; this ticket adds exactly the four tests
above. No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Non-vacuity, measured

The cache-hit dependency re-emit in `cache-source.ts` (`tryGet`'s hit branch:
`if (rev !== undefined) this.collector?.record(id, rev, purpose);`) was temporarily gated off and
the file re-run. **Three of the four tests fail**, all with the same message:

```
AssertionError: users: a cache-hit read must record read dependencies (the whole point of the fix):
  expected [] not to be empty
```

The captured set collapses to `[]` — i.e. *every* read in the flow is a cache hit, so the whole
chain depends on the fix. The fourth (absent-block) test passes under the mutation, correctly: it
asserts what must **not** be recorded, and the mutation only removes recording.

The mutation was reverted; `git status --porcelain` afterwards shows only the untracked new test
file.

# Known gaps — treat this as a floor, not a ceiling

- **`commitRivalTreeWrite` is only exercised as an upsert.** A rival *deleting* the reader's key is
  untested here (the prereq ticket's review recorded the same gap for its own cases).
- **Single-level tree.** The seeded tree is one node at the default fan-out (64), so root and leaf
  are the same block and there is no interior branch. The interaction between the reduced read set
  (`navigation` reads dropped — see `occ-structural-read-exclusion.spec.ts`) and a *cross-writer*
  supersession is therefore untested: a rival that restructures a multi-level tree, bumping an
  interior node that the reader deliberately excluded, is the case where the two mechanisms could
  disagree. `occ-structural-read-exclusion.spec.ts` covers that only against a hand-built validator
  with synthetic block revisions, not a real rival. This is the most likely place a real bug hides.
- **Validation is invoked directly; the reader's transaction is never pended.** So no pend-ordering
  or coordinator-retry interaction is covered, and the rival's `policy: 'r'` pend cannot collide
  with anything. A variant that pends the reader first would need the rival to move ahead of it (see
  the livelock rationale on `CompetingWriterTransactor` in `test-transactor.ts`).
- **The revision-equality guard asserts on *every* dep**, which is stronger than the ticket asked
  ("at least one"). It holds today for both captured blocks. If a future read path legitimately
  records a dep at a revision the transactor does not report (a staged-but-uncommitted block, say),
  this guard fails rather than the thing under test — the failure message names the block, so it
  should be diagnosable, but it is a deliberate tightness worth knowing about.
- **`hashOperations(collectOperations(new Map()))` is the only operations hash used.** These tests
  say nothing about the hash-compare step; they are aimed exclusively at step 3 of `validate()`.
- **No multi-collection *coordinator* path.** The mixed test concatenates two collections'
  dependency sets by hand into one `reads` array, which is the shape a multi-collection transaction
  produces — but it does not go through `TransactionCoordinator` to produce it.

# Tripwires

None new. Nothing conditional surfaced that needed parking at a code site; the items above are
present-tense coverage boundaries, recorded here rather than deferred.

# Accepted tradeoffs

None encountered. No `NOTE:` marking a declined finding exists at any site this ticket touched.
