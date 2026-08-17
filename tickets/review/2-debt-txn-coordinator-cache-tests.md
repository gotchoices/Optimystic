----
description: Review the new tests that cover what happens when the first storage node fails mid-save, when a remembered node is unreachable at commit time, and when several parts of one transaction commit at once.
files:
  - packages/db-core/test/network-transactor.spec.ts (all changes; the "per-transaction coordinator cache (pend → commit)" describe, ~line 1107-1400)
  - packages/db-core/src/transactor/network-transactor.ts (resolveCoordinator ~816, txnCoordinatorsFor ~837, pend cache-population ~640, commitBlocks ~750 — code under test, UNCHANGED)
  - packages/db-core/src/utility/batch-coordinator.ts (processBatches ~111 — the retry loop the tests drive; UNCHANGED)
  - packages/db-core/src/testing/test-transactor.ts (DelegatingTransactor ~446 — imported only, UNCHANGED)
difficulty: medium
----

# Review: per-transaction coordinator cache tests

Tests-only change. One file touched: `packages/db-core/test/network-transactor.spec.ts`
(+289 / −11). No production code was modified — `git status` shows only the spec.

## What the cache is (context for the reviewer)

`NetworkTransactor` remembers, per transaction, which network node coordinates each block:
`txnCoordinatorCache: Map<ActionId, { coordinators: Map<BlockId, PeerId>, expires }>`.
`pend()` fills it from its final batch assignment; `commit()` reads it through
`resolveCoordinator()` so the commit reuses pend's answer instead of running a fresh
`findCoordinator` lookup. Before this change two tests covered it: the happy path, and a
commit under a different transaction id missing the cache.

## What was added

Harness (file-local, inside the existing describe):

- `CountingClusterKeyNetwork` now takes `fallbackCoordinators: string[]` instead of one
  string. Its `findCoordinator` returns the first candidate **not** in `excludedPeers`
  (compared by `toString()`) and throws `'no alternative coordinator'` when all are
  excluded. New `findCoordinatorExclusions: string[][]` logs one entry per call. The two
  pre-existing tests were updated to pass `[peerShared]` and still pass.
- `FlakyTransportTransactor extends DelegatingTransactor` — pend/commit **throw** rather
  than return `{ success: false }`, because `processBatches` hangs its retry on the
  `.catch` of the per-batch call, so only a throw retries. With its fail counts at their
  default of 0 it is a pure call counter, which is how the reachable peer is instrumented.
- `makeTransactor`'s `transactors` map value type widened `TestTransactor` → `ITransactor`.

Six new tests (8 total in the describe, all passing):

1. **`caches the RETRY's coordinator, not the peer pend first tried`** — peerA is in the
   block's cluster and always throws on pend; the retry re-homes to peerB. Asserts the
   pend still succeeds, `peerA.pendCalls === 1` / `peerB.pendCalls === 1`, and that the
   follow-up commit makes **zero** further `findCoordinator` calls while dialing
   **peerB** (`peerB.commitCalls === 1`, `peerA.commitCalls === 0`).
2. **`self-heals when a commit retry excludes the cached coordinator`** — peerA and peerB
   wrap the **same** `TestTransactor`, which is the one-shared-store property cluster
   replication provides. pend caches peerA; peerA's commit throws; the retry excludes it,
   `resolveCoordinator` skips the cached entry, the live lookup returns peerB, and the
   commit lands. Asserts `findCoordinatorCalls === 0` after pend and `> 0` after commit,
   that an exclusion list containing peerA was seen, `peerA.commitCalls === 1` (no loop),
   and `inner.getCommittedActions().has(actionId)`.
3. **`excludes a cached coordinator by peer id, not by object identity`** — see
   *Deviation* below. Not in the ticket; added because the specified test 2 does not in
   fact cover the claim the ticket assigned to it.
4. + 5. **`one actionId shared by several collections' commits`** (nested describe,
   sequential and concurrent arms) — two blocks on disjoint single-peer clusters, two
   pends and two commits under one transaction id. Both arms assert
   `findClusterCalls === 2`, `findCoordinatorCalls === 0`, and per-peer
   `commitCalls === 1`, so the entry surviving a sibling's commit is observable and a
   commit that fanned to the wrong peer cannot pass.
6. **`never lets a read borrow a write's cached coordinator`** — `get()` after a pend
   passes no transaction id, so it must fall through to a live lookup;
   `findCoordinatorCalls` is asserted to increase.

## Deviation from the ticket — read this one

The ticket's edge-case list asserted that test 2 exercises `resolveCoordinator`'s
**string** comparison of peer ids, on the belief that the retry supplies "a different
object instance than the cached one". **It does not.** `resolveCoordinator` returns the
cached `PeerId` object itself, that same object becomes `batch.peerId`, and the retry
excludes that same object — so under a plain reference comparison test 2 passes
identically. I verified this: with the implementation temporarily changed to
`excludedPeers.some(p => p === cached)`, all of the ticket's specified tests still passed.

Test 3 above closes the gap. Two blocks that were cached from **separate pends** (hence
two distinct `PeerId` objects both naming `peer-A`) are put into one commit batch by the
remainder round of `commit()`. The retry can only exclude the instance belonging to the
first block, so the second is a same-string / different-object twin and is skipped only if
the comparison is by string. Under the reference-comparison mutation this test fails with
`expected 3 to equal 2` (an extra dial to the dead peer); with the real implementation it
passes. The mutation was reverted — confirm for yourself that
`packages/db-core/src/transactor/network-transactor.ts:824` reads
`excludedPeers.some(p => p.toString() === cached.toString())`.

## Validation run

```
yarn workspace @optimystic/db-core test                                  # 1387 passing, 0 failing
yarn workspace @optimystic/db-core test -- --grep "coordinator cache"    # 8 passing
yarn workspace @optimystic/db-core build                                 # clean (tsc covers test/)
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps — treat the tests as a floor

- **Only test 3 was mutation-verified.** The other five were reasoned against the
  implementation, not proven non-vacuous by breaking it. Tests 1, 2 and both arms of the
  shared-actionId pair have counter assertions that should fail under the obvious
  breakages (cache holding the pre-retry peer; the entry being deleted at commit-end), but
  that was not demonstrated. Worth a mutation pass if you want the floor higher.
- **The cache-miss arm asserts `greaterThan`, not an exact count.** `get()` has its own
  second-chance retry logic; pinning an exact number would couple the cache test to that
  unrelated behavior. The claim under test is only "a miss falls through to live
  resolution".
- **Retry exhaustion is untested on the cache path.** When every candidate is excluded,
  `findCoordinator` throws and `processBatches` swallows the retry-setup error, rethrowing
  the original. No new test reaches that state; the ticket flagged it only as something not
  to accidentally depend on.
- **`recordCoordinator` is deliberately left undefined** on `CountingClusterKeyNetwork`, so
  these tests exercise the cache and never the optional hint. If both are ever needed, they
  need separate counters.
- **TTL sweep and the 1000-entry size cap are out of scope** per the ticket — the cap needs
  ~1000 transactions and the TTL needs a clock injection seam that deliberately was not
  added. Both are memory backstops carrying no correctness property.
- **Test 3 leans on batch grouping order** — `makeBatchesByPeer` keeps the first block's
  `PeerId` instance as the batch's `peerId`. If that ever changes, the test still exercises
  the property (whichever instance wins, the other block's is a distinct twin), but the
  comment explaining which instance is excluded would go stale.

## Suggested review focus

- Are the counter assertions in tests 1, 2 and the shared-actionId pair actually
  discriminating, or would a broken cache still pass them?
- Is `FlakyTransportTransactor` in the right place? It is file-local per the ticket
  (matching `PartialLossTransactor` / `MixedPendTransactor` in `transaction.spec.ts`),
  deliberately not added to the shared `src/testing/test-transactor.ts` that two open
  backlog tickets already want to edit.
- The nested `describe` for the shared-actionId arms adds a level of nesting to a file that
  is otherwise flat. Fold it back into two sibling `it`s if that reads better.
