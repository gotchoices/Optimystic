description: When the database checks whether a block exists and the answer is a definite "no", treat that as final instead of redoing the whole lookup over the network a second time.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (get / retry rounds ~lines 112-163)
  - packages/db-p2p/src/storage/storage-repo.ts (get returns `{ state: {} }` for a missing block, ~line 229)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cluster consult on isMissing, ~lines 199-203)
  - packages/db-core/test/network-transactor.spec.ts (mock key network; add round-count assertion)
difficulty: medium
----

# Perf (a): authoritative "not found" must not trigger a second retry round

## Problem

`NetworkTransactor.get()` runs a "second-chance" retry round for any batch that
did not return a **materialized block**. The retry predicate is:

```ts
const hasBlockInResponse = (b) => {
  if (!hasValidResponse(b)) return false;
  const resp = b.request!.response! as GetBlockResults;
  return b.payload.some(bid => {
    const entry = resp[bid];
    return entry && typeof entry === 'object' && 'block' in entry && entry.block != null;
  });
};
```

A `GetBlockResult` is `{ block?: IBlock; state: BlockActionState }`. For a block
that genuinely does not exist yet, `storage-repo.ts` returns an **entry that is
present** but carries only `{ state: {} }` — no `block` (see `storage-repo.ts:229`).
That is an *authoritative "absent"* answer, not a missing answer. The predicate
above sees `entry.block == null`, calls the batch retryable, and — while still
under the transaction budget — kicks off a **whole second round** of
`findCoordinator` + `get` (serial per batch, lines 133-163).

This is the normal path for `createOrOpen`-style probing ("does this block exist?
no → create it"), so the common case pays for two network rounds where one had a
definitive answer.

## Why the retry was there, and why dropping it for this case is safe

The retry comment claims tolerance for "different cluster members may have
different views" — i.e. a lagging coordinator that returns "absent" while another
member has the block. That reconciliation **already happens one layer down**:
`CoordinatorRepo.get()` (`coordinator-repo.ts:199-203`) detects `isMissing`
(`!localEntry?.state?.latest`) and consults cluster peers *before* it responds.
So by the time an authoritative `{ state: {} }` reaches the transactor, the
coordinator has already reconciled the cross-member view. Retrying at the
transactor layer re-does work the coordinator already did.

## Fix direction

Distinguish an **authoritative "absent" response** (a valid response that contains
an *entry* for the requested block id, even if that entry has no `block`) from a
**genuine no-response** (no valid response, or no entry at all for the block id).
Retry only the latter.

Concretely: change the retry predicate from "does the response contain a
materialized block for some payload block id" to "does the response contain an
**entry** (authoritative answer) for every payload block id". An entry present
with only `state` counts as answered.

Sketch:

```ts
// A batch is answered when its response carries an entry for each requested
// block id — an entry with no `block` is an authoritative "absent", not a gap.
const isAuthoritative = (b) => {
  if (!hasValidResponse(b)) return false;
  const resp = b.request!.response! as GetBlockResults;
  return b.payload.every(bid => resp[bid] !== undefined);
};
const retryable = Array.from(allBatches(batches))
  .filter(b => !isAuthoritative(b));
```

Keep the existing `missingIds` aggregate-error path (lines 184-198) as the
backstop for a batch that truly returned no entry for a requested block.

## Interactions

- Interacts with **tx-9** (retry policy) — keep the "retry only on genuine
  no-response / error" intent consistent with whatever tx-9 lands. Note the
  decision in the review handoff so tx-9's author sees it.
- The `resultEntries` assembly (lines 166-201) already prefers a response that
  includes a materialized block over one that doesn't, so an absent entry never
  shadows a real block from another member. No change needed there — verify it.

## Expected behavior

Probing for a not-yet-existing block costs **one** coordinator round, not two.
A genuine no-response (peer down, dial timeout, empty response) still retries.

## TODO

- Replace `hasBlockInResponse` with an authoritative-entry predicate (entry
  present for every requested block id = answered) in `NetworkTransactor.get()`.
- Confirm the `resultEntries` preference logic still favors a materialized block
  over an absent entry when two members disagree; leave it intact.
- Add a test to `network-transactor.spec.ts`: mock key network counts
  `findCoordinator` calls; a `get` for a block whose coordinator returns
  `{ state: {} }` resolves after exactly one round (no retry). Add a companion
  test proving a genuine no-response / error still retries.
- Build + test the db-core package; stream output with `tee`.
