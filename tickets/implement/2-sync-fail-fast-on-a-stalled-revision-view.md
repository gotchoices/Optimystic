description: A client whose idea of "the current version" is wrong keeps re-submitting the same doomed write ten times over about twenty seconds before giving up. Make it notice within about a third of a second that refreshing did not move it, and stop with an error that names the disagreement instead of one that reads like ordinary busy-server contention.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/test/collection.spec.ts, packages/db-core/src/testing/test-transactor.ts, docs/debugging.md
difficulty: medium
----

# Stop a sync that is provably re-requesting a revision someone already holds

## Background

`Collection.sync` pushes pending actions at a revision it computes as "the last revision I know
about, plus one" (`getNextRev()`, `collection.ts:804`). When a responder rejects the write because
that revision is taken, `syncAttempts` (`collection.ts:915-1041`) backs off, calls `updateInternal()`
to refresh its view, and tries again — up to `maxAttempts` (default 10, roughly 21 s of exponential
backoff).

That is right when the client is merely **behind**: the refresh adopts the winner's revision and the
next attempt asks for a higher number. It is useless when the client's view is **wrong** rather than
stale — the refresh fails to move it (`advanceContext` refuses to lower the held revision; an equal
or absent read leaves it unchanged), so every attempt re-requests the identical taken number and the
caller waits the full budget for a failure decided on attempt one.

`StaleFailure.staleAt` (`network/struct.ts:107`) already carries the confirmed revision a responder
holds, and `syncAttempts` already threads it (`lastStaleAt`, `collection.ts:932/986/1017`) into
`SyncRetryExhaustedError.staleAt`. Today it is **purely diagnostic**. This ticket makes the loop act
on it.

## The decision, and why

The plan ticket left two candidate behaviours open. **Chosen: stop early with a named error. Do not
adopt the responder's revision.** The reasoning, with the evidence:

- **Adopting the responder's number would be a blind write.** `staleAt` is a bare revision, not
  content. Bumping `actionContext.rev` to it and retrying would submit transforms staged against the
  base this client actually read, at a revision built on a history it never saw.
- **Nothing downstream would catch that.** The member-side content check is conditional:
  `ClusterMember`'s digest guard checks an `updates`-only block **only when the member's local base
  revision equals the declared `baseRev`** (`packages/db-p2p/src/cluster/cluster-repo.ts:1646-1739`).
  A client that jumped its revision declares the old `baseRev`, so every member holding the newer
  base **abstains** rather than rejecting. The overwrite would land silently. That is
  divergence-by-adoption, not reconciliation.
- **Reconciliation is owned elsewhere and does not exist yet.** The "Forked (conflict)" branch of
  partition healing is designed in `docs/transactions.md` and unimplemented; it is tracked in
  `tickets/backlog/more-design/6.5-partition-healing`, which also owns the parked decision about
  whether a divergence should drop the read cache. Do not pre-empt it here.

**Consequence, stated plainly for the handoff:** this makes the failure fast and well-named. It does
**not** make a wedged write land. The downstream consumer that motivated the promotion
(`sereus/tickets/blocked/forked-control-collection-sync-livelocks`) gets a ~21 s livelock converted
into a sub-second named error — which that ticket itself calls "a strictly better outcome" — but its
write still fails. Its real unblock is the refresh being able to read authoritative state, filed as
`backlog/feat-refresh-can-demand-a-revision-floor`. Say this in the review handoff; do not claim the
downstream scenario is fixed.

## The detection rule

After a stale failure, the loop backs off and refreshes. **Then**, at the top of the next iteration,
compare the revision the next attempt *would* request against the highest confirmed revision any
responder has reported. The attempt is stalled when all three hold:

- a confirmed `lastStaleAt` exists, and
- `this.getNextRev() <= lastStaleAt.rev`, and
- the failure just handled carried its own `staleAt` (so the responder confirmed the number again
  this round, rather than us re-using an older observation).

Why this is sound, not a heuristic:

- A producer sets `staleAt` **only** when it read `latest.rev >= request.rev` out of its own storage
  and the holder is not this same action (`storage-repo.ts:601-607` for pend, `:775-784` for commit;
  `coordinator-repo.ts:1956-1983`). So a confirmed `staleAt.rev` means that revision is durably
  occupied by someone else, and every revision at or below it is past.
- Revisions are a single per-collection counter, and every commit unconditionally touches the log
  tail block (`CommitRequest.tailId`, "unconditionally the first block committed"), so the number is
  binding for the whole collection regardless of which block reported it.
- Durable invalidation takes a **new** revision slot rather than releasing an old one, so a confirmed
  revision never becomes un-taken. The bound only ever rises.

**This is not a second answer to "should this retry?"** `isConflictFailure` remains the sole
retryability rule and is untouched. This rule answers a strictly different question — *can the next
attempt possibly differ from the one that just failed?* — and only ever stops a loop that
`isConflictFailure` had already decided to continue.

**Two strikes, not one.** A legitimate loser can transiently read a view that has not yet caught up
with the rival's commit, which looks identical for one round. Require two **consecutive** stalled
observations before giving up: one transient lagging read is absorbed, a wedged view is not. Reset
the counter to 0 whenever the refresh does move past `lastStaleAt.rev`, and on every successful
transact alongside `consecutiveFailures`.

Contention does **not** trip this: the rival's commit is what the refresh adopts, so `getNextRev()`
lands at `staleAt.rev + 1` and the counter never reaches one, let alone two.

## Interface changes

`packages/db-core/src/collection/struct.ts`:

```ts
export interface SyncOptions {
  // ...existing fields unchanged...
  /** Consecutive refreshes that fail to move this collection past a revision a responder has
   *  CONFIRMED is already committed, before sync gives up with {@link SyncRevisionStalledError}.
   *  Such a retry provably re-requests the same taken revision, so the wait buys nothing. Two
   *  absorbs one transiently-lagging read; set it to `maxAttempts` or higher to restore the
   *  pre-existing behaviour of burning the whole budget. Default 2. */
  maxStalledAttempts?: number;
}

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when refreshing
 *  repeatedly failed to move this collection past a revision a responder confirmed it already
 *  holds — the client's view of the current revision disagrees with the cluster's, and retrying
 *  would re-request the identical taken number.
 *
 *  Extends {@link SyncRetryExhaustedError} so existing callers that catch the base class keep
 *  working; catch this subclass to distinguish "my revision view is wrong" from "I lost a race
 *  too many times". */
export class SyncRevisionStalledError extends SyncRetryExhaustedError {
  constructor(
    collectionId: CollectionId,
    attempts: number,
    /** Required here, unlike on the base class — it is the evidence the stall is based on. */
    staleAt: { blockId: BlockId; rev: number },
    /** The revision the next attempt would have requested. */
    readonly requestedRev: number,
    /** The revision this client believes is current. `undefined` for a collection that has
     *  committed nothing. */
    readonly heldRev: number | undefined,
    lastReason?: string,
  ) { /* super(...); then overwrite message and name */ }
}
```

Message shape (the base class's "exhausted N retries" wording must **not** be reused — it is the
misleading text this ticket exists to replace):

```
sync for collection <id> stopped after <n> attempts: this client holds rev <held|none> and would
request rev <requested>, but block <blockId> is confirmed committed at rev <staleRev> and refreshing
did not close the gap[: <lastReason>]
```

## Also fold in (small, same site)

- **`lastStaleAt` accumulation becomes highest-wins.** Today it is last-wins
  (`lastStaleAt = staleFailure.staleAt ?? lastStaleAt`), which understates the binding constraint
  when a later responder reports a lower number. Replace with
  `highestStaleAt([lastStaleAt, staleFailure.staleAt])` — the codebase's single rule for exactly this
  choice (`network/stale-failure.ts:36`). This also changes `SyncRetryExhaustedError.staleAt` on the
  plain-exhaustion path; that is an improvement, not a regression, but note it in the handoff.
- **Reuse `getNextRev()`** for the `newRev` computation at `collection.ts:964`, which currently
  duplicates its expression inline. One source for "the revision this sync would ask for".
- **New debug line** on the existing `collection` namespace, emitted at every stalled observation
  (not only the trip), gated on `log.enabled` like its siblings:
  ```
  collection:sync-stalled id=%s tag=%s heldRev=%s requestedRev=%d staleBlock=%s staleRev=%d strike=%d of=%d
  ```
  Document it in `docs/debugging.md` next to `collection:context-short-of-tail` and
  `collection:context-not-lowered` (§ "Did the refresh itself fail to close the gap?", around
  lines 330-395) — it is the write path's report of the same failure those two report from the read
  path, and an operator seeing `collection:lineage-divergence` alongside it is looking at a fork.
  Extend the `collection` namespace row near line 21 if it enumerates individual line names.

## Explicitly out of scope

- `TransactionCoordinator`'s own retry loop and `PendRejectedError` (`transaction/coordinator.ts`) —
  it carries `staleAt` too, but it is a separate loop with separate callers. Do not change it.
- Dropping the read cache on divergence, and any form of fork reconciliation — owned by
  `backlog/more-design/6.5-partition-healing`.
- Anything in `packages/db-p2p` — the producers already emit `staleAt` correctly.

## Edge cases & interactions

- **No `staleAt` anywhere** (unconfirmed rejections, older peers): no stall is ever detected; the
  loop and the `SyncRetryExhaustedError` message must be byte-identical to today. There is already a
  test asserting the exact message string — it must stay green untouched.
- **`staleAt` on an earlier attempt but absent on the current one**: no strike is recorded (the
  responder told us nothing new this round) and the counter is not reset either; the budget is still
  bounded by `maxAttempts`. The existing test `keeps the last reported revision when a later failure
  reports none` covers the reporting half of this and must stay green.
- **The refresh finally advances past `lastStaleAt.rev`**: strike counter resets to 0; a later stall
  needs a fresh two strikes.
- **Forward progress mid-multi-batch sync**: a successful transact resets both `consecutiveFailures`
  and the strike counter. The existing test `should complete a healthy multi-batch sync under a tiny
  maxAttempts` must stay green.
- **Torn action** (`CommitLandsButReportsStale`): the commit landed durably but answered stale; the
  refresh consumes this sync's own log entry via `inFlightActionId`, `pending` drains, and
  `hasUnsyncedChanges()` ends the loop before any strike. `collection-own-action-replay.spec.ts` must
  stay green — it is the regression guard for this.
- **Abort during a stall**: the `signal?.aborted` check at the top of the loop must still win, so
  place the stall check *after* it. The existing abort test must stay green.
- **Deadline and stall both true**: the deadline check stays first (it is the documented
  progress-agnostic ceiling); the caller gets `SyncRetryExhaustedError`. Acceptable — note it in the
  option's doc comment.
- **`maxAttempts: 1`**: the attempt cap throws before any strike can accumulate. Unchanged.
- **`maxStalledAttempts >= maxAttempts`**: pre-existing behaviour, exactly. This is the documented
  escape hatch for a high-contention caller that wants the full budget.
- **`maxStalledAttempts: 1`**: trips on the first stalled refresh — fastest failure, most exposed to
  transient read lag. Allowed, documented, not the default.
- **Invented collection** (no header, no context, `heldRev` undefined, `getNextRev()` = 1): two
  clients inventing one id. Normally the loser's refresh adopts the winner and advances; if it
  cannot, the stall fires and is correct. `heldRev` must print as `none`, not `0` or `undefined`.
- **Two handles on one collection id**: the strike counter is per-sync-call, so handles cannot
  contaminate each other. The debug line carries `tag=` like its siblings so the two do not read as
  one self-contradicting handle.
- **`updateAndSync`** inherits the behaviour unchanged — it delegates to the same `syncInternal`.
- **Latch release**: the new throw exits through the same `finally` blocks in `sync()` /
  `syncInternal()`; assert a subsequent latched op does not hang, as the existing exhaustion test
  does.

## Tests

- Stall trips: a transactor that always returns `{ success: false, conflict: true, staleAt: { blockId:
  'hot-block', rev: 42 } }` with `maxAttempts: 10` rejects with `SyncRevisionStalledError` after
  **exactly 2** commit attempts (assert the attempt count, not just the error), and the error is
  still `instanceof SyncRetryExhaustedError`. Assert `requestedRev`, `heldRev`, `staleAt`, and that
  the message names the disagreement and does **not** say "exhausted".
- One stalled refresh does not trip: a transactor that fails the first commit with a `staleAt` and
  then delegates → sync succeeds, the action is in the log.
- Degrade: no `staleAt` on any failure → unchanged `SyncRetryExhaustedError` at `maxAttempts`, exact
  message (the existing test).
- `maxStalledAttempts` raised to `maxAttempts` restores the full budget under an always-`staleAt`
  transactor.
- Abort mid-stall still yields `AbortError`; deadline still yields `SyncRetryExhaustedError`.
- **Existing tests that encode the old behaviour and must be re-pointed:** in
  `packages/db-core/test/collection.spec.ts`, the `staleAt on exhaustion` block's first case
  (`surfaces the reported revision on the error and names it in the message`) uses an always-`staleAt`
  transactor with `maxAttempts: 3` and asserts `exhausted 3 retries`. Under this change it now stalls
  at 2. Re-point it: keep an equivalent that pins the plain-exhaustion message using a **no-`staleAt`**
  failure, and move the `staleAt`-carrying case to the new stall assertions. Do not weaken or skip it.
- Preferred (drop it if it perturbs other specs): teach `TestTransactor`'s own conflict answers to
  carry `staleAt` (`test-transactor.ts:223-248, 329`) so a natural two-handle contention test proves
  the rule does **not** fire on real contention — the loser's refresh adopts the winner and
  `getNextRev()` clears `staleAt.rev`. Leave `FlakyCommitTransactor` alone: its doc comment says the
  shared harness must keep never setting `staleAt`, and the degrade tests depend on that.

## TODO

- Add `maxStalledAttempts` to `SyncOptions` (default 2) with the doc comment above.
- Add `SyncRevisionStalledError` to `collection/struct.ts` as a subclass of
  `SyncRetryExhaustedError`, with `requestedRev` / `heldRev` and the replacement message. It exports
  automatically via `collection/index.ts`'s `export *`.
- In `syncAttempts`: accumulate `lastStaleAt` with `highestStaleAt`, track a consecutive-stall
  counter, evaluate the stall rule at the top of the loop after the abort and deadline checks, and
  throw `SyncRevisionStalledError` when the counter reaches `maxStalledAttempts`.
- Reset the stall counter on forward progress (successful transact) and whenever `getNextRev()`
  exceeds `lastStaleAt.rev`.
- Replace the inline `newRev` expression at `collection.ts:964` with `this.getNextRev()`.
- Emit `collection:sync-stalled` on each stalled observation, gated on `log.enabled`.
- Document the line in `docs/debugging.md` § "Did the refresh itself fail to close the gap?".
- Write the tests above; re-point the two existing cases named under Tests.
- Run `yarn workspace @optimystic/db-core test` and a build/type check across `db-core`, `db-p2p`,
  and `quereus-plugin-optimystic` (the error class is public surface).
- In the review handoff, state plainly: the failure is now fast and named; a wedged write still does
  not land, and `backlog/feat-refresh-can-demand-a-revision-floor` is what would change that.
