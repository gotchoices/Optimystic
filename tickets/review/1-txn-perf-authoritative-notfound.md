description: A database read that gets a definite "the block does not exist" answer now trusts that answer instead of asking the network a second time, halving the cost of the common "does this block exist yet?" check — needs a review pass.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (get() retry predicate, ~lines 112-141)
  - packages/db-core/test/network-transactor.spec.ts ("get retry accounting" describe block)
difficulty: medium
----

# Review: authoritative "not found" must not trigger a second retry round

## What changed

Single behavioral change in `NetworkTransactor.get()`'s second-chance retry
predicate (`network-transactor.ts`). Nothing else in the read path moved.

**Before:** a batch was retried unless its response contained a *materialized
block* for at least one requested block id (`hasBlockInResponse`, a `.some`
check). A block that genuinely does not exist yet comes back as an entry that is
**present but blockless** — `{ state: {} }` (see `db-p2p` `storage-repo.ts:229`).
The old predicate read that as "no block → retry" and kicked off a whole second
`findCoordinator` + `get` round. That is the normal path for `createOrOpen`
probing ("does this block exist? no → create it"), so the common case paid for
two network rounds where one had a definitive answer.

**After:** the predicate is `isAuthoritative` — a batch is *answered* when its
response carries an **entry for every requested block id**, materialized block or
not. An entry with only `state` counts as an authoritative "absent". Retry fires
only for a genuine no-response: no valid response, or a response missing an entry
for some requested block id.

```ts
// answered = an entry exists for every requested block id
const isAuthoritative = (b) => {
  if (!hasValidResponse(b)) return false;
  const resp = b.request!.response! as GetBlockResults;
  return b.payload.every(bid => resp[bid] !== undefined);
};
const retryable = Array.from(allBatches(batches)).filter(b => !isAuthoritative(b));
```

## Why dropping the retry for this case is safe

The old retry's stated purpose was tolerance for "different cluster members may
have different views" (a lagging coordinator saying "absent" while a peer holds
the block). That reconciliation **already happens one layer down**:
`CoordinatorRepo.get()` (`db-p2p` `coordinator-repo.ts:197-232`) detects
`isMissing` (`!localEntry?.state?.latest`) and consults cluster peers *before*
it responds. So by the time an authoritative `{ state: {} }` reaches the
transactor, the cross-member view is already reconciled — a transactor-level
retry re-does work the coordinator already did.

## How to validate (tests added — treat as a floor)

New `describe('get retry accounting')` block in `network-transactor.spec.ts`,
using a `CountingKeyNetwork` (counts `findCoordinator` calls, picks the first
non-excluded peer so a retry lands on a distinct coordinator) and a
`makeGetOnlyRepo` helper (minimal `IRepo`; pend/commit/cancel throw if reached):

- **`resolves after exactly one coordinator round for an authoritative absent`** —
  repo returns `{ state: {} }` for the block. Asserts `findCoordinatorCalls === 1`
  and the repo's `get` ran exactly once. This is the regression guard: under the
  old predicate both counts were 2.
- **`still retries a genuine no-response ...`** — first coordinator returns an
  empty `{}` (no entry for the block); asserts a second round fires
  (`findCoordinatorCalls === 2`, first repo hit once, retry repo hit once) and the
  result resolves. Proves the backstop retry still works.

Commands run (from `packages/db-core`, streamed):
- `yarn build` — clean (tsc silent).
- `yarn test` — **1143 passing**, no regressions. Focused: `yarn test:verbose
  --grep "NetworkTransactor"` → 16 passing including the two new tests.

## Known gaps / what a reviewer should probe

- **No multi-block partial-batch test.** The change is strictly *less* retrying
  for the single-block absent case, but for a batch coordinating multiple blocks
  it is arguably *more* robust: old predicate `hasBlockInResponse` used `.some`,
  so a batch returning a block for `b1` but **no entry** for `b2` was judged
  non-retryable and `b2` fell straight to the `missingIds` aggregate-error path;
  the new `.every` predicate retries the whole payload and can recover `b2`. This
  is a behavior improvement, but it is **untested** — a reviewer may want a test
  with a batch payload `[b1, b2]` whose first response includes `b1` only.
- **`resultEntries` preference logic left intact (TODO item 2 — verified).** The
  assembly at `network-transactor.ts:166-201` still prefers a response carrying a
  materialized block over a blockless entry (`resHasBlock && !existingHasBlock`),
  so when two members disagree an absent entry never shadows a real block from
  another member. No change was needed; confirmed by reading, not by a dedicated
  test.
- **Integration coverage is in-memory only.** Both new tests mock `IKeyNetwork`
  and `IRepo` directly. The end-to-end premise — that `CoordinatorRepo` really
  reconciles a missing block before responding, so the transactor never needs the
  retry — is **not** exercised by a db-p2p integration test here. db-p2p was not
  built/tested in this ticket (out of scope per the implement brief); a reviewer
  wanting end-to-end confidence should run the db-p2p suite against the rebuilt
  db-core dist.

## Cross-ticket interaction (flag for tx-9)

The implement brief noted this interacts with **tx-9** (retry policy). The intent
landed here is: **retry only on genuine no-response / error; an authoritative
absent is final.** If tx-9 reworks the get() retry loop, preserve that
distinction — do not fold authoritative-absent back into the retryable set.
The retry loop still drives a **single** round (it iterates the `retryable`
snapshot computed before the loop; nested retries enqueued onto `subsumedBy`
during the loop are not re-driven) — pre-existing behavior, unchanged here, worth
keeping in mind if tx-9 touches the loop.
