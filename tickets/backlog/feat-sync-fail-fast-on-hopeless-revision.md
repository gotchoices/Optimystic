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
