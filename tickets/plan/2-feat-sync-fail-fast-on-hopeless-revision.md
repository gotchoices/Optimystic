----
description: A client whose idea of "the current version" is wrong keeps re-submitting the same doomed write ten times over about twenty seconds before giving up. Once the rejection tells it which version the server actually holds, the client should recognise a hopeless retry and either correct itself or stop immediately.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/collection.spec.ts
difficulty: medium
tradeoffs: It changes when every caller of sync gives up, including high-contention workloads that legitimately rely on the current retry budget, and telling a broken revision view apart from ordinary contention is the hard part — getting it wrong turns retryable contention into spurious failures.
----

# Stop retrying a write that will re-request the same taken revision

## Background

`Collection.sync` pushes a batch of pending actions to the transactor at a revision it computes as
"the last revision I know about, plus one". If the transactor rejects the write because someone else
already committed at that revision, sync waits (backing off exponentially), calls `update()` to
refresh its view, and tries again — up to ten times by default, roughly twenty-one seconds in total.

That loop is correct when the client is merely *behind*: refreshing its view advances its revision
and the next attempt asks for a new number. It is useless when the client's view is *wrong* rather
than stale — the refresh fails to move it, every attempt asks for the identical taken revision, and
the caller waits the full budget for a failure that was decided on attempt one. The resulting
`SyncRetryExhaustedError` reads like ordinary contention, which is misleading.

The prerequisite ticket adds a field to the rejection carrying the revision the responder actually
holds, which is what makes the two cases distinguishable. It deliberately only *reports* that
number; changing what sync does about it is this ticket.

## What we want

Sync should notice when a retry cannot possibly differ from the attempt that just failed — the
revision it is about to request is the one the responder already told it was taken — and act on that
instead of sleeping and re-asking.

Two candidate behaviours, to be decided during planning:

- **Correct and retry.** Advance the client's revision to the one the responder reported and retry
  immediately rather than hoping the refresh re-derives it. Fixes the common case in one round trip.
- **Stop early.** Fail immediately with an error that says the client's revision view is wrong,
  rather than burning the remaining budget.

These are not exclusive — correcting once and stopping if the corrected attempt loses the same way
is plausible. Whichever is chosen, the error raised on giving up should say the client's view of the
current revision disagreed with the server's, not just that retries ran out.

## Why it is filed separately

Reporting the number is additive and affects nobody who ignores it. Changing when sync gives up
changes behaviour for every caller of `sync` and `updateAndSync`, including high-contention
workloads that legitimately depend on the current retry budget. It deserves its own review.

## Things a planner will need to weigh

- A legitimate loser in a busy cluster also sees "the revision I want is taken" on every attempt.
  Distinguishing "I am contending and losing" from "my view is broken" is the crux — losing to a
  *different* rival each round is contention; failing against a revision the client cannot get past
  even after refreshing is a broken view.
- The rejection's revision field is optional and often absent (unconfirmed rejections, older peers).
  Any new behaviour must degrade to today's loop when it is missing.
- Retryability is already decided by a single existing rule; the new logic must not become a second,
  competing answer to "should this retry?".

## Status correction (backlog gardening, 2026-09-01)

The body says "the prerequisite ticket adds a field to the rejection carrying the revision the
responder actually holds". That field has landed and the `prereq:` header is (correctly) empty — this
ticket is buildable now, not gated:

- `StaleFailure.staleAt` (`{ blockId, rev }`) carries the last confirmed revision a responder reported.
- `Collection.sync` already threads it: `lastStaleAt` at `packages/db-core/src/collection/collection.ts:932`,
  updated at :986, cleared at :1017, and surfaced as `SyncRetryExhaustedError.staleAt`
  (`packages/db-core/src/collection/struct.ts:38-53`).

So the retry loop already *has* the number it needs on every attempt; what is missing is only the
decision about what to do with it. Note the doc comment on that field — it is absent whenever no
rejection carried a confirmed number, "which is normal" — which is exactly the degrade-to-today's-loop
case the body's third bullet calls for.

## Promotion note, 2026-09-05 — a downstream consumer is blocked on this exact case

Promoted out of `backlog/` during a tending pass, on urgency rather than on the ranking: a
`repro: verified` ticket in the sibling `sereus` checkout is blocked on this loop and names this
ticket's "wrong rather than stale" case, not its contention case.

**The downstream ticket** is `sereus/tickets/blocked/forked-control-collection-sync-livelocks`.
Its fingerprint, re-measured there on 2026-09-02 across five isolated rounds (1 failure in 10 test
cases, down from ~2 in 3 before an unrelated Sereus-side fix):

```
SyncRetryExhaustedError { collectionId: 'default/CadrePeer', attempts: 10 }
  thrown out of Collection.syncInternal under TransactionBridge.commitTransaction
```

Their description of the mechanism is this ticket's second paragraph almost word for word: a node
that committed while alone and its sibling hold two histories of one collection; on reconnect the
alone node's `update()` refresh does not move its revision, so all ten attempts re-request the
identical taken number and the caller waits the full ~21 s budget for a failure decided on attempt
one.

**This matters for which of the two candidate behaviours gets chosen, so weigh it explicitly.**

- **"Stop early" alone does not help them.** It converts a 21-second failure into a fast one. The
  write still fails, and their ticket is about writes that never succeed again, not about latency.
- **"Correct and retry"** — adopt the revision the responder reported in `StaleFailure.staleAt`
  instead of hoping the refresh re-derives it — is the arm that could actually let their write land,
  because their refresh is precisely the step that fails to move.

That is an argument for the correct-and-retry arm, **not** a conclusion. Two things a planner must
settle before treating it as one:

- On a genuinely **forked** lineage, adopting the responder's revision writes this node's action on
  top of a history it never saw. Whether that is reconciliation or silent divergence-by-adoption is
  the real question, and it is adjacent to — possibly the same as — what
  `backlog/more-design/6.5-partition-healing` owns under "Forked (conflict)". Read that before
  deciding. If the honest answer is that sync cannot make this write land without a healing policy
  that does not exist yet, say so in the implement ticket and scope this to the fast, well-named
  failure; do not stretch the design to reach the downstream symptom.
- Their fork is on a **control-network** collection whose divergence the upstream diagnostic
  `collection:lineage-divergence` already reports (`make-a-refresh-able-to-say-the-two-copies-disagree`,
  complete). A retry that corrects itself past a revision that instrument would flag as forked is
  worth at least logging, and possibly worth refusing.

Do not treat "unblock sereus" as this ticket's acceptance criterion — their scenario is not
runnable from this repo. The criterion stays the one the body states, plus: whatever is built must
be re-measurable downstream by re-running `control-delete-while-alone-convergence` in isolation
five times, which is what their ticket's unblock condition already asks for.
