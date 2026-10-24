description: A node limits how many background freshness checks it runs at once, counting one per block, so a single read naming more than 16 of its own blocks leaves the rest unchecked every time. Count the network requests those checks actually send instead, since checks started by one read already share one request per peer.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/coordinator-repo.ts (`MAX_HELD_BLOCK_CONSULTS`, `startHeldBlockConsult`, `heldBlockConsults`, `readRepairBlock`), packages/db-p2p/src/repo/consult-round.ts (`ConsultRound`), packages/db-p2p/src/protocol-limits.ts (`MAX_CONSULT_BATCH_BLOCKS`), packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/debugging.md
----
# The held-block consult cap counts requests, not blocks

Prerequisite of `the-reactivity-backstop-check-costs-nothing-while-idle` (GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48)), which batches every watched collection's tail read into one read per tick. That read names a header and a log tail per collection — 36 blocks for 18 tables — and the cap below would start a consult for only 16 of them.

## Today

When a read of a block this node holds finds the block's read-repair window expired (`readRepairWindowMs`, 10 s), `CoordinatorRepo.readRepairBlock` answers from the local copy and starts the cohort consult behind the read (`startHeldBlockConsult`). At most `MAX_HELD_BLOCK_CONSULTS` (16) such passes run at once, counted one per block. Past that the read is served, nothing starts, the block stays unstamped, and `cluster-tx:read-repair-deferred` is logged.

The cap's stated reason is streams: each consult used to open one sync-protocol stream per cohort peer, and the answering peer allows 32 inbound streams per connection. That premise no longer holds for passes started by one read: since `ConsultRound`, every pass a `CoordinatorRepo.get` starts joins that read's round, and the round sends ONE request per peer naming all of the round's blocks, chunked at `MAX_CONSULT_BATCH_BLOCKS` (32). So a read of 36 blocks costs two requests per peer whether 16 or 36 of its passes run.

The per-block count also starves deterministically. A read naming more than 16 window-expired blocks starts passes in `blockIds` order; the same trailing blocks are deferred on every such read, and since a deferred block stays unstamped, it is deferred again next time. Those blocks never get a consult from that read pattern, so a cohort member that missed a commit to them is never repaired by it.

## Design

The cap bounds **consult request slots**, not passes. A running background pass occupies a share of its round's slots: a round with `n` running background passes occupies `ceil(n / MAX_CONSULT_BATCH_BLOCKS)` slots, and a pass with no round (`openConsultRound` returns `undefined` when the batch callback is not wired) occupies one slot by itself. `startHeldBlockConsult` starts a pass when doing so keeps the total at or below the cap: joining a round whose running passes leave room in their last chunk is free; otherwise it needs a free slot. The per-block rule (at most one pass per block) is unchanged.

- Keep the bookkeeping beside `heldBlockConsults`: per round (or a sentinel for "no round"), the count of running background passes, decremented in the same `finally` that deletes the block's entry. Compute the slot total on demand; it is at most 16 entries' worth of arithmetic.
- Rename the constant to say what it bounds (e.g. `MAX_HELD_BLOCK_CONSULT_SLOTS`) and rewrite its doc comment: the resource is consult requests in flight to each peer, a round of up to 32 blocks is one request per peer, and the bound for unbatched reads (one block per read) is unchanged at 16.
- `cluster-tx:read-repair-deferred` keeps its fields and adds the slots in use, so an operator can tell the new count from the old.

Rejected: raising the per-block cap (still starves past the new number, and over-counts batched passes); queueing deferred blocks (a queued pass would run outside its read's round and cost one request per block, undoing the batching).

## Edge cases & interactions

- **A pass outlives its round's send.** After the answers come back a pass may still run acquisition (`restoreCorroborated`). It keeps its slot share until it ends — conservative, and what the per-block count did. By inspection.
- **Acquisition fetches.** A large round whose blocks are all behind could start many acquisitions at once. In the common case they reuse the archives the consult already returned (`ConsultedArchives`, `serveConsultAnswer` attaches content when the peer is ahead), so they open no stream. Leave a `NOTE:` tripwire at the constant: if acquisitions after a large round ever show stream-limit resets on the answering peer, bound acquisitions separately.
- **Unbatched reads keep today's bound.** Seventeen concurrent single-block reads still defer the seventeenth. Test.
- **The one-pass-per-block rule.** A read that finds the block's pass running starts nothing and joins no seat, as today. By inspection.
- **`awaitWindowConsults` / `'paranoid'` / floor-demanded consults** take the blocking path and never touch the cap. Unchanged; by inspection.
- **Join before first await.** `startHeldBlockConsult` is still called synchronously before `readRepairBlock`'s first await, so the round's count is final by the time `get` closes the round. Keep it that way; by inspection.

## Tests

In `packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts`:

- One read naming 36 held blocks whose windows have expired starts a consult for every one of them (no deferral), and the batch callback is called twice per cohort peer (36 blocks at 32 per request). Before the change: 16 started, 20 deferred.
- Seventeen single-block reads of different held blocks, each with its consult held open by a peer that has not answered yet: the seventeenth is deferred.

## TODO

- Track running background passes per round in `CoordinatorRepo`; replace the per-block cap check in `startHeldBlockConsult` with the slot rule; rename and re-document the constant (with the acquisition `NOTE:`).
- Add the slots-in-use field to `cluster-tx:read-repair-deferred`.
- Add the two tests above.
- Update docs/transactions.md ("What sets a held block's consult cadence") and docs/debugging.md (`cluster-tx:read-repair-deferred`) for the new count; run `yarn lint:docs`.
- `yarn workspace @optimystic/db-p2p build` then its tests.
