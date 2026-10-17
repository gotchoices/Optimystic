description: Three retries re-send an unanswered request at once: the coordinator retry, the read retry round, and the read-repair consult after a silent one. On a slow link the request they replace is usually still in the same send queue, so each re-send lengthens the queue that made its predecessor late. Measured as 28–48% of a phone workload's excess traffic. Wait before each, starting at one declared link round trip and doubling, within the existing budgets.
files: packages/db-core/src/utility/batch-coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/transactions.md
----

# Retries back off from one link round trip

From Sereus `../sereus/tickets/blocked/optimystic-retries-do-not-back-off.md` (gotchoices/sereus#48). Read that report for the measurement method and the rejected alternatives.

## What happens

- **Coordinator retry** (`processBatches` in `packages/db-core/src/utility/batch-coordinator.ts`): a failed batch is retried at once against the next coordinator, until the transaction budget runs out or no coordinator is left. On a two-member cohort the chain is the other member, then self, and the self-coordinated retry sends the same cluster transaction to the same slow member, whose earlier request is likely still queued.
- **Read retry round** (`NetworkTransactor.get`, `get:retry`): one extra round, at once, against coordinators not yet asked.
- **Read-repair consult after a silent one** (`CoordinatorRepo`): a consult that finds a cohort peer silent deliberately leaves the read-repair window unarmed, because a recovered peer could answer. The next read of that block therefore consults again as soon as the previous consult ends: once per per-peer deadline (7 s) plus the read interval.

The request being replaced was given up on at a deadline, not lost, so its replacement queues behind it.

## Measured (Sereus, 2026-10-17, Optimystic 1.15.0)

Two-member strand on a phone-shaped link (20 ms per outbound frame, serial; event loop 70% busy). Over 188.6 s: 12 coordinator retries; 53 consults, all of which found the other member silent at 7 s, 31 of them re-asks; then 224 re-asks in the following 180 s, one block about every 8.2 s. Together these were 28% of the traffic beyond the clean workload, or 48% with FRET and libp2p pings excluded.

## Expected

- **Coordinator retry and read retry round:** wait before each retry, starting at one declared link round trip (`NodeOptions.linkRoundTripMs`, already resolved in `packages/db-p2p/src/rpc-deadline.ts`) and doubling per further retry of the same operation, within the transaction budget. db-core takes the base wait by injection; it cannot import db-p2p. When the retry must reach a peer whose previous request just timed out (on a two-member cohort the self-coordinated retry always does), wait at least as long as that request was outstanding.
- **Read-repair consult after a silent one:** hold the next consult of that block for a wait starting at one round trip, doubling per consecutive silent consult, capped (the reconcile pass bound `reconcilePassTimeoutMs` is the suggested cap), and reset when that peer answers any request. Reads served meanwhile keep the doubt they carry today (`unconfirmedAheadRev`); the wait spaces consults and changes nothing a read reports. This keeps the reason the window stays unarmed after a silent consult.
- An initial wait of zero reproduces today's behaviour; tests can pin it.
- Docs: the retry and read-repair-window descriptions in `docs/transactions.md` and `docs/internals.md`, and `packages/db-p2p/readme.md` where `linkRoundTripMs` is described. Add a line to `.release-notes.pending.md`.

Backoff alone does not fix that link: one round with no timeouts already occupies the phone socket for 9.5 s, past the 7 s read deadline (Sereus `blocked/decide-link-deadlines-from-measured-response-time`). This ticket only stops retries from adding to that queue.
