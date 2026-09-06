description: On a small deployment that never declared how many machines it runs, a machine now queries its partner about a record on every single read instead of at most once every ten seconds, and never stops, because the answer it gets back can never satisfy its own confirmation rule.
files: packages/db-p2p/src/repo/coordinator-repo.ts (the "nothing corroborated" early return in `fetchBlockFromCluster`, and `reportRepairDeadlock`, which already computes the "this can never succeed" verdict), packages/db-p2p/src/cluster/quorum-restore.ts (`corroboratorCapacity`, `CORROBORATION_FLOOR`), docs/transactions.md (Lazy read-repair window)
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The affected configuration is one the docs already call misconfigured — it cannot repair itself either, and the single setting that fixes repair also fixes this — so a maintainer may reasonably say "declare your cohort size" instead of adding a second damping rule to a path that already carries five hand-argued special cases.
----

# A check that can never succeed is repeated on every read

## Plain statement

Before serving a record it already holds, a machine may ask the other machines responsible for
that record whether any of them has something newer. To accept an answer it requires **two**
independent machines to agree — unless the group is genuinely too small to field two, in which
case the requirement drops to one. Which case applies is decided from the size the operator
*declared*, never from the number of machines currently visible (that is deliberate: an attacker
who can shrink a machine's view of the group must not be able to talk the requirement down).

The consequence for an undeclared deployment: the declared size defaults to the replication
factor (10), so the requirement stays at two, while a real group of two machines can field only
one other machine. The check can therefore **never** be satisfied, no matter how healthy the
network is or how long anyone waits. The code already recognises this — it logs
`cluster-fetch:repair-deadlock` with reason `cohort-too-small` and prints the setting that would
fix it — but it goes on to leave the record marked "not yet checked", so the next read runs the
identical, identically-hopeless check, forever.

Every other way this check can end marks the record checked and buys ten seconds of quiet: a
group of exactly this machine, a group that answered and agreed, a group that answered and was
behind. Only the provably-hopeless outcome repeats without limit — the one case where repeating
is guaranteed to teach nothing.

## What made it visible now

Until `a-reader-cannot-tell-its-view-stopped-advancing` landed, a machine's own successful write
marked the record checked, which accidentally covered up the loop for any record that machine
wrote. That cover-up was itself the bug that ticket fixed (a machine's own writes are not
evidence its copy is current), so it should not come back. What is left exposed is the older,
narrower defect above, which always affected records the machine only ever *read*.

## Measured

Driving `CoordinatorRepo` with stubs: local peer plus one remote, `findCluster` returning both,
no `clusterSize` or `assumedClusterSize` declared, `readRepairMode: 'lazy'` with the default
10 s window, local copy at revision 1, the remote answering revision 1. One commit, then three
reads at +1 s, +2 s, +3 s — all inside one window:

- **6 peer queries** (2 peers × 3 reads). Every read consulted.
- The same probe with `clusterSize: 2` declared: **0 peer queries** — the first check succeeds,
  marks the record checked, and the window suppresses the rest.

(Probe was a scratch spec against the helpers in
`packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts`; run, measured, deleted.)

Groups of three or more are not affected: two other machines can corroborate each other, the
check succeeds, and the window is armed normally.

## Expected behaviour

A check whose failure is **provably permanent for the group as currently seen** — the group
cannot field enough corroborators even if every one of its members answered and agreed — should
mark the record checked, exactly as the single-machine group already does, and for exactly the
same reason: re-asking sooner than one window cannot learn anything the next lookup would not.
Delaying discovery of a group that later grows by at most one window (10 s by default) is the
cost the single-machine case already accepts.

The distinction that must survive is between *permanent* and *transient*: a check that failed
because a machine was silent, or because the only holder was silent, may recover at any moment
and must keep re-asking. The verdict separating those is already computed — `reportRepairDeadlock`
distinguishes `cohort-too-small` (permanent) from `sole-holder` (a copy is missing, not a machine)
— but it is computed for a log line and thrown away rather than returned.

## Why this is worth doing as a rule, not a patch

Whether a machine re-asks its group is currently decided at five separate places in one file,
each arguing its own case in a prose comment, with no shared statement of the rule they are all
approximating: *mark the record checked exactly when re-asking sooner could not learn anything.*
Two of those places agree that a check which consulted nobody still counts (the single-machine
group), one insists the opposite for a routing failure (correctly — that one can recover), and
this one simply never considered the question. The durable fix is for the freshness decision to
own that rule in one place, which is what
`debt-freshness-state-scattered-across-coordinator-repo` proposes; this ticket is its tenth piece
of evidence and can be resolved either on its own or as part of that extraction.

## Related

- `debt-freshness-state-scattered-across-coordinator-repo` — the extraction that would retire the
  whole class; this instance is recorded there.
- `fix/a-consult-that-asked-nobody-erases-recorded-doubt` — a different defect at the same
  function, about a check that reached nobody wrongly *clearing remembered doubt*. Distinct
  statement, distinct root cause, but the two will likely be touched together.
