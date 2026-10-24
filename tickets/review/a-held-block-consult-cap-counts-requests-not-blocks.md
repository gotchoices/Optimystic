description: A node limits how many background freshness checks it runs at once. The limit used to count one per block, so a single read naming more than 16 of its own blocks left the rest unchecked every time; it now counts the network requests those checks send, which the checks started by one read share.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/held-block-consults.ts (new: `HeldBlockConsults`, `MAX_HELD_BLOCK_CONSULT_SLOTS`), packages/db-p2p/src/repo/coordinator-repo.ts (`startHeldBlockConsult`, `heldBlockConsults`, `settleHeldBlockConsults`), packages/db-p2p/src/repo/consult-round.ts (`ConsultRound`, read only), packages/db-p2p/src/protocol-limits.ts (`MAX_CONSULT_BATCH_BLOCKS`, read only), packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/debugging.md, .release-notes.pending.md
----
# The held-block consult cap counts requests, not blocks

Prerequisite of `the-reactivity-backstop-check-costs-nothing-while-idle` (GitHub #48), whose batched tail read names 36 blocks for 18 tables.

## What changed

When a read finds a held block's read-repair window expired, `CoordinatorRepo.startHeldBlockConsult` starts the cohort consult behind the read. The bound on how many such background passes run at once moved out of `CoordinatorRepo` into a small collaborator, `HeldBlockConsults` in `packages/db-p2p/src/repo/held-block-consults.ts`, which owns both the per-block map of running passes (one pass per block, unchanged) and the new slot accounting.

- **Slot rule.** `MAX_HELD_BLOCK_CONSULT_SLOTS` (16, renamed from `MAX_HELD_BLOCK_CONSULTS`) bounds consult *requests* per peer. A round (`ConsultRound`) with `n` running background passes occupies `ceil(n / MAX_CONSULT_BATCH_BLOCKS)` = `ceil(n / 32)` slots; a pass with no round (batch callback not wired) occupies one. A pass starts when the total stays at or below 16: joining a round whose last 32-block chunk has room is free, otherwise it needs a free slot. Counts are kept per round in a `Map<ConsultRound, number>` plus a plain counter for round-less passes, adjusted in the same `finally` that removes the block's entry; the total is computed on demand.
- **Start API.** `HeldBlockConsults.start(blockId, round, pass)` returns `started` / `running` / `deferred` (the last with `inFlight` and `slotsInUse`). `pass` is called synchronously and only when the pass starts, so `nextPassSeq()` and `round?.join()` still happen before `readRepairBlock`'s first await and only for a started pass — the invariant `get` relies on to close the round.
- **Log.** `cluster-tx:read-repair-deferred` keeps `blockId` and `inFlight` and adds `slotsInUse`.
- **Constant doc.** Rewritten around requests per peer; carries two `NOTE:`s: the existing "conservative, not measured — raise it" (now also says *not* to queue deferred blocks, the rejected alternative), and the new acquisition tripwire (acquisitions after a large round are not bounded by the slots; if they ever cause stream-limit resets on the answering peer, bound them separately).
- **Docs.** `docs/transactions.md` ("What sets a held block's consult cadence"), `docs/debugging.md` (`background` field bullet and the `cluster-tx:read-repair-deferred` section, including how to read a line without `slotsInUse`), and a release note under "Unreleased" in `.release-notes.pending.md`. `yarn lint:docs` passes.

## Tests added

In `packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts` (the spec's `buildRepo` gained an optional batch-callback argument; new helpers `makeStorageHoldingAll`, `selfOnly`, `answerHeld`, and a shared `noWrites` storage stub):

- *one read naming more held blocks than there are slots consults every one, in two requests per peer* — 36 unstamped held blocks in one read, cohort of self + 2 peers, batch callback wired: each remote peer receives two batch requests (32 and 4 blocks) covering all 36. Verified to fail under the old per-block count (a temporary mutation to one slot per pass gave a single 16-block request).
- *a seventeenth single-block read is deferred while sixteen consults are held open* — 17 single-block reads, the peer's batch answers held open: the first 16 are asked, the 17th logs `cluster-tx:read-repair-deferred` with `{ blockId, inFlight: 16, slotsInUse: 16 }`. Pins that unbatched reads keep the 16 bound (this one passed before the change too; it is the "unbatched reads keep today's bound" edge the plan asked for).

## Validation

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn test` in `packages/db-p2p` — 3535 passing, 74 pending (env-gated), 0 failing.
- eslint on the three changed TS files — clean.
- Not run: `quereus-plugin-optimystic` suite and integration suites; the change is confined to the db-p2p read-repair background path.

## Known gaps / things for the reviewer to weigh

- **Under-count while a round's passes end unevenly.** The share follows how many of a round's passes still run, not which request each rode in. Each pass ends when *its* answers (from every peer) arrive, so passes from a round's first 32-block request can end while its second request is still open, and the round then counts fewer slots than it has requests in flight. Stated in the class doc; judged a brief, bounded mis-count (at most the round's own chunk count). Over-count (a pass holding its share through acquisition) is the other direction, same as before.
- **Still starves past 512 blocks in one read.** 16 slots × 32 blocks lets one read start up to 512 background passes; a read naming more defers the tail in `blockIds` order, deterministically, as the old count did past 16. No current reader is near that; not documented as a tripwire — the reviewer may want a `NOTE:`.
- **Many more concurrent passes now possible.** Up to 512 background passes (vs 16) can run at once, each doing a cohort lookup and possibly an acquisition. The consult requests are bounded; local CPU/memory per pass and acquisition streams are not. The acquisition side is the `NOTE:` tripwire at the constant; nothing measured.
- **Blocking consults in the same round are not counted**, as before (floor-demanded, missing-block and `'paranoid'` consults never touched the cap). Their questions can share a round's chunks with background passes, so a round's real request count can exceed what its background passes are charged; this matches the plan, which counts background passes only.
- The round-less path (no batch callback, one slot per pass) has no dedicated test; it is one line of arithmetic shared with the batched path's single-pass case.
