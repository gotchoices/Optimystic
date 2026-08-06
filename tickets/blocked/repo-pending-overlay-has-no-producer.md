description: A read request can carry "…and also show me this change I made but haven't finalised yet", and the storage layer knows how to answer it — but nothing in this codebase ever fills that part of the request in, so the feature does not work end to end. Someone needs to decide whether to finish wiring it up or to remove it.
prereq:
files: packages/db-core/src/collection/action.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, docs/internals.md, docs/transactions.md
difficulty: medium
----

# A read can ask for a not-yet-finalised change, but nothing ever asks

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
wrong so much as something nobody had checked; it needs a human decision rather than another round of
code.

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
is unreachable for the same reason as everything else here. It is listed because whichever way the
decision below goes, it is the thing that has to be fixed or deleted.

## The decision

Two coherent directions; they need a human to pick, because the code has already committed to the
feature in its documentation and structure while never actually shipping the caller:

**A — finish it.** Have the client populate the field when it wants to see its own outstanding
change, fix the throw described above, and add an end-to-end test that goes through the real
collection layer rather than calling the storage layer directly. This is the direction the existing
comments, docs, and the `TODO` all assume.

**B — remove it.** Delete the field, both implementations' handling of it, and the tests that pin
them, on the grounds that a client already holds its own uncommitted content in its local cache and
does not need to ask a remote node for it. This shrinks the wire surface and removes a branch a
remote peer can currently reach (the read request is forwarded as-is, unvalidated) but no local code
can.

Neither is obviously right, which is why this is here and not in `backlog/`. A maintainer might also
reasonably defer entirely: nothing is broken for users today precisely because the path is dormant,
and the cost of leaving it is a small amount of unreachable code plus documentation that overstates
what works.

Whichever is chosen, `docs/internals.md` and `docs/transactions.md` describe the pending-overlay read
as working machinery and should be reconciled with the outcome.
