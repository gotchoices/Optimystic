description: Finish wiring the pending-overlay read (`ActionContext.actionId`): give it a producer so a writer or validator can read through its own pending change and abandon a transaction that is certain to fail before commit, fix the self-contradictory-request throw in `StorageRepo.get`, and reconcile the docs.
prereq:
files: packages/db-core/src/collection/action.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, docs/internals.md, docs/transactions.md
difficulty: medium
----

# Finish wiring the pending-overlay read (a read can ask for a not-yet-finalised change, but nothing ever asks)

## The plain version

Writing a block happens in two steps. First the node stores the change as **pending**. Then, once the
group of nodes responsible for the block agrees, the change is **committed** and becomes a numbered
revision.

Between those two steps the change exists but is not official. A reader that wants to see it has to
say so explicitly, by naming the change in its read request. The request object has a field for
exactly that (`ActionContext.actionId` — "optional uncommitted pending action ID"), and two different
storage implementations know how to honour it:

- `StorageRepo.get` (the real one) — takes the named pending change and lays it over whatever
  committed content it has.
- `TestTransactor.get` (the in-memory test double) — same idea.

**No code in this repository ever sets that field.** Every place that builds a read context sets only
the revision number and the list of already-committed changes. I checked every construction site in
`packages/*/src`; the field is written only by test files. So both implementations' handling of it is
unreachable in a running system.

There is a matching acknowledgement already in the code: `TransactorSource.tryGet` carries a `TODO`
saying that when a read reports outstanding pending changes, it should record that — which is the
client half of the same missing feature.

## Why this is being raised now

The ticket `debt-pending-only-insert-unreadable-with-context` (see `tickets/complete/`) was written
against the premise that this is *how a writer reads back its own not-yet-finalised change*. It fixed
a genuine problem — the storage layer used to report such a block as **unreadable** instead of
serving it — and that fix stands on its own, because the same code path is also used by the
node-to-node repair logic, which does not name a pending change and is very much live.

But the user-facing story that motivated the fix ("the writer can now read its own change back")
cannot be true today, because no writer ever asks. That is not something the implementing agent got
wrong so much as something nobody had checked.

## The concrete defect hiding in the unreachable code

While confirming the above I ran a direct probe against `StorageRepo.get`. If a read request both
(a) claims a change is already committed and (b) names that same change as the pending overlay, the
two halves of that self-contradictory request are handled inconsistently:

- If the node **cannot** apply the change (no base to build on), it drops the pending record and
  returns a polite "I can't answer that" entry for the one block.
- If the node **can** apply it, it finalises the change, the pending record moves — and then the read
  **throws** `Pending action <id> not found`. That throw is not caught per-block, so it fails the
  entire batch of blocks in the same request, taking healthy blocks down with it.

Verified by running it (a scratch test, not committed): pend an insert, then read with the change
named in both places → throws. Serving the now-committed content would be the obvious right answer.

This is not a regression from the recent work — it behaves the same way before that change — and it
is unreachable for the same reason as everything else here. It must be fixed as part of this work.

## Decision (maintainer, 2026-10-04)

"Finish wiring it. That can short-circuit an inevitable transaction failure." Direction A is chosen;
removal (B) and deferral are rejected.

Rationale: a read that lays a pending change over committed content lets the writer (or a validator
re-executing its statements) observe its own uncommitted effect as the storage side sees it. A
transaction whose outcome is already determined to fail — its pend conflicts, a guard or constraint
will refuse it, or what it reads through its own pending change contradicts what it assumed — can then
be detected and abandoned (cancelling its pending records) early, instead of spending the commit round
and failing there.

## What the plan stage must produce

1. **Producer sites.** Identify where `ActionContext.actionId` should be set. Candidates to evaluate:
   the `TransactorSource` a `Collection` reads through between a successful pend and its commit (the
   in-flight action is already held as `Collection.inFlightActionId`); `TransactionCoordinator` /
   `TransactionSession` between pend and commit across collections; and validator re-execution of a
   transaction's recorded statements at pend time. Also the client half of the `TODO` in
   `TransactorSource.tryGet` ("if the state reports that there is a pending action, record this").
2. **The failure short-circuited.** Name concretely which inevitable failures become detectable
   early (e.g. a pending overlay that materializes nothing / is refused, a rival pending holding the
   block, a guard re-check against the overlaid state) and what the early exit does — cancel and
   surface which error, without regressing the retry semantics in `Collection.syncAttempts` and the
   coordinator's stale-loss handling.
3. **Fix the throw** below: a request naming the same action as both committed and pending must serve
   the committed content per block, never fail the batch.
4. **Cache interaction.** Overlay reads must never be retained in `CacheSource` as committed content
   (see "Staged Edits Keep Their Base" and floors in `docs/internals.md`).
5. **Security.** The field arrives from remote peers unvalidated today; decide what a remote asker
   may overlay (only its own action?) before making the path live.
6. An end-to-end test through the real collection layer, and reconcile `docs/internals.md` /
   `docs/transactions.md` with what ships.

Split into `prereq:`-chained implement tickets as needed.
