description: An optional stronger mode where a transaction spanning several data collections truly commits everywhere or nowhere, for collections that cannot tolerate a partial landing (e.g. money moving between accounts). The current system reports partial landings instead of preventing them; this would prevent them.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (commit/PEND/COMMIT phases)
  - docs/crdt-sync.md (Stage 5 per-collection consistency profiles; "Reservation and Escrow")
  - docs/correctness.md (Theorem 3 — atomic-intent/eventual-visibility baseline)
  - docs/right-is-right.md (durable invalidation / compensating reversal, currently single-collection)
difficulty: hard
tradeoffs: The shipped atomic-intent model is the right default and reporting partial landings is adequate for most callers, while genuine cross-collection atomicity costs liveness and touches consensus semantics — a maintainer may prefer callers reconcile rather than pay that.
----

## Why this exists

The near-term decision (ticket `1.5-multi-collection-atomicity-honest-downgrade`) makes multi-collection commit **atomic-intent / eventual-visibility**: the transaction records intent atomically, each collection becomes visible independently, and a partial landing is *reported* (`committedCollections` / `failedCollections`) for the caller to reconcile. That is the right default and ships now.

This backlog item is the **opt-in strong mode**: for collections where a partial landing is unacceptable (classic example — a transfer that debits one account collection and credits another; a half-landed transfer creates or destroys money), provide *genuine* all-or-nothing across collections.

## Why it is hard (and why it is parked, not queued)

The partial landing is caused by a **permanent stale loss**: a racing transaction advances one collection's log tail between that collection's PEND and COMMIT, so our commit for that collection can never win, while sibling collections already committed and there is no cross-collection undo. A durable coordinator decision record ("2PC journal") alone does **not** fix this — it addresses coordinator *crash* recovery, but cannot force a lost collection to commit nor un-commit a winner. Genuine atomicity needs one of:

- **Reservation-through-commit:** PEND durably *reserves* the log-tail slot and holds it through COMMIT so no racing transaction can steal it. This changes promise/consensus semantics and carries a liveness cost (a crashed coordinator holds reservations until expiration) — the CP/strong end of `crdt-sync.md` Stage 5.
- **Cross-collection compensating reversal:** on a partial landing, un-commit the already-committed collections via compensating entries. This means extending the single-collection `InvalidationEntry` reversal machinery (docs/right-is-right.md) to walk across collections — related to the invalidation-cascade follow-up.

Both presume an **agreed supercluster** and both are multi-subsystem changes well beyond one implement run. Neither should be attempted before membership agreement and cross-collection invalidation land.

(Gardening note: this ticket carried `prereq: design-cluster-membership-agreement`, a slug that exists nowhere on the board — the header was dropped. The membership-agreement work it meant has since landed as `1-bind-cluster-membership-into-signed-record` and `2-cluster-membership-admission-gate`, both complete. The remaining real gate is **cross-collection invalidation**, which is not yet ticketed anywhere; whoever promotes this must file that first or absorb it.)

## What a future planner should decide

- Which mechanism (reservation-through-commit vs. compensating reversal), or a hybrid per `crdt-sync.md` "Reservation and Escrow".
- How strong mode is selected — per-collection consistency profile (crdt-sync Stage 5) vs. per-transaction fence.
- Liveness/expiration semantics for held reservations, and interaction with the partition-safety counting argument (Theorem 2).
- Migration: strong-mode and atomic-intent collections must coexist in one network without a flag day.

## Evidence from Sereus

- **Sereus ticket `strand-half-committed-join-recovery`** (blocked there, a decision for its maintainer). A device joins a closed workspace by writing two rows in one SQL transaction, `Strand.Member` and `Strand.ConsumedInvite`, in two tables and so two collections; the schema admits the `Member` row only beside a same-transaction `ConsumedInvite` row, which is what makes an invitation single-use. When `ConsumedInvite` lands and `Member` does not, the invitation is spent and the device can never join with it; a manager has to admit it by hand. One of the three options Sereus is weighing is waiting for an all-or-nothing mode here, used for that one transaction. It is the concrete case of a rule that spans two collections and cannot tolerate a partial landing.
- **GitHub sereus#53** saw a table and its own unique index tear (`CoordinatorPartialCommitError`, the index committed and the table refused) on Optimystic 1.19.0, over a block two machines had forked; the fork itself is `6.52-feat-replay-mode-collections-merge-divergent-histories`. Since then a table and its indexes travel as one consensus record when one coordinator covers them ([docs/internals.md §One commit round when one coordinator covers every block](../../docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block)), which narrows but does not remove that shape.
