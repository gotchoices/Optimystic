description: One source file holds the entire behaviour of a cluster node — nearly two thousand lines in a single class — so the part that decides which of two competing writes wins is buried among storage, signatures, membership and recovery code, and is hard to read, review, or test on its own.
prereq:
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts
difficulty: medium
tradeoffs: This is the most safety-critical file in the repo and the split buys readability rather than behaviour, so a maintainer may reasonably decide that any churn here — even a mechanical move — costs more risk than the clarity is worth, especially with two consensus tickets in flight against the same file.
----

# The race-resolution logic deserves its own module

`packages/db-p2p/src/cluster/cluster-repo.ts` is **2034 lines**
(`wc -l packages/db-p2p/src/cluster/cluster-repo.ts`, re-measured after
`member-must-answer-a-lost-conflict-race` landed), almost all of it one class,
`ClusterMember`. That one class covers: the two-phase protocol state machine, signature
signing and verification, membership admission, block storage application, consensus
certificates, invalidation, persistence and restart recovery, expiration timers — and
conflict/race resolution.

No behaviour is wrong. The cost is that the piece a reader most often needs to reason about in
isolation has nowhere to live on its own.

## The seam

Race resolution is already nearly self-contained and unusually heavily documented (the safety
argument for its ordering runs to about forty lines of comment, and mirrors
`docs/correctness.md` §Theorem 9). Its members:

- `findConflict` — scans the member's active transactions for one touching the same blocks and
  returns the winner's messageHash when the incoming record loses, sweeping stale entries while it
  is there
- `resolveRace` — the deterministic arbiter: approvals, then aged priority, then message hash
- `approvalCount`, `recordPriority` — the two counts `resolveRace` ranks on
- `operationsConflict`, `getAffectedBlockIds` — pure block-overlap tests

Of these only `findConflict` touches member state (`activeTransactions`, and it clears entries);
the rest are pure functions of one or two records. A module that owns the pure arbiter, with
`findConflict` staying on the member and calling into it, is a mechanical move.

## Why it is worth doing

- The comment block explaining *why* the ordering is what it is currently sits in the middle of
  an unrelated 1900-line file; in its own module it would be the module's purpose.
- Every recent ticket in this area (`occ-priority-first-breaks-promise-monotonicity`,
  `abandoned-pend-holds-the-block`, `feat-occ-priority-reservation`) changes exactly these
  functions and nothing else in the file.
- The existing tests for it already reach in via a private-method escape hatch
  (`raceOf().resolveRace(...)` in `cluster-repo.spec.ts`) because there is no public surface to
  test against. An extracted module would be directly testable.

## Not in scope

Splitting the rest of `ClusterMember`. The protocol state machine, storage application and
recovery paths share mutable member state and do not have a clean seam; carving them apart is a
much larger and riskier piece of work, and this ticket should not be read as a first step
toward it.

## Sequencing

`member-must-answer-a-lost-conflict-race` has landed — it renamed `hasConflict` to `findConflict`,
changed its return type, and added the conflict-vote phases around it. Nothing in this area is
in flight now.
