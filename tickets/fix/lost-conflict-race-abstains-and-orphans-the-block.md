description: When two machines write the same block at the same time, the losing write is not told it lost — the other machines simply say nothing, and the block then stays unwritable for a couple of seconds. Retrying inside that window fails the same silent way, so ordinary concurrent writes get lost.
prereq:
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts
difficulty: hard
repro: verified
----

# A member that loses a conflict race votes nothing, and the losing pend keeps the block locked

Filed from the consuming repo (`../sereus`), where it is the dominant failure of
`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
and is tracked there as `tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio.md`.
Sereus does not edit this repo, hence the hand-off.

## What the consumer sees

A control write on a healthy three-node party — nothing degraded, nothing
partitioned — fails with

```
Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)
```

**Zero** approvals and **zero** rejections: not one of the three members voted
either way, including the coordinator's own in-process member. The consumer's
bounded retry re-presents the same write twice more (250 ms then 1 s backoff) and
gets the identical `0/3` both times, so the write is lost and the caller sees the
failure. Concurrent writes from the *other* two machines fail in the same window,
against the same block.

## Mechanism (measured, not inferred)

Reproduced 2026-08-12 at optimystic HEAD `12f4fe4` by running that scenario's
healthy-trio case under `DEBUG='optimystic:db-p2p:cluster*'` — 1 red in 3 runs
(2 green, 1 boot-gate failure in an earlier batch). The failing run's log carries
the whole chain.

**Step 1 — genuine OCC contention creates a rejected pend.** Three writers
(the party owner's row insert, and two members' own periodic self-record refreshes)
pend the same block within milliseconds. One transaction is promised by one member
and rejected `stale-revision` by the other two, so its coordinator raises
`ValidatorRejectionError` at `cluster-coordinator.ts:359`. Log, one transaction:

```
00.267 cluster-member:action-promise          zEQ15E1Haf…
00.267 cluster-member:validation-stale-revision
00.276 cluster-member:validation-rejected
00.277 cluster-tx:rejected-by-validators      zEQ15E1Haf…
```

**Step 2 — nobody tells the members.** The coordinator throws to its caller and
sends no abort. All three members persisted a vote for that transaction, so all
three keep it in `activeTransactions` (`processUpdate`'s `shouldPersist` path,
`cluster-repo.ts:469-483`). It is now an **orphan**: no coordinator will ever
advance it, and the only thing that removes it is the 2 s staleness sweep inside
`hasConflict` (`staleThresholdMs = 2000`, `cluster-repo.ts:1525`). Measured
lifetime, all three members: `cluster-member:stale-cleanup … age: 2101 / 2102 / 2110`.

**Step 3 — the orphan silently blocks every later write to that block.**
`resolveRace` (`cluster-repo.ts:1627`) compares promise counts first, and the
orphan already holds ≥1 promise while a freshly-arrived transaction holds 0 — so
the orphan wins **every** race, at every member, for its full 2 s:

```
02.372 cluster-member:race-keep-existing   existing: zHo7aWuox…  incoming: zGXXu3vgM…
02.372 cluster-member:phase-promising-blocked                    zGXXu3vgM…
```

That second line is the defect's core. `hasConflict` returning `true` makes
`getTransactionPhase` skip `OurPromiseNeeded` (`cluster-repo.ts:780`) and fall
through to `TransactionPhase.Promising` (`:791`), whose `processUpdate` branch
does **nothing at all** (`:460-466`) and returns the record with the member's vote
absent. The member has made a decision — "I am refusing you in favour of another
transaction" — and reports it as silence. Note the comment on that branch,
"This state shouldn't normally be reached since `OurPromiseNeeded` is checked
first": it is reached on exactly this path, every time.

The coordinator counts votes at `cluster-coordinator.ts:337-339`, sees nothing,
and raises the shortfall (`:374`) with `0 approvals, 0 rejections` — a message no
caller can distinguish from "the cohort was unreachable".

**Step 4 — it sustains itself.** Each blocked attempt is itself a transaction that
some member promised before another blocked it, so each failed attempt leaves a
*fresh* orphan younger than the 2 s threshold. The measured run accumulated a
chain of six (`zHsHFGV1…`, `zEQ15E1…`, `z2eBH2a…`, `z3d1q9W…`, `zFWuEpr…`,
`zHo7aWu…`), each blocking the next; at 02.370 the two oldest finally aged out and
the newest immediately took over the block. The consumer's three retry attempts
spanned 00.936 → 02.385, entirely inside that window.

## Why it matters beyond the test

Nothing in the reproduction is staged contention: two of the three colliding
writes are the ordinary self-registration refresh each node runs on an address-change
event. Any deployment with more than one writer on a hot block hits this — and
what it loses is not throughput but **writes**, reported with an error that blames
the network.

## The two arms

Both are in `cluster-repo.ts` and neither alone is sufficient — arm 1 makes the
failure diagnosable and correctly retryable, arm 2 is what lets the retry succeed.

1. **A member that loses a race must answer.** Losing `resolveRace` is a decision,
   not an absence. The member should return a distinguishable outcome — a `reject`
   vote carrying a `conflict:lost-race`-style reason is the shape the record
   already supports, and `evaluatePromise`'s reasons are already free-form and
   wire-visible. Two things to settle when doing it: this rejection must NOT count
   toward `rejectionCount > maxAllowedRejections` as a permanent validator refusal
   (it is a retry-later, not a "no"), and the coordinator's error text must carry
   the distinction, since a consumer that classifies on `0 rejections` (as Sereus
   does) will otherwise stop retrying a class that *is* retryable. Coordinate the
   message shape with the consumer — see the sereus ticket.

2. **An abandoned pend must not hold the block for 2 s.** A coordinator that gives
   up (`rejected-by-validators` at `cluster-coordinator.ts:359`, `supermajority-failed`
   at `:374`) knows exactly which members it left holding state and sends them
   nothing. Either notify them, or make the staleness sweep account for a
   transaction whose coordinator has stopped touching it — 2 s of fixed opacity per
   abandoned pend is what turns one lost race into a self-sustaining pile-up.

## How to reproduce

From `../sereus/packages/integration-tests`:

```bash
DEBUG='optimystic:db-p2p:cluster*,sereus:cadre:control-db' \
  npx vitest run control-write-degraded-cohort-member \
  -t "commits with a healthy three-member cohort"
```

Roughly 1 run in 3 is red (the scenario's own boot gate is separately flaky, so
budget more). On a red run grep the output for `race-keep-existing`,
`phase-promising-blocked` and `stale-cleanup` — they appear in that order, and the
`supermajority-failed` with `approvals: 0, rejections: 0` follows immediately.

A cheaper, deterministic reproduction of arm 1 alone needs no network: drive one
`ClusterMember` with transaction X for some block, then with a conflicting
transaction Y for the same block, and observe that the record Y comes back with
carries **no signature from that member** in either map.

## Not claimed by an existing ticket

`backlog/feat-occ-priority-reservation` names `hasConflict`/`resolveRace` but is
about *sequential* starvation (a stream of small transactions that never co-pend
with a large one) and explicitly presumes a losing race is answered. Nothing open
touches the abstention or the orphan lifetime; there is no accepted-tradeoff
`NOTE:` at either site.

## TODO

- Reproduce arm 1 as a no-network `ClusterMember` unit test (two conflicting
  transactions, assert the loser's record carries no vote from the member) — this
  is the regression gate and should land before the behaviour change.
- Decide the losing-race outcome's wire shape, and how the coordinator's error
  distinguishes "conflict, retry" from "cohort silent". Check the consumer's
  classifier (`../sereus/packages/cadre-core/src/control-write-retry.ts`) before
  finalising the text.
- Make the losing-race rejection non-fatal at `cluster-coordinator.ts:344-362`
  (it must not trip the permanent `rejected-by-validators` branch).
- Close the orphan window: notify members when a coordinator abandons a
  transaction, or age an untouched transaction out on the coordinator's silence
  rather than on a fixed 2 s.
- Re-run the sereus scenario above (≥5 runs of the healthy case) and record the
  red rate; update `../sereus/tickets/.pre-existing-known.md` when it clears.
