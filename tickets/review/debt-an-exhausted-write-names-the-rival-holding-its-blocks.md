description: When a write gives up after too many failed tries, the error now names the other writers that were holding the data it needed — so a caller can tell "I kept losing to writers I can name" from "I spent every try on machines that never answered" without reading the message text. No error message changed.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/network/struct.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transaction/errors.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, docs/offline-sync.md, docs/internals.md
----

# What landed

The evidence of *who* was holding a write's blocks used to be collected and then dropped at three boundaries before it reached the writer. It now rides all the way through to `SyncRetryExhaustedError.rivals`.

**New wire field and summary type** (`packages/db-core/src/network/struct.ts`). `StaleFailure.heldBy?: Record<string, ActionId>` — peer id → the action id that member's storage says holds the blocks, taken from the members' signed `held` votes (`BlocksHeldError.heldBy`). `ExpiredFailure`, `ShortfallFailure` and `RejectedFailure` each gained `heldBy?: never` beside their existing `pending?: never`, so a consumer still reads the field off a bare `WriteFailure` without narrowing. Beside them, the writer-facing summary `RivalHolders` — `{ actionIds: readonly ActionId[]; corroborated: boolean }` — exported from the package root through the existing `network/index.js` barrel.

**`CoordinatorRepo.answerBlocksHeld`** (`packages/db-p2p/src/repo/coordinator-repo.ts`) now sets `heldBy: error.heldBy` on **both** arms — the one where its own storage corroborated the rivals and the un-corroborated one, which its own doc calls the ordinary shape under delivery latency. The `NOTE:` that documented the drop is rewritten: what survives from it is that `heldBy` is still never folded into `pending` (different claims from different machines) and that nobody may recover the ids by parsing `reason`.

**`refusalFrom`** (`packages/db-core/src/transactor/network-transactor.ts`) carries both claims through the per-batch → action-level rebuild, via two new module-private helpers:

- `mergedHeldBy` — `Object.assign` across the refused responses, `undefined` when none carried one.
- `distinctBlockActions` — the `pending` entries deduplicated on `(blockId, actionId)` with any `transform` **stripped**. A nested `Map<BlockId, Set<ActionId>>` rather than a joined string key, so there is no separator to collide with an id.

Both keys are omitted entirely when nothing carried them, so a plain stale refusal keeps exactly the shape it had. The unretryable short-circuit (rejection / expiry / shortfall returned verbatim ahead of the rebuild) is untouched.

**`AttemptCycle`** (`packages/db-core/src/collection/write-attempts.ts`) gained a module-private `rivalsFrom(refusal)`: the `pending` action ids first (`corroborated: true`), else the `heldBy` values (`corroborated: false`), else `undefined`, deduplicated. The result is kept on the cycle as the last **non-empty** one seen — set in `recordRefusal` beside `lastReason`, cleared in `recordCommit` beside it — and passed to both `SyncRetryExhaustedError` construction sites (the deadline exit in `beforeAttempt`, the budget exit in `recordRefusal`) and through `SyncRevisionStalledError`.

**`SyncRetryExhaustedError`** (`packages/db-core/src/collection/struct.ts`) gained a final optional `rivals?: RivalHolders` parameter; `SyncRevisionStalledError` gained one too and threads it through its `super(...)`. **Neither message changed** — not the base class's `exhausted N retries`, not the subclass's rewritten sentence. That is the point: a consumer reads the field.

**`CoordinatorStaleLossError`** (`packages/db-core/src/transaction/errors.ts`) gained the NOTE-tagged tripwire described below. No behaviour change there.

**Docs.** `docs/offline-sync.md` §Classifying an attempt's outcome gained a paragraph after the table: what `rivals` says, what its absence means, and that `classifyCommitFailure` still sorts both shapes as `contention` (the row did not move). `docs/internals.md` §Consensus Execution, in the held-blocks bullet, now names `StaleFailure.heldBy` as where a `held` vote's action ids land on both arms, and keeps the statement that they are not the coordinator's own `pending` claim.

# Two places I departed from the ticket

**1. The ticket's merge rationale for `heldBy` is wrong, and I did not write it down.** It asked for the doc comment to say a repeated peer id "cannot matter (one peer answers one batch)". `heldBy`'s keys are the **refusing cohort members'** peer ids (built in `ClusterCoordinator.executeTransaction` from the `promises` map), not the coordinating peer's, and two batches' cohorts can share a member who holds a different rival on each batch's blocks. So a repeated key is possible, the later response wins it, and the field's one-action-id-per-peer shape leaves nowhere to put the other. `mergedHeldBy`'s comment states that honestly, plus why it is acceptable: it can drop one of several named rivals, but it can never turn a named rival into silence — the only distinction the field exists to carry — and `rivalsFrom` deduplicates the action ids anyway. **Worth a reviewer's second opinion**: if losing one of several concurrent rivals is considered a real loss, the fix is a different wire shape (peer id → action ids), not a different merge.

**2. The coordinator-repo test went in a different file than the ticket named.** The ticket said to extend `packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts`, describing it as already covering `answerBlocksHeld`. It does not — it covers `classifyStaleRejection` and the lost-conflict-race arm, and has no `held`-vote machinery at all. The spec that actually covers both arms of `answerBlocksHeld` is `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts` (`describe('CoordinatorRepo pend — blocks held by a rival unresolved action')`), so the two assertions went there, one per arm, beside the `pending` assertions already in each.

# Known gaps and things to look at

- **The two new `collection.spec.ts` tests do not exercise hops 2 and 3.** They drive `Collection.sync` against a local transactor that returns the refusal directly, so they pin the writer-facing contract (`rivalsFrom` → `AttemptCycle` → the error) end to end but do not go through `CoordinatorRepo` or `refusalFrom`. Those two hops are pinned separately by the db-p2p and network-transactor assertions listed under Tests. There is no single test that walks all four boundaries in one go; that would need a mesh test, which the ticket did not ask for and which I judged not worth its runtime for a diagnostic field. Reviewer's call.
- **No test pins `recordCommit` clearing the rivals.** The ticket's "forward progress clears it" edge case is covered by inspection against `lastReason`'s identical treatment (both are cleared in the same three lines of `recordCommit`), not by a spec. A test for it would have to drive a commit-then-lose-then-exhaust sequence through a sequenced transactor; if the reviewer wants that pinned, it is a small addition to the new `rivals on exhaustion` describe rather than a new file.
- **`isConflictFailure` was deliberately not widened** with a `heldBy` arm. Both producers of a `heldBy`-carrying refusal (`answerBlocksHeld`, `refusalFrom`) set `conflict` explicitly, so the `missing`/`pending` inference in `packages/db-core/src/network/stale-failure.ts` is never reached for one. Verified by inspection of both producers; a reviewer who disagrees should check whether any third producer can ever set `heldBy` without `conflict`.
- **`refusalFrom` now carries `pending` up to the writer**, where before it dropped it. Nothing reads `pending` off a *failure* except that same inference — re-checked with `grep -rn "\.pending\b" packages/db-core/src packages/db-p2p/src` (the other hits are `PendSuccess.pending`, segment state, or unrelated `pending` members) — so the carry is inert apart from feeding `rivalsFrom`.
- **Mixed versions degrade cleanly.** A coordinator on an older build sends no `heldBy`, so `rivals` is absent exactly where it is absent today. No version gate (AGENTS.md: no backwards compatibility yet).
- **The multi-collection counterpart deliberately still lacks this.** `CoordinatorStaleLossError` carries `staleAtByCollection` but no rivals, so a multi-collection writer still cannot make the distinction. Recorded as a NOTE-tagged tripwire in its constructor in `packages/db-core/src/transaction/errors.ts`, naming the symmetric field (`rivalsByCollection`, fed from `TransactionCoordinator`'s per-participant retry state) and the condition that would make it work. Not a deferred defect: no consumer drives `TransactionCoordinator` directly today.

# Use cases to validate

- A write that loses its whole budget to a rival pend whose holder the coordinator read from its own storage → `rivals.actionIds` names the rival, `rivals.corroborated === true`.
- The same write where only the refusing members named the holder (the member is ahead of the coordinator — the common shape under delivery latency) → the same `actionIds`, `corroborated === false`.
- A write that loses its whole budget to bare stale refusals naming nobody → `rivals` is **absent**, not an empty object. This is the arm a caller branches on to say "re-presenting this later buys nothing".
- Two batches of one pend each naming a holder → the rebuilt refusal carries the merged `heldBy` and the deduplicated, transform-free `pending`.
- A pend refused with neither claim → the rebuilt refusal has neither key present (not `undefined` values).

# Tests

Two new, three assertions added to existing cases.

New, `packages/db-core/test/collection.spec.ts`, `describe('bounded sync retry') > describe('rivals on exhaustion')` with its own local always-refusing transactor (the house pattern in that file — the shared `FlakyCommitTransactor` must keep naming no rivals):

- *names the rivals, and says whether the coordinator read them itself* — verifies the summary's source precedence and its dedup, driven both ways (a refusal carrying `pending`, and one carrying only `heldBy`) in one test because the setup is what splitting would duplicate.
- *leaves rivals ABSENT when no refusal named one* — verifies the negative arm of the discriminator (what an implementation returning an empty `RivalHolders` would fail) and that the message still contains the unchanged `exhausted 3 retries` prefix.

Extended:

- `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts` — `heldBy` is present on the corroborated answer *and* on the un-corroborated one (one assertion in each of the two existing arm tests).
- `packages/db-core/test/network-transactor.spec.ts`, `describe('pend staleAt aggregation across batches')` — one new case, *carries both batches' held-block claims through the rebuilt aggregate*: the merged `heldBy`, and the `pending` deduplicated on `(blockId, actionId)` with the input's `transform` gone (the `deep.equal` is what fails if a transform survives).
- `packages/db-core/test/network-transactor.spec.ts`, the existing *omits staleAt entirely when no batch reported one* — two added `hasOwnProperty` assertions that `heldBy` and `pending` are likewise absent rather than `undefined`.

No test for `rivalsFrom` on its own: it is module-private and all three of its branches are reached by the two new collection tests.

# Commands run

From `packages/db-core` and `packages/db-p2p`: `yarn build` (both clean). From the repo root: `yarn lint` (clean), `yarn lint:docs` (49 documents, 844 anchored citations, 906 file mentions, 815 links — all resolve), `yarn lint:deps` (1281 files across 13 packages — every import declared), `yarn typecheck` (clean).

Specs by file, `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/<file>`:

- db-core: `test/collection.spec.ts` + `test/network-transactor.spec.ts` — 163 passing
- db-core: `test/collection-segments.spec.ts`, `test/offline-queue.spec.ts`, `test/refresh-below-floor.spec.ts`, `test/write-durability-reaches-the-writer.spec.ts`, `test/absent-header-wedges-revision.spec.ts` — 92 passing
- db-core: `test/stale-failure.spec.ts`, `test/commit-failure-class.spec.ts`, `test/coordinator.spec.ts`, `test/coordinator-latch-span.spec.ts`, `test/coordinator-entry-commit.spec.ts` — 59 passing
- db-p2p: `test/coordinator-repo-pend-divergence.spec.ts`, `test/coordinator-repo-stale-classification.spec.ts`, `test/coordinator-repo-held-block-background-consult.spec.ts`, `test/cohort-pend-refusal-channel.spec.ts` — 45 passing
- db-p2p: `test/cluster-coordinator-supermajority.spec.ts`, `test/cluster-pend-held-vote.spec.ts` — 39 passing

No full package suite, per the project testing rules; review runs those. No pre-existing failures surfaced.

# Handoff to the downstream repository

sereus classifies `SyncRetryExhaustedError` as non-transient and does not re-present it, so in the runs it measured the write was simply lost. `rivals` is the field that makes that decision answerable without reading `lastReason`: present → the write lost races to rivals that will resolve, and re-presenting later is sensible; absent → the budget went against silence, and re-presenting buys nothing until something changes. `corroborated` is diagnostic only (which machine named the holder); both values mean a named live rival.

Weigh re-presenting with `a-member-that-missed-a-commit-refuses-every-later-write` in mind (landed 2026-09-18, commit `98fd2ab1`): the lost write sereus measured was caused by a pending record that never cleared, which that ticket fixed. With it fixed, re-presenting on a present `rivals` is useful rather than a way to loop forever.

Every message is unchanged, so nothing downstream breaks today.

# Sibling

`debt-a-transactor-failure-says-which-phase-it-failed-in` is the other half of the parent ticket; it landed first (commit `136b17b2`). It edited the four aggregate sites in `network-transactor.ts` and the same two documents; this ticket edited `refusalFrom` and different regions of both docs, over its landed state. No conflict.
