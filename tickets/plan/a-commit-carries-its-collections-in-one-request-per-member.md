description: A transaction over several collections (a table and its indexes or UNIQUE trees, or several tables) runs one pend and one commit per collection, each its own cluster request, and loses the two-member pend deferral, so a two-member write costs about 4 cluster requests per collection (24 for a five-index insert); carry a commit's collections that share a cohort in one request per member per phase.
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/db-core/src/transaction/coordinator.ts (`pendPhase`, `commitPhase`, the `sole = collectionTransforms.size === 1` rule), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitBatchLegacy`), packages/db-p2p/src/repo/coordinator-repo.ts (one cluster transaction per pend), packages/db-p2p/src/repo/cluster-coordinator.ts (pend deferral), packages/db-p2p/test/two-node-write-request-count.spec.ts, docs/transactions.md
----
# A commit carries its collections in one request per member

GitHub [#42](https://github.com/gotchoices/Optimystic/issues/42) (per-index measurements 4/8/12/…/24, a Taleus payment at 24 requests, a partial-index arm, and a scenario), with a comment adding sereus's multi-table membership writes. Related: #29, backlog `feat-cross-collection-atomic-commit`.

## What happens

- `pendPhase` and `commitPhase` fan out one `transactor.pend` / commit per collection with `Promise.allSettled`; each becomes its own cluster transaction.
- `soleReservation` is set only when `collectionTransforms.size === 1`, so the two-member pend deferral (which makes a one-collection write 3 requests) is off for any multi-collection transaction.
- `RepoMessage.operations` is already an array, and `commitBatchLegacy` already pends every tree before committing any, so the batch exists; it is not carried together on the wire.

## Measured

- #42: one-row insert, 0–5 indexes → 4, 8, 12, 16, 20, 24 `cluster` requests to the other member.
- sereus: a joiner's seat and peer binding (multi-table, UNIQUE trees) 27 + 18 `/cluster` streams (2026-09-17, 1.12); 20 `cluster` requests from the joiner in the settle window after a join (2026-10-19, `f22a8cb7`).

## Direction (to settle in planning)

#42's suggestion 1: when a commit's collections share a coordinator and cohort (always on a two-member cohort), send one pend carrying every collection's transforms and one commit carrying every collection's commit, per member per phase, and allow the deferral for the whole transaction. Its suggestions 2 (derive non-unique indexes locally) and 3 (honour a partial index's predicate on write) are separate tickets if taken; file 3 as a `bug-` if it is confirmed.

## TODO

- Plan the batched pend/commit and the deferral rule; decide how a late refusal of one collection's pend is reported when they travel together (the reason `sole` is false today).
- Re-pin `two-node-write-request-count.spec.ts`.
