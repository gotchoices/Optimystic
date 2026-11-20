description: When a write gives up after too many failed tries, the error now names the other writers that were holding the data it needed — so a caller can tell "I kept losing to writers I can name" from "I spent every try on machines that never answered" without reading the message text. No error message changed.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/network/struct.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transaction/errors.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, docs/offline-sync.md, docs/internals.md
----

# What landed

The evidence of *who* was holding a write's blocks used to be collected and then dropped at three boundaries before it reached the writer. It now rides all the way through to `SyncRetryExhaustedError.rivals`.

**New wire field and summary type** (`packages/db-core/src/network/struct.ts`). `StaleFailure.heldBy?: Record<string, ActionId>` — peer id → the action id that member's storage says holds the blocks, taken from the members' signed `held` votes (`BlocksHeldError.heldBy`). `ExpiredFailure`, `ShortfallFailure` and `RejectedFailure` each gained `heldBy?: never` beside their existing `pending?: never`, so a consumer still reads the field off a bare `WriteFailure` without narrowing. Beside them, the writer-facing summary `RivalHolders` — `{ actionIds: readonly ActionId[]; corroborated: boolean }` — exported from the package root through the existing `network/index.js` barrel.

**`CoordinatorRepo.answerBlocksHeld`** (`packages/db-p2p/src/repo/coordinator-repo.ts`) sets `heldBy: error.heldBy` on **both** arms — the one where its own storage corroborated the rivals and the un-corroborated one, which its own doc calls the ordinary shape under delivery latency. The `NOTE:` that documented the drop is replaced by the rule that survives it: `heldBy` is still a field of its own rather than extra entries in `pending`, and nobody may recover the ids by parsing `reason`.

**`refusalFrom`** (`packages/db-core/src/transactor/network-transactor.ts`) carries both claims through the per-batch → action-level rebuild, via two module-private helpers: `mergedHeldBy` (`Object.assign` across the refused responses, `undefined` when none carried one) and `distinctBlockActions` (the `pending` entries deduplicated on `(blockId, actionId)` with any `transform` stripped, keyed through a nested `Map<BlockId, Set<ActionId>>` so there is no separator to collide with an id). Both keys are omitted entirely when nothing carried them, so a plain stale refusal keeps exactly the shape it had. The unretryable short-circuit (rejection / expiry / shortfall returned verbatim ahead of the rebuild) is untouched.

**`AttemptCycle`** (`packages/db-core/src/collection/write-attempts.ts`) gained a module-private `rivalsFrom(refusal)`: the union of the `pending` action ids and the `heldBy` values, deduplicated, with `corroborated` true when at least one came from `pending`; `undefined` when neither source named anyone. The result is kept on the cycle as the last **non-empty** one seen — set in `recordRefusal` beside `lastReason`, cleared in `recordCommit` beside it — and passed to both `SyncRetryExhaustedError` construction sites (the deadline exit in `beforeAttempt`, the budget exit in `recordRefusal`) and through `SyncRevisionStalledError`.

**`SyncRetryExhaustedError`** (`packages/db-core/src/collection/struct.ts`) gained a final optional `rivals?: RivalHolders` parameter; `SyncRevisionStalledError` gained one too and threads it through its `super(...)`. **Neither message changed** — not the base class's `exhausted N retries`, not the subclass's rewritten sentence. That is the point: a consumer reads the field.

**`CoordinatorStaleLossError`** (`packages/db-core/src/transaction/errors.ts`) gained a `NOTE:`-tagged tripwire saying the multi-collection counterpart still names no rivals, what the symmetric field would be (`rivalsByCollection`, fed from `TransactionCoordinator`'s per-participant retry state), and why it was left out. No behaviour change there.

**Docs.** `docs/offline-sync.md` §Classifying an attempt's outcome gained a paragraph after the table: what `rivals` says, what its absence means, and that `classifyCommitFailure` still sorts both shapes as `contention` (the row did not move). `docs/internals.md` §Consensus Execution, in the held-blocks bullet, names `StaleFailure.heldBy` as where a `held` vote's action ids land on both arms, and why they stay their own field rather than joining `pending`.

# Where the implementation departed from the plan

**The plan's merge rationale for `heldBy` was wrong, and the implementer said so instead of writing it down.** The plan asked for a doc comment saying a repeated peer id "cannot matter (one peer answers one batch)". `heldBy`'s keys are the **refusing cohort members'** peer ids (built in `ClusterCoordinator.executeTransaction` from the `promises` map), not the coordinating peer's, and two batches' cohorts can share a member who holds a different rival on each batch's blocks. Review confirmed this reading and kept the honest comment; see the tripwire under *Review findings*.

**The coordinator-repo test went in a different file than the plan named.** The plan said to extend `packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts`, describing it as already covering `answerBlocksHeld`. It does not — it covers `classifyStaleRejection` and the lost-conflict-race arm, with no `held`-vote machinery. The spec that covers both arms of `answerBlocksHeld` is `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts`, so the two assertions went there, one per arm. Review agrees this is the right file.

# Tests

Two cases in `packages/db-core/test/collection.spec.ts`, `describe('bounded sync retry') > describe('rivals on exhaustion')`, with a local always-refusing transactor (the house pattern in that file — the shared `FlakyCommitTransactor` must keep naming no rivals):

- *names the rivals, and says whether the coordinator read them itself* — three arms over one setup: `pending` alone (corroborated, deduplicated across two blocks held by one action), `heldBy` alone (the delivery-latency shape, un-corroborated), and both at once naming different actions (the union; added in review, see below).
- *leaves rivals ABSENT when no refusal named one* — the negative arm of the discriminator, which an implementation returning an empty `RivalHolders` would fail, plus the unchanged `exhausted 3 retries` message prefix.

Extended:

- `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts` — `heldBy` present on the corroborated answer *and* on the un-corroborated one, one assertion in each existing arm test. These are the boundary the ticket exists to fix.
- `packages/db-core/test/network-transactor.spec.ts`, `describe('pend staleAt aggregation across batches')` — one case, *carries both batches' held-block claims through the rebuilt aggregate*: the merged `heldBy`, and the `pending` deduplicated on `(blockId, actionId)` with the input's `transform` gone (the `deep.equal` is what fails if a transform survives). Plus two `hasOwnProperty` assertions on the existing *omits staleAt entirely when no batch reported one* case, that `heldBy` and `pending` are likewise absent rather than `undefined`.

No test for `rivalsFrom` on its own: it is module-private and every branch is reached by the collection cases.

## Review findings

Read the `ticket(implement): debt-an-exhausted-write-names-the-rival-holding-its-blocks` diff before the handoff summary.

**Correctness — one defect found, fixed inline.**

`rivalsFrom` picked `pending` over `heldBy` by precedence: when the refusal carried both, the members' `heldBy` ids were discarded. The implement-stage comment justified this with "a refusal carrying both carries the same rival twice", which is not guaranteed. `CoordinatorRepo.corroborateHeldBlocks` reads *this node's* storage, and the un-corroborated arm exists precisely because a refusing member can be ahead of the coordinator — so a member can name a rival the coordinator's own re-read never saw, and the precedence pick silently dropped it from a list whose only job is to name rivals. It also contradicted both doc comments already in the diff: `RivalHolders.actionIds` says "the named rivals", and `corroborated` says "true when the coordinator read **at least one** holder out of its OWN storage", which only makes sense for a union. `rivalsFrom` now unions and deduplicates both sources and sets `corroborated` from whether `pending` contributed anything; the now-unused `distinct` helper is gone, and the function is four lines with no branching. One test arm added as the reproduction (both claims present naming different actions → both ids, `corroborated: true`), which fails against the old precedence code.

**Documentation — four sites corrected, same root cause as above.** `StaleFailure.heldBy`, the `answerBlocksHeld` doc comment, `docs/internals.md`'s held-blocks bullet, and a db-p2p spec comment all claimed the reason `heldBy` is not folded into `pending` is that "a consumer that merged them would report one rival as two". That holds only when the two name the same action, and the fix above makes it actively misleading. All four now state the real reason: two claims from two machines that need not name the same action, kept apart so a consumer can tell which machine claimed what, with the writer's summary unioning and deduplicating. `docs/offline-sync.md`'s new paragraph said `rivals` reports whether the coordinator read "them" or only the members did; it now says whether *any* of them came from the coordinator's own storage.

**Conditional concern — recorded as a tripwire, not a ticket.** `mergedHeldBy`'s cross-batch merge is last-write-wins on a repeated peer id, which can drop one of several named rivals. The implementer documented this in prose and asked for a second opinion. The call stands: one member casts one `held` vote per record, so the shape is exact per batch, and the merge can never turn a named rival into silence — the only distinction the field exists to carry. The prose is now a `NOTE:`-tagged tripwire at `mergedHeldBy` so the set stays greppable, naming the widening (`Record<string, ActionId[]>` here and at `BlocksHeldError.heldBy`) and the condition that would call for it.

**Checked and found clean, no change made.**

- **The wire hop.** `RepoClient.pend`/`pendMany` return `processRepoMessage<PendResult>`, a pass-through of the decoded response with no field-wise reconstruction, so `heldBy` crosses the repo boundary exactly as `staleAt` and `pending` already do. No codec, schema or allow-list to extend.
- **`isConflictFailure` was correctly left un-widened.** Its `missing`/`pending` fallback is only reached when `conflict` is absent, and both producers of a `heldBy`-carrying refusal (`answerBlocksHeld`, `refusalFrom`) set `conflict` explicitly. Grepped every reader of `.pending` on a *failure* across `packages/*/src`: that inference is the only one, so carrying `pending` up through `refusalFrom` — which previously dropped it — is inert apart from feeding `rivalsFrom`.
- **No persistence or size cost from the carried `pending`.** The offline queue's `failAndCascade` takes an `Error`, not a raw `WriteFailure`; nothing stores a refusal object.
- **`distinctBlockActions` output is deterministic** (blockId then actionId, both first-seen order), so the aggregate's `pending` is stable across runs and the spec's `deep.equal` is not order-lucky.
- **Docs that should have moved and did not need to.** `docs/correctness.md`'s `held`-vote passage argues about the signed `conflictWith`/`heldBy` id spaces, not about the coordinator boundary, and stays true. `docs/debugging.md`'s `cluster-tx:rejected-by-validators` field list describes the coordinator's log fields, which this change does not touch. `docs/internals.md`'s `staleAt` bullet is about the highest-wins rule and is unaffected.
- **`RivalHolders` really is reachable** from the package root: `network/index.js` re-exports `./struct.js` with `export *`, and `db-core/src/index.ts` re-exports the network barrel.

**Tests — none cut, one arm added.** Every test in the diff pins a boundary that previously dropped the evidence, or the present-vs-absent discriminator that is the deliverable; none restates the implementation or verifies a mock. The handoff offered a test for `recordCommit` clearing the rivals; declined, below the bar — it is one line of symmetry with `lastReason`, cleared in the same statement block, and a spec for it would need a commit-then-lose-then-exhaust sequencing harness to assert nothing.

**Known gaps accepted as the handoff describes them.** There is no single test walking all four boundaries in one go; the four hops are pinned separately (collection, network-transactor, coordinator-repo), and a mesh test for a diagnostic field does not earn its runtime. `CoordinatorStaleLossError` still names no rivals, which is a `NOTE:` tripwire at its constructor and not a latent defect — no consumer drives `TransactionCoordinator` directly today.

**Nothing filed.** No ticket: every finding was small enough to fix in this pass, and the one conditional concern is a tripwire by the rules rather than queued work.

# Commands run

From the repo root: `yarn typecheck`, `yarn lint`, `yarn lint:docs` (49 documents, 844 anchored citations, 906 file mentions, 815 links — all resolve) — all clean. `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build` — clean.

Full suites, after the review fixes:

- `yarn workspace @optimystic/db-core test` — 2124 passing
- `yarn workspace @optimystic/db-p2p test` — 3829 passing, 84 pending
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1429 passing, 14 pending, smoke ok
- `yarn test:integration` — 1435 passing, 8 pending

No pre-existing failures surfaced. `yarn check:rn` skipped: the change adds no imports in code that ships to React Native.

# Handoff to the downstream repository

sereus classifies `SyncRetryExhaustedError` as non-transient and does not re-present it, so in the runs it measured the write was simply lost. `rivals` is the field that makes that decision answerable without reading `lastReason`: present → the write lost races to rivals that will resolve, and re-presenting later is sensible; absent → the budget went against silence, and re-presenting buys nothing until something changes. `corroborated` is diagnostic only (which machine named the holder); both values mean a named live rival, and a `true` does not imply the list is only the coordinator's — it is the union of both sources.

Weigh re-presenting with `a-member-that-missed-a-commit-refuses-every-later-write` in mind (landed 2026-09-18, commit `98fd2ab1`): the lost write sereus measured was caused by a pending record that never cleared, which that ticket fixed. With it fixed, re-presenting on a present `rivals` is useful rather than a way to loop forever.

Every message is unchanged, so nothing downstream breaks today.

# Sibling

`debt-a-transactor-failure-says-which-phase-it-failed-in` is the other half of the parent ticket; it landed first (commit `136b17b2`). It edited the four aggregate sites in `network-transactor.ts` and the same two documents; this ticket edited `refusalFrom` and different regions of both docs, over its landed state. No conflict.
