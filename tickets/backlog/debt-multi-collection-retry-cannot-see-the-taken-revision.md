description: When a write spanning several collections keeps losing, the system retries it about ten times over roughly twenty seconds even in the case where every one of those retries is guaranteed to fail for the same reason. The single-collection write path already detects that case and stops in under a second; this one cannot, because the fact it would need is thrown away before it gets there.
files: packages/db-core/src/transaction/errors.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/collection/collection.ts
difficulty: medium
repro: static
tradeoffs: Multi-collection commits are a much less travelled path than single-collection sync, and the payoff is only a faster, better-named failure — the write still does not land — so a maintainer may reasonably rank this below work that makes writes succeed.
----

## What is wrong

A writer submits changes at a revision number. If someone else already committed that number, the
submission is refused, the writer re-reads to catch up, and tries again. Two loops in this codebase
do that:

- `Collection.sync` (one collection) — `packages/db-core/src/collection/collection.ts`
- `TransactionCoordinator.commit` (several collections at once) —
  `packages/db-core/src/transaction/coordinator.ts:265-313`

Both retry up to ten times with growing pauses, roughly twenty seconds in total.

That budget is worth spending only while the re-read can actually change the next attempt. When the
writer's idea of the current revision is *wrong* rather than merely *behind*, the re-read moves it
nowhere — a collection never lowers a revision it holds, and a read that finds the same or less
leaves it unchanged — so every attempt re-sends the identical, already-refused request, and the
caller waits the full budget for an answer that was settled on the first try.

`Collection.sync` now detects this and stops in a fraction of a second with an error naming the
disagreement (`SyncRevisionStalledError`). It can do that because responders report the revision
they already hold as a machine-readable field (`StaleFailure.staleAt`), which reaches that loop
intact.

**The multi-collection loop cannot do the same, and the reason is a single seam.** The number is
present when the pend is refused — `PendRejectedError` receives it (`coordinator.ts:33-45`,
constructed at `coordinator.ts:1302`) — but that class folds it into a human-readable message
string, and the error the retry loop actually catches, `CoordinatorStaleLossError`
(`packages/db-core/src/transaction/errors.ts:78-91`), carries only `failedCollections` and a
free-text `reason`. The revision is gone by the time the loop could use it. No amount of work
inside the loop recovers it; the fact has to survive the seam first.

## Why this is filed as one ticket at the type, not as a fix in the loop

The two loops already share their retry policy deliberately — same default attempt count, same
backoff shape, same "re-read between attempts" step, and `coordinator.ts:19` says so explicitly.
They should also share the answer to "can the next attempt possibly differ from the one that just
failed?". This codebase's established habit is to single-source exactly this kind of predicate
rather than restate it: `isConflictFailure`, `highestStaleAt` and `isOwnRevision` all live in
`packages/db-core/src/network/stale-failure.ts` with doc comments naming every caller.

So the work is: let the confirmed revision reach the multi-collection loop as data, and give both
loops one shared rule instead of two hand-written ones. Doing it as a patch inside
`TransactionCoordinator.commit` would leave the number still being reconstructed from prose, and a
third retry loop would repeat the whole exercise.

## Expected behaviour

- A multi-collection commit whose re-read demonstrably moves nothing, against a responder that has
  confirmed a revision at or above the one being requested, fails fast and says so — rather than
  spending its whole budget and reporting what looks like ordinary contention.
- Whatever "fails fast" costs is configurable, and can be set back to the old whole-budget
  behaviour, exactly as `SyncOptions.maxStalledAttempts` allows on the single-collection path.
- Forward progress of any size still resets the count. A writer that is *catching up* — its
  requested revision rising each round without yet clearing the confirmed one — is behind, not
  wedged, and must not be failed. (This distinction was a live bug in the single-collection rule
  and was corrected during its review; whoever picks this up should not re-derive it.)
- Ordinary contention across several collections is unaffected.

## Evidence level

Traced by reading the code, **not** reproduced: the seam that drops the revision is plain from the
two class definitions above, and the retry loop is plainly the same shape as the one that was
fixed. What would confirm the user-visible half is a multi-collection commit driven against a
responder that keeps confirming a revision the coordinator's re-read cannot reach, asserting the
number of commit attempts made — the shape of
`packages/db-core/test/collection.spec.ts` → `bounded sync retry` → `stalled revision view`.

## Explicitly not in scope

Making the wedged write *succeed*. That is reconciliation, tracked under
`backlog/more-design/6.5-partition-healing` (see its "sync now fails fast on a wedged revision view"
section) and `backlog/feat-refresh-can-demand-a-revision-floor`. This ticket only brings the
multi-collection path up to the single-collection path's standard of failing quickly and honestly.
