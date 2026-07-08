description: A big transaction can still be starved by a steady stream of tiny fast ones — the small ones commit and vanish before the big one finishes reading, so they never actually collide where the fairness tiebreak could help. To truly guarantee the big one eventually gets through, the cluster would need to briefly hold off new conflicting transactions once an old one has waited long enough.
prereq: implement-occ-priority-aging
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (hasConflict / resolveRace / activeTransactions — admission point)
  - packages/db-core/src/transaction/transaction.ts (priority field from implement-occ-priority-aging)
  - docs/correctness.md (Theorem 9; Theorem 7 termination)
----

## Why this exists

`implement-occ-priority-aging` gives a repeatedly-losing transaction a rising priority that wins
head-to-head races. But that only helps when two conflicting transactions are pending **at the
same instant**. A large transaction spends real time reading many blocks before it can pend. A
steady stream of small transactions can each read → pend → commit → finish *inside that read
window*, so they never co-pend with the large one. The large transaction just keeps getting
stale-rejected at PEND, retries, re-reads (long), and gets stale-rejected again — priority never
gets a chance to act because there is no concurrent rival to out-rank. This is **sequential
starvation**, and it is the residual the priority-aging ticket explicitly leaves open.

## What a fix would need to do

Give the cluster a way to *reserve a commit window* for an aged, high-priority transaction: once
a transaction's priority crosses a threshold, the block cluster briefly **defers admitting fresh
conflicting pends** so the starved transaction gets one clear window to re-read and commit. That
turns "eventually wins a concurrent race" into "eventually gets an uncontended window" — a real
progress guarantee against sequential streams.

This is deferred because it is a distinct, consequential subsystem, not a tweak:

- **Cluster-side state.** The cluster must remember an outstanding high-priority reservation
  across the gap between the starved transaction's attempts (its `activeTransactions` map is
  currently short-lived and per-pending-record). Needs a lineage token linking a transaction's
  retries, or a per-block reservation slot.
- **Byzantine-verifiability of priority.** Priority in the aging ticket is self-asserted by the
  coordinator and only affects fairness (safe because it can't cause two commits). A *reservation*
  that makes honest peers actively reject others' transactions is a stronger lever — a Byzantine
  coordinator claiming a max-priority reservation on a hot block could deny service to everyone
  else. A fix must make the reservation cost the claimant something, or bind priority to provable
  age/work, or bound reservation scope so abuse degrades gracefully. This is the hard part and
  needs its own design pass.
- **Throughput cost bound.** Deferring fresh pends on a hot block trades throughput for fairness.
  The window length × conflict rate is a direct throughput tax on that block; it must be bounded
  (e.g. ≤ one round-trip, at most one active reservation per block, reservation expires with the
  transaction TTL) and measured.
- **Interaction with expiration/termination (Theorem 7).** A reservation must not outlive its
  transaction's expiration, must release on commit/abort/timeout, and must not create a new way to
  hold a block hostage past the TTL.
- **Interaction with partition safety (Theorem 2) and hot-log-tail sharding.** A reservation is
  another cluster-admission decision layered next to the membership admission gate and the future
  HLC/crdt-sync tail redesign; it must compose with both, not fight them.

## Use case / expected behavior

A workload with one long analytical/bulk transaction and a continuous firehose of small point
writes on overlapping keys. Today (even with priority aging) the bulk transaction can retry until
its deadline and give up (`SyncRetryExhaustedError`). Expected after this feature: the bulk
transaction is guaranteed to commit within a bounded number of attempts once it has aged, because
the cluster grants it an uncontended window — while the small-write throughput cost stays bounded
and a Byzantine claimant cannot weaponize reservations to deny service.

This is a design-first item — it needs a `plan/` pass to settle the Byzantine-verifiability and
throughput-bound questions before any implement ticket.
