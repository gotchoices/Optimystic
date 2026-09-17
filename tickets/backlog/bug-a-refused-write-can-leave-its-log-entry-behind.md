description: A write that was refused, and correctly reported to its writer as not saved, can still leave a permanent record in the collection's history saying it happened. Nothing marks that record as abandoned or removes it, and if the application submits the same change again the history shows it twice.
files:
  - packages/db-core/src/transactor/network-transactor.ts (`commit` — stores the log tail first, then the other blocks; returns at a refused tail without storing the rest)
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `tornFromRefusal` — where the writer learns the write cannot be finished; `syncAttempts` — the budget-exhausted exit that is not followed by a refresh)
  - packages/db-core/src/collection/struct.ts (`TornActionError`, `SyncRetryExhaustedError`)
  - packages/db-core/src/log/log.ts, packages/db-core/src/log/struct.ts (`addActions`; the existing `invalidation` entry kind, which already means "an earlier entry's effect was reverted")
  - packages/db-core/src/transaction/coordinator.ts (`commit` — same exits on the multi-collection path)
difficulty: hard
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: Tables and indexes are read from their stored blocks, never from the history, so no query returns a wrong row because of a leftover record; today the only things that read the history itself are diary collections (which cannot be half-saved) and a writer's conflict check, so a maintainer could reasonably leave this until something that consumes the history — change feeds, replay from a checkpoint, auditing — actually exists.
----

# Background

A write to a collection stores the collection's **log tail** (the block holding the history record "action X, at revision N, changed these blocks") before it stores the data blocks that record describes. A write can therefore be refused after its history record is already stored. The writer's retry notices its own record and tries to finish the write by re-sending it at the same revision (`Collection.completeOwnEntry`). When that works the write is whole. This ticket is about the cases where it does not.

# When a record is left behind

In each case the writer is correctly told the write was **not saved**. The problem is what stays in storage afterwards: a history record at revision N whose data blocks never took revision N, on any machine.

- **Another writer commits in between.** Every commit touches the log tail, and the tail must be committed first at the writer's own revision. So once *any* other write to the collection lands after the half-saved one — even a write to completely different rows — the re-send is refused for good (`TornActionError`, reason `rival-holds-revision`). On a busy collection that is the likely outcome of any half-saved write, because the retry waits out a backoff before it looks. Verified: `packages/db-core/test/own-entry-completes-the-action.spec.ts` ("refuses, by name, when a rival took a block…") and the coordinator equivalent end with the log reading `seed, local, rival` while `local`'s block was never stored.
- **Finishing keeps being refused until the retry budget runs out** (`TornActionError`, reason `completion-refused`). Verified by the "gives up as a TORN write" cases in the same specs.
- **The attempt that spends the last of the budget is the one that half-lands.** No refresh follows it, so nobody notices: the writer gets a plain `SyncRetryExhaustedError`. Same for a commit that throws (a transport fault) after the tail was stored. Inferred from the code, not run.

# Consequences

- The history contains an action that was never applied. Anything that treats the history as the record of what happened is wrong about that action. In the tree today that is only `Collection.selectLog` (used by diary collections, whose writes touch nothing but the log and so cannot be half-saved) and a writer's conflict filter (no collection type in this repository supplies one). So there is no known wrong result today — this is a trap for the first feature that reads the history of a tree.
- If the application reacts to the refusal by submitting the same staged actions again — the natural thing to do, and what `TornActionError`'s documentation says is the caller's call — they are recorded a second time at a later revision. The data then lands once; the history says twice.
- The refused writer's own view is unaffected (its revision does not advance past the unsaved write).

# Expected behaviour

A reader of a collection's history can tell a record whose write was abandoned from one whose write was saved, without having to check every block the record names. Whether that is done by the writer adding a follow-up record when it gives up (the log already has an `invalidation` record kind for "an earlier record's effect was reverted"), by readers checking, or by changing the commit order so the record cannot be stored ahead of its data, is the design question for whoever picks this up. A writer that gives up without ever learning its record was stored (the third case above) cannot add a follow-up, so a writer-side marker alone does not cover every case.

Resubmitting after a refusal should not produce a second history record for the same logical change that is indistinguishable from the first.

# Related

- `backlog/bug-a-retried-write-can-store-two-versions-of-one-log-revision` — a different defect at the same stage of the same protocol (two byte-different copies of one record); not a duplicate.
