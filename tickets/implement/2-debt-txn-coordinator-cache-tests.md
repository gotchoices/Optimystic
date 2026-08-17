----
description: Add tests for the three untested corners of the per-transaction coordinator cache — what happens when the first node fails during the save, when a remembered node is unreachable at commit, and when two parts of one transaction commit at the same time.
files:
  - packages/db-core/test/network-transactor.spec.ts (the "per-transaction coordinator cache (pend → commit)" describe, ~line 1111 — all new tests land here)
  - packages/db-core/src/transactor/network-transactor.ts (resolveCoordinator ~816, txnCoordinatorsFor ~837, pend cache-population site ~640, commitBlocks ~750 — code under test, NOT modified)
  - packages/db-core/src/utility/batch-coordinator.ts (processBatches ~111 — the retry loop these tests drive; read-only)
  - packages/db-core/src/testing/test-transactor.ts (DelegatingTransactor ~446 — imported, NOT modified)
difficulty: medium
----

# Test hardening: per-transaction coordinator cache

## What the cache is

`NetworkTransactor` keeps a per-transaction map from block id to the network node
that coordinates it: `txnCoordinatorCache: Map<ActionId, {coordinators: Map<BlockId, PeerId>, expires}>`
in `packages/db-core/src/transactor/network-transactor.ts`. `pend()` fills it from
its final batch assignment; `commitBlocks()` reads it through `resolveCoordinator()`
so the commit reuses pend's resolution instead of running a fresh `findCoordinator`.

Two tests exist today (happy path; a commit under a different `actionId` misses the
cache). Three corners are untested. **None is a known defect** — this ticket adds
tests only. If a test fails, that is a real find: stop and report it rather than
bending the assertion.

## The mechanics these tests rely on

Read these before writing the tests; the assertions only make sense against them.

- **`pend` assembles batches from `findCluster`, not `findCoordinator`.**
  `consolidateCoordinators()` calls `keyNetwork.findCluster` per block and greedily
  assigns blocks to covering peers. `findCoordinator` is only the fallback for blocks
  whose cluster lookup produced nothing — which is why the existing happy-path test
  can assert `findCoordinatorCalls === 0` after a pend.
- **Only a THROWN failure triggers a retry.** `processBatches()`
  (`packages/db-core/src/utility/batch-coordinator.ts:111`) attaches its retry logic
  to the `.catch` of the per-batch call. A returned `{ success: false }` never retries
  — it flows to `pend`'s stale-failure path or `commitBlocks`' aggregate error. This is
  why `FlakyCommitTransactor` (which *returns* a stale failure) cannot drive any of
  these tests: the harness below must **throw**, transport-style.
- **A retry re-resolves with the failed peer excluded.** The retry calls
  `createBatchesForPayload(..., excludedPeers: [failedPeer, ...prior], findCoordinator)`,
  where `findCoordinator` is `resolveCoordinator` for commit and the raw
  `keyNetwork.findCoordinator` for pend.
- **A failed root batch is not cached.** `pend` seeds the cache from
  `allBatches(batches, b => b.request?.isResponse && b.request.response.success)`.
  `Pending.isResponse` stays `false` when the promise rejected
  (`packages/db-core/src/utility/pending.ts:8`), so a thrown-away first attempt
  contributes nothing; only the retry batch that actually succeeded does.
- **Success survives a failed root.** `everyBatch` requires only that *some* node of a
  root's retry tree succeeded, so a pend/commit whose retry landed reports success.

## Harness changes (all local to `network-transactor.spec.ts`)

Follow the file-local convention already used by `PartialLossTransactor` /
`MixedPendTransactor` in `packages/db-core/test/transaction.spec.ts:4149` — define the
wrapper in the spec, not in `src/testing/test-transactor.ts`. Only this one spec needs
it, and two open backlog tickets already want to edit that shared file. If a second
spec ever needs it, promote it then.

**1. A transport-failing wrapper.** Extends `DelegatingTransactor` (already exported
from `packages/db-core/src/testing/test-transactor.ts`):

```ts
/** Wraps a TestTransactor and makes pend/commit THROW — a transport-level failure, the
 *  only failure shape processBatches retries (a returned {success:false} does not, which
 *  is why FlakyCommitTransactor cannot drive these tests). Counts calls so a test can
 *  prove which peer a phase actually reached. */
class FlakyTransportTransactor extends DelegatingTransactor {
  pendCalls = 0;
  commitCalls = 0;
  constructor(
    inner: TestTransactor,
    private readonly opts: {
      /** initial pend() calls to throw on; Infinity = always. Default 0. */
      failPendFirstN?: number;
      /** initial commit() calls to throw on; Infinity = always. Default 0. */
      failCommitFirstN?: number;
      message?: string;
    } = {},
  ) { super(inner); }
  // pend/commit: increment the counter, throw new Error(message ?? 'The stream has been reset')
  // while the counter is <= the respective failFirstN, otherwise delegate to inner.
}
```

With both `failFirstN` at their default of 0 this is a pure call counter, which is how
the *reachable* peer in each test gets instrumented — one class, both roles.

**2. Extend the existing `CountingClusterKeyNetwork`** (spec, ~line 1113) so its
`findCoordinator` honours `excludedPeers`:

- constructor takes `fallbackCoordinators: string[]` instead of a single string
  (update the two existing call sites to pass `[peerShared]`);
- `findCoordinator` returns the first fallback not present in
  `options.excludedPeers` (compare by `toString()`), and throws
  `new Error('no alternative coordinator')` when all are excluded — matching what a
  real `findCoordinator` does when it runs out of candidates;
- keep the `findCoordinatorCalls` counter (existing tests read it) and add
  `findCoordinatorExclusions: string[][]`, one entry per call, so a test can assert
  *what* was excluded rather than only that a call happened.

## The three tests

All go in the existing `describe('per-transaction coordinator cache (pend → commit)')`
block and reuse its `makeTransactor` helper (widen its `transactors` map value type
from `TestTransactor` to `ITransactor` so wrappers can be registered).

### 1. Commit reuses the RETRY's node, not the node pend first tried

Setup: block `b` with cluster `[peerA]`; `findCoordinator` fallbacks `[peerA, peerB]`.
`peerA` = `FlakyTransportTransactor(new TestTransactor(), { failPendFirstN: Infinity })`;
`peerB` = `FlakyTransportTransactor(new TestTransactor())` (counting only).

Flow: pend picks `peerA` from the cluster → `peerA.pend` throws → `processBatches`
retries with `excludedPeers: [peerA]` → `findCoordinator` returns `peerB` → `peerB.pend`
succeeds → cache records `b → peerB`.

Expected:
- `pendResult.success === true` (the retry landed).
- `peerA.pendCalls === 1`, `peerB.pendCalls === 1`.
- Snapshot `net.findCoordinatorCalls` after the pend, then commit
  `{ actionId, rev: 1, blockIds: [b], tailId: b }`.
- After commit: `net.findCoordinatorCalls` **unchanged** — the commit resolved purely
  from the cache.
- `peerB.commitCalls === 1` and `peerA.commitCalls === 0` — the cache carried the
  *post-retry* assignment, not the original one.
- `commitResult.success === true`.

### 2. A cached node that is excluded on a commit retry self-heals to a live lookup

The plan-stage note that this needs `NetworkSimulation` to be end-to-end is resolved:
give `peerA` and `peerB` wrappers over the **same** `TestTransactor` instance. One
shared block store is exactly the property cluster replication provides (the pending
action recorded via `peerA` is visible to `peerB`), so the bare unit test can assert
the commit ultimately **succeeds**, not merely that a live lookup happened.

Setup: shared `inner = new TestTransactor()`; block `b` cluster `[peerA]`; fallbacks
`[peerA, peerB]`;
`peerA = new FlakyTransportTransactor(inner, { failCommitFirstN: Infinity })`,
`peerB = new FlakyTransportTransactor(inner)`.

Flow: pend succeeds on `peerA` (its pend is not intercepted) and caches `b → peerA`.
Commit resolves `peerA` **from the cache** → `peerA.commit` throws → retry re-resolves
with `excludedPeers: [peerA]` → `resolveCoordinator` sees the cached `peerA` is
excluded and skips it → live `findCoordinator` returns `peerB` → `peerB.commit`
succeeds against the shared state.

Expected:
- `net.findCoordinatorCalls === 0` immediately after pend; `> 0` after commit — the
  commit's *first* resolution was cached, and only the retry went live.
- `net.findCoordinatorExclusions.some(ex => ex.includes(peerA))` — the live lookup was
  the retry's, carrying the exclusion.
- `peerA.commitCalls === 1` (it is never re-tried; the cache did not loop on it),
  `peerB.commitCalls === 1`.
- `commitResult.success === true`, and `inner.getCommittedActions().has(actionId)`.

### 3. One transaction id shared by several collections' commits

A multi-collection transaction fans out one `pend()` and one `commit()` per collection,
all under the same `actionId`, so they share one cache entry. The implementation
reclaims entries by TTL rather than deleting at commit-end precisely so a finished
sibling cannot pull the entry out from under a commit still in flight. Two arms:

**Sequential arm (the no-delete-on-commit-end property).** Blocks `b1`, `b2` with
disjoint clusters `[peer1]`, `[peer2]`. Two `pend()` calls under the same `actionId`,
one per block (each pend both creates and then re-uses the same cache entry). Then
commit `b1` and await it; then commit `b2`.
Expected: both succeed, and `net.findCoordinatorCalls === 0` for the whole test —
`b2`'s commit still found its entry after `b1`'s commit finished.

**Concurrent arm (shared-entry read/write under fan-out).** Same setup, fresh
`actionId`; run the two `pend()` calls under `Promise.all`, then the two `commit()`
calls under `Promise.all`.
Expected: all four settle successfully, `net.findClusterCalls === 2` (one per block,
from pend only) and `net.findCoordinatorCalls === 0` — every commit was served from
the shared entry. Register a per-peer `FlakyTransportTransactor` counter and assert
`peer1.commitCalls === 1` / `peer2.commitCalls === 1`, so a commit that silently
fanned to the wrong peer cannot pass.

Use a distinct `rev` per block only if `TestTransactor.commit` complains; the blocks
are disjoint, so `rev: 1` on both is expected to be fine.

## Edge cases & interactions

The implementer must handle these; the reviewer will check them.

- **Peer identity is compared by string, not reference.** `resolveCoordinator`'s
  exclusion check is `excludedPeers.some(p => p.toString() === cached.toString())`.
  Test 2 must produce the excluded `PeerId` through the normal retry path (a different
  object instance than the cached one), not by handing the same instance back — the
  string comparison is part of what is under test.
- **A cache miss must never fail.** Add one cheap arm: after a pend, call
  `networkTransactor.get({ blockIds: [b] })` and assert `findCoordinatorCalls`
  increased — `get`/`cancel` pass no `actionId`, so they must fall through to live
  resolution rather than borrowing a write's cached coordinator.
- **Retry exhaustion.** If `findCoordinator` throws because every candidate is
  excluded, `processBatches` swallows the retry-setup error and rethrows the original
  failure. Do not let a test depend on the retry error surfacing; assert against the
  *original* failure's message when a test reaches that state.
- **The `recordCoordinator` hint is optional.** `pend` calls
  `keyNetwork.recordCoordinator?.(...)` inside a try/catch. `CountingClusterKeyNetwork`
  does not define it; leave it undefined so the tests exercise the cache and not the
  hint. If a test ever needs both, count them separately.
- **`commit()` splits into header/tail/remainder.** `NetworkTransactor.commit` issues
  a separate `commitBlocks` for the header (when distinct), the tail, and the rest.
  Keep the test requests single-block with `tailId === blockIds[0]` unless a test
  specifically wants multiple rounds, or per-peer `commitCalls` counts will not match
  the numbers above.
- **Non-tail commit failures are swallowed.** A failure on a non-tail block only logs
  and still returns `{ success: true }`. Any test asserting a commit failure must put
  the failing block in the tail position, or the assertion is vacuous.
- **Cross-test cache bleed.** The cache lives on the `NetworkTransactor` instance and
  is keyed by `actionId`. Build a fresh transactor per test (as the existing tests do)
  and use `generateRandomActionId()` for each transaction, including for each arm of
  test 3.
- **Timing.** `timeoutMs: 1000` in `makeTransactor` bounds both the retry window
  (`expiration > Date.now()` gates the retry) and the cache TTL
  (`max(timeoutMs * 2, 60_000)`). Keep the harness synchronous — no artificial delays —
  so a slow CI machine cannot expire the window and turn a retry test into a timeout.

## Deliberately out of scope

- The TTL sweep and the 1000-entry size cap in `txnCoordinatorsFor`. Exercising the cap
  needs ~1000 transactions and exercising the TTL needs either a clock injection point
  or a multi-minute wait; neither is worth its cost for a pure memory backstop that
  carries no correctness property. If it is ever wanted, it needs a seam for the clock
  first — do not add one under this ticket.
- Any change to `network-transactor.ts`. This ticket is tests only.

## TODO

- Extend `CountingClusterKeyNetwork` in `packages/db-core/test/network-transactor.spec.ts`:
  `fallbackCoordinators: string[]`, exclusion-aware `findCoordinator` that throws when
  all candidates are excluded, plus the `findCoordinatorExclusions` log. Update the two
  existing call sites.
- Widen `makeTransactor`'s `transactors` map value type to `ITransactor`.
- Add the file-local `FlakyTransportTransactor` (throwing pend/commit + call counters)
  with the doc comment explaining why it throws instead of returning `{success:false}`.
- Write test 1 (commit follows the retry's node).
- Write test 2 (cached node excluded on commit retry → live re-resolve → commit succeeds
  against shared state).
- Write test 3, both arms (sequential and concurrent commits sharing one `actionId`).
- Add the cache-miss arm: `get()` after a pend still resolves live.
- Run `yarn workspace @optimystic/db-core test` in the foreground (no redirection) and
  confirm the full suite passes — the extended `CountingClusterKeyNetwork` touches the
  two pre-existing cache tests, so they are part of the regression surface.
- Run the repo type check / build for `db-core` and confirm it is clean.
- Hand off to `review/` noting any assertion that had to be weakened and why. A test
  that fails against the current implementation is a genuine finding — report it, do
  not adjust the assertion to match.
