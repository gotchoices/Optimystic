description: A distributed save resolved which network node owns each block twice — once when staging, again when committing. It now resolves once and reuses that during the commit.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (txnCoordinatorCache field, pend population site, resolveCoordinator, txnCoordinatorsFor, batchesForPayload actionId param, commitBlocks wiring)
  - packages/db-core/test/network-transactor.spec.ts ("per-transaction coordinator cache (pend → commit)" describe)
difficulty: medium
----

# Review: cache per-block cluster/coordinator lookups for the pend→commit window

## What the ticket asked for

`NetworkTransactor.pend` resolves each block's cluster (`findCluster`) and picks a
coordinator per block, then `commit` re-resolved the same blocks from scratch
(`findCoordinator` per block). The only thing carrying pend's choice to commit was
an **optional, duck-typed** `keyNetwork.recordCoordinator?.(...)` hint that silently
no-ops on key networks that don't implement it (e.g. the Quereus adapter). Goal:
resolve each block's cluster/coordinator **once per transaction**, and make commit
reuse pend's resolution without depending on that optional hop.

## What I built (shape chosen + tradeoff)

The ticket offered two shapes. I implemented **shape (1) — a per-transaction cache** —
but with one deliberate adaptation, explained below.

- **New field** `txnCoordinatorCache: Map<ActionId, { coordinators: Map<BlockId, PeerId>, expires }>`
  on `NetworkTransactor`.
- **pend populates it** (network-transactor.ts, in the pend success path): after
  `processBatches` succeeds, it reads the *final, retry-adjusted* batch tree and records
  `blockId → coordinator PeerId` for **every** block each consolidated batch coordinates
  (via `blockIdsForTransforms(b.payload)`), not just the anchor block the old
  `recordCoordinator` hint recorded.
- **commit reads it**: `commitBlocks` now threads the transaction's `actionId` into
  `batchesForPayload` and `processBatches`, both of which resolve coordinators through a
  new `resolveCoordinator(blockId, options, actionId)` helper. That helper returns the
  cached coordinator when present **and not in `excludedPeers`**, else falls back to a live
  `keyNetwork.findCoordinator`. A cache miss (including all `get`/`cancel` calls, which pass
  no `actionId`) never fails — it always falls through to live resolution.

### The adaptation: keyed by `actionId`, not threaded through the call

The pure ticket wording for shape (1) is "thread a `Map` object through the pend→commit
call path." I did **not** thread a Map through the `ITransactor` methods, because `pend`
and `commit` are **separate `ITransactor` calls** driven by separate phases of
`TransactionCoordinator` (pendPhase → commitPhase) with no shared per-transaction object
except `actionId`. Threading a shared Map would have meant changing the `ITransactor`
contract (or the `PendRequest`/`CommitRequest` shapes) and every implementation + call
site + test — large blast radius for a perf optimization.

Instead the cache lives inside `NetworkTransactor` keyed by `actionId`. **Crucially this
preserves shape (1)'s "no staleness" property**: `actionId` is unique per transaction, so
an entry is only ever *read* by commits of the same transaction (the ones right after its
pend). Once those finish, nothing reads that entry again. So even though the map is
long-lived and the entries have a TTL, there is **no cross-transaction staleness** — the
TTL + a 1000-entry size cap (in `txnCoordinatorsFor`) are purely a **memory backstop** that
reclaims entries from transactions that pend but never commit. TTL = `max(timeoutMs*2, 60s)`.

Why not explicitly delete the entry at commit-end (the most literal shape-1 lifetime)?
Because a multi-collection transaction fans out **concurrent** `commit()` calls for the
**same** `actionId` (one per collection, in `TransactionCoordinator.commitPhase`). The first
to finish would delete the shared entry out from under the others mid-flight. TTL-based
reclamation sidesteps that without a ref-count, and — per the uniqueness argument above —
costs nothing in staleness.

I intentionally **kept** the existing optional `recordCoordinator` hint call in pend and the
`as any` duck-type in `packages/db-p2p/src/cluster/client.ts` (that was shape (2)'s job to
remove). They remain useful for the libp2p `findCoordinator` fast-path and cross-process
reuse; the new per-transaction cache is now the *reliable in-process* handoff that works
regardless of whether the key network implements `recordCoordinator`.

## NOTE tripwire left in code

At the pend population site (network-transactor.ts) there is a `// NOTE:` stating the cache
**assumes cluster membership is stable for the transaction's lifetime** — the coordinator
resolved at pend is reused verbatim at commit. Fine now (transactions are short). If a
future change lets clusters churn *within* one transaction (e.g. very long-running commits),
a cached coordinator could be stale; commit self-heals (a failed cached peer is excluded and
re-resolved live by `processBatches`) at the cost of one wasted round-trip. Parked as a
code comment, not a ticket.

## How to validate

Build + test (both pass; full db-core suite = 1153 passing, 0 failing):

```
cd packages/db-core && yarn build && yarn test
cd packages/db-p2p  && yarn build            # typecheck only; contract unchanged
```

New tests: `network-transactor.spec.ts` → `describe('per-transaction coordinator cache (pend → commit)')`

- **"commit reuses pend's coordinator…"** — two blocks sharing a cluster peer; a counting
  mock key network asserts `findCluster` is called exactly twice (once per block, at pend)
  and `findCoordinator` **zero** times across pend **and** commit. Proves "resolved once per
  transaction; commit reuses pend's resolution."
- **"is per-transaction…"** — pend under actionA, then commit the same block under actionB;
  asserts commit falls back to a live `findCoordinator` (cache miss), proving no
  cross-transaction leakage and that a miss degrades safely.

## Known gaps / where the reviewer should push (tests are a floor)

- **Retry-adjusted population is asserted only indirectly.** The population reads
  `blockIdsForTransforms(b.payload)` over the *final* batch tree (including `subsumedBy`
  retry children) filtered to successful batches, so a block re-homed by a pend retry is
  recorded against the peer that actually pended it. There is **no test that forces a pend
  retry** and then asserts commit reuses the *retry's* coordinator. Worth adding (the
  existing `FlakyCommitTransactor` fails commits, not pends — a pend-flaky harness would be
  new).
- **excludedPeers skip on commit retry is untested.** `resolveCoordinator` skips a cached
  coordinator that's in `excludedPeers` so a commit retry can't loop on a dead cached peer,
  then re-resolves live. No test exercises a cached-coordinator-then-excluded commit retry.
- **Multi-collection concurrent commit** (shared `actionId`, concurrent `commit()` calls) is
  the reason I avoided explicit delete; it is exercised by higher-level coordinator tests but
  not by a direct unit test here. If the reviewer disagrees with TTL-based reclamation, the
  alternative is ref-counting concurrent commits per actionId — heavier.
- **TTL floor interaction with very long `timeoutMs`.** If an operator sets `timeoutMs`
  large *and* a pend burns nearly its full budget before commit, the entry could expire
  before commit reads it → cache miss → live fallback (correctness preserved, optimization
  lost). Only a perf edge, never a correctness bug.
- **`findCluster` itself is still called once per block per pend** and is *not* memoized
  across `queryClusterNominees` (GATHER, multi-collection) vs `consolidateCoordinators`
  (pend) for the same critical block. The ticket's headline redundancy (pend `findCluster`
  → commit `findCoordinator`) is closed; this secondary same-transaction `findCluster`
  repeat for multi-collection critical blocks is not. Left as out-of-scope; flag if it
  matters.

## Files touched

- `packages/db-core/src/transactor/network-transactor.ts` — cache field + doc, pend
  population (NOTE site), `resolveCoordinator`, `txnCoordinatorsFor`, `batchesForPayload`
  optional `actionId`, `commitBlocks` wiring.
- `packages/db-core/test/network-transactor.spec.ts` — new describe block (2 tests).
