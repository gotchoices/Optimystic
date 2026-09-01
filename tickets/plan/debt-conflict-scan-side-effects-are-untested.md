description: When two writes want the same data at the same time, a cluster node runs a bookkeeping pass that both expires abandoned reservations and drops the loser of the contest. Two of that pass's behaviours have no test, so a future edit could break either and every test would still pass.
files: packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.findConflict, ~line 2190; ClusterMemberComponents, ~line 189; constructor, ~line 317), packages/db-p2p/src/cluster/race-resolution.ts (the pure helpers it calls — already directly tested), packages/db-p2p/test/cluster-repo.spec.ts (describe 'conflict detection', ~line 577 — where the new cases belong), packages/db-p2p/test/race-resolution.spec.ts, packages/db-p2p/src/cohort-topic/topic-router.ts and packages/db-p2p/src/cohort-topic/host.ts (existing `now?: () => number` injection precedent to copy)
difficulty: medium

# The reservation scan's expiry and multi-conflict behaviours have no test

## What the code does

`ClusterMember.findConflict` (`cluster-repo.ts`) is the pass a node runs before voting on a write.
It walks `activeTransactions` — the table of writes this node is currently holding open — and on
the way through does four things, in this order per entry:

- **Skips the record against itself** (`existingHash === record.messageHash`).
- **Expires abandoned entries.** Anything whose `lastUpdate` is older than a hardcoded 2000 ms is
  cleared, freeing its blocks. This check sits *above* the conflict test, so an abandoned write
  never gets to win a contest it should not be in.
- **Decides the contest** for a still-live overlapping entry, via `operationsConflict` then
  `resolveRace` (both now in `race-resolution.ts`, both directly unit-tested).
- **Clears the loser and continues.** If the incoming write wins, the held entry is dropped and the
  loop `continue`s — because the incoming write may overlap more than one held entry. A `break`
  here would let a write proceed past a second, still-live conflicting reservation.

## What is already covered (checked, not assumed)

`test/cluster-repo.spec.ts` → `describe('conflict detection')` already drives the public
`update()` path and asserts:

- a held entry that wins is named by identity in the resulting vote —
  `'answers a lost conflict race with a conflict vote naming the winner'` asserts
  `vote.conflictWith === recordX.messageHash`;
- a conflict-voted loser does not keep holding its blocks —
  `'does not reserve the blocks of a transaction it conflict-voted'`;
- plus basic same-block / different-block conflict detection.

`test/race-resolution.spec.ts` covers `approvalCount`, `recordPriority`, `operationsConflict` and
`resolveRace` as pure functions.

So two of the four bullets the originating backlog ticket listed are already done. This ticket is
the remainder.

## The actual gap

**1. Expiry ordering.** Nothing asserts that a stale entry is dropped, and specifically that it is
dropped *before* the race is decided. An edit moving the staleness check below `operationsConflict`
would let an abandoned write win a contest and block a live one for the rest of its life, with
every existing test still green.

**2. `continue`, not `break`.** Nothing asserts that a write which beats one held entry is still
blocked by a second, independently conflicting held entry. Replacing the `continue` with a `break`
keeps every existing test green while admitting a write over a live reservation.

**3. Self-skip.** The `existingHash === record.messageHash` guard appears to be unreachable through
the public surface: a record only enters `activeTransactions` after the phase loop has recorded this
member's own vote, and `getTransactionPhase` only calls `findConflict` when
`!record.promises[ourId]`. Treat this as defensive code, not as a test target — but confirm the
reachability claim during implementation rather than taking it on faith, and if a path *is* found,
that path is the test.

## The obstacle, and the recommended way through

`findConflict` is private and the 2000 ms window is read against `Date.now()`. Gap 2 needs neither
— it is reachable today through `update()` alone. Gap 1 needs one of: a real >2 s sleep (this repo
already carries a standing complaint about wall-clock sleeps in tests), a cast into the private
method (deliberately removed from `cluster-repo.spec.ts` when the race rule was extracted —
re-introducing one is a step backwards), or injectable time.

**Recommendation: injectable time.** The repo already has the pattern —
`cohort-topic/topic-router.ts` and `cohort-topic/host.ts` both take
`readonly now?: () => number` defaulting to `Date.now`, for exactly this reason. Mirror it:

- add `now?: () => number` to `ClusterMemberComponents` and thread it as the last positional
  constructor argument (the `clusterMember()` factory hides the positional ugliness of the existing
  16-argument constructor from every caller);
- store it as `private readonly now: () => number = Date.now` and read it in `findConflict`;
- promote the hardcoded `2000` to a named exported module constant so a test can cross the window
  by that constant rather than by a copied literal.

Scope note: convert only the `Date.now()` reads this ticket's tests need. `cluster-repo.ts` has a
dozen other `Date.now()` sites (TTL pruning, expiration sweeps, `executedAt` stamps); sweeping them
all is a separate, larger change and is **not** in scope here.

## Ordering, for gap 2's test

`activeTransactions` is a `Map`, so iteration follows insertion order. A test for the `continue`
must therefore seed the loser first: hold A (blocks `{b1}`), then hold C (blocks `{b2}`), then
deliver D touching both, arranged so D beats A but loses to C. Expect D to come back with a
`conflict` vote naming C. Under a `break` the scan would clear A and return `undefined`, and D
would come back `approve` — the two outcomes are cleanly distinguishable. `resolveRace` orders by
approval count first, so giving C a co-signed approval and A none is the simplest way to fix the
two outcomes deterministically without depending on the hash tiebreak.

## What "done" looks like

- `ClusterMember` takes an injectable clock, defaulted to `Date.now`, with the staleness window a
  named constant.
- A test showing a held entry past the staleness window is cleared and does **not** block the
  incoming write, *even though it would have won the race on its own merits* (give it the higher
  approval count) — that framing is what pins the expiry-before-race ordering.
- A test showing an incoming write clears one loser and is still blocked by a second live
  conflicting entry, naming the second by identity.
- Both live alongside the existing cases in `describe('conflict detection')` in
  `test/cluster-repo.spec.ts`; no cast into a private method, and no multi-second sleep.
- `packages/db-p2p` build + test suite green.
