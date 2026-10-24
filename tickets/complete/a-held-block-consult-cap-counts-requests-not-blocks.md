description: A node limits how many background freshness checks it runs at once. The limit used to count one per block, so a single read naming more than 16 of its own blocks left the rest unchecked every time; it now counts the network requests those checks send, which the checks started by one read share.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/held-block-consults.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/consult-round.ts, packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/debugging.md, .release-notes.pending.md
----
# The held-block consult cap counts requests, not blocks

Prerequisite of `the-reactivity-backstop-check-costs-nothing-while-idle` (GitHub #48), whose batched tail read names 36 blocks for 18 tables.

## What landed

`ticket(implement): a-held-block-consult-cap-counts-requests-not-blocks` moved the bound on background held-block consults out of `CoordinatorRepo` into `HeldBlockConsults` (`packages/db-p2p/src/repo/held-block-consults.ts`). `MAX_HELD_BLOCK_CONSULT_SLOTS` (16) bounds consult requests per peer: a `ConsultRound` with `n` running background passes occupies `ceil(n / 32)` slots (`MAX_CONSULT_BATCH_BLOCKS`), a pass with no round occupies one. A pass starts when the total stays within 16; joining a round whose last 32-block chunk has room is free. One pass per block, as before. `HeldBlockConsults.start` calls the pass synchronously and only when it starts, so `nextPassSeq()` and `round?.join()` still happen before the first await and only for a started pass. `cluster-tx:read-repair-deferred` adds `slotsInUse`. Docs (`docs/transactions.md`, `docs/debugging.md`) and a release note were updated.

Tests: a 36-block read against a two-peer cohort sends each peer two batch requests (32 + 4) covering all 36 (fails under the old per-block count); a 17th single-block read is deferred with `{ inFlight: 16, slotsInUse: 16 }` while 16 consults are held open (pins that unbatched reads keep the 16 bound).

## Review findings

**Checked.**
- The diff read before the handoff: `HeldBlockConsults.start` / `settled` / slot arithmetic, the call site in `startHeldBlockConsult`, `ConsultRound` (how it chunks per peer, how it treats self and older peers), and the two new specs.
- Ordering invariant: `nextPassSeq()` then `round?.join()` are evaluated inside the synchronous `pass` thunk, in the original order, before `count` and before any await; a deferred or already-running block never joins the round, so `get` can still close it. A synchronous throw from `join` (round already closed) leaves no count and no map entry, same as before.
- Slot arithmetic: the first pass of a round costs one slot, passes 2–32 cost nothing, the 33rd costs one; the count is global across peers and across rounds of different cohorts, which only over-counts per peer. The decrement shares the `finally` that removes the block's entry, so counts and the map cannot drift.
- Under-count while passes end unevenly (stated in the class doc): a pass ends only after its own questions are answered, so the gap is bounded by the round's own chunk count; accepted as the implementer described.
- Blocking consults in the same round are uncounted, as they were before; their questions can add a chunk the background passes are not charged for. Matches the plan; no change.
- Docs: `docs/transactions.md` and `docs/debugging.md` describe the new rule and cite symbols that exist; no other doc or open ticket references the old `MAX_HELD_BLOCK_CONSULTS`. The "At most 16 background checks" line further down `.release-notes.pending.md` is under the released v1.13.0 section, a historical record, left as is.
- Tests: both specs pay for themselves (the first reproduces the defect, the second pins the bound for the commonest read shape on the slot rule's one-pass branch). No test cut, none added: the round-less path is the same one-line arithmetic as the single-pass case.
- Validation: `yarn build` in `packages/db-p2p` clean; eslint on the three changed TS files clean; `yarn test` in `packages/db-p2p` 3535 passing, 74 pending (env-gated), 0 failing. Integration and plugin suites not run; the change is confined to the db-p2p background read-repair path.

**Found and fixed inline (minor).**
- Mixed-version stream count. A peer on a build before `SyncRequest.held` answers a chunk's first block only, and `ConsultRound.askEachSingly` then asks it every remaining block on its own request, all at once. The old per-block cap bounded that to 16 streams; with up to 512 passes from one read it no longer does. Mixed-version only, and the project is not holding backwards compatibility yet, so recorded as a `NOTE:` tripwire on `MAX_HELD_BLOCK_CONSULT_SLOTS` (remedy: bound the single-block requests a round sends such a peer at once) rather than a ticket.
- The 512-block ceiling the handoff left undocumented: a read naming more than 16 × 32 blocks defers its tail in the same order on every read. Recorded as a `NOTE:` tripwire at the same constant.

**Major findings.** None. No ticket filed.

**Tripwires recorded.** Both above, at `MAX_HELD_BLOCK_CONSULT_SLOTS` in `packages/db-p2p/src/repo/held-block-consults.ts`, beside the implementer's two (unmeasured bound; acquisitions after a large round not bounded by the slots).
