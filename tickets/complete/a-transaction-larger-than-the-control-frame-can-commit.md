description: A write bigger than about one megabyte used to fail as soon as a second machine shared the data, because the message carrying it between machines was capped at one megabyte. The cap is now the one the writer's own request travels under, and a transaction too large for it is refused on the writer, before anything is sent, with an error that names the limit.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/network/transaction-size.ts, packages/db-core/src/network/index.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/inbound-message-caps.spec.ts, packages/db-p2p/test/two-node-convergence.integration.spec.ts, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/cluster.md
----
# A transaction larger than the control frame can commit

GitHub [#35](https://github.com/gotchoices/Optimystic/issues/35).

## What was wrong

A pend's payload travels twice: writer → coordinator on the repo protocol (decoded under 8 MiB), then coordinator → each other cohort member inside the cluster record, which the member echoes back with its vote. The cluster protocol decoded and read under the 1 MiB control cap, so a 1–8 MiB transaction passed the first hop and every remote member reset the second: `Failed to get super-majority`. A cohort of one never takes the second hop, so it only failed once a second machine joined.

## What was built

- `MAX_TRANSACTION_BYTES` (7.5 MiB of JSON-encoded pend), `jsonEncodedBytes`, `TransactionTooLargeError` and `assertTransactionFits` in `packages/db-core/src/network/transaction-size.ts`, exported from db-core's root.
- `MAX_BLOCK_MESSAGE_BYTES` (`packages/db-p2p/src/protocol-limits.ts`) derived as that limit plus `TRANSACTION_ENVELOPE_RESERVE_BYTES` (512 KiB) — still exactly 8 MiB.
- Cluster protocol (service decode, client request and response) and the dispute challenge decode moved to the block cap; `ClusterClient.updateCarrying`'s carried-records fallback is judged against the same cap the request is sent under.
- Writer check first thing in `NetworkTransactor.pend`; coordinator check in `CoordinatorRepo.pendMany` at every cohort size; `ProtocolClient.processMessage` encodes once and refuses a request over `ProcessMessageOptions.maxRequestBytes` with `MessageTooLargeError` before dialing.
- `TransactionCoordinator`'s pend phase carries a `TransactionTooLargeError` whole (`tooLarge`, beside `expired`) so `commit()` throws it by name rather than as `Error('Transaction commit failed: …')`.
- Docs: `docs/internals.md` § *A transaction's size limit*, `packages/db-p2p/docs/cluster.md`, `docs/debugging.md`.

Tests: the two-node integration spec commits a 1.1 MB `Diary` append on a two-member cohort and reads it back from the other node (the implementer verified it fails with the issue's exact error when the cluster caps are put back to 1 MiB); a `NetworkTransactor` spec pins the refusal by name before any lookup; `inbound-message-caps.spec.ts` was updated for the new caps and gained a cluster-service case pinning the block cap at the lowest layer.

## Review findings

Read the implement diff (`ticket(implement): a-transaction-larger-than-the-control-frame-can-commit`) first, then the handoff.

**Checked, correct:**
- *Every hop the pend rides fits.* `pendRequestForBatch` gives each coordinator a subset of the pend (same validation payload, filtered transforms), and the retry merge in `processBatches` only re-combines subsets, so judging the whole pend in `NetworkTransactor.pend` bounds every share. The cluster record carries `message: RepoMessage` as an object (no JSON-in-JSON escaping), so the writer's measure and the frame's agree. Deferred pend records carried on the commit's first request fall back to the timer path when too large, by the same cap `send` enforces.
- *Error path to callers.* `TransactorSource.transact` calls `pend` outside its try, so `Collection.sync` surfaces `TransactionTooLargeError` unchanged, and `Tree`/`Diary` unstage through the catch in `actAndSync`. `TransactionCoordinator.pendCollection` lets the throw reach the `allSettled` in `pendPhase`, which now carries it to `commitOnceLatched`. `execute()` returns an error string for it, as it already does for an expiry — consistent, and no production caller commits multi-collection transactions through `execute` (existing `NOTE:` there).
- *Barrel cycles.* `transaction-size.ts` has type-only imports; `coordinator.ts` and `network-transactor.ts` import it directly, not through a barrel.
- *Remaining control-cap users.* The sync request decode (`SyncService`) and the request cap on `SyncClient` stay at 1 MiB and match each other; dispute vote and ack replies are read at 1 MiB and are small.
- *Doc accuracy.* The `docs/debugging.md` lines for `carried:too-large` and `request:too-large` match the code; the stated default of `ProcessMessageOptions.maxDataLength` matches `exchange`.

**Fixed inline (minor):**
- The `MAX_TRANSACTION_BYTES` and `assertTransactionFits` docstrings claimed the limit is measured "over every PendRequest the transaction sends", which is false for a multi-collection transaction (each collection is pended and judged separately). Reworded to say it bounds the pends that ride in one consensus record — one collection's pend, or a `pendMany` batch's sum — which is what the frames require. Same wording fix to the comment at the check in `NetworkTransactor.pend`. Binding per record rather than summing across collections is kept: summing would refuse transactions whose every frame fits.
- `docs/internals.md` § *Durable commit proof* still said a proof fits "the 1 MiB control-message bound"; proofs ride sync responses and block-transfer pushes, both 8 MiB frames. Corrected to match the implementer's fix in `commit-proof.ts`. The same stale "1 MiB control-message cap" in the `MAX_PROOF_SIGNERS` note in `packages/db-p2p/src/cluster/certified-claims.ts` is corrected too (it predates this ticket, but states the bound this ticket documents).

**Tripwires parked:**
- The envelope reserve is reasoned, not measured: `NOTE:` at `TRANSACTION_ENVELOPE_RESERVE_BYTES` in `packages/db-p2p/src/protocol-limits.ts` names the log line that would show it is too small and how to adjust it without moving the 8 MiB frame cap.
- Double encoding of the pend (writer and coordinator): already a `NOTE:` at `assertTransactionFits` from implement; left as is.

**Tests:** all three kept. The cluster-service "block cap, not control cap" unit case pays for itself: it reproduces #35 at its lowest layer in plain `yarn test`, where the integration spec is env-gated. None added — the review found no defect needing one.

**Not filed (by design or already tracked):** solo cohorts are now refused above 7.5 MiB (intended, documented); un-upgraded members still decode cluster frames at 1 MiB (a rollout concern — no `CHANGELOG.md` entry exists, so whoever cuts the release should mention both); a `MessageTooLargeError` from `RepoClient` being retried by `processBatches` is unreachable for pends (the writer check sits 512 KiB below the cap) and get and commit requests are small; a remote writer that bypasses `NetworkTransactor` sees a reset stream with the cause only in the coordinator's log (as planned). Transactions larger than one frame and blocks that outgrow a frame stay with backlog `feat-a-transaction-larger-than-one-frame-can-commit` and `bug-a-block-larger-than-a-frame-cannot-be-copied`.

**Runs:** root `yarn build` clean; `yarn typecheck` clean; `yarn lint:docs` clean; eslint on touched files clean; db-core `yarn test` 1905 passing; db-p2p `yarn test` 3527 passing / 74 pending; `two-node-convergence.integration.spec.ts` under `OPTIMYSTIC_INTEGRATION=1` 7 passing. Full `yarn test:integration` and the quereus plugin suite were not re-run in review (the review changed only comments and docs; the implementer ran the plugin suite green).

## Reply-ready note for issue #35

> Fixed. The cluster protocol now frames records under the same 8 MiB cap the writer's request uses, so a write up to the per-transaction limit commits whether the group has one machine or several. The limit is `MAX_TRANSACTION_BYTES` (7.5 MiB of JSON-encoded pend, exported from `@optimystic/db-core`), the same at every group size. A transaction above it is refused on the writer before anything is sent, with `TransactionTooLargeError` (carrying `bytes` and `limit`); split the batch into smaller transactions. For SQL writes the log entry repeats the row data beside the tree's blocks, so usable row volume is about half the limit. Two related limits are tracked separately: a single block that outgrows a frame by accumulation (backlog `bug-a-block-larger-than-a-frame-cannot-be-copied`) and transactions larger than one frame via chunking (backlog `feat-a-transaction-larger-than-one-frame-can-commit`). The follow-on `TornActionError` you saw after raising the cap locally did not reproduce on our two-node test with a 1.1 MB append.
