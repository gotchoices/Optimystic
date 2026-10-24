description: A write bigger than about one megabyte can never be saved once another machine shares the data, because the message carrying it between machines is capped at one megabyte. Raise that message's cap to the one the writer's own request already travels under, and have the writer refuse, before sending anything, a transaction too large for that cap, with an error that names the limit.
files: packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/protocol-client.ts (`processMessage`, `exchange`, `ProcessMessageOptions`), packages/db-p2p/src/cluster/client.ts (`ClusterClient.send`, `updateCarrying`, `encodedBytes`), packages/db-p2p/src/cluster/service.ts (the `lpDecode` in the stream handler), packages/db-p2p/src/repo/client.ts (`processRepoMessage`), packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferClient`), packages/db-p2p/src/dispute/client.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.pendMany`), packages/db-core/src/network/ (new `transaction-size.ts`, `index.ts`), packages/db-core/src/transactor/network-transactor.ts (`NetworkTransactor.pend`), packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/two-node-convergence.integration.spec.ts, docs/internals.md, packages/db-p2p/docs/cluster.md
difficulty: medium
----
# A transaction larger than the control frame can commit

GitHub [#35](https://github.com/gotchoices/Optimystic/issues/35). The issue has a standalone reproduction (`oversized-pend.test.mjs`: two real nodes, `clusterSize: 2`, a 600 KB diary append commits, a 1.1 MB one fails).

## The defect

A pend's whole payload travels twice:

1. **Writer → coordinator**, on the repo protocol: `RepoClient` sends `{ operations: [{ pend }] }`, and `RepoService` decodes it under `MAX_BLOCK_MESSAGE_BYTES` (8 MiB).
2. **Coordinator → each other cohort member**, on the cluster protocol: `ClusterClient.update` sends `{ operation: 'update', record }`, whose `record.message.operations[].pend.transforms` is the same payload. `ClusterService` decodes it under `MAX_CONTROL_MESSAGE_BYTES` (1 MiB), and `ClusterClient.send` reads the member's answer — the same record, echoed with its vote — under the same 1 MiB.

`protocol-limits.ts` classifies the cluster protocol as control-plane ("a peer set + signatures + small metadata, never bulk block data"). That is wrong: a pend record carries the transaction. So a transaction between 1 MiB and 8 MiB passes hop 1 and is refused at hop 2 by every remote member (`InvalidDataLengthError`, stream reset), and the coordinator reports `Failed to get super-majority`. A cohort of one never takes hop 2, which is why the same write succeeds alone and starts failing when a second machine joins. Nothing on any sender checks the size of what it sends; `updateCarrying` measures only to decide whether to drop its carried records.

## Decision

**The cluster protocol (and the dispute protocol, which carries a cluster record in its challenge) is classified as block-carrying and framed under `MAX_BLOCK_MESSAGE_BYTES`, both directions. One per-transaction limit, `MAX_TRANSACTION_BYTES`, is defined in db-core, checked by the writer before anything is sent, and the frame cap is derived from it.**

Why not the other directions the ticket offered:

- **Transforms by reference** (the record carries digests; members fetch the transforms over a block-sized protocol). Hop 1 already carries the full payload in one 8 MiB frame, so this removes no cliff — the transaction is still bounded by hop 1 — while adding a fetch round trip per member per pend, on a path tuned to three requests per write (docs/internals.md §One commit round when one coordinator covers every block), and complicating the in-process pre-vote, the deferred pend delivery carried on the commit, and the signed record. The signatures already bind the content through `messageHash`; keeping the payload inline keeps that unchanged.
- **Chunking or streaming the frame.** Lifting the per-transaction limit altogether means chunking every hop the payload takes (repo request, cluster request, the echoed answer, carried records), which is a feature of its own. Parked as backlog `feat-a-transaction-larger-than-one-frame-can-commit`.
- **Only raising the control cap.** The issue rightly rejects a bigger cap as the whole fix. What this ticket does is different in kind: it makes the two hops agree on one limit (they disagreed by 8×), makes that limit a named, documented writer-facing number, and checks it before sending, so a too-large write fails at once on the writer with the limit in the message instead of as a missing vote.

Exposure: `RepoService` already accepts an 8 MiB frame from any connected peer, so admitting 8 MiB on `ClusterService` adds no new class of attacker-controlled allocation.

## Numbers and where they live

In db-core, new file `packages/db-core/src/network/transaction-size.ts`, exported through `network/index.ts`:

- `MAX_TRANSACTION_BYTES = 7.5 MiB` (7 864 320). The most bytes one transaction's pend may encode to, measured as the UTF-8 length of `JSON.stringify` of the `PendRequest` (transforms, validation payload, everything). JSON is the measure because it is the encoding every hop uses (`ProtocolClient.processMessage`).
- `jsonEncodedBytes(value: unknown): number` — that measure. db-p2p's private `encodedBytes` in `cluster/client.ts` is replaced by it (one implementation).
- `TransactionTooLargeError extends Error` — `name = 'TransactionTooLargeError'`, readonly `actionId`, `bytes`, `limit`; message names the limit, e.g. `transaction <actionId> encodes to 9123456 bytes, over the per-transaction limit MAX_TRANSACTION_BYTES (7864320 bytes); split it into smaller transactions`. Not a `StaleFailure`; nothing retries it.
- `assertTransactionFits(requests: readonly PendRequest[]): void` — throws `TransactionTooLargeError` when the summed `jsonEncodedBytes` of the requests exceeds `MAX_TRANSACTION_BYTES`. One rule, used by both enforcement sites below.

In db-p2p, `protocol-limits.ts`:

- `TRANSACTION_ENVELOPE_RESERVE_BYTES = 512 KiB` — what a frame carries beyond the pend itself: the repo message envelope, the cluster record's peer map (addresses capped at 8 per peer), promise and commit signatures, apply outcomes, and a commit record carried alongside a deferred pend record (`deferPendDelivery`).
- `MAX_BLOCK_MESSAGE_BYTES = MAX_TRANSACTION_BYTES + TRANSACTION_ENVELOPE_RESERVE_BYTES` — still exactly 8 MiB, now derived (the existing NOTE there asked for exactly this derivation). Rewrite the comment: the cluster and dispute protocols are block-carrying; list which protocol decodes under which cap.
- `MAX_CONTROL_MESSAGE_BYTES` stays 1 MiB for what really is control-plane: sync requests (server decode), dispute *responses*, cohort-topic etc. Rewrite its comment so it no longer names cluster records.

## Enforcement sites

1. **Writer, before anything is sent — `NetworkTransactor.pend`.** First statement, ahead of `owedCancels.beforePend` and coordinator consolidation: `assertTransactionFits([blockAction])`. The check is on the whole transaction, not per coordinator batch: a batch is a subset, so a whole that fits means every batch fits, and writers get a number they can plan against (in a group no wider than its cohort one coordinator covers every block anyway). Nothing was sent, so nothing needs cancelling. The error propagates unchanged out of `Collection.sync` / `TransactionCoordinator.commit` (it is not a `StaleFailure`, so no retry loop absorbs it) — confirm by reading `Collection.syncAttempts` and the coordinator's pend phase; no code change expected there.
2. **Coordinator, on an inbound pend — `CoordinatorRepo.pendMany`** (which `pend` delegates to), before `verifyResponsibility`: `assertTransactionFits(requests)`. This covers a writer that bypassed `NetworkTransactor` (a custom `ITransactor`, a direct `RepoClient` user) and the future multi-collection writer (`pendMany` sums every collection's request — the record carries all of them). For a local caller the error arrives named; for a remote one `RepoService` aborts the stream as it does for any throw, and the coordinator's error log names the cause. Applies to the solo-cohort path too, deliberately: the limit must be the same at every group size, so a write that succeeds on one machine never starts failing when a second joins — the exact trap in the issue.
3. **Every frame sender — `ProtocolClient.processMessage`.** Add `maxRequestBytes?: number` to `ProcessMessageOptions`. `processMessage` encodes the message once, before opening a stream; when the encoded length exceeds `maxRequestBytes` it throws a new `MessageTooLargeError` (`protocol-client.ts`, `code = 'MESSAGE_TOO_LARGE'`, fields `protocol`, `bytes`, `limit`, message naming the peer, protocol and limit) and never dials. `exchange` and the prepared-stream re-send take the already-encoded bytes. Every subclass passes the cap its server decodes requests under: `RepoClient`, `ClusterClient`, `BlockTransferClient`, `DisputeClient` (challenge) → `MAX_BLOCK_MESSAGE_BYTES`; `SyncClient` → `MAX_CONTROL_MESSAGE_BYTES`. This is the backstop: with sites 1–2 in place it should never fire for a pend, but any future oversized request becomes a named local error rather than a remote reset that reads as silence.

And the cap changes themselves:

- `ClusterService` decodes under `MAX_BLOCK_MESSAGE_BYTES`; `ClusterClient.send` reads answers under `MAX_BLOCK_MESSAGE_BYTES` and passes `maxRequestBytes: MAX_BLOCK_MESSAGE_BYTES`; `updateCarrying`'s too-large fallback compares against `MAX_BLOCK_MESSAGE_BYTES` (using `jsonEncodedBytes`).
- `DisputeService` decodes under `MAX_BLOCK_MESSAGE_BYTES` (a challenge carries `originalRecord`, transforms included); the dispute client's response cap stays control.

## Edge cases & interactions

- **Carried pend on the commit** (two-member cohorts, `deferPendDelivery` → `takeOwedRecords` → `updateCarrying`). A pend record near the limit plus the commit record must still fit one frame; the 512 KiB reserve covers a commit record (block ids, tail, per-block digests, signatures) for any realistic block count. If it ever does not, the existing fallback sends the commit alone and reports the pend not delivered — the member then commits without the pend and reconciles, which is correct but slower. Verify by inspection that the fallback compares against the same cap the request is then sent under (site 3 would otherwise throw on the carried request instead of falling back).
- **The echoed answer.** A member answers with the record plus its vote and apply outcomes; the client must read that under the block cap, not control — this was the second half of the defect. Covered by the integration spec below.
- **Pend round vs commit round.** Only pend records carry transforms; commit records (`CommitRequest`: block ids, digests) stay small. No per-round special-casing.
- **Re-send on a dead prepared stream** reuses the encoded bytes; the size check runs once, before the first stream is opened.
- **Retry loops.** `TransactionTooLargeError` thrown in `NetworkTransactor.pend` happens before `processBatches`, so it is never re-batched onto other coordinators with backoff. A `MessageTooLargeError` from `RepoClient` inside `processBatches` *would* be retried; site 1 makes that unreachable for pends (the transaction limit sits below the frame cap by the reserve). Verify by inspection; no test.
- **Solo cohort.** Previously unlimited (no cluster hop); now refused above 7.5 MiB at sites 1–2. Intended, see site 2. Note it in the changelog-facing docs.
- **Mixed versions.** An old member decodes cluster frames at 1 MiB, so a 1–7.5 MiB transaction still fails against it until it upgrades — no worse than today. An old writer has no preflight; the new coordinator's site 2 refuses for it.
- **Per-block size is a different limit and is not addressed here.** A block grows by accumulation — a log block holds 32 entries and each entry carries its action's data — so a block can outgrow every frame cap (block-transfer push base64-inflates by 4/3; sync archives and remote `get` answers are one frame each) without any single transaction being large. Parked as backlog `bug-a-block-larger-than-a-frame-cannot-be-copied`; do not attempt it in this ticket.
- **The reporter's follow-on `TornActionError`** (seen in their harness after raising the cap locally, not isolated by them). If the integration spec below shows it, it is in scope to diagnose, since it would mean a large transaction still cannot commit; if the spec is green, mention in the review handoff that it did not reproduce here.

## Tests (two, both named by the ticket)

- **Two-node commit above the old cap** — add an `it` to `packages/db-p2p/test/two-node-convergence.integration.spec.ts` (gated on `OPTIMYSTIC_INTEGRATION=1`, real libp2p, `clusterSize: 2`): wait for a two-member cohort, then one `Diary` append of `{ pad: 'x'.repeat(1_100_000) }` through `transactorFor(nodeA)` commits, and the entry is readable from node B. This is the issue's reproduction, flipped. It fails today with `Failed to get super-majority`.
- **Oversized transaction fails locally with the named error** — in `packages/db-core/test/network-transactor.spec.ts`: a `NetworkTransactor` whose `getRepo` and key network record any call; `pend` of a request whose transforms encode above `MAX_TRANSACTION_BYTES` rejects with `TransactionTooLargeError` (`bytes > limit`, `limit === MAX_TRANSACTION_BYTES`, message contains `MAX_TRANSACTION_BYTES`) and no repo or coordinator lookup was called.

No test for the `ProtocolClient` guard, the `CoordinatorRepo` check, or the constant derivation — each is a single comparison against a named constant, verified by inspection.

## Docs

- `docs/internals.md` — new short subsection under *Commit Path (Distributed Consensus)*, "A transaction's size limit": the limit (`MAX_TRANSACTION_BYTES`, 7.5 MiB of JSON-encoded pend), that it is the same at every group size, what counts (for a SQL write the log entry repeats the row data beside the tree's own blocks, so the usable row volume is roughly half — the issue's 1.06 MB catalog batch was 584 KB of log beside 480 KB of tree), the error a writer gets (`TransactionTooLargeError`), and that a writer must split a larger batch. Cite `MAX_TRANSACTION_BYTES` in `packages/db-core/src/network/transaction-size.ts`.
- `packages/db-p2p/docs/cluster.md` — the *Size* bullet under carried records says "the 1 MiB control-message limit"; change to the block-message limit.
- Run `yarn lint:docs`.

## TODO

- Add `packages/db-core/src/network/transaction-size.ts` (`MAX_TRANSACTION_BYTES`, `jsonEncodedBytes`, `TransactionTooLargeError`, `assertTransactionFits`) and export it from `network/index.ts`.
- `NetworkTransactor.pend`: call `assertTransactionFits([blockAction])` first.
- `protocol-limits.ts`: add `TRANSACTION_ENVELOPE_RESERVE_BYTES`, derive `MAX_BLOCK_MESSAGE_BYTES`, rewrite both cap comments.
- `ProtocolClient`: `maxRequestBytes`, encode once before dialing, `MessageTooLargeError`; thread through `exchange` and the re-send.
- Pass `maxRequestBytes` from `RepoClient`, `ClusterClient`, `BlockTransferClient`, `DisputeClient`, `SyncClient`.
- `ClusterService` and `ClusterClient` (request, response, carried fallback) onto `MAX_BLOCK_MESSAGE_BYTES`; replace `encodedBytes` with `jsonEncodedBytes`.
- `DisputeService` decode onto `MAX_BLOCK_MESSAGE_BYTES`.
- `CoordinatorRepo.pendMany`: `assertTransactionFits(requests)` before `verifyResponsibility`.
- The two tests above; run `yarn build`, `yarn test` in db-core and db-p2p, and `OPTIMYSTIC_INTEGRATION=1` for the two-node spec (`yarn workspace @optimystic/db-p2p test:integration -- --grep "Two-node convergence"`).
- Docs as above; `yarn lint:docs`.
- Reply-ready note for issue #35 in the review handoff: the limit, the error name, and the backlog tickets for block size and chunking.
