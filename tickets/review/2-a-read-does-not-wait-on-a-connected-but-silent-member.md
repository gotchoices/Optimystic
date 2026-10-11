description: When a node already holds a record, reading it now returns that copy right away and checks with the other members in the background, instead of making the read wait several seconds for a member that is connected but not answering, or for a dial that hangs on the first read after a restart (GitHub #25 and #34). This is the review pass over that change.
architecture: docs/transactions.md#lazy-read-repair-window
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `settleHeldBlockConsults`, `nextPassSeq`, `recordAheadClaim`, `AheadClaimState.writtenBy`, `MAX_HELD_BLOCK_CONSULTS`, `awaitWindowConsults`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`clusterPolicy.readRepairMode`, `clusterPolicy.readRepairWindowMs`, `resolveReadRepairWindowMs`, `MAX_READ_REPAIR_WINDOW_MS`)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairMode` / `readRepairWindowMs` doc comments)
  - packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts (new)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, coordinator-repo-unavailable.spec.ts, coordinator-repo-small-cohort-arming.spec.ts, coordinator-repo-solo-read-repair-window.spec.ts, coordinator-repo-commit-freshness.spec.ts (seam set where a spec asserts what a consult concluded)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-p2p/test/two-phones-over-relay.integration.spec.ts, packages/db-p2p/test/util/two-machine-lifecycle.ts (one-read-later convergence)
  - packages/db-p2p/test/repo-service-remote-get-consult.spec.ts (comment only)
  - docs/transactions.md, docs/internals.md, docs/debugging.md, packages/quereus-plugin-optimystic/README.md
difficulty: hard
----

# Review: a read of a block this node holds does not wait on the cohort consult

GitHub #25: https://github.com/gotchoices/Optimystic/issues/25 — GitHub #34: https://github.com/gotchoices/Optimystic/issues/34.

## What changed

**The read path.** In `readRepairBlock`, a held block whose consult only the lazy window asked for (`windowDemands`, mode `'lazy'`, no floor) is served from the local copy at once; `startHeldBlockConsult` runs the consult behind it. The pass (`runHeldBlockConsult`) is the blocking path's consult minus the floor and the absence verdict: `fetchBlockFromCluster`, then `recordAheadClaim`, then the `read-repair-applied` / `read-repair-noop` line from a fresh local read against the revision the triggering read served. The read is still stamped from the unsettled-claim memo as it stands (`flagUnconfirmedCurrency`), so only the consult's effort moved, not its honesty. Errors inside the pass are caught and logged `cluster-fetch:error { background: true }`; the pass promise never rejects. The blocking path's error line now carries `background: false`, and `cluster-tx:read-repair-triggered` carries `background`.

What still blocks, unchanged: a missing block, a held block whose read carries a floor above it (`floorDemandsConsult`), and every consult under `'paranoid'`. `'off'` never consults a held block.

**One per block, bounded.** `heldBlockConsults` (a `Map<BlockId, Promise<void>>`) dedups: a read that finds a pass in flight for its block is served and starts nothing. `MAX_HELD_BLOCK_CONSULTS` (16) caps passes in flight; past it the read is served, nothing starts, the block stays unstamped, and `cluster-tx:read-repair-deferred { blockId, inFlight }` is logged. The constant's doc explains the 16 against libp2p's defaults: the sync protocol is registered with no stream limits (`registerProtocolHandler` in `packages/db-p2p/src/network/register-protocol-handler.ts`), so 32 inbound streams per connection on the answering peer and 64 outbound here; 16 leaves the peer half its inbound allowance for other readers and for acquisition's archive fetches on the same protocol. A `NOTE:` at the constant says to raise or queue if `read-repair-deferred` shows steadily; a `NOTE:` at the map records the no-stop lifetime tripwire.

**The sequence gate.** Every pass takes a number from `nextPassSeq()` before its consult goes out. `AheadClaimState.writtenBy` records the highest sequence that wrote `rev`/`claimants`. `recordAheadClaim(blockId, currency, passSeq)` refuses to weaken (retire, or lower) a memo written by a later-started pass, logging `cluster-fetch:stale-pass-ignored { blockId, rev, passSeq, recordedBy }`; the gate sits ahead of the silent-claimants check. Raising is ungated; a write stores `max(prior, passSeq)`. Retirement clears `writtenBy` with `rev` and `claimants` (the "one fact" rule on that type), which means an older pass that lands an `unsettled-claim` after a newer pass retired the memo re-records it. That is the flagging direction, which the ticket calls safe, but a reviewer may want to confirm they agree.

**Settable on a node.** `clusterPolicy.readRepairMode` passes through untouched (closed union). `clusterPolicy.readRepairWindowMs` goes through `resolveReadRepairWindowMs`: absent stays `undefined` (the coordinator's 10 000 applies); not a finite number above zero, or above `MAX_READ_REPAIR_WINDOW_MS` (`2 ** 31 - 1`), throws at construction naming the field. The window is compared against a clock, never handed to a timer, so the ceiling exists to catch a unit mix-up rather than an overflow; the doc comment says so. Both reach `CoordinatorRepo` through the `consensusConfig` spread in `libp2p-node-base.ts`, which needed no change.

**Test seams.** `awaitWindowConsults` (public field, default false) makes a window-demanded consult take the blocking path. `settleHeldBlockConsults()` resolves once no held-block consult is in flight, looping in case a pass that ends unarmed lets a concurrent read start the next one.

## Tests

New spec, `packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts`:

- *serves a held block at once while a cohort peer never answers, and starts one consult for it* — two back-to-back reads of a held block against a peer whose callback never resolves, with `cohortQueryTimeoutMs: 500`, both complete in well under the budget with the local revision and no flags; after settling, that peer's callback was invoked once. Pins #25's shape and the one-per-block dedup.
- *a repair the consult lands is served by the next read, and arms the window* — cohort corroborates rev 2 and the storage double adopts the promotion; the first read serves rev 1, the read after `settleHeldBlockConsults()` serves rev 2 and consults nobody.
- *a claim the consult cannot settle flags the next read* — same cohort, storage that cannot adopt and no acquisition callback; the first read is unflagged, the next carries `unconfirmedAheadRev: 2`.
- *an older pass that ends late cannot retire a doubt a newer pass recorded* — pass A (background) is held open at peer X; a floored read runs pass B, which records X's claim of 3; releasing A with X answering "nothing ahead" logs `cluster-fetch:stale-pass-ignored` and the next read still carries 3. Pins the sequence gate, the one piece of new branching logic.

No tests were added for the config pass-through or the cap, per the ticket.

Existing specs, changed only where the seam or settle was needed, checked per spec:

- `coordinator-repo-read-repair.spec.ts`: the four lazy-mode tests and *a declined repair does not suppress the next attempt* set `awaitWindowConsults` (they count callback invocations after one read). *consults the cohort for every block of a multi-block read at once* awaits `settleHeldBlockConsults()` instead, so it pins that background passes also start together. The floor describe's trigger-payload expectation gained `background: false`, and its window-lapse step settles before counting. Everything under the paranoid describes (2-node, deadlock naming, asker statement) is untouched.
- `coordinator-repo-unavailable.spec.ts`: `buildRepo` takes `awaitWindowConsults?: true`; set only on the two lazy held-block tests under *the mark outlives the consult*. The missing-block and paranoid tests are untouched.
- `coordinator-repo-small-cohort-arming.spec.ts`, `coordinator-repo-solo-read-repair-window.spec.ts`, `coordinator-repo-commit-freshness.spec.ts`: seam set in the repo factories, since every lazy test there counts consults per window for a held block. The commit-freshness test that constructs inline asserts that no trigger fires, so it needs none.
- Other coordinator specs that run default lazy mode were inspected rather than changed (`coordinator-repo-solo-self-bypass`, `coordinator-repo-cohort-query-deadline`, `coordinator-repo-proximity`, `coordinator-repo-absence-write-bypass`, `repo-service-remote-get-consult`, `coordinator-repo-stale-classification`): their reads are of missing blocks, or assert only on served content, so none depends on a background pass having finished. The one comment in `repo-service-remote-get-consult.spec.ts` that said a present block "still consults" now says the consult runs behind the read.

**Integration specs changed for one-read-later convergence** (the ticket asked for these to be listed):

- `coordinator-repo-integration.spec.ts`, *a network read lands the confirmed newer revision, not the first coordinator's stale copy*: the stale coordinator's first read is now asserted unflagged (served from the held copy), then `settleHeldBlockConsults()` on that node's `CoordinatorRepo`, then the read that carries `unconfirmedAheadRev: 2`. The transactor half is unchanged and still lands rev 2. This uses the settle seam, not polling, because the mesh harness exposes the `CoordinatorRepo` directly and the wait is deterministic; the ticket's "never in integration specs" was about `awaitWindowConsults`, which stays out of all wiring.
- `two-phones-over-relay.integration.spec.ts`, phase 3 (*B after its restart*): failed under `yarn test:integration` before the fix (phase 4 then did not run). B returns knowing only the relay and reads back at once; its first read of each held block is answered from the pre-restart copy while the consult runs, so A's away-write arrived one read later. The direct-TCP sibling spec waits for the drain's push before reading and was unaffected. Added `expectReadableEventually` to `test/util/two-machine-lifecycle.ts` (bounded poll, 30 s default, hand-rolled so the assertion can name the rows still unread) and used it for that one read-back; `expectReadable` is unchanged in meaning and now shares the row comparison. All five relay phases pass after the change.

## Validation run

| Command | Result |
|---|---|
| `yarn build` | clean |
| `yarn workspace @optimystic/db-p2p test` (before the three read-repair spec fixes) | 3278 passing, 3 failing, all in `coordinator-repo-read-repair.spec.ts` |
| `yarn workspace @optimystic/db-p2p test -- --grep "CoordinatorRepo read-repair\|held-block background"` (after) | 63 passing |
| the four specs sharing the lifecycle helper, plus the new spec, run directly | 24 passing |
| `yarn test:harness` and every other workspace's `test` | all passing (db-core 1882, quereus-plugin-optimystic 1001, upgrade-check 6, others green) |
| `yarn test:integration` (before the relay fix) | 47 passing, 2 failing (relay phases 3 and 4) |
| `two-phones-over-relay.integration.spec.ts` alone (after) | 5 passing |
| `yarn lint`, `yarn lint:docs` | clean |

Not re-run after the last edits: the full db-p2p suite (only `coordinator-repo-read-repair.spec.ts`, the helper and two integration specs changed after it, and each was re-run on its own) and the full integration suite (only the relay spec and the shared helper changed; the helper refactor keeps `expectReadable`'s behaviour).

## Docs

- `docs/transactions.md` § Lazy read-repair window: the window paragraph (consult behind the read, what still blocks, watcher wake, writes stay safe), a new *What sets a held block's consult cadence* paragraph (window, silent-peer rule, one per block, the cap, #25's 30 s rhythm recorded rather than chased), the worst-case bound (one window plus one consult), the restart sentence, the asker-statement paragraph's "every read waits" sentence, and the two knob rows.
- `docs/internals.md` § Quereus vtab read path: the per-window consult runs behind the read.
- `docs/debugging.md`: `background` on `cluster-tx:read-repair-triggered`; new entries for `cluster-tx:read-repair-deferred` and `cluster-fetch:stale-pass-ignored`.
- `ClusterConsensusConfig.readRepairMode` / `readRepairWindowMs` doc comments.
- `packages/quereus-plugin-optimystic/README.md` read-consistency note: the bound is the window plus the consult the expiring read starts.

## Known gaps and points for the reviewer

- The background pass reads back with `readLocalRev(blockId)` and no context, as the ticket specified; the blocking path's refreshed read uses the triggering read's context. The difference only matters for a context that could promote a pending the triggering read's own local read did not already promote, which should not exist.
- The deferred-at-cap path and the `background` field have no test (per the ticket). The cap is a reasoned bound, not a measured one.
- A background pass that is still running when a spec ends keeps calling the spec's doubles until its deadlines expire. Nothing observed, but a reviewer skimming for cross-test interference should know the passes exist.
- The ticket's `readRepairWindowMs` ceiling is implemented as asked; `resolveSlotHoldWindowMs` beside it argues a clock-compared window needs no ceiling. The two doc comments state their different reasons; a reviewer may prefer consistency.
- `docs/debugging.md` line beginning "They stop within about one read-repair window" (the below-floor section) still says one window; with this change it is one window plus a consult, which the phrase "about" covers.
