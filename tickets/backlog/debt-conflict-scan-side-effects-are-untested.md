description: When two writes want the same data at the same time, a cluster node runs a small bookkeeping pass that both expires abandoned reservations and drops the loser of the contest. Nothing tests that pass directly, so a future edit could break either job and every test would still pass.
files: packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.findConflict — the untested method), packages/db-p2p/src/cluster/race-resolution.ts (resolveRace/operationsConflict — the pure parts, now directly tested), packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts
difficulty: medium
tradeoffs: The method is exercised indirectly by roughly 47 admission and mesh tests and its two pure helpers now have direct unit tests, so a maintainer could reasonably judge the remaining risk small — and the honest version of this test needs either controllable time or a multi-second wait, both of which cost more than a normal unit test.

# The reservation scan has no test of its own

## What the code does

When a cluster node is asked to vote on a write, it first checks whether it is already holding a
different write that wants one of the same data blocks. That check is one method on the cluster
member, `findConflict`. It walks a table of the writes the node is currently holding open, and on
the way through it does three separate things:

- **Expires abandoned entries.** Anything in the table older than two seconds is dropped, on the
  assumption that its coordinator went away. A dropped entry frees its blocks for the new write.
- **Decides the contest.** For an entry that is still live and overlaps the incoming write, it asks
  the deterministic rule (now in `race-resolution.ts`) which of the two wins.
- **Clears the loser and keeps going.** If the incoming write wins, the held entry is removed from
  the table and the scan continues, because the incoming write may overlap more than one held entry.
  If the held entry wins, the scan stops and reports which write is blocking.

The *ordering* of the first two matters: expiry runs before the contest, so an abandoned write never
gets to win a contest it should not be in. The *continue* in the third matters too: stopping early
there would let a write proceed while a second, still-live conflicting write is left holding its
blocks.

## The gap

None of that has a direct test. The two pure pieces the method leans on — the win/lose rule and the
overlap test — do now have their own unit tests (`test/race-resolution.spec.ts`), but they are pure
functions of their inputs and say nothing about the scan around them. The scan itself is only ever
reached indirectly, by driving a whole simulated cluster through the admission and mesh suites, and
those suites assert on the final vote, not on which entries the table gained or lost along the way.

So a future edit that moved the expiry check below the contest, or replaced the `continue` with a
`break`, would keep every existing test green while changing when a node votes to block a write.

## What "done" looks like

Direct coverage of the scan's observable effects on the held-write table, for at least these cases:

- an entry older than the expiry window is dropped and does **not** block the incoming write, even
  when it would have won the contest on its own merits;
- an incoming write that beats a held entry clears that entry **and** is still blocked by a second,
  independently conflicting held entry (the `continue`, not `break`, behaviour);
- a held entry that wins is reported as the blocker by identity — the caller turns that identity
  into the `conflictWith` field of its vote, so returning the wrong one is a silently wrong vote;
- a write does not conflict with itself when the same record arrives twice.

## Why this is not trivial to write today

`findConflict` is private, and the expiry threshold is a hardcoded two seconds read against
`Date.now()`. Testing it honestly therefore needs one of:

- driving the public vote path with a real multi-second wait — accurate but slow, and this repo
  already carries a note that its wall-clock sleeps are a problem;
- injectable time, so the expiry window can be crossed instantly; or
- making the scan reachable to a test without a cast into a private method.

Choosing among those is part of the work. Note that a cast into the private method is the pattern
that was deliberately removed from `cluster-repo.spec.ts` when the race rule was extracted, so
re-introducing one here would be a step backwards.
